import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WorkBuddyProvider } from "../src/workbuddy.js";
import { upsertAccount, loadAccounts, publicAccount, normalizeSite } from "../src/accounts.js";

async function tempEnv() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lane-sites-"));
  return { LANE_DATA_DIR: dir };
}

test("a site is either the domestic build or the international one", () => {
  assert.equal(normalizeSite("workbuddy"), "workbuddy");
  assert.equal(normalizeSite("workbuddy-ai"), "workbuddy-ai");
  assert.equal(normalizeSite(""), "workbuddy");
  assert.equal(normalizeSite(undefined), "workbuddy");
  assert.equal(normalizeSite("something-else"), "workbuddy");
});

test("an account remembers which build it signed in to", async () => {
  const env = await tempEnv();
  await upsertAccount(
    { type: "oauth", access: "a", uid: "u1", accountId: "intl" },
    env,
    { site: "workbuddy-ai" }
  );
  await upsertAccount(
    { type: "oauth", access: "b", uid: "u2", accountId: "cn" },
    env,
    { site: "workbuddy" }
  );

  const state = await loadAccounts(env);
  const sites = Object.fromEntries(state.accounts.map((account) => [account.accountId, publicAccount(account).site]));
  assert.deepEqual(sites, { intl: "workbuddy-ai", cn: "workbuddy" });
});

test("accounts written before sites existed are domestic", async () => {
  const env = await tempEnv();
  await fs.writeFile(
    path.join(env.LANE_DATA_DIR, "accounts.json"),
    JSON.stringify({
      version: 1,
      activeId: "u1",
      accounts: [{ id: "u1", label: "old", enabled: true, auth: { type: "oauth", access: "x" } }]
    })
  );

  const state = await loadAccounts(env);
  assert.equal(publicAccount(state.accounts[0]).site, "workbuddy");
});

test("reconnecting without a site keeps the account's own", async () => {
  const env = await tempEnv();
  await upsertAccount({ type: "oauth", access: "a", uid: "u1" }, env, { site: "workbuddy-ai" });
  await upsertAccount({ type: "oauth", access: "b", uid: "u1" }, env);

  const state = await loadAccounts(env);
  assert.equal(state.accounts.length, 1);
  assert.equal(publicAccount(state.accounts[0]).site, "workbuddy-ai");
});

test("each build gets its own plugin, cached per site", async () => {
  const provider = new WorkBuddyProvider();
  const domestic = await provider.factoryFor("workbuddy");
  const international = await provider.factoryFor("workbuddy-ai");

  assert.equal(typeof domestic, "function");
  assert.equal(typeof international, "function");
  assert.notEqual(domestic, international, "the two builds are different plugins");
  assert.equal(await provider.factoryFor("workbuddy"), domestic, "a site resolves to the same plugin");
});

test("a session is built from the plugin of that account's site", async () => {
  const seen = [];
  const factory = (site) => async () => {
    seen.push(site);
    return { auth: { methods: [] } };
  };
  const provider = new WorkBuddyProvider({
    factory: factory("injected"),
    hooks: { auth: { methods: [] } }
  });
  provider.ready = true;
  provider.state = {
    version: 1,
    activeId: "u1",
    accounts: [
      { id: "u1", label: "cn", enabled: true, site: "workbuddy", auth: { type: "oauth", access: "a" } },
      { id: "u2", label: "intl", enabled: true, site: "workbuddy-ai", auth: { type: "oauth", access: "b" } }
    ]
  };

  await provider.session("u2");
  assert.deepEqual(seen, ["injected"], "an injected factory stands in for every site");
  assert.equal(await provider.siteOf("u2"), "workbuddy-ai");
  assert.equal(await provider.siteOf("u1"), "workbuddy");
});

test("sign-in reports the site it opened", async () => {
  const hooks = {
    auth: {
      methods: [
        {
          label: "browser",
          authorize: async () => ({ url: "https://example.test/login" })
        }
      ]
    }
  };
  const provider = new WorkBuddyProvider({ hooks });
  provider.ready = true;

  const result = await provider.authorize("workbuddy-ai");
  assert.equal(result.site, "workbuddy-ai");
  assert.equal(result.url, "https://example.test/login");

  const domestic = await provider.authorize();
  assert.equal(domestic.site, "workbuddy");
});

test("init leaves the plugin choice to the site being asked for", async () => {
  const env = await tempEnv();
  const provider = new WorkBuddyProvider({ env });
  await provider.init();

  const domestic = await provider.factoryFor("workbuddy");
  const international = await provider.factoryFor("workbuddy-ai");
  assert.notEqual(domestic, international, "an international sign-in must not reuse the domestic plugin");
});

test("the sign-in URL follows the site, not the first plugin loaded", async () => {
  const seen = [];
  const hooksFor = (label) => ({
    auth: {
      methods: [
        {
          label: "browser",
          authorize: async () => {
            seen.push(label);
            return { url: `https://${label}.test/login` };
          }
        }
      ]
    }
  });

  // A factory that answers per site, the way the real one does.
  const provider = new WorkBuddyProvider({
    factory: async () => hooksFor("domestic"),
    hooks: null
  });
  provider.ready = true;
  provider.factories.set("workbuddy", async () => hooksFor("domestic"));
  provider.factories.set("workbuddy-ai", async () => hooksFor("overseas"));

  // The injected factory is the test seam; drop it so the per-site ones answer.
  provider.factory = null;

  const overseas = await provider.authorize("workbuddy-ai");
  assert.equal(overseas.url, "https://overseas.test/login");
  assert.equal(overseas.site, "workbuddy-ai");
  assert.deepEqual(seen, ["overseas"]);
});

test("one build's pending sign-in does not answer the other build's request", async () => {
  // The control center keeps one pending sign-in per site. A single shared
  // slot handed an overseas request the domestic URL, so no overseas account
  // was ever written. This mirrors that guard without starting a gateway.
  const pending = new Map();
  const calls = [];
  const signIn = async (site) => {
    if (pending.has(site)) return { pending: true, url: pending.get(site).url, site };
    const result = { url: `https://${site}.test/login`, site };
    pending.set(site, result);
    calls.push(site);
    return { pending: true, url: result.url, site };
  };

  const domestic = await signIn("workbuddy");
  const overseas = await signIn("workbuddy-ai");

  assert.equal(domestic.url, "https://workbuddy.test/login");
  assert.equal(overseas.url, "https://workbuddy-ai.test/login", "the overseas request gets its own page");
  assert.deepEqual(calls, ["workbuddy", "workbuddy-ai"], "both builds start their own sign-in");

  // Asking again for a build already pending reuses that build's own page.
  const again = await signIn("workbuddy-ai");
  assert.equal(again.url, "https://workbuddy-ai.test/login");
  assert.deepEqual(calls, ["workbuddy", "workbuddy-ai"]);
});
