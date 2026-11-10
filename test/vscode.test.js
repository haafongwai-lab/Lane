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
  return { USERPROFILE: root, LANE_VSCODE_CONFIG: path.join(root, "claude", "settings.json") };
}

test("connecting writes the Claude Code gateway variables beside existing settings", async (t) => {
  const env = await tempEnv(t);
  const file = vscodePaths(env).config;
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify({
    env: { CLAUDE_CODE_MAX_CONTEXT_TOKENS: "1000000", ANTHROPIC_MODEL: "old" },
    modelSettings: { "deepseek-flash": { effortLevel: "xhigh" } },
    enabledPlugins: { "adobe-for-creativity@claude-plugins-official": true }
  }), "utf8");

  const result = await connectVscode({
    env,
    gateway: "http://127.0.0.1:3426",
    providerModels: async () => [{ id: "deepseek-v4.1-flash", name: "DeepSeek" }]
  });
  assert.equal(result.agent, "vscode");
  assert.equal(result.connected, true);

  const document = JSON.parse(await fs.readFile(file, "utf8"));
  assert.equal(document.env.ANTHROPIC_BASE_URL, "http://127.0.0.1:3426");
  assert.equal(document.env.ANTHROPIC_AUTH_TOKEN, "lane");
  assert.equal(document.env.ANTHROPIC_MODEL, "deepseek-v4.1-flash");
  assert.equal(document.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, "1000000", "unrelated env preserved");
  assert.equal(document.modelSettings["deepseek-flash"].effortLevel, "xhigh", "model settings preserved");
  assert.equal(document.enabledPlugins["adobe-for-creativity@claude-plugins-official"], true);
});

test("connecting with no catalogue entry still writes a usable model", async (t) => {
  const env = await tempEnv(t);
  await connectVscode({
    env,
    gateway: "http://127.0.0.1:3426",
    providerModels: async () => []
  });
  const document = JSON.parse(await fs.readFile(vscodePaths(env).config, "utf8"));
  assert.equal(document.env.ANTHROPIC_MODEL, "auto");
});

test("a second connect replaces the Lane variables rather than duplicating them", async (t) => {
  const env = await tempEnv(t);
  await connectVscode({ env, gateway: "http://127.0.0.1:3426", providerModels: async () => [{ id: "one" }] });
  await connectVscode({ env, gateway: "http://127.0.0.1:3426", providerModels: async () => [{ id: "two" }] });
  const document = JSON.parse(await fs.readFile(vscodePaths(env).config, "utf8"));
  assert.equal(document.env.ANTHROPIC_MODEL, "two");
  assert.equal(Object.keys(document.env).filter((key) => key === "ANTHROPIC_BASE_URL").length, 1);
});

test("sync updates the model id without touching other settings", async (t) => {
  const env = await tempEnv(t);
  await connectVscode({ env, gateway: "http://127.0.0.1:3426", providerModels: async () => [{ id: "old" }] });
  const result = await syncVscodeCatalog({ env, models: [{ id: "new" }] });
  assert.equal(result.changed, true);
  const document = JSON.parse(await fs.readFile(vscodePaths(env).config, "utf8"));
  assert.equal(document.env.ANTHROPIC_MODEL, "new");
});

test("disconnect restores the user's original env values and removes Lane's", async (t) => {
  const env = await tempEnv(t);
  const file = vscodePaths(env).config;
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify({
    env: { CLAUDE_CODE_MAX_CONTEXT_TOKENS: "1000000", ANTHROPIC_MODEL: "mine" }
  }), "utf8");
  await connectVscode({ env, gateway: "http://127.0.0.1:3426", providerModels: async () => [{ id: "lane-model" }] });
  const result = await disconnectVscode({ env });
  assert.equal(result.connected, false);
  const document = JSON.parse(await fs.readFile(file, "utf8"));
  assert.equal(document.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, "1000000");
  assert.equal(document.env.ANTHROPIC_MODEL, "mine");
  assert.equal(document.env.ANTHROPIC_BASE_URL, undefined);
  assert.equal(document.env.ANTHROPIC_AUTH_TOKEN, undefined);
  assert.equal((await vscodeStatus({ env })).connected, false);
});

test("an invalid Claude Code settings file is refused without being overwritten", async (t) => {
  const env = await tempEnv(t);
  const file = vscodePaths(env).config;
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, "{ not json", "utf8");
  await assert.rejects(
    () => connectVscode({ env, gateway: "http://127.0.0.1:3426", providerModels: async () => [] }),
    /not valid JSON/
  );
  assert.equal(await fs.readFile(file, "utf8"), "{ not json");
});
