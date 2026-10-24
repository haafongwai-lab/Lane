import test from "node:test";
import assert from "node:assert/strict";
import { summary, rangeDays, localDateKey } from "../src/usage.js";

const at = (iso) => new Date(iso).getTime();

function request(overrides = {}) {
  return {
    id: "r1",
    agent: "claude-desktop",
    model: "deepseek-v4.1-flash",
    rate: 0.03,
    status: "complete",
    startedAt: at("2026-10-22T10:00:00"),
    inputTokens: 1_000_000,
    outputTokens: 0,
    totalTokens: 1_000_000,
    cachedTokens: 0,
    credits: 0.03,
    ...overrides
  };
}

const NOW = at("2026-10-22T18:00:00");

test("a range covers whole local days, including days with no traffic", () => {
  assert.equal(rangeDays("today"), 1);
  assert.equal(rangeDays("7d"), 7);
  assert.equal(rangeDays("nope"), 1);

  const report = summary([], { range: "7d", now: NOW });
  assert.equal(report.series.length, 7);
  assert.equal(report.series.at(-1).date, "2026-10-22");
  assert.equal(report.series[0].date, "2026-10-16");
  assert.deepEqual(report.totals, {
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cachedTokens: 0,
    credits: 0,
    failed: 0
  });
});

test("today only counts the current local day", () => {
  const rows = [
    request({ id: "a", startedAt: at("2026-10-22T00:05:00") }),
    request({ id: "b", startedAt: at("2026-10-21T23:55:00") })
  ];
  const report = summary(rows, { range: "today", now: NOW });
  assert.equal(report.totals.requests, 1);
  assert.equal(report.totals.credits, 0.03);
  assert.equal(report.series.length, 1);
});

test("credits are summed from the multiple recorded with the request", () => {
  const rows = [
    request({ id: "a", inputTokens: 500_000, outputTokens: 500_000, totalTokens: 1_000_000, credits: 0.03 }),
    request({ id: "b", model: "hy3", rate: 1, inputTokens: 100_000, outputTokens: 20_000, totalTokens: 120_000, credits: 0.12 })
  ];
  const report = summary(rows, { range: "today", now: NOW });
  assert.equal(report.totals.totalTokens, 1_120_000);
  assert.equal(report.totals.credits, 0.15);
  assert.equal(report.models.length, 2);
  assert.equal(report.models[0].model, "hy3");
  assert.equal(report.models[0].share, 0.8);
  assert.equal(report.models[1].share.toFixed(2), "0.20");
});

test("a request recorded before credits were kept is costed from the catalogue", () => {
  const rows = [request({ id: "a", credits: undefined, rate: undefined })];
  const report = summary(rows, { range: "today", now: NOW, rateFor: () => 0.5 });
  assert.equal(report.totals.credits, 0.5);
  assert.equal(report.models[0].rate, 0.5);
});

test("an uncostable request counts its tokens but adds no credits", () => {
  const rows = [request({ id: "a", credits: undefined, rate: undefined })];
  const report = summary(rows, { range: "today", now: NOW });
  assert.equal(report.totals.totalTokens, 1_000_000);
  assert.equal(report.totals.credits, 0);
});

test("cached input never exceeds the input it came from", () => {
  const rows = [request({ inputTokens: 1000, totalTokens: 1000, cachedTokens: 5000, credits: 0.01 })];
  const report = summary(rows, { range: "today", now: NOW });
  assert.equal(report.totals.cachedTokens, 1000);
});

test("the context gauge reads the newest request's window fill and the range's cache hit", () => {
  const rows = [
    // Newest first, as the journal keeps them: the running request has no
    // tokens to read yet, so the capacity comes from the one behind it.
    request({ id: "live", startedAt: at("2026-10-22T17:00:00"), status: "running", inputTokens: 0, totalTokens: 0 }),
    request({ id: "new", startedAt: at("2026-10-22T16:00:00"), model: "hy3", inputTokens: 50_000, outputTokens: 10_000, totalTokens: 60_000, cachedTokens: 45_000, contextWindow: 192_000 }),
    request({ id: "old", startedAt: at("2026-10-22T10:00:00"), inputTokens: 10_000, totalTokens: 10_000, cachedTokens: 9_000, contextWindow: 168_000 })
  ];
  const report = summary(rows, { range: "today", now: NOW });
  assert.equal(report.context.used, 50_000);
  assert.equal(report.context.window, 192_000);
  assert.equal(report.context.model, "hy3");
  assert.equal(report.context.fill, 50_000 / 192_000);
  // Weighted by input tokens: (45_000 + 9_000) / (50_000 + 10_000).
  assert.equal(report.context.cacheHit, 54_000 / 60_000);
});

test("a range without context windows leaves the gauge unknown", () => {
  // Rows recorded before the journal kept a window carry none.
  const report = summary([request({ inputTokens: 1_000, totalTokens: 1_000 })], { range: "today", now: NOW });
  assert.equal(report.context.used, null);
  assert.equal(report.context.window, null);
  assert.equal(report.context.fill, null);
  assert.equal(report.context.cacheHit, 0);

  const empty = summary([], { range: "today", now: NOW });
  assert.equal(empty.context.used, null);
  assert.equal(empty.context.cacheHit, null);
});

test("the previous period is the same length immediately before", () => {
  const rows = [
    request({ id: "now", startedAt: at("2026-10-22T12:00:00"), credits: 0.03, totalTokens: 1000 }),
    request({ id: "before", startedAt: at("2026-10-21T12:00:00"), credits: 0.09, totalTokens: 3000 }),
    request({ id: "older", startedAt: at("2026-10-20T12:00:00"), credits: 0.5, totalTokens: 5000 })
  ];
  const report = summary(rows, { range: "today", now: NOW });
  assert.deepEqual(report.previous, { requests: 1, credits: 0.09, totalTokens: 3000 });
});

test("agents are grouped and failed requests counted", () => {
  const rows = [
    request({ id: "a", agent: "codex", credits: 0.02 }),
    request({ id: "b", agent: "codex", credits: 0.03, status: "error" })
  ];
  const report = summary(rows, { range: "today", now: NOW });
  assert.equal(report.totals.failed, 1);
  assert.deepEqual(report.agents, [{ agent: "codex", requests: 2, totalTokens: 2_000_000, credits: 0.05 }]);
});

test("a row with no usable start time is ignored", () => {
  const report = summary([request({ startedAt: null }), request({ id: "ok" })], { range: "today", now: NOW });
  assert.equal(report.totals.requests, 1);
});

test("localDateKey pads a date the way the series does", () => {
  assert.equal(localDateKey(new Date(2026, 0, 5)), "2026-01-05");
});
