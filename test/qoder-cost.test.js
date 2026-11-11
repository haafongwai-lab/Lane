import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { RequestJournal } from "../src/request-journal.js";
import { summary } from "../src/usage.js";

/**
 * Qoder reports only token counts back from a chat. Its model listing carries a
 * `price_factor` — the "0.8×" Qoder's own client prints beside a model — which
 * the vendored plugin documents as "the credits a request costs, as a
 * multiple". That is a multiple, not an amount: the base it multiplies is not
 * in the protocol, and different models carry different multiples. Recording it
 * as the row's credits invented an absolute charge nobody measured, so the row
 * keeps its token count and the multiplier stays a display detail.
 */

async function tempJournal(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lane-qoder-cost-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return new RequestJournal({ dir });
}

test("a Qoder row keeps its token count and invents no credit charge", async (t) => {
  const journal = await tempJournal(t);
  const record = journal.start({
    agent: "openai",
    model: "qoder:performance",
    requestedModel: "qoder:performance",
    // The catalogue's multiple, as Qoder's client shows it.
    rate: 1.1
  });
  // What Qoder's plugin actually returns: token counts and nothing else.
  journal.usage(record.id, { prompt_tokens: 1200, completion_tokens: 300, total_tokens: 1500 });

  const row = journal.list().find((item) => item.id === record.id);
  assert.equal(row.totalTokens, 1500);
  assert.equal(row.creditsSource, "estimate");
  assert.equal(row.credits, null, "no price is calibrated yet, so the row stays uncosted");
  assert.equal(row.rate, 1.1, "the multiple is kept for display");
});

test("the multiple never becomes a credit amount, at any value", async (t) => {
  const journal = await tempJournal(t);
  // 0.4 and 8 are the cheapest and dearest models in one listing. Neither is
  // a credit count; both must stay uncosted until a real price exists.
  for (const rate of [0.4, 1.1, 8]) {
    const record = journal.start({ model: `qoder:m${rate}`, rate });
    journal.usage(record.id, { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 });
    const row = journal.list().find((item) => item.id === record.id);
    assert.equal(row.creditsSource, "estimate", `rate ${rate} must not bill`);
    assert.equal(row.credits, null, `rate ${rate} left a fabricated charge`);
  }
});

test("an upstream that measures the charge still bills it", async (t) => {
  const journal = await tempJournal(t);
  const record = journal.start({ model: "hy3", rate: 0.08 });
  journal.usage(record.id, { prompt_tokens: 10, completion_tokens: 5, credit: 3.5 });
  const row = journal.list().find((item) => item.id === record.id);
  assert.equal(row.creditsSource, "upstream");
  assert.equal(row.credits, 3.5);
});

test("cycle-billed rows are reported as unbilled traffic", async (t) => {
  const journal = await tempJournal(t);
  const qoder = journal.start({ model: "qoder:fast", rate: 0.8 });
  journal.usage(qoder.id, { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 });
  const report = summary(journal.list(), { range: "today", rateFor: () => null });
  assert.equal(report.totals.unbilledRequests, 1, "the panel says so instead of showing a number");
  assert.equal(report.totals.credits, 0);
});

test("the request row shows tokens and names the multiple in its tooltip", async () => {
  const app = await fs.readFile(new URL("../desktop/app.js", import.meta.url), "utf8");
  // The credit column carries a measured charge or a token count, never a
  // multiplier printed as if it were credits.
  assert.match(app, /const measured = item\.creditsSource === "upstream"/);
  assert.match(app, /模型倍率 \$\{multiple\}/);
  assert.equal(
    /creditsSource === "catalogue"/.test(app),
    false,
    "the fabricated catalogue charge is gone"
  );
});
