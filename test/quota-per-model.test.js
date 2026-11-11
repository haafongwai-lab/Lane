import test from "node:test";
import assert from "node:assert/strict";
import { freeAllowance } from "../src/free-window.js";
import { creditWindowOf, tokenWindowsOf } from "../src/credit-window.js";
import { modelStatus } from "../desktop/format.js";

/**
 * 0.2.27 refuses one model's allowance, not the account's: the vendor says
 * "您也可以切换其他模型继续使用" and keeps serving the rest. The model list has
 * to follow that, and the domestic build answers Chinese, which the reset
 * reader used to skip entirely.
 */

const NOW = Date.parse("2026-11-11T12:00:00Z"); // 20:00 local (UTC+8)

function usage(overrides = {}) {
  return {
    plan: "Free",
    windows: [
      {
        name: "Total credits",
        amount: 10,
        limit: 500,
        used: 2,
        notModels: ["hy3", "deepseek-v4.1-flash"],
        ...overrides
      }
    ]
  };
}

function row(model, error, { at = NOW - 60_000, status = "error" } = {}) {
  return { model, status, error, startedAt: at, inputTokens: 100, outputTokens: 0 };
}

const CHINESE = '{"code":6004,"msg":"您的使用量已超出频率限制，将在 2026-11-11 21:48:41 UTC+8 重置，您也可以切换其他模型继续使用。"}';

test("a Chinese refusal names the model it belongs to, not the whole list", () => {
  const a = freeAllowance(usage(), [row("deepseek-v4.1-flash", CHINESE)], { now: NOW });
  assert.ok(a, "the free card is still reported");
  assert.equal(a.refusedModels["deepseek-v4.1-flash"], "2026-11-11T13:48:41.000Z");
  assert.equal(a.refusedModels.hy3, undefined, "the other free model is untouched");
});

test("the model list marks only the exhausted model", () => {
  const a = freeAllowance(usage(), [row("deepseek-v4.1-flash", CHINESE)], { now: NOW });
  const allowance = { freeModels: a.freeModels, refusedModels: a.refusedModels, refusedUntil: a.refusedUntil };
  const exhausted = modelStatus({ id: "deepseek-v4.1-flash" }, allowance);
  const other = modelStatus({ id: "hy3" }, allowance);
  assert.equal(exhausted.tone, "exhausted");
  assert.match(exhausted.hint, /恢复/);
  assert.equal(other.tone, "", "a model with allowance left stays available");
  assert.equal(other.text, "可用");
});

test("an English refusal is still read", () => {
  const english = "usage limit reached; reset at 2026-11-11 21:48:41 UTC+8";
  const a = freeAllowance(usage(), [row("hy3", english)], { now: NOW });
  assert.equal(a.refusedModels.hy3, "2026-11-11T13:48:41.000Z");
});

test("a reset that already passed is history, not a state", () => {
  const past = '{"code":6004,"msg":"您的使用量已超出频率限制，将在 2026-11-11 08:00:00 UTC+8 重置"}';
  const a = freeAllowance(usage(), [row("hy3", past)], { now: NOW });
  assert.equal(a.refusedModels.hy3, undefined);
  assert.equal(a.refusedUntil, "");
});

test("a refusal with no named offset is not placed by guesswork", () => {
  const noOffset = "usage limit reached; reset at 2026-11-11 21:48:41";
  const a = freeAllowance(usage(), [row("hy3", noOffset)], { now: NOW });
  assert.equal(a.refusedModels.hy3, undefined);
});

test("0.2.27's per-model token window is not read as credits", () => {
  const quota = {
    plan: "Free",
    windows: [
      { name: "Credits", amount: 100, limit: 500, aside: true },
      { name: "Extra credits", amount: 20, limit: 100, aside: true },
      { name: "Total credits", amount: 120, limit: 600 },
      {
        name: "deepseek-v4.1-flash tokens (est.)",
        amount: 2e8,
        limit: 2e8,
        unit: "",
        models: ["deepseek-v4.1-flash", "deepseek-v4.1-flash-sg"],
        refused: true
      }
    ]
  };
  const credits = creditWindowOf(quota);
  assert.equal(credits.name, "Total credits", "the token window does not win");
  assert.equal(credits.limit, 600);
  const tokens = tokenWindowsOf(quota);
  assert.equal(tokens.length, 1);
  assert.equal(tokens[0].refused, true);
});
