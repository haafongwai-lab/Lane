import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { connectDsh, disconnectDsh, dshStatus, dshPatchPath } from "../src/agents/dsh.js";

/**
 * DeepSeek Harness loads the active profile's Cordis patch layer, not
 * ~/.dsh/settings.yaml — that file is an import source from earlier releases,
 * renamed to .imported once read. A provider written there is inert, which is
 * how a hand-written config kept failing. These pin the real target.
 */

async function temp() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "lane-dsh-"));
  return { root, env: { DSH_HOME: path.join(root, ".dsh"), LANE_DATA_DIR: path.join(root, "data") } };
}

// This machine's real patch layer, trimmed: the user's own entries, their
// comments, and the default-model entry pointing at Lane.
const USER_PATCH = `# Your patch layer for this dsh profile.
- id: ui-theme
  name: "@deepseek-ai/dsh-client-ui-theme"
  config:
    preference: light
    fontSize: 16
- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config:
    provider: lane
    model: deepseek-v4.1-flash
    reasoningEffort: high
- id: permission
  name: "@deepseek-ai/dsh-permission-presets"
  config:
    defaultPreset: workspace-write
- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      lane:
        displayName: Lane
        api: openai-completions
        baseURL: http://127.0.0.1:3427/v1
        models:
          - id: deepseek-v4.1-flash
            name: DeepSeek-V4.1-Flash
`;

const MODELS = [
  { id: "auto", name: "Auto", efforts: ["low", "high", "max"] },
  { id: "deepseek-v4.1-flash", name: "DeepSeek-V4.1-Flash", efforts: ["low", "high", "max"] },
  { id: "glm-5.2", name: "GLM-5.2", efforts: ["high", "xhigh"] }
];

async function writePatch(env, text = USER_PATCH) {
  await fs.mkdir(path.dirname(dshPatchPath(env)), { recursive: true });
  await fs.writeFile(dshPatchPath(env), text);
}

test("it writes the profile's patch layer, not the inert settings.yaml", async () => {
  const { env } = await temp();
  await writePatch(env);
  const result = await connectDsh({ env, gateway: "http://127.0.0.1:3427", providerModels: async () => MODELS });
  assert.equal(result.connected, true);
  assert.match(dshPatchPath(env), /profiles[\\/]desktop[\\/]cordis\.patch\.yml$/);
  // Nothing is written to the file the harness does not read.
  await assert.rejects(() => fs.access(path.join(env.DSH_HOME, "settings.yaml")), /ENOENT/);
});

test("each model declares the efforts it takes", async () => {
  // The failure this module was written after: a model entry with no
  // reasoning.efforts declares nothing, so the harness refuses every effort
  // before the request is sent.
  const { env } = await temp();
  await writePatch(env);
  await connectDsh({ env, gateway: "http://127.0.0.1:3427", providerModels: async () => MODELS });
  const text = await fs.readFile(dshPatchPath(env), "utf8");
  assert.match(text, /- id: deepseek-v4\.1-flash\n\s+name: DeepSeek-V4\.1-Flash\n\s+reasoning:\n\s+efforts:/);
  assert.match(text, /- id: low\n\s+name: Low/);
  assert.match(text, /defaultEffort: max/);
});

test("the default model's effort is one the model accepts", async () => {
  const { env } = await temp();
  await writePatch(env);
  const result = await connectDsh({ env, gateway: "http://127.0.0.1:3427", providerModels: async () => MODELS });
  assert.equal(result.defaultModel.id, "deepseek-v4.1-flash");
  assert.equal(result.defaultModel.effort, "high", "the requested effort is supported, so it is kept");
  const text = await fs.readFile(dshPatchPath(env), "utf8");
  const at = text.indexOf("- id: agent-default-model");
  assert.match(text.slice(at, at + 240), /reasoningEffort: high/);
});

test("a supported effort is kept exactly as the file asked", async () => {
  // The user asked for "high" and the model declares it: rewriting it to the
  // model's last level would change a choice they made on purpose.
  const { env } = await temp();
  await writePatch(env, USER_PATCH.replace("model: deepseek-v4.1-flash", "model: glm-5.2"));
  const result = await connectDsh({
    env,
    gateway: "http://127.0.0.1:3427",
    providerModels: async () => [{ id: "glm-5.2", name: "GLM-5.2", efforts: ["high", "xhigh"] }]
  });
  assert.equal(result.defaultModel.effort, "high");
});

test("a default effort the model cannot take is replaced, not preserved", async () => {
  // The reported failure, in miniature: the file asks for "high" and the
  // model declares only low/max, so the harness refuses before sending.
  const { env } = await temp();
  await writePatch(env, USER_PATCH.replace("model: deepseek-v4.1-flash", "model: hy3-x"));
  const result = await connectDsh({
    env,
    gateway: "http://127.0.0.1:3427",
    providerModels: async () => [{ id: "hy3-x", name: "Hy3 (X)", efforts: ["low", "max"] }]
  });
  assert.equal(result.defaultModel.effort, "max", "falls back to a level the model declares");
  const text = await fs.readFile(dshPatchPath(env), "utf8");
  assert.match(text, /reasoningEffort: max/);
});

test("the user's other entries, comments and order survive", async () => {
  const { env } = await temp();
  await writePatch(env);
  await connectDsh({ env, gateway: "http://127.0.0.1:3427", providerModels: async () => MODELS });
  const text = await fs.readFile(dshPatchPath(env), "utf8");
  assert.match(text, /^# Your patch layer for this dsh profile\.$/m);
  assert.match(text, /fontSize: 16/);
  assert.match(text, /defaultPreset: workspace-write/);
  const order = ["ui-theme", "agent-default-model", "permission", "llm-pi-ai"].map((id) => text.indexOf(`- id: ${id}`));
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  assert.equal((text.match(/- id: llm-pi-ai/g) || []).length, 1);
});

test("reconnecting refreshes in place", async () => {
  const { env } = await temp();
  await writePatch(env);
  await connectDsh({ env, gateway: "http://127.0.0.1:3427", providerModels: async () => MODELS });
  await connectDsh({
    env,
    gateway: "http://127.0.0.1:3427",
    providerModels: async () => [{ id: "hy3", name: "Hy3", efforts: ["low", "high"] }]
  });
  const text = await fs.readFile(dshPatchPath(env), "utf8");
  assert.equal((text.match(/^ {6}lane:$/gm) || []).length, 1);
  assert.doesNotMatch(text, /- id: auto/);
  assert.match(text, /- id: hy3/);
});

test("a patch layer without llm-pi-ai gains the entry", async () => {
  const { env } = await temp();
  await writePatch(env, "- id: ui-theme\n  config:\n    preference: dark\n");
  await connectDsh({ env, gateway: "http://127.0.0.1:3427", providerModels: async () => MODELS });
  const text = await fs.readFile(dshPatchPath(env), "utf8");
  assert.match(text, /- id: ui-theme/);
  assert.match(text, /- id: llm-pi-ai/);
  assert.match(text, /lane:/);
});

test("disconnect removes only Lane's provider", async () => {
  const { env } = await temp();
  await writePatch(env);
  await connectDsh({ env, gateway: "http://127.0.0.1:3427", providerModels: async () => MODELS });
  const off = await disconnectDsh({ env });
  assert.equal(off.changed, true);
  const text = await fs.readFile(dshPatchPath(env), "utf8");
  assert.doesNotMatch(text, /^ {6}lane:$/m);
  assert.match(text, /- id: ui-theme/);
  assert.match(text, /- id: permission/);
});

test("status reads the patch layer", async () => {
  const { env } = await temp();
  await writePatch(env);
  assert.equal((await dshStatus({ env })).connected, true, "the user's own lane entry counts as connected");
  await disconnectDsh({ env });
  assert.equal((await dshStatus({ env })).connected, false);
});

test("a model name with YAML punctuation is quoted", async () => {
  const { env } = await temp();
  await writePatch(env);
  await connectDsh({ env, gateway: "http://127.0.0.1:3427", providerModels: async () => [{ id: "x", name: "A: B # C" }] });
  const text = await fs.readFile(dshPatchPath(env), "utf8");
  assert.match(text, /name: "A: B # C"/);
});
