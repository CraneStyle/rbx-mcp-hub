#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const HUB_PORT = Number(process.env.RBX_MCP_HUB_PORT) || 44755;
const HUB_HOST = "127.0.0.1";
const STATE_DIR = path.join(os.homedir(), ".rbx-mcp-hub");
const PID_FILE = path.join(STATE_DIR, "hub.pid");
const LOG_FILE = path.join(STATE_DIR, "hub.log");

function ensureStateDir() {
  fs.mkdirSync(STATE_DIR, { recursive: true });
}

async function ask(q) {
  const rl = createInterface({ input, output });
  try {
    return (await rl.question(q)).trim();
  } finally {
    rl.close();
  }
}

function printHelp() {
  console.log(`rbx-mcp-hub — multi-place MCP hub for Roblox Studio

Usage:
  rbx-mcp-hub <command> [options]

Commands:
  init                 Write a per-project .mcp.json in the current directory.
                       Prompts for this project's Roblox PlaceId.
  init --dynamic       Same, but with NO fixed PlaceId and no prompts: the
                       agent binds at runtime with the bind_place tool
                       (discover targets via list_places).
  start                Start the hub daemon in the background.
  stop                 Stop the running hub daemon.
  status               Show which Studio plugins are currently connected.
  install-plugin       Copy the Studio plugin .rbxm into your Roblox
                       Plugins folder. Requires plugin/build/*.rbxm to
                       exist (built with rojo).
  help, --help, -h     Show this message.

Env vars:
  RBX_MCP_HUB_PORT     Override the hub port (default 44755).
`);
}

async function cmdInit(flags) {
  const dynamic = flags.includes("--dynamic");
  const cwd = process.cwd();
  const target = path.join(cwd, ".mcp.json");
  let existing = {};
  if (fs.existsSync(target)) {
    try {
      existing = JSON.parse(fs.readFileSync(target, "utf8"));
    } catch {
      console.error(`warning: existing ${target} is not valid JSON; overwriting`);
    }
  }

  let env;
  if (dynamic) {
    env = undefined;
  } else {
    const placeId = await ask(
      "Roblox PlaceId for this project (find via `print(game.PlaceId)` in Studio, or the /games/<id> URL segment): ",
    );
    if (!placeId || !/^\d+$/.test(placeId)) {
      console.error("error: PlaceId must be a positive integer.");
      process.exit(1);
    }
    const placeName = await ask("Optional short name (e.g. 'chess'); blank to skip: ");
    env = {
      RBX_PLACE_ID: placeId,
      ...(placeName ? { RBX_PLACE_NAME: placeName } : {}),
    };
  }

  const bridgeBin = path.resolve(ROOT, "src", "bridge.js");

  existing.mcpServers = existing.mcpServers || {};
  existing.mcpServers["rbx-mcp-hub"] = {
    command: "node",
    args: [bridgeBin],
    ...(env ? { env } : {}),
  };
  fs.writeFileSync(target, JSON.stringify(existing, null, 2) + "\n");
  console.log(`wrote ${target}${dynamic ? " (dynamic: no fixed PlaceId)" : ""}`);
  if (dynamic) {
    console.log(
      "next: run `rbx-mcp-hub start` (once, globally). Sessions here start unbound —\n" +
      "tell the agent to call list_places, then bind_place with the target PlaceId.",
    );
  } else {
    console.log("next: run `rbx-mcp-hub start` (once, globally) and open this place in Studio.");
  }
}

function readPid() {
  try {
    const s = fs.readFileSync(PID_FILE, "utf8").trim();
    const n = Number(s);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function cmdStart() {
  ensureStateDir();
  const existing = readPid();
  if (existing && pidAlive(existing)) {
    console.log(`hub already running (pid ${existing}). Use 'status' or 'stop'.`);
    return;
  }

  const hubJs = path.resolve(ROOT, "src", "hub.js");
  const logFd = fs.openSync(LOG_FILE, "a");
  const child = spawn(process.execPath, [hubJs], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    windowsHide: true,
    env: process.env,
  });
  child.unref();

  fs.writeFileSync(PID_FILE, String(child.pid));
  console.log(`hub started (pid ${child.pid}), logs: ${LOG_FILE}`);

  await new Promise((r) => setTimeout(r, 500));
  try {
    const res = await fetch(`http://${HUB_HOST}:${HUB_PORT}/status`);
    if (res.ok) {
      console.log(`health check OK: listening on ${HUB_HOST}:${HUB_PORT}`);
    } else {
      console.log(`health check returned HTTP ${res.status}. Check ${LOG_FILE}.`);
    }
  } catch (e) {
    console.log(`health check failed: ${e.message}. Check ${LOG_FILE}.`);
  }
}

async function cmdStop() {
  const pid = readPid();
  if (!pid) {
    console.log("no pid file; nothing to stop.");
    return;
  }
  if (!pidAlive(pid)) {
    console.log(`pid ${pid} not alive; clearing pid file.`);
    fs.rmSync(PID_FILE, { force: true });
    return;
  }
  process.kill(pid);
  console.log(`sent SIGTERM to pid ${pid}`);
  fs.rmSync(PID_FILE, { force: true });
}

async function cmdStatus() {
  try {
    const res = await fetch(`http://${HUB_HOST}:${HUB_PORT}/status`);
    const body = await res.json();
    console.log(`hub on ${HUB_HOST}:${body.port}`);
    if (!body.plugins || body.plugins.length === 0) {
      console.log("  no plugins connected yet. Open Studio and load the plugin.");
      return;
    }
    for (const p of body.plugins) {
      const flag = p.connected ? "✓" : "stale";
      console.log(
        `  ${flag} placeId=${p.context} name=${p.name ?? "-"} queue=${p.queueDepth} lastSeen=${Math.round(p.lastSeenMs / 1000)}s ago`,
      );
    }
    console.log(`  pending tool calls: ${body.pendingCommands}`);
  } catch (e) {
    console.log(`hub not reachable on ${HUB_HOST}:${HUB_PORT} (${e.message}).`);
    console.log("start it with: rbx-mcp-hub start");
  }
}

function pluginsFolder() {
  if (process.platform === "win32") {
    return path.join(os.homedir(), "AppData", "Local", "Roblox", "Plugins");
  }
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Documents", "Roblox", "Plugins");
  }
  return path.join(os.homedir(), ".local", "share", "Roblox", "Plugins");
}

async function cmdInstallPlugin() {
  const candidates = [
    path.join(ROOT, "plugin", "build", "rbx-mcp-hub.rbxm"),
    path.join(ROOT, "plugin", "build", "rbx-mcp-hub.rbxmx"),
  ];
  const built = candidates.find((p) => fs.existsSync(p));
  if (!built) {
    console.error(
      "no built plugin found. From the repo root run:\n" +
      "  rojo build plugin/default.project.json -o plugin/build/rbx-mcp-hub.rbxm",
    );
    process.exit(1);
  }
  const dest = pluginsFolder();
  fs.mkdirSync(dest, { recursive: true });
  const destFile = path.join(dest, path.basename(built));
  fs.copyFileSync(built, destFile);
  console.log(`installed plugin to ${destFile}`);
  console.log("open Roblox Studio; the plugin loads automatically.");
}

const cmd = process.argv[2];
const flags = process.argv.slice(3);
switch (cmd) {
  case "init":
    await cmdInit(flags);
    break;
  case "start":
    await cmdStart();
    break;
  case "stop":
    await cmdStop();
    break;
  case "status":
    await cmdStatus();
    break;
  case "install-plugin":
    await cmdInstallPlugin();
    break;
  case "help":
  case "--help":
  case "-h":
  case undefined:
    printHelp();
    break;
  default:
    console.error(`unknown command: ${cmd}`);
    printHelp();
    process.exit(1);
}
