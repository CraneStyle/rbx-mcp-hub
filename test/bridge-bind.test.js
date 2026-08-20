#!/usr/bin/env node
// Smoke tests for dynamic place binding on the MCP bridge.
// Hermetic: spins a fake hub on a random port, no Studio required.
// Run: node test/bridge-bind.test.js

import { spawn } from "node:child_process";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE = path.resolve(__dirname, "..", "src", "bridge.js");

// ---------- fake hub ----------
const FAKE_PLUGINS = [
  { context: "111", name: "GameA", connected: true, queueDepth: 0, waiters: 1, ageMs: 1000, lastSeenMs: 500 },
  { context: "222", name: "GameB", connected: true, queueDepth: 0, waiters: 1, ageMs: 1000, lastSeenMs: 700 },
];
const proxyCalls = [];

function startFakeHub() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, "http://127.0.0.1");
      if (req.method === "GET" && url.pathname === "/status") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, port: server.address().port, plugins: FAKE_PLUGINS, pendingCommands: 0 }));
        return;
      }
      if (req.method === "POST" && url.pathname === "/proxy") {
        const chunks = [];
        req.on("data", (c) => chunks.push(c));
        req.on("end", () => {
          const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          proxyCalls.push(body);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ id: body.id, result: `edit(context=${body.context})`, error: null }));
        });
        return;
      }
      res.writeHead(404);
      res.end();
    });
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

// ---------- minimal MCP stdio client ----------
class McpClient {
  constructor(env) {
    this.proc = spawn(process.execPath, [BRIDGE], {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.nextId = 1;
    this.pending = new Map();
    this.buf = "";
    this.proc.stdout.on("data", (d) => {
      this.buf += d.toString("utf8");
      let idx;
      while ((idx = this.buf.indexOf("\n")) >= 0) {
        const line = this.buf.slice(0, idx).trim();
        this.buf = this.buf.slice(idx + 1);
        if (!line) continue;
        const msg = JSON.parse(line);
        if (msg.id != null && this.pending.has(msg.id)) {
          this.pending.get(msg.id)(msg);
          this.pending.delete(msg.id);
        }
      }
    });
    this.stderr = "";
    this.proc.stderr.on("data", (d) => (this.stderr += d.toString("utf8")));
  }
  request(method, params) {
    const id = this.nextId++;
    const p = new Promise((resolve, reject) => {
      this.pending.set(id, resolve);
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`timeout waiting for ${method}`));
        }
      }, 8000);
    });
    this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    return p;
  }
  notify(method, params) {
    this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }
  async init() {
    await this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "bind-test", version: "0.0.0" },
    });
    this.notify("notifications/initialized", {});
  }
  callTool(name, args) {
    return this.request("tools/call", { name, arguments: args ?? {} });
  }
  kill() {
    this.proc.kill();
  }
}

// ---------- assertions ----------
let failures = 0;
function check(label, cond, detail) {
  if (cond) {
    console.log(`  ok   - ${label}`);
  } else {
    failures++;
    console.log(`  FAIL - ${label}${detail ? ` :: ${detail}` : ""}`);
  }
}
function textOf(callResult) {
  return (callResult.result?.content ?? []).map((c) => c.text).join("\n");
}

// ---------- tests ----------
const hub = await startFakeHub();
const HUB_PORT = String(hub.address().port);

console.log("case 1: unbound bridge (no RBX_PLACE_ID)");
{
  const c = new McpClient({ RBX_MCP_HUB_PORT: HUB_PORT, RBX_PLACE_ID: "", RBX_PLACE_NAME: "" });
  await c.init();

  const tools = await c.request("tools/list", {});
  const names = tools.result.tools.map((t) => t.name);
  check("tools/list includes bind_place", names.includes("bind_place"), names.join(","));
  check("tools/list includes list_places", names.includes("list_places"), names.join(","));

  const unbound = await c.callTool("get_studio_mode", {});
  check("studio tool before bind is an error", unbound.result?.isError === true);
  check("error text mentions bind_place", /bind_place/.test(textOf(unbound)), textOf(unbound));

  const listed = await c.callTool("list_places", {});
  check("list_places is not an error", !listed.result?.isError, textOf(listed));
  check("list_places shows GameA and GameB", /GameA/.test(textOf(listed)) && /GameB/.test(textOf(listed)), textOf(listed));

  const bound = await c.callTool("bind_place", { placeId: "222" });
  check("bind_place succeeds", !bound.result?.isError, textOf(bound));

  proxyCalls.length = 0;
  const mode = await c.callTool("get_studio_mode", {});
  check("studio tool after bind succeeds", !mode.result?.isError, textOf(mode));
  check("call routed with context=222", proxyCalls.length === 1 && proxyCalls[0].context === "222", JSON.stringify(proxyCalls));

  const rebound = await c.callTool("bind_place", { placeId: "111" });
  check("re-bind to another place succeeds", !rebound.result?.isError, textOf(rebound));
  proxyCalls.length = 0;
  await c.callTool("get_studio_mode", {});
  check("call routed with context=111", proxyCalls.length === 1 && proxyCalls[0].context === "111", JSON.stringify(proxyCalls));

  const badBind = await c.callTool("bind_place", { placeId: "not-a-number" });
  check("bind_place rejects non-numeric placeId", badBind.result?.isError === true, textOf(badBind));

  c.kill();
}

console.log("case 2: welded bridge (RBX_PLACE_ID set, no RBX_ALLOW_REBIND)");
{
  const c = new McpClient({ RBX_MCP_HUB_PORT: HUB_PORT, RBX_PLACE_ID: "111", RBX_PLACE_NAME: "GameA" });
  await c.init();

  proxyCalls.length = 0;
  const mode = await c.callTool("get_studio_mode", {});
  check("welded bridge routes with env context", proxyCalls.length === 1 && proxyCalls[0].context === "111", JSON.stringify(proxyCalls));
  check("welded call succeeds", !mode.result?.isError, textOf(mode));

  const bound = await c.callTool("bind_place", { placeId: "222" });
  check("bind_place refused on welded bridge", bound.result?.isError === true, textOf(bound));
  check("refusal mentions RBX_ALLOW_REBIND", /RBX_ALLOW_REBIND/.test(textOf(bound)), textOf(bound));

  proxyCalls.length = 0;
  await c.callTool("get_studio_mode", {});
  check("weld unchanged after refused bind", proxyCalls.length === 1 && proxyCalls[0].context === "111", JSON.stringify(proxyCalls));

  c.kill();
}

console.log("case 3: welded but rebind allowed (RBX_ALLOW_REBIND=1)");
{
  const c = new McpClient({ RBX_MCP_HUB_PORT: HUB_PORT, RBX_PLACE_ID: "111", RBX_ALLOW_REBIND: "1" });
  await c.init();

  const bound = await c.callTool("bind_place", { placeId: "222" });
  check("bind_place allowed with RBX_ALLOW_REBIND", !bound.result?.isError, textOf(bound));

  proxyCalls.length = 0;
  await c.callTool("get_studio_mode", {});
  check("rebound call routes with context=222", proxyCalls.length === 1 && proxyCalls[0].context === "222", JSON.stringify(proxyCalls));

  c.kill();
}

hub.close();
console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
