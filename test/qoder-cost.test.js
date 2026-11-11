import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { RequestJournal } from "../src/request-journal.js";
import { summary } from "../src/usage.js";

/**
 * Qoder reports only token counts back from a chat, and publishes the credits
 * one request takes in its catalogue (`price_factor`, the "0.8×" its client
 * shows). Lane records that published figure as the row's cost — the vendor's
 * own tariff, not a token-derived guess — and marks it `catalogue` so it is
 * never confused with a charge the upstream measured.
 */

async function tempJournal(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lane-qoder-cost-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return new RequestJournal({ dir });
}

test("a Qoder row is costed from the catalogue's per-request price", async (t) => {
  const journal = await tempJournal(t);
  const record = journal.start({
    agent: "openai",
    model: "qoder:performance",
    requestedModel: "qoder:performance",
    rate: 1.1,
    rateUnit: "request"
  });
  // What Qoder's plugin actually returns: token counts and nothing else.
  journal.usage(record.id, { prompt_tokens: 1200, completion_tokens: 300, total_tokens: 1500 });

  const row = journal.list().find((item) => item.id === record.id);
  assert.equal(row.creditsSource, "catalogue");
  assert.equal(row.credits, 1.1, "the published per-request figure, not a token formula");
});

test("an upstream that measures the charge still wins over the catalogue", async (t) => {
  const journal = await tempJournal(t);
  const record = journal.start({ model: "hy3", rate: 0.08 });
  journal.usage(record.id, { prompt_tokens: 10, completion_tokens: 5, credit: 3.5 });
  const row = journal.list().find((item) => item.id === record.id);
  assert.equal(row.creditsSource, "upstream");
  assert.equal(row.credits, 3.5);
});

test("a catalogue-priced row counts as billed, not as unbilled traffic", async (t) => {
  const journal = await tempJournal(t);
  const qoder = journal.start({ model: "qoder:fast", rate: 0.8, rateUnit: "request" });
  journal.usage(qoder.id, { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 });
  // A row with no price and no upstream figure stays an estimate.
  const trae = journal.start({ model: "trae:glm-5.3", rate: 0.5 });
  journal.usage(trae.id, { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 });

  const report = summary(journal.list(), { range: "today", rateFor: () => null });
  assert.equal(report.totals.unbilledRequests, 1, "only the unpriced row is unbilled");
  assert.ok(report.totals.credits > 0, "the catalogue price reaches the totals");
});

test("the kind of price is carried, so a relative multiple is not used as a price", async () => {
  // WorkBuddy's rate is a relative multiple and must never be read as credits
  // per request. Only a model whose provider declares rateUnit "request" is.
  const router = await fs.readFile(new URL("../src/provider-router.js", import.meta.url), "utf8");
  assert.match(router, /account\.provider === "qoder" \? \{ rateUnit: "request" \}/);
  const relay = await fs.readFile(new URL("../src/relay.js", import.meta.url), "utf8");
  assert.match(relay, /rateUnit: options\.rateUnit/);
});
