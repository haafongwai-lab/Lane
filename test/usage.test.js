import test from "node:test";
import assert from "node:assert/strict";
import { summary, rangeDays, localDateKey, billedRates } from "../src/usage.js";

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
    // What WorkBuddy charged, as the journal records it since it reads the
    // upstream's own `credit` report.
    credits: 0.03,
    creditsSource: "upstream",
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
    billableTokens: 0,
    credits: 0,
    estimatedCredits: 0,
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

test("billed credits are summed from what the upstream charged", () => {
  const rows = [
    request({ id: "a", inputTokens: 500_000, outputTokens: 500_000, totalTokens: 1_000_000, credits: 0.03 }),
    request({ id: "b", model: "hy3", rate: 1, inputTokens: 100_000, outputTokens: 20_000, totalTokens: 120_000, credits: 0.12 })
  ];
  const report = summary(rows, { range: "today", now: NOW });
  assert.equal(report.totals.totalTokens, 1_120_000);
  assert.equal(report.totals.credits, 0.15);
  assert.equal(report.totals.estimatedCredits, 0);
  assert.equal(report.models.length, 2);
  assert.equal(report.models[0].model, "hy3");
  assert.equal(report.models[0].share, 0.8);
  assert.equal(report.models[1].share.toFixed(2), "0.20");
});

test("a row the upstream did not cost is an estimate, never a billed credit", () => {
  // Rows written before the journal read the upstream's `credit` carry no
  // source; the token formula fills in, priced by the calibrated
  // credits-per-million rate — the row's declared multiple never costs.
  const rows = [request({ id: "a", creditsSource: undefined, credits: undefined, rate: 0.5 })];
  const report = summary(rows, { range: "today", now: NOW, rateFor: () => 0.5 });
  assert.equal(report.totals.credits, 0);
  assert.ok(Math.abs(report.totals.estimatedCredits - 0.5) < 1e-9);
  assert.equal(report.models[0].rate, 0.5);
});

test("an uncostable request counts its tokens but adds no credits", () => {
  const rows = [request({ id: "a", credits: undefined, creditsSource: undefined, rate: undefined })];
  const report = summary(rows, { range: "today", now: NOW });
  assert.equal(report.totals.totalTokens, 1_000_000);
  assert.equal(report.totals.credits, 0);
  assert.equal(report.totals.estimatedCredits, 0);
});

test("billed and estimated credits are never added", () => {
  const rows = [
    request({ id: "a", credits: 7.28, creditsSource: "upstream" }),
    request({ id: "b", credits: undefined, creditsSource: "estimate", rate: 0.11, inputTokens: 45_000, outputTokens: 500, totalTokens: 45_500 })
  ];
  const report = summary(rows, { range: "today", now: NOW, rateFor: () => 0.11 });
  assert.equal(report.totals.credits, 7.28);
  assert.ok(Math.abs(report.totals.estimatedCredits - 45_500 / 1e6 * 0.11) < 1e-9);
});

test("billedRates calibrates a price only from enough billed traffic", () => {
  const rows = [
    request({ id: "a", model: "glm", credits: 5.4, creditsSource: "upstream", inputTokens: 1_000_000, outputTokens: 0, totalTokens: 1_000_000 }),
    request({ id: "b", model: "glm", credits: 5.4, creditsSource: "upstream", inputTokens: 500_000, outputTokens: 0, totalTokens: 500_000 }),
    // Too little billed traffic to trust an average.
    request({ id: "c", model: "tiny", credits: 0.01, creditsSource: "upstream", inputTokens: 500, outputTokens: 0, totalTokens: 500 }),
    // Estimate rows never feed the calibration.
    request({ id: "d", model: "deepseek", credits: 9, creditsSource: "estimate", inputTokens: 1_000_000, outputTokens: 0, totalTokens: 1_000_000 })
  ];
  const rates = billedRates(rows);
  assert.ok(Math.abs(rates.get("glm") - 7.2) < 1e-9);
  assert.equal(rates.has("tiny"), false);
  assert.equal(rates.has("deepseek"), false);

  // With no calibrated price, uncosted rows contribute tokens but no credits.
  const report = summary(
    [request({ id: "e", model: "deepseek", credits: undefined, creditsSource: undefined, rate: 0.11 })],
    { range: "today", now: NOW, rateFor: (id) => rates.get(id) ?? null }
  );
  assert.equal(report.totals.estimatedCredits, 0);
});

test("cached input never exceeds the input it came from", () => {
  const rows = [request({ inputTokens: 1000, totalTokens: 1000, cachedTokens: 5000, credits: 0.01 })];
  const report = summary(rows, { range: "today", now: NOW });
  assert.equal(report.totals.cachedTokens, 1000);
});

test("billable tokens exclude the cache-served part of the input", () => {
  const rows = [request({ inputTokens: 20_000, cachedTokens: 19_840, outputTokens: 50, totalTokens: 20_050 })];
  const report = summary(rows, { range: "today", now: NOW });
  assert.equal(report.totals.inputTokens, 20_000);
  assert.equal(report.totals.billableTokens, 20_000 - 19_840 + 50);
});

test("context capacity and cache hit are computed per project", () => {
  const rows = [
    // Newest first, as the journal keeps them.
    request({
      id: "a", project: "C:\\Repo\\lane", projectName: "lane",
      model: "hy3", inputTokens: 50_000, totalTokens: 60_000, cachedTokens: 45_000,
      contextWindow: 192_000
    }),
    request({
      id: "b", project: "C:\\Repo\\other", projectName: "other",
      model: "hy3", inputTokens: 300_000, totalTokens: 300_000, cachedTokens: 10_000,
      contextWindow: 192_000
    })
  ];
  const report = summary(rows, { range: "today", now: NOW });
  assert.equal(report.projects.length, 2);
  const lane = report.projects.find((row) => row.name === "lane");
  const other = report.projects.find((row) => row.name === "other");
  assert.equal(lane.context.used, 50_000);
  assert.equal(lane.context.fill, 50_000 / 192_000);
  assert.equal(lane.cacheHit, 45_000 / 50_000);
  assert.equal(other.context.used, 300_000);
  assert.equal(other.cacheHit, 10_000 / 300_000);
  // The headline gauge carries the newest attributed project, not a blend.
  assert.equal(report.context.used, 50_000);
});

test("requests that name no project stay unattributed", () => {
  const rows = [request({ id: "a" }), request({ id: "b", project: "", projectName: "" })];
  const report = summary(rows, { range: "today", now: NOW });
  assert.equal(report.projects.length, 1);
  assert.equal(report.projects[0].id, "");
  assert.equal(report.projects[0].name, "");
});

test("the previous period is the same length immediately before", () => {
  const rows = [
    request({ id: "now", startedAt: at("2026-10-22T12:00:00"), credits: 0.03, totalTokens: 1000 }),
    request({ id: "before", startedAt: at("2026-10-21T12:00:00"), credits: 0.09, totalTokens: 3000 }),
    request({ id: "older", startedAt: at("2026-10-20T12:00:00"), credits: 0.5, totalTokens: 5000 })
  ];
  const report = summary(rows, { range: "today", now: NOW });
  assert.deepEqual(report.previous, { requests: 1, credits: 0.09, estimatedCredits: 0, totalTokens: 3000 });
});

test("agents are grouped and failed requests counted", () => {
  const rows = [
    request({ id: "a", agent: "codex", credits: 0.02 }),
    request({ id: "b", agent: "codex", credits: 0.03, status: "error" })
  ];
  const report = summary(rows, { range: "today", now: NOW });
  assert.equal(report.totals.failed, 1);
  assert.deepEqual(report.agents, [{
    agent: "codex",
    requests: 2,
    inputTokens: 2_000_000,
    outputTokens: 0,
    totalTokens: 2_000_000,
    cachedTokens: 0,
    billableTokens: 2_000_000,
    credits: 0.05,
    estimatedCredits: 0,
    failed: 1
  }]);
});

test("a row with no usable start time is ignored", () => {
  const report = summary([request({ startedAt: null }), request({ id: "ok" })], { range: "today", now: NOW });
  assert.equal(report.totals.requests, 1);
});

test("localDateKey pads a date the way the series does", () => {
  assert.equal(localDateKey(new Date(2026, 0, 5)), "2026-01-05");
});
