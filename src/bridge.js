#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { randomUUID } from "node:crypto";
import { TOOL_DEFINITIONS, BRIDGE_TOOL_DEFINITIONS } from "./tools.js";

const HUB_PORT = Number(process.env.RBX_MCP_HUB_PORT) || 44755;
const HUB_HOST = process.env.RBX_MCP_HUB_HOST || "127.0.0.1";
const ENV_PLACE_ID = process.env.RBX_PLACE_ID || "";
const ALLOW_REBIND = /^(1|true|yes)$/i.test(process.env.RBX_ALLOW_REBIND || "");
// A bridge started with a fixed RBX_PLACE_ID stays welded to it (the original
// no-wrong-Studio guarantee) unless RBX_ALLOW_REBIND opts in to bind_place.
const WELDED = Boolean(ENV_PLACE_ID) && !ALLOW_REBIND;

let boundPlaceId = ENV_PLACE_ID;
let boundPlaceName = process.env.RBX_PLACE_NAME || "";

function log(...args) {
  process.stderr.write(`[bridge] ${args.join(" ")}\n`);
}

if (!boundPlaceId) {
  log("warning: no place bound yet. Studio tools will fail until one is.");
  log("bind at runtime with the `bind_place` tool, or run `rbx-mcp-hub init` to fix a PlaceId in .mcp.json");
}

async function forwardToHub(tool, args) {
  const id = randomUUID();
  const body = JSON.stringify({
    id,
    context: boundPlaceId,
    tool,
    params: args ?? {},
  });

  const res = await fetch(`http://${HUB_HOST}:${HUB_PORT}/proxy`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  }).catch((e) => {
    throw new Error(
      `hub unreachable at ${HUB_HOST}:${HUB_PORT} (${e.message}). ` +
      `Start it with: rbx-mcp-hub start`,
    );
  });

  const text = await res.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`hub returned non-JSON: ${text.slice(0, 200)}`);
  }
  if (!res.ok) {
    throw new Error(parsed.error || `hub error HTTP ${res.status}`);
  }
  if (parsed.error) {
    throw new Error(parsed.error);
  }
  return parsed.result;
}

const server = new Server(
  {
    name: "rbx-mcp-hub",
    version: "0.1.0",
  },
  {
    capabilities: {
      tools: {},
    },
  },
);

async function fetchHubStatus() {
  const res = await fetch(`http://${HUB_HOST}:${HUB_PORT}/status`).catch((e) => {
    throw new Error(
      `hub unreachable at ${HUB_HOST}:${HUB_PORT} (${e.message}). ` +
      `Start it with: rbx-mcp-hub start`,
    );
  });
  return res.json();
}

function textResult(text, isError = false) {
  return { ...(isError ? { isError: true } : {}), content: [{ type: "text", text }] };
}

async function handleListPlaces() {
  const status = await fetchHubStatus();
  const places = (status.plugins ?? []).map((p) => ({
    placeId: p.context,
    name: p.name,
    connected: p.connected,
    lastSeenSecondsAgo: Math.round((p.lastSeenMs ?? 0) / 1000),
  }));
  return textResult(JSON.stringify({ boundPlaceId: boundPlaceId || null, places }, null, 2));
}

async function handleBindPlace(args) {
  const placeId = String(args?.placeId ?? "").trim();
  if (!/^\d+$/.test(placeId)) {
    return textResult(
      `bind_place: placeId must be a positive integer (got "${placeId}"). ` +
      "Find it via list_places, or `print(game.PlaceId)` in Studio.",
      true,
    );
  }
  if (WELDED) {
    return textResult(
      `bind_place refused: this bridge is welded to RBX_PLACE_ID=${ENV_PLACE_ID} by its .mcp.json. ` +
      "Set RBX_ALLOW_REBIND=1 in the same env block to allow runtime re-binding.",
      true,
    );
  }
  let note = "";
  try {
    const status = await fetchHubStatus();
    const match = (status.plugins ?? []).find((p) => p.context === placeId);
    if (!match) {
      note = " Warning: no Studio plugin is currently connected for that PlaceId — calls will fail until that place is open in Studio.";
    } else if (!match.connected) {
      note = " Warning: the plugin for that PlaceId looks stale — check the Studio window.";
    } else if (match.name) {
      note = ` Connected Studio reports name "${match.name}".`;
    }
  } catch {
    note = " Warning: hub unreachable, binding stored anyway.";
  }
  boundPlaceId = placeId;
  boundPlaceName = "";
  log(`bound to place ${placeId}`);
  return textResult(`Bound to PlaceId ${placeId}. All Studio tools now route there.${note}`);
}

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [...TOOL_DEFINITIONS, ...BRIDGE_TOOL_DEFINITIONS],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;

  try {
    if (name === "list_places") return await handleListPlaces();
    if (name === "bind_place") return await handleBindPlace(args);
  } catch (e) {
    return textResult(e.message || String(e), true);
  }

  if (!boundPlaceId) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text:
            "No place is bound for this MCP bridge. " +
            "Call `bind_place` with the target PlaceId (see `list_places`), " +
            "or run `rbx-mcp-hub init` in the project directory " +
            "to set `env.RBX_PLACE_ID` in its .mcp.json.",
        },
      ],
    };
  }

  try {
    const result = await forwardToHub(name, args);
    const text =
      typeof result === "string"
        ? result
        : JSON.stringify(result, null, 2);
    return {
      content: [{ type: "text", text }],
    };
  } catch (e) {
    return {
      isError: true,
      content: [{ type: "text", text: e.message || String(e) }],
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
log(
  `bridge running (place=${boundPlaceId || "unbound"} name=${boundPlaceName || "-"}` +
  `${WELDED ? " welded" : " rebindable"})`,
);
