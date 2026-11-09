import test from "node:test";
import assert from "node:assert/strict";
import { freeAllowance } from "../src/free-window.js";

/**
 * Measured on the real accounts the last version got wrong: the Free plan
 * refuses paid models outright (11158 personal_free_user), never billed a
 * credit across 28.6M tokens of free-model traffic, and still reports a
 * Credits window with usage - consumed outside Lane. Credits and free models
 * are two allowances; these tests pin them as separate.
 */

const NOW = Date.parse("2026-11-01T05:00:00Z"); // 13:00 local (UTC+8)

function usage(overrides = {}) {
  return {
    plan: "Free",
    windows: [{
      name: "Credits",
      used: 37.93,
      amount: 117.58,
      limit: 310,
      unit: "credits",
      runsOutAt: "2026-11-19T16:14:43.000Z",
      notModels: ["hy3", "deepseek-v4.1-flash"],
      ...overrides
    }]
  };
}

function row(model, { status = "complete", at = NOW, tokens = 1000, error = "" } = {}) {
  return { model, status, error, startedAt: at, inputTokens: tokens, outputTokens: 0 };
}

test("the credits window is reported as the paid allowance, verbatim", () => {
  const a = freeAllowance(usage(), [], { now: NOW });
  assert.ok(Math.abs(a.credits.used - 117.58) < 1e-9);
  assert.equal(a.credits.limit, 310);
  assert.ok(Math.abs(a.credits.left - 192.42) < 1e-9);
  assert.equal(a.credits.runsOutAt, "2026-11-19T16:14:43.000Z");
});

test("the cycle reset and the lapse day are two different dates", () => {
  // 0.2.17 puts the cycle's reset on the plan window (resetsAt) and the day
  // leftover credits lapse on the window that stops the account (runsOutAt).
  // The card used to print the latter as "重置", which reads as a refill.
  const a = freeAllowance(usage({
    resetsAt: "2026-12-01T00:00:00.000Z",
    runsOutAt: "2026-11-19T16:14:43.000Z"
  }), [], { now: NOW });
  assert.equal(a.credits.resetsAt, "2026-12-01T00:00:00.000Z");
  assert.equal(a.credits.runsOutAt, "2026-11-19T16:14:43.000Z");
});

test("the plugin's 0.1.34+ plan label \"Free plan\" is the same plan", () => {
  // 0.1.34 renamed the plan from "Free" to "Free plan" so the bare word
  // beside an account would stop reading as the model being free.
  const a = freeAllowance({ ...usage(), plan: "Free plan" }, [], { now: NOW });
  assert.ok(a, "a Free plan account keeps its allowance card");
  assert.equal(a.plan, "Free plan");
  assert.equal(a.credits.limit, 310);
});

test("free-model usage is counted over the local day only", () => {
  const rows = [
    row("deepseek-v4.1-flash", { at: NOW - 20 * 3600 * 1000, tokens: 5000000 }),
    row("deepseek-v4.1-flash", { at: NOW - 3600 * 1000, tokens: 2000000 }),
    row("hy3", { at: NOW - 60 * 1000, tokens: 100000 }),
    row("gpt-6-luna", { at: NOW - 30 * 1000, tokens: 900000 }),
    row("deepseek-v4.1-flash", { at: NOW - 20 * 1000, status: "error" })
  ];
  const a = freeAllowance(usage(), rows, { now: NOW });
  assert.equal(a.freeRequestsToday, 2);
  assert.equal(a.freeTokensToday, 2100000);
  assert.equal(a.freeRequestsTotal, 3, "the whole journal's free rows, not just today");
});

test("free-model traffic counts across every account when no account is named", () => {
  // The usage page reads the allowance without a route: there the whole
  // journal is the machine's traffic. The model list passes an account id
  // and is scoped to it instead (next test).
  const overseas = "overseas-id";
  const domestic = "domestic-id";
  const rows = [
    { ...row("hy3", { at: NOW - 60_000 }), accountId: overseas },
    { ...row("hy3", { at: NOW - 40_000 }), accountId: domestic },
    { ...row("deepseek-v4.1-flash", { at: NOW - 20_000 }), accountId: domestic },
    { ...row("gpt-6-luna", { at: NOW - 10_000 }), accountId: domestic }
  ];
  const a = freeAllowance(usage(), rows, { now: NOW });
  assert.equal(a.freeRequestsToday, 3, "every account's free models count");
  assert.equal(a.freeRequestsTotal, 3);
});

test("an account-scoped allowance ignores another account's refusal", () => {
  // A 429 naming a reset on the overseas account must not mark the domestic
  // account's free models exhausted: that was the bug that made switching
  // accounts leave the model list unchanged.
  const overseas = "overseas-id";
  const domestic = "domestic-id";
  const rows = [
    {
      ...row("hy3", {
        at: NOW - 60_000,
        status: "error",
        error: "allowance exhausted, reset at 2026-11-02 08:00:00 UTC+8"
      }),
      accountId: overseas
    },
    { ...row("hy3", { at: NOW - 30_000 }), accountId: domestic }
  ];
  const domesticView = freeAllowance(usage(), rows, { now: NOW, accountId: domestic });
  assert.equal(domesticView.refusedUntil, "", "the other account's refusal is not ours");
  assert.equal(domesticView.freeRequestsToday, 1, "today's machine-wide traffic still counts");
  const overseasView = freeAllowance(usage(), rows, { now: NOW, accountId: overseas });
  assert.equal(overseasView.refusedUntil, "2026-11-02T00:00:00.000Z");
  assert.equal(overseasView.freeRequestsToday, 1, "the traffic total is machine-wide, not per account");
});

test("an in-force refusal is surfaced with its reset time", () => {
  const reset = "2026-11-02T00:00:00Z";
  const rows = [
    row("deepseek-v4.1-flash", {
      status: "error",
      error: "allowance exhausted, reset at 2026-11-02 08:00:00 UTC+8"
    })
  ];
  const a = freeAllowance(usage(), rows, { now: NOW });
  assert.equal(a.refusedUntil, "2026-11-02T00:00:00.000Z", "UTC+8 08:00 = 00:00Z");
});

test("a refusal whose reset has passed is history, not a state", () => {
  const rows = [
    row("deepseek-v4.1-flash", {
      status: "error",
      error: "allowance exhausted, reset at 2026-10-31 20:00:00 UTC+8"
    })
  ];
  const a = freeAllowance(usage(), rows, { now: NOW });
  assert.equal(a.refusedUntil, "");
});

test("a paid plan gets nothing; so do failed reports", () => {
  assert.equal(freeAllowance({ plan: "Personal", windows: usage().windows }, [], { now: NOW }), null);
  assert.equal(freeAllowance(null, [], { now: NOW }), null);
  assert.equal(freeAllowance({ error: "not signed in" }, [], { now: NOW }), null);
  assert.equal(freeAllowance(usage({ limit: 0 }), [], { now: NOW }), null);
});

test("the plan's own not-models list decides what counts as free", () => {
  const rows = [row("anything"), row("else")];
  const a = freeAllowance(usage({ notModels: [] }), rows, { now: NOW });
  assert.equal(a.freeRequestsToday, 2, "no list: every answered request counts");
  assert.deepEqual(a.freeModels, []);
});
