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
