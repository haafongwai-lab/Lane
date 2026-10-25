import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WorkBuddyProvider } from "../src/workbuddy.js";

// A provider with one account already signed in, and hooks standing in for
// the plugin's, so nothing here touches the network.
function providerWith(hooks, auth = { type: "oauth", access: "test", uid: "u1" }) {
  const provider = new WorkBuddyProvider({ hooks });
  provider.ready = true;
  provider.state = {
    version: 1,
    activeId: "u1",
    accounts: [{ id: "u1", label: "tester", enabled: true, auth }]
  };
  provider.sessions.set("u1", { id: "u1", auth, hooks, loader: null });
  return provider;
}

function modelHooks(models) {
  return {
    config(config) {
      config.provider.workbuddy = { models: {} };
    },
    provider: { models: async () => models }
  };
}

test("model discovery keeps WorkBuddy credit rates", async () => {
  const provider = providerWith(modelHooks({
    hy3: { name: "Hy3", limit: { context: 192000 }, rate: 0.34, rateWas: 1 },
    free: { name: "Free", limit: { context: 32000 }, free: true, rate: 0 },
    unknown: { name: "Unknown" }
  }));

  assert.deepEqual(await provider.listModels(), [
    {
      id: "hy3",
      name: "Hy3",
      context: 192000,
      owned_by: "workbuddy",
      rate: 0.34,
      rateWas: 1
    },
    {
      id: "free",
      name: "Free",
      context: 32000,
      owned_by: "workbuddy",
      free: true,
      rate: 0
    },
    {
      id: "unknown",
      name: "Unknown",
      context: 0,
      owned_by: "workbuddy"
    }
  ]);
});

test("model discovery keeps WorkBuddy reasoning levels", async () => {
  const provider = providerWith(modelHooks({
    hy3: {
      name: "Hy3",
      reasoning: true,
      variants: {
        low: { reasoningEffort: "low" },
        high: { reasoningEffort: "high" }
      }
    }
  }));

  assert.deepEqual((await provider.listModels())[0], {
    id: "hy3",
    name: "Hy3",
    context: 0,
    owned_by: "workbuddy",
    reasoning: true,
    efforts: ["low", "high"]
  });
});

test("the account's credits come from the plugin's usage hook", async () => {
  const provider = providerWith({
    auth: {
      usage: async (getAuth) => {
        const auth = await getAuth();
        return {
          plan: "Free",
          windows: [
            {
              name: "Credits",
              used: 11.4,
              amount: 296.4,
              limit: 2600,
              unit: "credits"
            }
          ],
          account: auth.access
        };
      }
    }
  });

  const usage = await provider.usage();
  assert.equal(usage.plan, "Free");
  assert.equal(usage.windows[0].amount, 296.4);
  assert.equal(usage.windows[0].limit, 2600);
});

test("a usage failure is reported, not thrown", async () => {
  const provider = providerWith({
    auth: {
      usage: async () => {
        throw new Error("meter is down");
      }
    }
  });

  assert.deepEqual(await provider.usage(), { error: "meter is down" });
});

test("usage is answered per account, not only for the active one", async () => {
  const seen = [];
  const hooks = {
    auth: {
      usage: async (getAuth) => {
        const auth = await getAuth();
        seen.push(auth.access);
        return { plan: auth.access };
      }
    }
  };
  const provider = new WorkBuddyProvider({ hooks });
  provider.ready = true;
  provider.state = {
    version: 1,
    activeId: "u1",
    accounts: [
      { id: "u1", label: "one", enabled: true, auth: { access: "first" } },
      { id: "u2", label: "two", enabled: true, auth: { access: "second" } }
    ]
  };
  provider.sessions.set("u1", { id: "u1", auth: { access: "first" }, hooks, loader: null });
  provider.sessions.set("u2", { id: "u2", auth: { access: "second" }, hooks, loader: null });

  assert.equal((await provider.usage()).plan, "first");
  assert.equal((await provider.usage("u2")).plan, "second");
  assert.deepEqual(seen, ["first", "second"]);
});

test("chat goes through the active account's loader", async () => {
  const calls = [];
  const hooks = {};
  const provider = new WorkBuddyProvider({ hooks });
  provider.ready = true;
  provider.state = {
    version: 1,
    activeId: "u2",
    accounts: [
      { id: "u1", label: "one", enabled: true, auth: { access: "first" } },
      { id: "u2", label: "two", enabled: true, auth: { access: "second" } }
    ]
  };
  for (const [id, access] of [["u1", "first"], ["u2", "second"]]) {
    provider.sessions.set(id, {
      id,
      auth: { access },
      hooks,
      loader: {
        baseURL: `https://example.test/${access}/v2`,
        fetch: async (url) => {
          calls.push(url);
          return new Response("ok");
        }
      }
    });
  }

  await provider.chat({ model: "hy3", messages: [] });
  assert.deepEqual(calls, ["https://example.test/second/v2/chat/completions"]);
});

test("a switched-off account is not the route", async () => {
  const provider = new WorkBuddyProvider({ hooks: {} });
  provider.ready = true;
  provider.state = {
    version: 1,
    activeId: "u1",
    accounts: [
      { id: "u1", label: "one", enabled: false, auth: { access: "first" } },
      { id: "u2", label: "two", enabled: true, auth: { access: "second" } }
    ]
  };
  provider.sessions.set("u1", { id: "u1", auth: { access: "first" }, hooks: {}, loader: null });

  assert.equal(await provider.signedIn(), false);
});

test("model discovery asks the plugin once per burst, not once per caller", async () => {
  let asked = 0;
  const provider = providerWith({
    config(config) {
      config.provider.workbuddy = { models: {} };
    },
    provider: {
      models: async () => {
        asked += 1;
        return { hy3: { name: "Hy3" } };
      }
    }
  });

  // The model routes ask twice per request (resolve, then rate); one load
  // must serve both.
  const [a, b] = await Promise.all([provider.listModels(), provider.listModels()]);
  assert.deepEqual(a, b);
  assert.equal(asked, 1);
  // And the second burst inside the cache window is not a new ask either.
  await provider.listModels();
  assert.equal(asked, 1);
});

test("an awaited sign-in result is stored without polling the callback again", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lane-signin-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const env = { LANE_DATA_DIR: dir };
  let polls = 0;
  const result = {
    site: "workbuddy",
    callback: async () => {
      polls += 1;
      return { type: "success", access: "a", refresh: "r", uid: "u9", accountId: "ninth" };
    }
  };
  const provider = new WorkBuddyProvider({ env });
  await provider.init();
  // The control center waits for the callback itself, then hands the outcome
  // over; the store must not poll the same state a second time.
  const auth = await result.callback();
  const stored = await provider.finishSignIn(result, "workbuddy", auth);
  assert.equal(stored.id, "u9");
  assert.equal(polls, 1);
  assert.equal(await provider.activeId(), "u9");
});

test("a relative plugin baseURL is resolved against the account's site", async () => {
  // The plugin's 0.1.34 switched baseURL from an absolute endpoint to a bare
  // path; Lane used to concatenate it straight into a fetch and every call
  // died with "Failed to parse URL from /chat/completions". Either shape
  // must now answer with a usable absolute base.
  const hooks = {
    auth: { loader: async () => ({ baseURL: "/v2", apiKey: "" }) }
  };
  const provider = providerWith(hooks);
  assert.equal(await provider.baseURL("u1"), "https://copilot.tencent.com/v2");

  // An absolute base is passed through untouched.
  hooks.auth.loader = async () => ({ baseURL: "https://copilot.tencent.com/v2//", apiKey: "" });
  assert.equal(await provider.baseURL("u1"), "https://copilot.tencent.com/v2");
});
