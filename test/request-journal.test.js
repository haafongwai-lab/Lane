import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { RequestJournal } from "../src/request-journal.js";

function tempDir(t, prefix = "lane-journal-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// A pid that really exited: `process.pid + 1` may belong to a live process,
// and the journal no longer marks a live owner's rows as crashed.
function deadPid() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", "process.exit(0)"]);
    const pid = child.pid;
    child.once("exit", () => resolve(pid));
    child.once("error", reject);
  });
}

function livePid() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"]);
    child.once("spawn", () => resolve(child));
    child.once("error", reject);
  });
}

test("RequestJournal marks requests left running by a dead process as failed", async (t) => {
  const dir = tempDir(t);
  const pid = await deadPid();
  fs.writeFileSync(path.join(dir, "activity.json"), JSON.stringify([{
    id: "old",
    owner: pid,
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

test("another Lane's live requests are left alone", async (t) => {
  const dir = tempDir(t);
  const other = await livePid();
  t.after(() => other.kill());
  fs.writeFileSync(path.join(dir, "activity.json"), JSON.stringify([{
    id: "live",
    owner: other.pid,
    status: "running",
    startedAt: Date.now() - 1000,
    finishedAt: null,
    durationMs: null
  }]));

  // A second Lane opening the same journal must not decide the owner's
  // in-flight request crashed while its process is still running.
  const journal = new RequestJournal({ dir });
  assert.equal(journal.list()[0].status, "running");
});

test("the status snapshot carries only the newest requests, the journal keeps all", async (t) => {
  const dir = tempDir(t);
  const journal = new RequestJournal({ dir });
  for (let index = 0; index < 30; index += 1) {
    journal.start({ agent: "codex", endpoint: "/v1/responses", model: "hy3", rate: 1 });
  }
  assert.equal(journal.list().length, 30);
  assert.equal(journal.recent().length, 20);
  assert.equal(journal.recent(5).length, 5);
  // Newest first, so the route card's "latest request" is the first entry.
  assert.ok(journal.recent()[0].startedAt >= journal.recent()[19].startedAt);
  // Settle the debounce so it cannot write after the directory is removed.
  await journal.flush();
});

test("a reader journal follows the file the owner writes", async (t) => {
  const dir = tempDir(t);
  fs.writeFileSync(path.join(dir, "activity.json"), JSON.stringify([{
    id: "live",
    owner: process.pid,
    status: "running",
    startedAt: Date.now() - 1000,
    finishedAt: null,
    durationMs: null
 }]));

  // A secondary window reads the owner's file: its in-flight request is
  // genuinely running, and new rows appear as the owner writes them.
  const reader = new RequestJournal({ dir, shared: true });
  assert.equal(reader.list()[0].status, "running");

  const owner = new RequestJournal({ dir });
  owner.start({ agent: "codex", endpoint: "/v1/responses", model: "hy3", rate: 1 });
  // The owner's writes are debounced; the flush is what puts them on disk.
  await owner.flush();
  assert.equal(reader.list().length, 2, "list() re-reads as the owner writes");
  // The owner's own view is unchanged by the reader.
  assert.equal(owner.list().length, 2);
  assert.equal(owner.list()[0].status, "running");
});

test("a reader journal that flushes does not overwrite the owner's file", async (t) => {
  const dir = tempDir(t);
  const owner = new RequestJournal({ dir });
  const first = owner.start({ agent: "codex", endpoint: "/v1/responses", model: "hy3" });
  owner.finish(first.id, { status: "complete" });
  await owner.flush();

  const reader = new RequestJournal({ dir, shared: true });
  reader.list();
  // While the reader holds its snapshot, the owner records one more.
  const second = owner.start({ agent: "codex", endpoint: "/v1/responses", model: "hy3" });
  owner.finish(second.id, { status: "complete" });
  await owner.flush();

  // The reader quitting (control.stop → flush) must not roll the file back
  // to the older snapshot it still holds in memory.
  await reader.flush();
  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, "activity.json"), "utf8"));
  assert.equal(onDisk.length, 2, "the owner's newer rows survive the reader's flush");
});

test("a request costs the model's multiple per million tokens, on both sides", async (t) => {
  const dir = tempDir(t);
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
  await journal.flush();
});

test("a burst of notes becomes one write, a finish reaches the disk at once", async (t) => {
  const dir = tempDir(t);
  const journal = new RequestJournal({ dir });
  const record = journal.start({ agent: "codex", endpoint: "/v1/responses", model: "hy3" });
  journal.note(record.id, { firstTextMs: 12 });
  journal.note(record.id, { firstTextMs: 20 });
  // Nothing forced a write yet: the debounce is still holding it back.
  assert.equal(fs.existsSync(path.join(dir, "activity.json")), false);
  journal.finish(record.id, { status: "complete" });
  await journal.flush();
  const rows = JSON.parse(fs.readFileSync(path.join(dir, "activity.json"), "utf8"));
  assert.equal(rows[0].status, "complete");
  assert.equal(rows[0].firstTextMs, 20);
});

test("a request remembers the context window it was served in", async (t) => {
  const dir = tempDir(t);
  const journal = new RequestJournal({ dir });
  journal.start({ agent: "codex", endpoint: "/v1/responses", model: "hy3", contextWindow: 192_000 });
  assert.equal(journal.list()[0].contextWindow, 192_000);

  // The upstream says 0 when it cannot say, and a start without the field is
  // the same: both read as unknown rather than a zero-wide window.
  journal.start({ agent: "codex", endpoint: "/v1/responses", model: "mystery", contextWindow: 0 });
  journal.start({ agent: "codex", endpoint: "/v1/responses", model: "mystery" });
  assert.equal(journal.list()[0].contextWindow, null);
  assert.equal(journal.list()[1].contextWindow, null);
  await journal.flush();
});

test("a corrupt journal is set aside, not overwritten", async (t) => {
  const dir = tempDir(t);
  fs.writeFileSync(path.join(dir, "activity.json"), "{ not json");
  const journal = new RequestJournal({ dir });
  assert.equal(journal.list().length, 0);
  // The broken file survives for forensics instead of being erased by the
  // next save, which would lose the history twice over.
  assert.equal(fs.existsSync(path.join(dir, "activity.json.corrupt")), true);
  journal.start({ agent: "codex", endpoint: "/v1/responses", model: "hy3" });
  await journal.flush();
  const rows = JSON.parse(fs.readFileSync(path.join(dir, "activity.json"), "utf8"));
  assert.equal(rows.length, 1);
  assert.equal(fs.existsSync(path.join(dir, "activity.json.corrupt")), true);
});

test("a running row older than a day counts as crashed even if its pid lives", async (t) => {
  const dir = tempDir(t);
  // Windows recycles pids: whatever process now owns the recorded pid does
  // not make the row alive. Older than any real generation settles it.
  const other = await livePid();
  t.after(() => other.kill());
  fs.writeFileSync(path.join(dir, "activity.json"), JSON.stringify([{
    id: "zombie",
    owner: other.pid,
    status: "running",
    startedAt: Date.now() - 25 * 60 * 60 * 1000,
    finishedAt: null,
    durationMs: null
  }]));
  const journal = new RequestJournal({ dir });
  const [row] = journal.list();
  assert.equal(row.status, "error");
  assert.match(row.error, /尚未完成/);
});
