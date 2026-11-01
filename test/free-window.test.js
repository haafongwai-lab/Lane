import test from "node:test";
import assert from "node:assert/strict";
import { freeAllowance } from "../src/free-window.js";

/**
 * The card is about a *plan*, not a model. Measured on the real accounts:
 * the domestic plan bills deepseek-v4.1-flash on every request (899 credits
 * across two accounts), while the international Free plan charges nothing for
 * it and reports the model in `notModels`. An earlier version of this module
 * assumed the model itself was free within a rolling window; the journal
 * disproved that, and these tests pin the corrected reading.
 */

const NOW = Date.parse("2026-11-01T00:00:00Z");

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

function row(model, { status = "complete", credits = 0, at = NOW } = {}) {
  return { model, status, credits, startedAt: at };
}

test("a Free plan's allowance is read from the account's own report", () => {
  const a = freeAllowance(usage(), [], { now: NOW });
  assert.ok(a);
  assert.equal(a.plan, "Free");
  assert.ok(Math.abs(a.used - 117.58) < 1e-9);
  assert.equal(a.limit, 310);
  assert.ok(Math.abs(a.left - 192.42) < 1e-9);
  assert.equal(Math.round(a.percent), 38);
  assert.ok(Math.abs(a.leftYuan - 192.42 / 20) < 1e-9);
  assert.deepEqual(a.freeModels, ["hy3", "deepseek-v4.1-flash"]);
  // 18 days 16h from now: the allowance serves today too, so the count is
  // ceil — "含今天还可用 19 天" is the reading a user acts on.
  assert.equal(a.daysLeft, 19);
});

test("a paid plan gets no card at all", () => {
  // The domestic accounts are the measured case: every request is billed.
  assert.equal(freeAllowance({ plan: "Personal", windows: usage().windows }, [], { now: NOW }), null);
  assert.equal(freeAllowance({ plan: "Pro", windows: usage().windows }, [], { now: NOW }), null);
});

test("a failed or empty usage report gets no card", () => {
  assert.equal(freeAllowance(null, [], { now: NOW }), null);
  assert.equal(freeAllowance({ error: "not signed in" }, [], { now: NOW }), null);
  assert.equal(freeAllowance({ plan: "Free", windows: [] }, [], { now: NOW }), null);
  assert.equal(freeAllowance(usage({ limit: 0 }), [], { now: NOW }), null);
});

test("request counting follows the plan's own not-models list", () => {
  const rows = [
    row("deepseek-v4.1-flash"),
    row("hy3"),
    row("glm-5.3-flash"),          // charged on this plan: not counted
    row("deepseek-v4.1-flash", { status: "error" })
  ];
  const a = freeAllowance(usage(), rows, { now: NOW });
  assert.equal(a.freeRequests, 2, "two answered requests on free models");
});

test("a report that names no not-models counts answered traffic", () => {
  const rows = [row("anything"), row("else"), row("x", { status: "error" })];
  const a = freeAllowance(usage({ notModels: [] }), rows, { now: NOW });
  assert.equal(a.freeRequests, 2);
});

test("an exhausted allowance reads as zero left, not as absent", () => {
  const a = freeAllowance(usage({ amount: 310 }), [], { now: NOW });
  assert.ok(Math.abs(a.left) < 1e-9);
  assert.ok(Math.abs(a.percent - 100) < 1e-9);
});

test("a missing reset date leaves the days unknown rather than inventing one", () => {
  const a = freeAllowance(usage({ runsOutAt: "" }), [], { now: NOW });
  assert.equal(a.runsOutAt, "");
  assert.equal(a.daysLeft, null);
});

test("the raw amount wins when a build sends both forms", () => {
  // `amount` is the credits spent; `used` may be a percentage of the limit.
  const a = freeAllowance(usage({ amount: 62, used: 20 }), [], { now: NOW });
  assert.ok(Math.abs(a.used - 62) < 1e-9);
  assert.ok(Math.abs(a.left - 248) < 1e-9);
  const b = freeAllowance(usage({ amount: undefined, used: 50 }), [], { now: NOW });
  assert.ok(Math.abs(b.used - 155) < 1e-9, "50% of 310");
});
