import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { creditBreakdown, creditWindowOf, tokenWindowsOf } from "../desktop/format.js";

/**
 * The quota card's per-allowance rows. Their labels and dates are the part a
 * user acts on: "which part of this balance is about to be lost" (an expiry)
 * and "when does it come back" (a reset). The two are different dates, and a
 * reset must never be printed as an expiry.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = fs.readFileSync(path.join(HERE, "..", "desktop", "app.js"), "utf8");

const from = APP.indexOf("function renderUsageQuota(");
const to = APP.indexOf("// The donut's slice colours", from);
const body = APP.slice(from, to);

function render(quota) {
  const nodes = { "#usage-quota": { innerHTML: "" }, "#usage-plan": { textContent: "" } };
  const esc = (v) => String(v ?? "");
  const creditNumber = (v) => String(Math.round(Number(v) * 100) / 100);
  const percent = (v) => `${Math.round(Number(v) * 100)}%`;
  const compact = (v) => String(v);
  const fn = new Function(
    "$", "esc", "creditNumber", "percent", "compact",
    "creditWindowOf", "creditBreakdown", "tokenWindowsOf", "renderQuotaAccountPicker",
    body + "\nreturn renderUsageQuota;"
  );
  fn(
    (sel) => nodes[sel], esc, creditNumber, percent, compact,
    creditWindowOf, creditBreakdown, tokenWindowsOf, () => {}
  )(quota);
  return nodes["#usage-quota"].innerHTML;
}

test("Qoder's two allowances print with their own dates", () => {
  const html = render({
    plan: "Free",
    windows: [
      { name: "Total credits", used: 42, amount: 210, limit: 500, unit: "credits" },
      {
        name: "Credits", used: 30, amount: 150, limit: 500, unit: "credits",
        resetsAt: "2026-12-01T00:00:00.000Z"
      },
      {
        name: "Add-on credits", used: 60, amount: 60, limit: 100, unit: "credits",
        aside: true, runsOutAt: "2026-11-18T00:00:00.000Z"
      }
    ]
  });
  assert.match(html, /赠送积分/, "the plan's grant is named");
  assert.match(html, /签到与额外积分/, "the reward pool is named separately");
  assert.match(html, /12\/1 重置/, "a renewal date reads as a reset");
  assert.match(html, /11\/18 到期/, "an expiry reads as an expiry");
  // The pool that lapses first is the one marked.
  assert.match(html, /先消耗/);
});

test("a plan window's reset is never printed as an expiry", () => {
  const html = render({
    windows: [
      { name: "Credits", amount: 500, limit: 500, resetsAt: "2026-11-30T15:59:59.000Z" },
      { name: "Extra credits", amount: 975.95, limit: 2200, runsOutAt: "2026-12-05T14:52:21.000Z" }
    ]
  });
  assert.match(html, /11\/30 重置/);
  assert.doesNotMatch(html, /11\/30 到期/, "the grant renews on that day, it does not vanish");
  assert.match(html, /12\/5 到期/);
});

test("a single-pool account shows the total and no split", () => {
  const html = render({
    windows: [{ name: "Credits", used: 20, amount: 100, limit: 500, unit: "credits", resetsAt: "2026-12-01T00:00:00.000Z" }]
  });
  assert.doesNotMatch(html, /赠送积分/, "one pool has nothing to split");
  assert.match(html, /quota-hero/);
});
