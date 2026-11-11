import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { creditBreakdown, creditWindowOf, isTokenWindow } from "../desktop/format.js";

/**
 * A Free plan holds two kinds of credits and they are not the same money: the
 * plan's monthly grant renews with the cycle, while the daily check-in's
 * credits lapse on their own day. WorkBuddy spends whichever lapses first, so
 * the card has to show them apart — one total hid the part about to be lost.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");

function usage() {
  return {
    plan: "Free plan",
    windows: [
      { name: "Credits", amount: 500, limit: 500, aside: true, resetsAt: "2026-11-30T15:59:59.000Z" },
      { name: "Extra credits", amount: 975.95, limit: 2200, aside: true, runsOutAt: "2026-12-05T14:52:21.000Z" },
      {
        name: "Total credits",
        amount: 1475.95,
        limit: 2700,
        resetsAt: "2026-11-30T15:59:59.000Z",
        runsOutAt: "2026-12-05T14:52:21.000Z"
      }
    ]
  };
}

test("the plan grant and the check-in credits are listed apart", () => {
  const rows = creditBreakdown(usage());
  assert.equal(rows.length, 2);
  // "赠送积分" rather than "月度赠送积分": the grant renews with whatever the
  // plan's period is, which is not always a month.
  assert.equal(rows[0].label, "赠送积分");
  assert.equal(rows[0].kind, "plan");
  assert.equal(rows[0].limit, 500);
  assert.equal(rows[0].left, 0);
  assert.equal(rows[1].label, "签到与额外积分");
  assert.equal(rows[1].kind, "extra");
  assert.equal(rows[1].limit, 2200);
  assert.ok(Math.abs(rows[1].left - 1224.05) < 1e-6);
});

test("a renewal date is never printed as an expiry", () => {
  // The plan's `resetsAt` is when the allowance comes back. Reporting it as
  // `lapsesAt` told the user their grant disappears on the day it renews.
  const rows = creditBreakdown(usage());
  assert.equal(rows[0].lapsesAt, "", "a plan window's reset is not an expiry");
  assert.equal(rows[0].resetsAt, "2026-11-30T15:59:59.000Z");
  assert.equal(rows[1].lapsesAt, "2026-12-05T14:52:21.000Z", "reward credits do expire");
  assert.equal(rows[1].resetsAt, "");
});

test("Qoder's window names are recognised", () => {
  // Qoder names its pools differently: the plan's is "Credits", the rewards
  // are "Add-on credits". Both must still land on the two rows.
  const rows = creditBreakdown({
    windows: [
      { name: "Total credits", used: 42, amount: 210, limit: 500, unit: "credits" },
      { name: "Credits", used: 30, amount: 150, limit: 500, unit: "credits", resetsAt: "2026-12-01T00:00:00.000Z" },
      { name: "Add-on credits", used: 60, amount: 60, limit: 100, unit: "credits", aside: true, runsOutAt: "2026-11-18T00:00:00.000Z" }
    ]
  });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].label, "赠送积分");
  assert.equal(rows[0].left, 350);
  assert.equal(rows[0].resetsAt, "2026-12-01T00:00:00.000Z");
  assert.equal(rows[1].label, "签到与额外积分");
  assert.equal(rows[1].left, 40);
  assert.equal(rows[1].first, true, "the add-on pool lapses first");
});

test("the part that lapses first is marked, not merely ordered", () => {
  const rows = creditBreakdown(usage());
  assert.equal(rows[0].first, true, "the monthly grant resets 11/30, before the extra credits lapse");
  assert.equal(rows[1].first, undefined);
});

test("the mark follows the dates when the extra credits lapse first", () => {
  const data = usage();
  data.windows[1].runsOutAt = "2026-11-20T00:00:00.000Z";
  const rows = creditBreakdown(data);
  assert.equal(rows[1].first, true, "the check-in credits go first this time");
  assert.equal(rows[0].first, undefined);
});

test("a build with one merged window gets no breakdown", () => {
  const rows = creditBreakdown({
    windows: [{ name: "Credits", amount: 100, limit: 500 }]
  });
  assert.deepEqual(rows, [], "one window has nothing to split");
});

test("a paid account with no extra credits gets no breakdown", () => {
  const rows = creditBreakdown({
    windows: [{ name: "Credits", amount: 100, limit: 500, resetsAt: "2026-11-30T15:59:59.000Z" }]
  });
  assert.deepEqual(rows, []);
});

test("the total still wins for the headline figure", () => {
  const view = creditWindowOf(usage());
  assert.equal(view.name, "Total credits");
  assert.equal(view.limit, 2700);
});

test("a token window is never part of the credit breakdown", () => {
  const data = usage();
  data.windows.push({
    name: "deepseek-v4.1-flash tokens (est.)",
    amount: 2e8,
    limit: 2e8,
    models: ["deepseek-v4.1-flash"]
  });
  assert.equal(isTokenWindow(data.windows[3]), true);
  const rows = creditBreakdown(data);
  assert.equal(rows.length, 2, "the token window is not credits");
  assert.ok(rows.every((row) => row.kind === "plan" || row.kind === "extra"));
});

test("the free-model card is gone from the page and the renderer", () => {
  const html = fs.readFileSync(path.join(ROOT, "desktop/index.html"), "utf8");
  const app = fs.readFileSync(path.join(ROOT, "desktop/app.js"), "utf8");
  assert.doesNotMatch(html, /usage-free/, "no free-model card in the markup");
  assert.doesNotMatch(app, /renderFreeAllowance/, "no free-model renderer left");
});

test("a skill description carries no hover popup", () => {
  const app = fs.readFileSync(path.join(ROOT, "desktop/app.js"), "utf8");
  const at = app.indexOf("skill.description");
  assert.ok(at > 0, "the description is still rendered");
  const around = app.slice(at - 200, at + 120);
  assert.doesNotMatch(around, /data-tip/, "the description has no tooltip");
});
