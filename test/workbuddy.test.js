import test from "node:test";
import assert from "node:assert/strict";
import { WorkBuddyProvider } from "../src/workbuddy.js";

function providerWith(models) {
  const provider = new WorkBuddyProvider();
  provider.init = async () => provider;
  provider.getAuth = async () => ({ access: "test" });
  provider.hooks = {
    config(config) {
      config.provider.workbuddy = { models: {} };
    },
    provider: { models: async () => models }
  };
  return provider;
}

test("model discovery keeps WorkBuddy credit rates", async () => {
  const provider = providerWith({
    hy3: { name: "Hy3", limit: { context: 192000 }, rate: 0.34, rateWas: 1 },
    free: { name: "Free", limit: { context: 32000 }, free: true, rate: 0 },
    unknown: { name: "Unknown" }
  });

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
  const provider = providerWith({
    hy3: {
      name: "Hy3",
      reasoning: true,
      variants: {
        low: { reasoningEffort: "low" },
        high: { reasoningEffort: "high" }
      }
    }
  });

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
  const provider = new WorkBuddyProvider();
  provider.init = async () => provider;
  provider.getAuth = async () => ({ access: "test" });
  provider.hooks = {
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
  };

  const usage = await provider.usage();
  assert.equal(usage.plan, "Free");
  assert.equal(usage.windows[0].amount, 296.4);
  assert.equal(usage.windows[0].limit, 2600);
});

test("a usage failure is reported, not thrown", async () => {
  const provider = new WorkBuddyProvider();
  provider.init = async () => provider;
  provider.getAuth = async () => ({ access: "test" });
  provider.hooks = {
    auth: {
      usage: async () => {
        throw new Error("meter is down");
      }
    }
  };

  assert.deepEqual(await provider.usage(), { error: "meter is down" });
});
