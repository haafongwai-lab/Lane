import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { connectCodex, disconnectCodex } from "../src/agents/codex.js";
import {
  connectClaudeDesktop,
  disconnectClaudeDesktop
} from "../src/agents/claude-desktop.js";
import { installWindowsTask } from "../src/windows-task.js";

async function temp() {
  return fs.mkdtemp(path.join(os.tmpdir(), "lane-test-"));
}

test("Codex connect is reversible", async () => {
  const root = await temp();
  const env = {
    LANE_DATA_DIR: path.join(root, "data"),
    LANE_CODEX_CONFIG: path.join(root, "codex", "config.toml")
  };
  await fs.mkdir(path.dirname(env.LANE_CODEX_CONFIG), { recursive: true });
  await fs.writeFile(env.LANE_CODEX_CONFIG, 'model = "gpt-5"\napproval_policy = "on-request"\n');

  await connectCodex({
    env,
    gateway: "http://127.0.0.1:3426",
    providerModels: async () => [{ id: "auto", name: "Auto", context: 168000 }]
  });
  const wired = await fs.readFile(env.LANE_CODEX_CONFIG, "utf8");
  assert.match(wired, /^model_provider = "lane"/m);
  assert.match(wired, /^model_catalog_json = "lane-models.json"/m);
  assert.match(wired, /\[model_providers\.lane\]/);
  assert.match(wired, /base_url = "http:\/\/127\.0\.0\.1:3426\/v1"/);
  assert.match(wired, /supports_websockets = false/);
  assert.equal(
    JSON.parse(await fs.readFile(path.join(root, "codex", "lane-models.json"), "utf8")).models[0].slug,
    "auto"
  );

  await disconnectCodex({ env });
  const restored = await fs.readFile(env.LANE_CODEX_CONFIG, "utf8");
  assert.doesNotMatch(restored, /^model_provider/m);
  assert.doesNotMatch(restored, /^model_catalog_json/m);
  assert.doesNotMatch(restored, /\[model_providers\.lane\]/);
  assert.match(restored, /approval_policy = "on-request"/);
});

test("Claude Desktop connect writes and restores its own 3p profile", async () => {
  const root = await temp();
  const env = {
    LANE_DATA_DIR: path.join(root, "data"),
    LANE_CLAUDE_LOCALAPPDATA: path.join(root, "local")
  };
  await connectClaudeDesktop({ env, gateway: "http://127.0.0.1:3426" });
  const mode = JSON.parse(
    await fs.readFile(path.join(root, "local", "Claude", "claude_desktop_config.json"), "utf8")
  );
  assert.equal(mode.deploymentMode, "3p");

  const metaPath = path.join(root, "local", "Claude-3p", "configLibrary", "_meta.json");
  const meta = JSON.parse(await fs.readFile(metaPath, "utf8"));
  assert.equal(meta.appliedId, "00000000-0000-4000-8000-6c616e650001");

  await disconnectClaudeDesktop({ env });
  const restored = JSON.parse(
    await fs.readFile(path.join(root, "local", "Claude", "claude_desktop_config.json"), "utf8")
  );
  assert.equal(restored.deploymentMode, undefined);
});

test("Windows autostart writes a task runner in Lane's own data directory", async () => {
  if (process.platform !== "win32") return;
  const root = await temp();
  let invocation;
  const result = await installWindowsTask({
    env: { LANE_DATA_DIR: path.join(root, "data") },
    port: 4123,
    node: "C:\\Program Files\\nodejs\\node.exe",
    script: path.join(root, "src", "cli.js"),
    runTask: async (command, args) => {
      invocation = { command, args };
      return "";
    }
  });
  assert.equal(invocation.command, "schtasks.exe");
  assert.ok(invocation.args.includes("Lane Gateway"));
  assert.ok(invocation.args.includes("/XML"));
  const runner = await fs.readFile(result.runner, "utf8");
  assert.match(runner, /--addr 127\.0\.0\.1:4123/);
  assert.ok(runner.includes(`>> "${path.join(root, "data", "lane.log")}"`));
  assert.doesNotMatch(runner, /%LOCALAPPDATA%/);
  const xml = await fs.readFile(path.join(root, "data", "lane-task.xml"), "utf16le");
  assert.match(xml, /<LogonTrigger>/);
  assert.match(xml, /<RunLevel>LeastPrivilege<\/RunLevel>/);
  assert.ok(xml.includes(result.runner.replaceAll("&", "&amp;")));
});
