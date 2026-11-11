import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ProviderRouter } from "../src/provider-router.js";

/**
 * Several accounts of different providers serve models at once.
 *
 * Two providers publish overlapping ids (GLM-5.3, MiniMax, Kimi are on both),
 * so a bare id would be ambiguous. WorkBuddy keeps the plain id — it is what
 * every existing models.json names — and every other provider is namespaced.
 * A second account serving an id the first already has gets a `#suffix` so it
 * stays selectable instead of vanishing from the page.
 */

async function tempEnv(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "lane-multi-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { LANE_DATA_DIR: root };
}

function fakeProvider(name, accounts, modelsByAccount) {
  return {
    init: async () => {},
    activeId: async () => accounts[0]?.id || "",
    accounts: async () => accounts,
    listModels: async (id) => modelsByAccount[id || accounts[0]?.id] || [],
    chat: async () => new Response(name),
    usage: async () => ({ plan: "Free plan" }),
    activate: async (id) => ({ id }),
    setEnabled: async (id, enabled) => ({ id, enabled }),
    setRoutable: async (id, routable) => ({ id, routable }),
    forget: async (id) => ({ removed: id })
  };
}

function router(env, { workbuddy, trae }) {
  return new ProviderRouter({ env, workbuddy, trae });
}

test("the model pool is off until an account is explicitly switched in", async (t) => {
  const env = await tempEnv(t);
  // No `routable` field at all: an account that was signed in before this
  // existed. Adding an account is a sign-in, not a decision to serve models,
  // so it must start out of the pool.
  const workbuddy = fakeProvider("wb", [{ id: "wb-1", label: "Fresh", provider: "workbuddy", enabled: true }], {
    "wb-1": [{ id: "hy3" }]
  });
  const r = router(env, { workbuddy, trae: fakeProvider("trae", [], {}) });
  assert.deepEqual(await r.catalogue(), [], "a fresh account contributes nothing yet");
  assert.equal((await r.resolveModel("hy3")).known, false);
});

test("an account switched into the pool starts serving its models", async (t) => {
  const env = await tempEnv(t);
  let routable = false;
  const accounts = [{ id: "wb-1", label: "Fresh", provider: "workbuddy", enabled: true }];
  const workbuddy = fakeProvider("wb", accounts, { "wb-1": [{ id: "hy3" }] });
  // Mirror the real store: the public shape derives `routable` from the field.
  workbuddy.accounts = async () => accounts.map((a) => ({ ...a, routable }));
  const r = router(env, { workbuddy, trae: fakeProvider("trae", [], {}) });
  assert.deepEqual(await r.catalogue(), []);
  routable = true;
  assert.deepEqual((await r.catalogue()).map((m) => m.id), ["hy3"]);
});

test("every routable account contributes its models", async (t) => {
  const env = await tempEnv(t);
  const workbuddy = fakeProvider("wb", [{ id: "wb-1", label: "WB", provider: "workbuddy", enabled: true, routable: true }], {
    "wb-1": [{ id: "hy3", name: "Hy3" }]
  });
  const trae = fakeProvider("trae", [{ id: "tr-1", label: "Trae", provider: "trae", enabled: true, routable: true }], {
    "tr-1": [{ id: "gpt-5.4", name: "GPT-5.4" }]
  });
  const r = router(env, { workbuddy, trae });
  const catalogue = await r.catalogue();
  assert.equal(catalogue.length, 2);
  assert.deepEqual(catalogue.map((m) => m.id).sort(), ["hy3", "trae:gpt-5.4"]);
});

test("an account with routable off keeps its sign-in but leaves the pool", async (t) => {
  const env = await tempEnv(t);
  const workbuddy = fakeProvider("wb", [
    { id: "wb-1", label: "On", provider: "workbuddy", enabled: true, routable: true },
    { id: "wb-2", label: "Off", provider: "workbuddy", enabled: true, routable: false }
  ], {
    "wb-1": [{ id: "hy3" }],
    "wb-2": [{ id: "glm-5.3" }]
  });
  const r = router(env, { workbuddy, trae: fakeProvider("trae", [], {}) });
  const catalogue = await r.catalogue();
  assert.deepEqual(catalogue.map((m) => m.id), ["hy3"], "only the routable account contributes");
});

test("a switched-off account is never routable", async (t) => {
  const env = await tempEnv(t);
  const workbuddy = fakeProvider("wb", [
    { id: "wb-1", label: "On", provider: "workbuddy", enabled: true, routable: true },
    { id: "wb-2", label: "Disabled", provider: "workbuddy", enabled: false }
  ], {
    "wb-1": [{ id: "hy3" }],
    "wb-2": [{ id: "glm-5.3" }]
  });
  const r = router(env, { workbuddy, trae: fakeProvider("trae", [], {}) });
  assert.deepEqual((await r.catalogue()).map((m) => m.id), ["hy3"]);
});

test("an id two providers share is namespaced, and both stay selectable", async (t) => {
  const env = await tempEnv(t);
  const workbuddy = fakeProvider("wb", [{ id: "wb-1", label: "WB", provider: "workbuddy", enabled: true, routable: true }], {
    "wb-1": [{ id: "glm-5.3", name: "GLM-5.3" }]
  });
  const trae = fakeProvider("trae", [{ id: "tr-1", label: "Trae", provider: "trae", enabled: true, routable: true }], {
    "tr-1": [{ id: "glm-5.3", name: "GLM-5.3" }]
  });
  const r = router(env, { workbuddy, trae });
  const catalogue = await r.catalogue();
  assert.deepEqual(catalogue.map((m) => m.id), ["glm-5.3", "trae:glm-5.3"]);

  const plain = await r.resolveModel("glm-5.3");
  assert.equal(plain.accountId, "wb-1");
  const namespaced = await r.resolveModel("trae:glm-5.3");
  assert.equal(namespaced.accountId, "tr-1");
  assert.equal(namespaced.id, "glm-5.3", "the upstream gets its own id back");
});

test("a second account serving one id is folded into the first row", async (t) => {
  const env = await tempEnv(t);
  const workbuddy = fakeProvider("wb", [
    { id: "wb-1", label: "First", provider: "workbuddy", enabled: true, routable: true },
    { id: "wb-2", label: "Second", provider: "workbuddy", enabled: true, routable: true }
  ], {
    "wb-1": [{ id: "hy3", name: "Hy3" }],
    "wb-2": [{ id: "hy3", name: "Hy3" }]
  });
  const r = router(env, { workbuddy, trae: fakeProvider("trae", [], {}) });
  const catalogue = await r.catalogue();
  // One row, not two: four accounts all publishing `hy3` would otherwise fill
  // the page with identical lines. The accounts are interchangeable for that
  // model, so a count on one row is the truth.
  assert.equal(catalogue.length, 1, "the second account folds into the first");
  const row = catalogue[0];
  assert.equal(row.id, "hy3");
  assert.equal(row.ownerAccountId, "wb-1");
  assert.equal(row.sharedWith.length, 1);
  assert.equal(row.sharedWith[0].ownerAccountId, "wb-2");
  assert.equal(row.sharedWith[0].id, "hy3#wb-2", "the folded id is the plain id plus an account suffix");

  // The folded account is still selectable by its suffixed id.
  const folded = await r.resolveModel(row.sharedWith[0].id);
  assert.equal(folded.accountId, "wb-2");
  assert.equal(folded.id, "hy3", "the upstream gets its own id back");
});

test("an unknown model resolves to nothing rather than to an arbitrary account", async (t) => {
  const env = await tempEnv(t);
  const workbuddy = fakeProvider("wb", [{ id: "wb-1", label: "WB", provider: "workbuddy", enabled: true, routable: true }], {
    "wb-1": [{ id: "hy3" }]
  });
  const r = router(env, { workbuddy, trae: fakeProvider("trae", [], {}) });
  assert.equal((await r.resolveModel("nope")).known, false);
  assert.equal((await r.resolveModel("")).known, false);
});

test("the allowlist still gates what agents see", async (t) => {
  const env = await tempEnv(t);
  const workbuddy = fakeProvider("wb", [{ id: "wb-1", label: "WB", provider: "workbuddy", enabled: true, routable: true }], {
    "wb-1": [{ id: "hy3" }]
  });
  const trae = fakeProvider("trae", [{ id: "tr-1", label: "Trae", provider: "trae", enabled: true, routable: true }], {
    "tr-1": [{ id: "gpt-5.4" }]
  });
  const r = router(env, { workbuddy, trae });
  assert.deepEqual(await r.listModels(), [], "nothing is served until added");
  const { setModelEnabled } = await import("../src/model-gate.js");
  await setModelEnabled("trae:gpt-5.4", true, env, "trae");
  assert.deepEqual((await r.listModels()).map((m) => m.id), ["trae:gpt-5.4"]);
});

test("a failure is never retried on another account", async (t) => {
  const env = await tempEnv(t);
  let calls = 0;
  const workbuddy = fakeProvider("wb", [
    { id: "wb-1", label: "First", provider: "workbuddy", enabled: true, routable: true },
    { id: "wb-2", label: "Second", provider: "workbuddy", enabled: true, routable: true }
  ], {
    "wb-1": [{ id: "hy3" }],
    "wb-2": [{ id: "hy3" }]
  });
  workbuddy.chat = async () => {
    calls += 1;
    return new Response("refused", { status: 500 });
  };
  const r = router(env, { workbuddy, trae: fakeProvider("trae", [], {}) });
  const { resolved, response } = await r.chatOn({ model: "hy3" });
  assert.equal(resolved.accountId, "wb-1");
  assert.equal(response.status, 500);
  assert.equal(calls, 1, "one attempt: the charge stays with the account the user chose");
});

test("the router's chatOn sends the bare id to the resolved provider", async (t) => {
  const env = await tempEnv(t);
  let seen = null;
  const workbuddy = fakeProvider("wb", [], {});
  const trae = fakeProvider("trae", [{ id: "tr-1", label: "Trae", provider: "trae", enabled: true, routable: true }], {
    "tr-1": [{ id: "gpt-5.4" }]
  });
  trae.chat = async (body) => {
    seen = body;
    return new Response("ok");
  };
  const r = router(env, { workbuddy, trae });
  const { resolved } = await r.chatOn({ model: "trae:gpt-5.4", messages: [] });
  assert.equal(resolved.provider, "trae");
  assert.equal(seen.model, "gpt-5.4", "the prefix is Lane's, not the upstream's");
});

test("a provider id that already carries a prefix is not prefixed twice", async () => {
  // A saved allowlist entry can read back through a provider that kept the
  // prefix; `trae:trae:glm-5.3` would then be a model nobody can select.
  const { ProviderRouter } = await import("../src/provider-router.js");
  assert.equal(ProviderRouter.qualifiedId("trae", "glm-5.3"), "trae:glm-5.3");
  assert.equal(ProviderRouter.qualifiedId("trae", "trae:glm-5.3"), "trae:glm-5.3");
  assert.equal(ProviderRouter.qualifiedId("workbuddy", "hy3"), "hy3");
  assert.equal(ProviderRouter.qualifiedId("workbuddy", "workbuddy:hy3"), "hy3");
  // A prefix naming another provider is replaced, not stacked.
  assert.equal(ProviderRouter.qualifiedId("trae", "workbuddy:hy3"), "trae:hy3");
});

test("the account row has one switch: the model pool", async () => {
  const app = await fs.readFile(path.join(import.meta.dirname, "..", "desktop/app.js"), "utf8");
  assert.match(app, /data-act="routable"/, "a switch for the model pool");
  // The 启用 switch is gone: an account is in the list because it was signed
  // in, and the 切换 button went with the single-route design.
  assert.doesNotMatch(app, /data-act="enabled"/, "no sign-in switch in the row");
  assert.doesNotMatch(app, /data-act="activate"/, "the 切换 button is gone");
});

test("one account per upstream serves models", async (t) => {
  const env = await tempEnv(t);
  const { setAccountRoutable, loadAccounts } = await import("../src/accounts.js");
  const { writeAccounts } = await import("../src/accounts.js");

  // Two WorkBuddy accounts (one domestic, one international — one provider)
  // and one Trae account. Switching the second WorkBuddy one on must switch
  // the first off, and leave Trae alone.
  await writeAccounts({
    version: 1,
    activeId: "wb-1",
    accounts: [
      { id: "wb-1", label: "wb-1", site: "workbuddy", enabled: true, auth: { token: "x" } },
      { id: "wb-2", label: "wb-2", site: "workbuddy-ai", enabled: true, auth: { token: "x" } },
      { id: "tr-1", label: "tr-1", site: "trae-cn", enabled: true, auth: { token: "x" } }
    ]
  }, env);

  await setAccountRoutable("wb-1", true, env);
  await setAccountRoutable("tr-1", true, env);
  await setAccountRoutable("wb-2", true, env);

  const state = await loadAccounts(env);
  const byId = new Map(state.accounts.map((a) => [a.id, a]));
  assert.equal(byId.get("wb-1").routable, false, "the other WorkBuddy account is switched off");
  assert.equal(byId.get("wb-2").routable, true);
  assert.equal(byId.get("tr-1").routable, true, "a different upstream is untouched");
});
