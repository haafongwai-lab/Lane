import test from "node:test";
import assert from "node:assert/strict";
import {
  freeWindow,
  isFreeWindowModel,
  resetInstant,
  FREE_WINDOW_SPAN,
  FREE_WINDOW_CAP
} from "../src/free-window.js";

/**
 * The window is derived, not reported: no endpoint says where it began. These
 * pin the rules that make the derivation match the vendor's — the same rules
 * the plugin applies to magpie's ledger — because a window read a day early
 * would report a spend that was never in it.
 */

const HOUR = 60 * 60 * 1000;
const T0 = Date.UTC(2026, 10, 1, 0, 0, 0); // 2026-11-01T00:00Z

function row(at, { tokens = 1_000_000, model = "deepseek-v4.1-flash", status = "complete", error = "", accountId = "a1" } = {}) {
  return {
    model,
    status,
    error,
    accountId,
    domain: "www.workbuddy.ai",
    startedAt: at,
    inputTokens: tokens,
    outputTokens: 0
  };
}

test("only the model the allowance belongs to counts", () => {
  assert.equal(isFreeWindowModel("deepseek-v4.1-flash"), true);
  assert.equal(isFreeWindowModel("deepseek-v4.1-flash-sg"), true);
  assert.equal(isFreeWindowModel("glm-5.3-flash"), false);
  assert.equal(isFreeWindowModel(""), false);
  assert.equal(isFreeWindowModel(undefined), false);
});

test("a run of requests inside 24h is one window", () => {
  const rows = [row(T0), row(T0 + HOUR), row(T0 + 5 * HOUR)];
  const w = freeWindow(rows, { now: T0 + 6 * HOUR });
  assert.ok(w, "a window is open");
  assert.equal(w.start, T0);
  assert.equal(w.end, T0 + FREE_WINDOW_SPAN);
  assert.equal(w.usedTokens, 3_000_000);
  assert.equal(w.requests, 3);
  assert.equal(w.percent, (100 * 3_000_000) / FREE_WINDOW_CAP);
});

test("a request a day later opens a new window", () => {
  const rows = [row(T0), row(T0 + FREE_WINDOW_SPAN + HOUR)];
  const w = freeWindow(rows, { now: T0 + FREE_WINDOW_SPAN + 2 * HOUR });
  assert.ok(w);
  assert.equal(w.start, T0 + FREE_WINDOW_SPAN + HOUR, "the second request opened it");
  assert.equal(w.usedTokens, 1_000_000, "the earlier request is not in this window");
});

test("a window that has lapsed is not reported at all", () => {
  const rows = [row(T0), row(T0 + HOUR)];
  assert.equal(freeWindow(rows, { now: T0 + FREE_WINDOW_SPAN + 1 }), null);
});

test("another account's traffic does not enter this one's window", () => {
  const rows = [
    row(T0, { accountId: "a1" }),
    row(T0 + HOUR, { accountId: "a2", tokens: 50_000_000 })
  ];
  const w = freeWindow(rows, { accountId: "a1", now: T0 + 2 * HOUR });
  assert.equal(w.usedTokens, 1_000_000);
  const other = freeWindow(rows, { accountId: "a2", now: T0 + 2 * HOUR });
  assert.equal(other.usedTokens, 50_000_000, "each account has its own allowance");
});

test("the domestic build's rows make no window", () => {
  const rows = [{ ...row(T0), domain: "www.workbuddy.cn" }];
  assert.equal(freeWindow(rows, { now: T0 + HOUR }), null);
});

test("failed requests do not spend the allowance", () => {
  const rows = [
    row(T0),
    row(T0 + HOUR, { status: "error", error: "model refused" })
  ];
  const w = freeWindow(rows, { now: T0 + 2 * HOUR });
  assert.equal(w.usedTokens, 1_000_000);
  assert.equal(w.requests, 1);
});

test("a refusal that names a reset ends the window it refused in", () => {
  // The vendor's own answer is exact, so the window it names closes: the
  // first request after that instant opens a new one, even though it is well
  // inside 24 hours of the window that was refused.
  const reset = "2026-11-01T12:00:00Z";
  const rows = [
    row(T0),
    row(T0 + HOUR, {
      status: "error",
      error: `allowance exhausted, reset at 2026-11-01 20:00:00 UTC+8`
    }),
    row(T0 + 13 * HOUR, { tokens: 7_000_000 })
  ];
  assert.equal(resetInstant(`reset at 2026-11-01 20:00:00 UTC+8`), Date.parse(reset));
  const w = freeWindow(rows, { now: T0 + 14 * HOUR });
  assert.equal(w.start, T0 + 13 * HOUR, "the post-reset request opened the new window");
  assert.equal(w.usedTokens, 7_000_000);
});

test("a reset with no readable offset is not used as an edge", () => {
  assert.ok(Number.isNaN(resetInstant("reset at 2026-11-01 20:00:00")));
  assert.ok(Number.isNaN(resetInstant("no reset here")));
  assert.ok(Number.isNaN(resetInstant("")));
});

test("a gap longer than the span starts the chain at the later row", () => {
  // Rows: day 1 morning, day 3 morning (gap of two days), then the same day.
  const rows = [
    row(T0),
    row(T0 + 48 * HOUR),
    row(T0 + 49 * HOUR)
  ];
  const w = freeWindow(rows, { now: T0 + 50 * HOUR });
  assert.equal(w.start, T0 + 48 * HOUR);
  assert.equal(w.usedTokens, 2_000_000);
});

test("no free-model traffic means no window", () => {
  assert.equal(freeWindow([], {}), null);
  assert.equal(freeWindow([row(T0, { model: "glm-5.3-flash" })], { now: T0 }), null);
});

test("the elapsed share is reported for the card", () => {
  const rows = [row(T0)];
  const w = freeWindow(rows, { now: T0 + FREE_WINDOW_SPAN / 2 });
  assert.equal(Math.round(w.elapsedPercent), 50);
});
