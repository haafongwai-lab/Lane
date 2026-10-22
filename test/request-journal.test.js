import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { RequestJournal } from "../src/request-journal.js";

test("RequestJournal marks requests left running by an older process as failed", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lane-journal-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, "activity.json"), JSON.stringify([{
    id: "old",
    owner: process.pid + 1,
    status: "running",
    startedAt: Date.now() - 5000,
    finishedAt: null,
    durationMs: null
  }]));

  const journal = new RequestJournal({ dir });
  const [request] = journal.list();
  assert.equal(request.status, "error");
  assert.match(request.error, /尚未完成/);
  assert.ok(request.finishedAt);
  assert.ok(request.durationMs >= 5000);
});

test("the status snapshot carries only the newest requests, the journal keeps all", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lane-journal-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const journal = new RequestJournal({ dir });
  for (let index = 0; index < 30; index += 1) {
    journal.start({ agent: "codex", endpoint: "/v1/responses", model: "hy3", rate: 1 });
  }
  assert.equal(journal.list().length, 30);
  assert.equal(journal.recent().length, 20);
  assert.equal(journal.recent(5).length, 5);
  // Newest first, so the route card's "latest request" is the first entry.
  assert.ok(journal.recent()[0].startedAt >= journal.recent()[19].startedAt);
});

test("a request costs the model's multiple per million tokens, on both sides", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lane-journal-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const journal = new RequestJournal({ dir });
  const record = journal.start({ agent: "codex", endpoint: "/v1/responses", model: "hy3", rate: 2 });
  journal.usage(record.id, { prompt_tokens: 250_000, completion_tokens: 250_000 });
  const [row] = journal.list();
  assert.equal(row.totalTokens, 500_000);
  assert.equal(row.credits, 1);

  // A model whose multiple the provider could not report stays uncosted
  // rather than being counted as free.
  const unknown = journal.start({ agent: "codex", endpoint: "/v1/responses", model: "mystery" });
  journal.usage(unknown.id, { prompt_tokens: 1000, completion_tokens: 0 });
  assert.equal(journal.list()[0].credits, null);
});
