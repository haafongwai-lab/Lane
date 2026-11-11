import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ProviderRouter, SITE_PROVIDER, providerOfSiteName } from "../src/provider-router.js";
import { providerOfSite, SITES } from "../src/accounts.js";
import { runCheckins, readCheckin } from "../src/checkin.js";

/**
 * Qoder is the third upstream, and only its two Qoder sites are wired:
 * qoder.com (international) and qoder.cn (CN). These pin the shape the rest
 * of Lane depends on: the site map, the model-id prefix, and that the daily
 * check-in reaches the plugin's own `auth.checkin` hook instead of Lane's
 * WorkBuddy HTTP path.
 */

async function tempEnv(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lane-qoder-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return { LANE_DATA_DIR: dir };
}

function fakeProvider(name, accounts, models) {
  return {
    init: async () => {},
    activeId: async () => accounts[0]?.id || "",
    accounts: async () => accounts,
    listModels: async (id) => models[id || accounts[0]?.id] || [],
    chat: async () => new Response("ok"),
    usage: async () => ({ plan: "Free" }),
    activate: async (id) => ({ id }),
    setEnabled: async (id, enabled) => ({ id, enabled }),
    setRoutable: async (id, routable) => ({ id, routable }),
    forget: async (id) => ({ removed: id })
  };
}

test("the router knows three providers and maps both Qoder sites to one", () => {
  assert.deepEqual(Object.keys(SITE_PROVIDER).sort(), [
    "qoder", "qoder-cn", "trae-cn", "trae-global", "workbuddy", "workbuddy-ai"
  ]);
  assert.equal(providerOfSiteName("qoder"), "qoder");
  assert.equal(providerOfSiteName("qoder-cn"), "qoder");
  assert.equal(providerOfSiteName("nonsense"), "workbuddy");
  // The account store and the "one account per upstream" rule must agree.
  assert.equal(providerOfSite("qoder"), "qoder");
  assert.equal(providerOfSite("qoder-cn"), "qoder");
  assert.ok(SITES.includes("qoder"));
  assert.ok(SITES.includes("qoder-cn"));
});

test("Qoder models are namespaced once, and a bare id resolves", async (t) => {
  const env = await tempEnv(t);
  const workbuddy = fakeProvider("wb", [], {});
  const trae = fakeProvider("trae", [], {});
  const qoder = fakeProvider("qoder", [
    { id: "q-1", label: "Qoder", provider: "qoder", site: "qoder", enabled: true, routable: true }
  ], {
    "q-1": [{ id: "ultimate", name: "Ultimate" }, { id: "fast", name: "Fast" }]
  });
  const r = new ProviderRouter({ env, workbuddy, trae, qoder });
  const catalogue = await r.catalogue();
  assert.deepEqual(catalogue.map((m) => m.id), ["qoder:ultimate", "qoder:fast"]);
  assert.equal(catalogue.some((m) => /qoder:qoder:/.test(m.id)), false, "the prefix is not stacked");

  const prefixed = await r.resolveModel("qoder:ultimate");
  assert.equal(prefixed.known, true);
  assert.equal(prefixed.provider, "qoder");
  assert.equal(prefixed.accountId, "q-1");
  assert.equal(prefixed.id, "ultimate", "the upstream gets its own id");

  const bare = await r.resolveModel("ultimate");
  assert.equal(bare.known, true, "a client that still says the bare id is not refused");
  assert.equal(bare.accountId, "q-1");
});

test("a Qoder account never reaches the WorkBuddy free-allowance path", async () => {
  // The allowance is a WorkBuddy Free-plan figure. The filter that decides
  // which accounts to ask used to be "anything that is not Trae"; a Qoder
  // account in that list would be asked for a window it does not publish.
  const source = await fs.readFile(new URL("../src/control-center.js", import.meta.url), "utf8");
  assert.match(source, /list\.filter\(\(item\) => item\.provider === "workbuddy"\)/);
  assert.doesNotMatch(source, /item\.provider !== "trae"/);
});

test("the daily check-in claims through the plugin's hook, credit included", async (t) => {
  const env = await tempEnv(t);
  const calls = [];
  const account = { id: "q-1", label: "Qoder", enabled: true };
  const provider = {
    accounts: async () => [account],
    session: async (id) => (id === "q-1"
      ? {
        id,
        auth: { type: "oauth", access: "a", uid: "q-1", domain: "qoder.com" },
        hooks: {
          auth: {
            // The shape the Qoder plugin returns: outcome words Lane already
            // maps, with the day's credit.
            checkin: async () => {
              calls.push("hook");
              return { outcome: "claimed", credit: 50 };
            }
          }
        }
      }
      : null),
    refreshIfNeeded: async () => ({}),
    siteOf: async () => "qoder"
  };
  const run = await runCheckins({
    provider,
    env,
    now: new Date("2026-11-12T10:00:00"),
    force: true,
    // A WorkBuddy HTTP fallback would call this; the hook must win first.
    fetchImpl: async () => {
      calls.push("http");
      throw new Error("the WorkBuddy check-in path must not run for Qoder");
    }
  });
  assert.deepEqual(calls, ["hook"], "the plugin's hook is used, not Lane's HTTP path");
  assert.equal(run.results[0].status, "done");
  assert.equal(run.results[0].reward, "50");
  const state = await readCheckin(env);
  assert.equal(state.accounts["q-1"].status, "done");
  assert.equal(state.accounts["q-1"].reward, "50");
});

test("a Qoder check-in reports the vendor's credit, not a fixed number", async (t) => {
  const env = await tempEnv(t);
  const account = { id: "q-3", label: "Qoder", enabled: true };
  const provider = {
    accounts: async () => [account],
    session: async (id) => ({
      id,
      auth: { type: "oauth", access: "a", uid: "q-3", domain: "qoder.com" },
      hooks: {
        auth: {
          // The shape the vendored plugin returns for a fresh claim: the
          // campaign's benefit.amount read as credit. Qoder pays 100 today;
          // the number must come from the answer, not from Lane.
          checkin: async () => ({ outcome: "claimed", credit: 100 })
        }
      }
    }),
    refreshIfNeeded: async () => ({}),
    siteOf: async () => "qoder"
  };
  const run = await runCheckins({
    provider,
    env,
    now: new Date("2026-11-12T10:00:00"),
    force: true,
    fetchImpl: async () => { throw new Error("the WorkBuddy HTTP path must not run"); }
  });
  assert.equal(run.results[0].status, "done");
  assert.equal(run.results[0].reward, "100");
  const state = await readCheckin(env);
  assert.equal(state.accounts["q-3"].reward, "100");
});

test("the account row prints the credit the vendor reported", async () => {
  const app = await fs.readFile(new URL("../desktop/app.js", import.meta.url), "utf8");
  assert.match(app, /已签到 \+\$\{esc\(item\.reward\)\}/);
});

test("a Qoder account with no check-in activity is recorded as unavailable, not failed", async (t) => {
  const env = await tempEnv(t);
  const account = { id: "q-2", label: "Qoder CN", enabled: true };
  const provider = {
    accounts: async () => [account],
    session: async (id) => ({
      id,
      auth: { type: "oauth", access: "a", uid: "q-2" },
      hooks: { auth: { checkin: async () => ({ outcome: "inactive", message: "no campaigns page" }) } }
    }),
    refreshIfNeeded: async () => ({}),
    siteOf: async () => "qoder-cn"
  };
  const run = await runCheckins({
    provider, env, now: new Date("2026-11-12T10:00:00"), force: true,
    fetchImpl: async () => { throw new Error("must not run"); }
  });
  assert.equal(run.results[0].status, "unavailable");
  assert.doesNotMatch(run.results[0].error || "", /must not run/);
});
