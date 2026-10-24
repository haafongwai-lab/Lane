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

test("credits come from the upstream's own report, not from arithmetic", async (t) => {
  const dir = tempDir(t);
  const journal = new RequestJournal({ dir });
  // The exact usage object WorkBuddy's stream carries (measured on a real
  // account): `credit` is what the quota meter moves by — 8.60 credits for a
  // 45k-token request — while the token formula would have said 0.03.
  const record = journal.start({ agent: "codex", endpoint: "/v1/responses", model: "glm-5.3", rate: 0.69 });
  journal.usage(record.id, {
    prompt_tokens: 45_000,
    completion_tokens: 500,
    total_tokens: 45_500,
    prompt_cache_hit_tokens: 0,
    credit: 7.28
  });
  const [row] = journal.list();
  assert.equal(row.credits, 7.28);
  assert.equal(row.creditsSource, "upstream");
  await journal.flush();
});

test("cache hits are read from the field the upstream actually fills", async (t) => {
  const dir = tempDir(t);
  const journal = new RequestJournal({ dir });
  // This build's `cached_tokens` stays 0 while prompt_tokens_details carries
  // the hit; reading only the first made every row look uncached.
  const record = journal.start({ agent: "claude-desktop", endpoint: "/v1/messages", model: "deepseek-v4.1-flash", rate: 0.11 });
  journal.usage(record.id, {
    prompt_tokens: 20_013,
    completion_tokens: 50,
    total_tokens: 20_063,
    cached_tokens: 0,
    prompt_tokens_details: { cached_tokens: 19_840 },
    credit: 0.01
  });
  const [row] = journal.list();
  assert.equal(row.cachedTokens, 19_840);
  assert.equal(row.credits, 0.01);
  await journal.flush();
});

test("a cache hit larger than its input is clamped to the input", async (t) => {
  const dir = tempDir(t);
  const journal = new RequestJournal({ dir });
  const record = journal.start({ agent: "claude-desktop", endpoint: "/v1/messages", model: "hy3", rate: 0 });
  journal.usage(record.id, { prompt_tokens: 1000, completion_tokens: 0, prompt_cache_hit_tokens: 5000 });
  assert.equal(journal.list()[0].cachedTokens, 1000);
  await journal.flush();
});

test("a request the upstream does not cost is an estimate at the calibrated price", async (t) => {
  const dir = tempDir(t);
  const journal = new RequestJournal({ dir });
  // A usage report with no `credit` — an older build's upstream, or a proxy
  // that strips it — falls back to the token formula, priced at what the
  // upstream actually charged for the model on its billed rows; the
  // catalogue's relative multiple is not a price and never costs.
  const priced = journal.start({ agent: "codex", endpoint: "/v1/responses", model: "hy3", rate: 0.02 });
  journal.usage(priced.id, { prompt_tokens: 1_000_000, completion_tokens: 0, credit: 5 });
  const record = journal.start({ agent: "codex", endpoint: "/v1/responses", model: "hy3", rate: 0.02 });
  journal.usage(record.id, { prompt_tokens: 250_000, completion_tokens: 250_000 });
  const rows = journal.list();
  assert.equal(rows[0].totalTokens, 500_000);
  assert.equal(rows[0].credits, 2.5);
  assert.equal(rows[0].creditsSource, "estimate");
  assert.equal(rows[1].credits, 5);
  assert.equal(rows[1].creditsSource, "upstream");

  // A model with no billed history has no calibrated price, so the row
  // stays uncosted rather than being counted as free — or priced by a
  // multiple that is not a price.
  const unknown = journal.start({ agent: "codex", endpoint: "/v1/responses", model: "mystery" });
  journal.usage(unknown.id, { prompt_tokens: 1000, completion_tokens: 0 });
  assert.equal(journal.list()[0].credits, null);
  await journal.flush();
});

test("a request remembers the project it came from", async (t) => {
  const dir = tempDir(t);
  const journal = new RequestJournal({ dir });
  journal.start({
    agent: "codex", endpoint: "/v1/responses", model: "hy3",
    project: "c:\\repo\\lane", projectName: "lane"
  });
  const [row] = journal.list();
  assert.equal(row.project, "c:\\repo\\lane");
  assert.equal(row.projectName, "lane");

  // A client that names no directory keeps an empty project rather than a
  // made-up bucket.
  journal.start({ agent: "openai", endpoint: "/v1/chat/completions", model: "hy3" });
  assert.equal(journal.list()[0].project, "");
  assert.equal(journal.list()[0].projectName, "");
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

test("an unreadable-but-present journal is never overwritten", async (t) => {
  // A persistent read failure (a directory in the file's place stands in for
  // a locked file): the journal keeps running in memory but its writes are
  // held back, so the unreadable original survives instead of being replaced
  // by a journal that started empty.
  const dir = tempDir(t);
  fs.mkdirSync(path.join(dir, "activity.json"));
  const journal = new RequestJournal({ dir });
  const record = journal.start({ agent: "codex", endpoint: "/v1/responses", model: "hy3" });
  journal.usage(record.id, { prompt_tokens: 10, completion_tokens: 2 });
  await journal.flush();
  // Still a directory — nothing was written over it.
  assert.ok(fs.statSync(path.join(dir, "activity.json")).isDirectory());
  // The in-memory row is intact for the running session.
  assert.equal(journal.list()[0].totalTokens, 12);
});

test("crash-leftover tmp files are cleaned on load", async (t) => {
  const dir = tempDir(t);
  fs.writeFileSync(path.join(dir, "activity.json.999999.tmp"), "[]");
  fs.writeFileSync(path.join(dir, "unrelated.json.999999.tmp"), "[]");
  new RequestJournal({ dir });
  assert.equal(fs.existsSync(path.join(dir, "activity.json.999999.tmp")), false);
  assert.equal(fs.existsSync(path.join(dir, "unrelated.json.999999.tmp")), true);
});
