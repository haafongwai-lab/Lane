import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { TraeProvider } from "../src/trae.js";
import { ProviderRouter } from "../src/provider-router.js";
import { setModelEnabled } from "../src/model-gate.js";

async function tempEnv(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "lane-trae-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { LANE_DATA_DIR: root };
}

function hooksFor({ site = "trae-cn" } = {}) {
  return {
    config(config) {
      config.provider[site] = {
        name: "Trae",
        npm: "@ai-sdk/openai-compatible",
        api: "https://trae.test/v1",
        models: { "trae-model": { name: "Trae Model", limit: { context: 128000 } } }
      };
    },
    provider: {
      models: async () => ({ "trae-model": { name: "Trae Model", limit: { context: 128000, output: 64000 } } })
    },
    auth: {
      loader: async () => ({
        baseURL: "https://trae.test/v1",
        fetch: async () => new Response("data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } })
      }),
      usage: async () => ({ plan: "Free", windows: [] })
    }
  };
}

test("Trae sign-in stores an account in its own provider store and lists models", async (t) => {
  const env = await tempEnv(t);
  const provider = new TraeProvider({ env, factory: async () => hooksFor() });
  await provider.init();
  const outcome = {
    type: "success",
    access: "access",
    refresh: "refresh",
    expires: Date.now() + 3600_000,
    uid: "trae-u1",
    accountId: "Trae Tester",
    clientId: "client",
    deviceId: "123",
    machineId: "456"
  };
  await provider.finishSignIn(null, "trae-cn", outcome);
  assert.equal(await provider.activeId(), "trae-u1");
  const accounts = await provider.accounts();
  assert.equal(accounts.length, 1);
  assert.equal(accounts[0].site, "trae-cn");
  const models = await provider.listModels();
  assert.equal(models[0].id, "trae-model");
  assert.equal(models[0].owned_by, "trae");
  assert.equal(models[0].output, 64000);
});

test("Trae chat uses the plugin loader and restores the response", async (t) => {
  const env = await tempEnv(t);
  let seen = null;
  const hooks = hooksFor();
  hooks.auth.loader = async () => ({
    baseURL: "https://trae.test/v1",
    fetch: async (url, init) => {
      seen = { url, body: JSON.parse(init.body) };
      return new Response("data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
    }
  });
  const provider = new TraeProvider({ env, factory: async () => hooks });
  await provider.init();
  await provider.finishSignIn(null, "trae-cn", {
    type: "success", access: "a", refresh: "r", expires: Date.now() + 3600_000,
    uid: "trae-u2", accountId: "Tester"
  });
  const response = await provider.chat({ model: "trae-model", messages: [{ role: "user", content: "hi" }], stream: true });
  assert.equal(response.headers.get("content-type"), "text/event-stream");
  assert.equal(seen.url, "https://trae.test/v1/chat/completions");
  assert.equal(seen.body.model, "trae-model");
});

test("the provider router merges stores and remembers a Trae route", async (t) => {
  const env = await tempEnv(t);
  const calls = [];
  const workbuddy = {
    init: async () => {},
    activeId: async () => "wb-1",
    accounts: async () => [{ id: "wb-1", label: "WorkBuddy", site: "workbuddy", enabled: true }],
    listModels: async () => [{ id: "wb-model" }],
    activate: async (id) => ({ id, label: "WorkBuddy" }),
    setEnabled: async (id, enabled) => ({ id, enabled }),
    forget: async (id) => ({ removed: id }),
    usage: async () => ({ plan: "Free plan" }),
    chat: async () => new Response("wb")
  };
  const trae = {
    init: async () => {},
    activeId: async () => "trae-1",
    accounts: async () => [{ id: "trae-1", label: "Trae", site: "trae-cn", enabled: true }],
    listModels: async () => [{ id: "trae-model" }],
    activate: async (id) => { calls.push(["activate", id]); return { id, label: "Trae" }; },
    setEnabled: async (id, enabled) => ({ id, enabled }),
    forget: async (id) => ({ removed: id }),
    usage: async () => ({ plan: "Credits", signIn: "expired", error: "sign-in expired" }),
    accountUsage: async () => ({ plan: "Credits", signIn: "kept" }),
    chat: async () => new Response("trae")
  };
  const router = new ProviderRouter({ env, workbuddy, trae });
  await router.init();
  assert.deepEqual((await router.accounts()).map((item) => item.provider), ["workbuddy", "trae"]);
  assert.equal(await router.activeId(), "wb-1");
  await router.activate("trae-1");
  assert.deepEqual(calls, [["activate", "trae-1"]]);
  assert.equal(await router.activeId(), "trae-1");
  // The full catalogue is what the model page draws; nothing is served to
  // agents until the model is added.
  assert.equal((await router.catalogue())[0].id, "trae-model");
  assert.deepEqual(await router.listModels(), []);
  // The router must forward Trae's chip-safe usage, not its raw expired flag:
  // the control center checks exactly this method.
  assert.equal((await router.accountUsage("trae-1")).signIn, "kept");
  await setModelEnabled("trae-model", true, env);
  assert.equal((await router.listModels())[0].id, "trae-model");
  const routed = await router.chat({});
  assert.equal(await routed.text(), "trae");
});
