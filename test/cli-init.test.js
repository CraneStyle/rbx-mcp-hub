#!/usr/bin/env node
// Tests for `rbx-mcp-hub init --dynamic` (no-prompt, unbound .mcp.json).
// Run: node test/cli-init.test.js

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(__dirname, "..", "bin", "cli.js");

let failures = 0;
function check(label, cond, detail) {
  if (cond) {
    console.log(`  ok   - ${label}`);
  } else {
    failures++;
    console.log(`  FAIL - ${label}${detail ? ` :: ${detail}` : ""}`);
  }
}

console.log("case: init --dynamic writes an unbound .mcp.json without prompting");
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rbx-hub-test-"));
  const run = spawnSync(process.execPath, [CLI, "init", "--dynamic"], {
    cwd: dir,
    encoding: "utf8",
    timeout: 15000,
    stdio: ["ignore", "pipe", "pipe"], // no stdin: would hang if it prompted
  });
  check("exits 0", run.status === 0, `status=${run.status} stderr=${run.stderr}`);

  const target = path.join(dir, ".mcp.json");
  check(".mcp.json created", fs.existsSync(target));

  const cfg = JSON.parse(fs.readFileSync(target, "utf8"));
  const entry = cfg.mcpServers?.["rbx-mcp-hub"];
  check("has rbx-mcp-hub entry", Boolean(entry));
  check("command is node", entry?.command === "node");
  check("args point at bridge.js", /bridge\.js$/.test(entry?.args?.[0] ?? ""), JSON.stringify(entry?.args));
  check("no RBX_PLACE_ID set", !entry?.env?.RBX_PLACE_ID, JSON.stringify(entry?.env));
  check("output mentions bind_place", /bind_place/.test(run.stdout), run.stdout);

  fs.rmSync(dir, { recursive: true, force: true });
}

console.log("case: init --dynamic preserves other keys in an existing .mcp.json");
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rbx-hub-test-"));
  fs.writeFileSync(
    path.join(dir, ".mcp.json"),
    JSON.stringify({ mcpServers: { other: { command: "foo", args: [] } } }, null, 2),
  );
  const run = spawnSync(process.execPath, [CLI, "init", "--dynamic"], {
    cwd: dir,
    encoding: "utf8",
    timeout: 15000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  check("exits 0", run.status === 0, `status=${run.status} stderr=${run.stderr}`);
  const cfg = JSON.parse(fs.readFileSync(path.join(dir, ".mcp.json"), "utf8"));
  check("other server kept", cfg.mcpServers?.other?.command === "foo");
  check("rbx-mcp-hub entry added", Boolean(cfg.mcpServers?.["rbx-mcp-hub"]));
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
