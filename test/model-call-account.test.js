import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ProviderRouter } from "../src/provider-router.js";

/**
 * A model the catalogue lists must be callable through the account that
 * serves it.
 *
 * The pool made models from every account visible at once, but the chat path
 * still sent on the route account: an agent could pick a model from a second
 * account and the call failed, because the request went out on an account
 * that does not serve that model. These pin the three places that have to
 * carry the resolved account through: the router, the provider, and the relay.
 */

async function tempEnv(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "lane-call-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { LANE_DATA_DIR: root };
}

function fakeProvider(name, accounts, modelsByAccount) {
  return {
    init: async () => {},
    activeId: async () => accounts.find((a) => a.routable)?.id || accounts[0]?.id || "",
    accounts: async () => accounts,
    listModels: async (id) => modelsByAccount[id || accounts[0]?.id] || [],
    usage: async () => ({ plan: "Free plan" }),
    activate: async (id) => ({ id }),
    setEnabled: async (id, enabled) => ({ id, enabled }),
    setRoutable: async (id, routable) => ({ id, routable }),
    forget: async (id) => ({ removed: id })
  };
}

test("a model served by a second account is called on that account", async (t) => {
  const env = await tempEnv(t);
  const sent = [];
  const workbuddy = fakeProvider("wb", [
    { id: "wb-route", label: "Route", provider: "workbuddy", enabled: true, routable: true },
    { id: "wb-other", label: "Other", provider: "workbuddy", enabled: true, routable: true }
  ], {
    "wb-route": [{ id: "hy3" }],
    "wb-other": [{ id: "glm-5.3" }]
  });
  workbuddy.chat = async (body, init) => {
    sent.push({ model: body.model, accountId: init?.accountId });
    return new Response("ok");
  };
  const r = new ProviderRouter({ env, workbuddy, trae: fakeProvider("trae", [], {}) });

  // The model belongs to the second account, not the route.
  const { resolved } = await r.chatOn({ model: "glm-5.3", messages: [] });
  assert.equal(resolved.accountId, "wb-other");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].accountId, "wb-other", "the call carries the owning account");
  assert.equal(sent[0].model, "glm-5.3");
});

test("a model served by the route account still goes there", async (t) => {
  const env = await tempEnv(t);
  const sent = [];
  const workbuddy = fakeProvider("wb", [
    { id: "wb-route", label: "Route", provider: "workbuddy", enabled: true, routable: true },
    { id: "wb-other", label: "Other", provider: "workbuddy", enabled: true, routable: true }
  ], {
    "wb-route": [{ id: "hy3" }],
    "wb-other": [{ id: "glm-5.3" }]
  });
  workbuddy.chat = async (body, init) => {
    sent.push({ model: body.model, accountId: init?.accountId });
    return new Response("ok");
  };
  const r = new ProviderRouter({ env, workbuddy, trae: fakeProvider("trae", [], {}) });
  const { resolved } = await r.chatOn({ model: "hy3", messages: [] });
  assert.equal(resolved.accountId, "wb-route");
  assert.equal(sent[0].accountId, "wb-route");
});

test("the relay forwards the resolved account to the provider", async () => {
  const relay = await fs.readFile(new URL("../src/relay.js", import.meta.url), "utf8");
  // Both protocol paths build an init object; each must carry accountId, or
  // the provider falls back to the route account and the call fails.
  const initBlocks = relay.match(/const init = \{ signal: abort\.signal \};[\s\S]{0,160}?accountId = options\.accountId/g) || [];
  assert.equal(initBlocks.length, 2, "both the OpenAI and the protocol paths carry the account");
  assert.match(relay, /provider\.chat\(body, init\)/, "the retry helper passes it on");
});

test("the providers honour the account they are given", async () => {
  const workbuddy = await fs.readFile(new URL("../src/workbuddy.js", import.meta.url), "utf8");
  const trae = await fs.readFile(new URL("../src/trae.js", import.meta.url), "utf8");
  for (const [name, source] of [["workbuddy.js", workbuddy], ["trae.js", trae]]) {
    assert.match(source, /async chat\(body, \{ signal, accountId = "" \}/, `${name} accepts an account`);
    assert.match(source, /accountId \? await this\.session\(accountId\) : await this\.activeSession\(\)/, `${name} uses it`);
  }
});

test("a bare id a client still carries resolves to its namespaced row", async (t) => {
  const env = await tempEnv(t);
  const workbuddy = fakeProvider("wb", [
    { id: "wb-1", label: "WB", provider: "workbuddy", enabled: true, routable: true }
  ], {
    "wb-1": [{ id: "hy3" }]
  });
  const trae = fakeProvider("trae", [
    { id: "tr-1", label: "Trae", provider: "trae", enabled: true, routable: true }
  ], {
    "tr-1": [{ id: "glm-5.3" }]
  });
  const r = new ProviderRouter({ env, workbuddy, trae });

  // Claude Desktop keeps the chosen model in the conversation and an agent's
  // config names it; both still say `glm-5.3` from before ids were namespaced.
  const namespaced = await r.resolveModel("trae:glm-5.3");
  assert.equal(namespaced.known, true);
  const bare = await r.resolveModel("glm-5.3");
  assert.equal(bare.known, true, "an old bare id must not turn into a 400");
  assert.equal(bare.accountId, "tr-1");
  assert.equal(bare.id, "glm-5.3", "the upstream still gets its own id");
});

test("a bare id the default provider owns stays on the default provider", async (t) => {
  const env = await tempEnv(t);
  const workbuddy = fakeProvider("wb", [
    { id: "wb-1", label: "WB", provider: "workbuddy", enabled: true, routable: true }
  ], {
    "wb-1": [{ id: "glm-5.3" }]
  });
  const trae = fakeProvider("trae", [
    { id: "tr-1", label: "Trae", provider: "trae", enabled: true, routable: true }
  ], {
    "tr-1": [{ id: "glm-5.3" }]
  });
  const r = new ProviderRouter({ env, workbuddy, trae });
  // Both serve it; the unprefixed row is WorkBuddy's, so the bare id is
  // unambiguous — it means that one.
  const bare = await r.resolveModel("glm-5.3");
  assert.equal(bare.accountId, "wb-1");
  const prefixed = await r.resolveModel("trae:glm-5.3");
  assert.equal(prefixed.accountId, "tr-1");
});

test("enabling a namespaced model does not stack the prefix in models.json", async (t) => {
  const env = await tempEnv(t);
  const workbuddy = fakeProvider("wb", [], {});
  const trae = fakeProvider("trae", [
    { id: "tr-1", label: "Trae", provider: "trae", enabled: true, routable: true }
  ], {
    "tr-1": [{ id: "glm-5.3" }]
  });
  const r = new ProviderRouter({ env, workbuddy, trae });
  const [row] = await r.catalogue();
  assert.equal(row.id, "trae:glm-5.3");

  // The page sends the row's id plus its provider, exactly as the checkbox
  // carries them.
  const { setModelEnabled, restrictModels } = await import("../src/model-gate.js");
  await setModelEnabled(row.id, true, env, "trae");
  const saved = JSON.parse(await fs.readFile(path.join(env.LANE_DATA_DIR, "models.json"), "utf8"));
  assert.deepEqual(saved.ids, ["trae:glm-5.3"], "the prefix is not stacked into trae:trae:…");

  const served = await restrictModels(await r.catalogue(), env);
  assert.deepEqual(served.map((m) => m.id), ["trae:glm-5.3"]);
});

test("the Anthropic and Responses routes resolve the account too", async () => {
  const server = await fs.readFile(new URL("../src/server.js", import.meta.url), "utf8");
  // Three request paths reach a provider: OpenAI chat, Anthropic messages and
  // OpenAI responses. Each must resolve which account owns the model.
  const calls = server.match(/await provider\.resolveModel\(/g) || [];
  assert.equal(calls.length, 3, "the OpenAI, Anthropic and Responses paths each resolve the model");
  assert.doesNotMatch(
    server,
    /await proxyProtocol\(res, provider, chat,/,
    "no protocol path sends on the bare route provider"
  );
});
