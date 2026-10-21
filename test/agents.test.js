import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { connectCodex, disconnectCodex, syncCodexCatalog } from "../src/agents/codex.js";
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
    providerModels: async () => [{
      id: "auto",
      name: "Auto",
      context: 168000,
      efforts: ["low", "high"]
    }]
  });
  const wired = await fs.readFile(env.LANE_CODEX_CONFIG, "utf8");
  assert.match(wired, /^model_provider = "lane"/m);
  assert.match(wired, /^model_catalog_json = "lane-models.json"/m);
  assert.match(wired, /\[model_providers\.lane\]/);
  assert.match(wired, /base_url = "http:\/\/127\.0\.0\.1:3426\/v1"/);
  assert.match(wired, /supports_websockets = false/);
  const catalogPath = path.join(root, "codex", "lane-models.json");
  const model = JSON.parse(await fs.readFile(catalogPath, "utf8")).models[0];
  assert.equal(model.slug, "auto");
  assert.equal(model.default_reasoning_level, "high");
  assert.deepEqual(model.supported_reasoning_levels, [
    { effort: "low", description: "Fast responses with lighter reasoning" },
    { effort: "high", description: "Greater reasoning depth for complex problems" }
  ]);
  assert.equal(model.supports_reasoning_summaries, true);
  assert.ok(model.supported_reasoning_levels.every((level) => level.description));

  await fs.writeFile(catalogPath, '{"models":[]}\n');
  assert.equal((await syncCodexCatalog({
    env,
    models: [{ id: "auto", name: "Auto", context: 168000, efforts: ["low", "high"] }]
  })).changed, true);
  assert.equal(
    JSON.parse(await fs.readFile(catalogPath, "utf8")).models[0].default_reasoning_level,
    "high"
  );

  await disconnectCodex({ env });
  const restored = await fs.readFile(env.LANE_CODEX_CONFIG, "utf8");
  assert.doesNotMatch(restored, /^model_provider/m);
  assert.doesNotMatch(restored, /^model_catalog_json/m);
  assert.doesNotMatch(restored, /\[model_providers\.lane\]/);
  assert.match(restored, /approval_policy = "on-request"/);
});

test("Codex connect refreshes an existing Lane provider table", async () => {
  const root = await temp();
  const env = {
    LANE_DATA_DIR: path.join(root, "data"),
    LANE_CODEX_CONFIG: path.join(root, "codex", "config.toml")
  };
  await fs.mkdir(path.dirname(env.LANE_CODEX_CONFIG), { recursive: true });
  await fs.writeFile(
    env.LANE_CODEX_CONFIG,
    [
      'model_provider = "lane"',
      "",
      "[model_providers.lane]",
      'name = "Lane"',
      'base_url = "http://127.0.0.1:3425/v1"',
      'wire_api = "responses"',
      "",
      "[model_providers.other]",
      'base_url = "http://127.0.0.1:9000/v1"',
      ""
    ].join("\n")
  );

  await connectCodex({
    env,
    gateway: "http://127.0.0.1:3426",
    providerModels: async () => []
  });
  const wired = await fs.readFile(env.LANE_CODEX_CONFIG, "utf8");
  assert.doesNotMatch(wired, /127\.0\.0\.1:3425/);
  assert.match(wired, /base_url = "http:\/\/127\.0\.0\.1:3426\/v1"/);
  assert.match(wired, /requires_openai_auth = false/);
  assert.match(wired, /supports_websockets = false/);
  assert.match(wired, /\[model_providers\.other\]/);

  await disconnectCodex({ env });
  const restored = await fs.readFile(env.LANE_CODEX_CONFIG, "utf8");
  assert.match(restored, /base_url = "http:\/\/127\.0\.0\.1:3425\/v1"/);
  assert.match(restored, /\[model_providers\.other\]/);
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
  assert.equal(invocation.command, "powershell.exe");
  const runner = await fs.readFile(result.runner, "utf8");
  assert.ok(runner.includes(`$env:LANE_DATA_DIR = '${path.join(root, "data")}'`));
  assert.ok(runner.includes(`--addr 127.0.0.1:4123`));
  assert.ok(runner.includes(`$log = '${path.join(root, "data", "lane.log")}'`));
  assert.ok(runner.includes(`Lane.exe`));
  assert.doesNotMatch(runner, /%LOCALAPPDATA%/);
  assert.match(result.shortcut, /Startup\\Lane Gateway\.lnk$/);
  const shortcut = invocation.args.find((arg) => arg.includes("CreateShortcut"));
  assert.ok(shortcut.includes(result.shortcut));
  assert.ok(shortcut.includes(result.runner));
});
