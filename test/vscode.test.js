import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  connectVscode,
  disconnectVscode,
  syncVscodeCatalog,
  vscodePaths,
  vscodeStatus
} from "../src/agents/vscode.js";

async function tempEnv(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "lane-vscode-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return {
    USERPROFILE: root,
    LANE_DATA_DIR: path.join(root, "lane"),
    LANE_VSCODE_SETTINGS: path.join(root, "Code", "User", "settings.json")
  };
}

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, "utf8"));
}

test("connecting writes a Lane custom-endpoint group and default model", async (t) => {
  const env = await tempEnv(t);
  const paths = vscodePaths(env);
  await fs.mkdir(path.dirname(paths.settings), { recursive: true });
  await fs.writeFile(paths.settings, JSON.stringify({
    "editor.fontSize": 14,
    "chat.defaultModel": "gpt-5",
    "chat.agent.enabled": true
  }), "utf8");
  await fs.writeFile(paths.models, JSON.stringify([
    { name: "Ollama", vendor: "ollama", url: "http://localhost:11434" }
  ]), "utf8");

  const result = await connectVscode({
    env,
    gateway: "http://127.0.0.1:3426",
    providerModels: async () => [{ id: "deepseek-v4.1-flash", name: "DeepSeek", context: 1000000, image: true }]
  });
  assert.equal(result.agent, "vscode");
  assert.equal(result.connected, true);

  const settings = await readJson(paths.settings);
  assert.equal(settings["chat.defaultModel"], "lane/deepseek-v4.1-flash");
  assert.equal(settings["editor.fontSize"], 14, "other settings preserved");
  const groups = await readJson(paths.models);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].vendor, "customendpoint");
  assert.equal(groups[0].name, "lane");
  assert.equal(groups[0].apiType, "chat-completions");
  assert.equal(groups[0].models[0].id, "lane/deepseek-v4.1-flash");
  assert.equal(groups[0].models[0].url, "http://127.0.0.1:3426/v1/chat/completions");
  assert.equal(groups[0].models[0].requestHeaders.Authorization, "Bearer lane");
  assert.equal(groups[0].models[0].contextWindow, 1000000);
  assert.equal(groups[1].name, "Ollama", "user's group preserved");
});

test("connecting with no catalogue still writes a usable auto model", async (t) => {
  const env = await tempEnv(t);
  await connectVscode({ env, gateway: "http://127.0.0.1:3426", providerModels: async () => [] });
  const paths = vscodePaths(env);
  const groups = await readJson(paths.models);
  assert.equal(groups[0].models[0].id, "lane/auto");
});

test("a second connect replaces the Lane group rather than duplicating it", async (t) => {
  const env = await tempEnv(t);
  await connectVscode({ env, gateway: "http://127.0.0.1:3426", providerModels: async () => [{ id: "one" }] });
  await connectVscode({ env, gateway: "http://127.0.0.1:3426", providerModels: async () => [{ id: "two" }] });
  const groups = await readJson(vscodePaths(env).models);
  assert.equal(groups.filter((group) => group.name === "lane").length, 1);
  assert.equal(groups.find((group) => group.name === "lane").models[0].id, "lane/two");
});

test("sync updates the Lane catalogue and keeps other groups", async (t) => {
  const env = await tempEnv(t);
  const paths = vscodePaths(env);
  await fs.mkdir(path.dirname(paths.settings), { recursive: true });
  await fs.writeFile(paths.models, JSON.stringify([{ name: "Mine", vendor: "ollama" }]), "utf8");
  await connectVscode({ env, gateway: "http://127.0.0.1:3426", providerModels: async () => [{ id: "old" }] });
  await syncVscodeCatalog({ env, models: [{ id: "new" }] });
  const groups = await readJson(paths.models);
  assert.equal(groups[0].models[0].id, "lane/new");
  assert.equal(groups[1].name, "Mine");
});

test("disconnect removes only Lane's group and restores the previous default", async (t) => {
  const env = await tempEnv(t);
  const paths = vscodePaths(env);
  await fs.mkdir(path.dirname(paths.settings), { recursive: true });
  await fs.writeFile(paths.settings, JSON.stringify({ "chat.defaultModel": "gpt-5", "editor.fontSize": 14 }), "utf8");
  await connectVscode({ env, gateway: "http://127.0.0.1:3426", providerModels: async () => [{ id: "lane-model" }] });
  await disconnectVscode({ env });
  const settings = await readJson(paths.settings);
  assert.equal(settings["chat.defaultModel"], "gpt-5");
  assert.equal(settings["editor.fontSize"], 14);
  const groups = await readJson(paths.models);
  assert.deepEqual(groups, []);
  assert.equal((await vscodeStatus({ env })).connected, false);
});

test("an invalid settings file is refused without being overwritten", async (t) => {
  const env = await tempEnv(t);
  const paths = vscodePaths(env);
  await fs.mkdir(path.dirname(paths.settings), { recursive: true });
  await fs.writeFile(paths.settings, "{ not json", "utf8");
  await assert.rejects(
    () => connectVscode({ env, gateway: "http://127.0.0.1:3426", providerModels: async () => [] }),
    /not valid JSON/
  );
  assert.equal(await fs.readFile(paths.settings, "utf8"), "{ not json");
});
