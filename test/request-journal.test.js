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
