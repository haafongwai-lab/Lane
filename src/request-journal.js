import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

const KEEP_DAYS = 120;
const MAX_ROWS = 6000;
// The window polls status every 3 seconds; sending the whole journal each
// time would repeat tens of kilobytes that only the usage page reads.
const MAX_RECENT = 20;
const TRIM_EVERY = 200;
// start/note/usage arrive in bursts inside one request's lifetime; merging
// them into one write keeps a busy gateway from sync-writing megabytes of
// pretty JSON several times per request. finish() flushes at once, so a
// completed request is on disk before its answer leaves.
const SAVE_DEBOUNCE_MS = 250;

// EPERM says the pid exists but belongs to someone else; only ESRCH says it
// is gone. Anything unknown reads as alive, so a live owner's rows are never
// mistaken for a crash.
function processAlive(pid) {
  if (!Number.isFinite(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

export class RequestJournal {
  constructor({ dir, shared = false }) {
    this.dir = dir;
    this.file = path.join(dir, "activity.json");
    // A secondary window owns no requests; it reads the file the gateway's
    // process writes and follows it as it changes.
    this.shared = shared;
    this.requests = [];
    this.saveTimer = null;
    this.writing = Promise.resolve();
    this.writeFailed = false;
    this.load();
  }

  load() {
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, "utf8"));
      const rows = Array.isArray(saved) ? saved : [];
      // A row without a starting time can't be placed in a day; drop it
      // rather than let it count towards a total nothing can attribute.
      this.requests = rows
        .filter((request) => Number.isFinite(request?.startedAt))
        .slice(0, MAX_ROWS);
      // Only the process that owns the file rewrites rows left running: its
      // own are in flight. Another Lane's rows are that Lane's business — a
      // second process used to mark them failed on sight, breaking the
      // owner's own view of its live requests; now only a pid that no longer
      // exists counts as a crash.
      if (!this.shared) {
        for (const request of this.requests) {
          if (request.status === "running" && request.owner !== process.pid && !processAlive(request.owner)) {
            request.status = "error";
            request.error = "Lane 上次退出时请求尚未完成";
            request.finishedAt = request.finishedAt || Date.now();
            request.durationMs = request.finishedAt - request.startedAt;
          }
        }
      }
      this.prune();
    } catch {
      this.requests = [];
    }
  }

  // Totals are read per day and per model, so the journal keeps a longer
  // history than the request list shows; a busy month still fits in a file
  // the desktop app can parse on every status poll.
  prune(now = Date.now()) {
    const cutoff = now - KEEP_DAYS * 24 * 60 * 60 * 1000;
    this.requests = this.requests
      .filter((request) => request.startedAt >= cutoff)
      .slice(0, MAX_ROWS);
  }

  start({ agent, endpoint, requestedModel, model, accountId, rate }) {
    const request = {
      id: randomUUID().replaceAll("-", ""),
      owner: process.pid,
      agent,
      endpoint,
      requestedModel: requestedModel || "",
      model: model || requestedModel || "",
      accountId: accountId || "",
      // The model's credit multiple at the time of the request: a catalogue
      // that changes later must not rewrite what this request already cost.
      rate: Number.isFinite(rate) ? rate : null,
      status: "running",
      startedAt: Date.now(),
      finishedAt: null,
      durationMs: null,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      cachedTokens: 0,
      credits: 0,
      firstTextMs: null,
      error: ""
    };
    this.requests.unshift(request);
    this.requests = this.requests.slice(0, MAX_ROWS);
    this.started = (this.started || 0) + 1;
    // The day limit is not checked on every request: once the list is long
    // enough for it to matter, checking every couple of hundred starts keeps
    // a long-running gateway from growing a journal nothing ever trims.
    if (this.started % TRIM_EVERY === 0) this.prune();
    this.save();
    return request;
  }

  finish(id, values = {}) {
    const request = this.requests.find((entry) => entry.id === id);
    if (!request) return;
    Object.assign(request, values, {
      status: values.status || "complete",
      finishedAt: Date.now()
    });
    request.durationMs = request.finishedAt - request.startedAt;
    // The request is over: its final state reaches the disk now, so a crash
    // right after cannot leave it running forever.
    this.flush();
  }

  usage(id, usage = {}) {
    const request = this.requests.find((entry) => entry.id === id);
    if (!request) return;
    request.inputTokens = usage.input_tokens || usage.prompt_tokens || request.inputTokens;
    request.outputTokens = usage.output_tokens || usage.completion_tokens || request.outputTokens;
    request.totalTokens = usage.total_tokens || request.totalTokens ||
      request.inputTokens + request.outputTokens;
    request.cachedTokens = usage.input_tokens_details?.cached_tokens ||
      usage.prompt_tokens_details?.cached_tokens || request.cachedTokens;
    // WorkBuddy bills a model by the multiple it shows in the picker, so the
    // request's cost is that multiple per million tokens on both sides.
    request.credits = Number.isFinite(request.rate)
      ? ((request.inputTokens + request.outputTokens) / 1_000_000) * request.rate
      : null;
    this.save();
  }

  note(id, values = {}) {
    const request = this.requests.find((entry) => entry.id === id);
    if (!request) return;
    Object.assign(request, values);
    this.save();
  }

  list() {
    // The gateway's own journal changes only through its requests, so its
    // copy is the truth. A reader's copy would go stale, so it re-reads
    // the file on every read instead.
    if (this.shared) this.load();
    return this.requests;
  }

  // What the status snapshot carries: enough for the route card and the
  // activity list, without repeating the whole journal every poll.
  recent(limit = MAX_RECENT) {
    return this.list().slice(0, limit);
  }

  // Merges a burst of changes into one write, shortly from now.
  save() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.write();
    }, SAVE_DEBOUNCE_MS);
    this.saveTimer.unref?.();
  }

  // Cancels the debounce and writes now. Awaited by shutdown and by every
  // request's finish.
  flush() {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    return this.write();
  }

  write() {
    // A shared journal follows the owner's file; flushing its own stale
    // snapshot over the owner's newer rows would lose them, so a reader
    // never writes.
    if (this.shared) return Promise.resolve();
    const run = this.writing.then(() => this.writeNow());
    this.writing = run.catch(() => {});
    return run;
  }

  async writeNow() {
    try {
      await fsp.mkdir(this.dir, { recursive: true });
      const target = `${this.file}.${process.pid}.tmp`;
      await fsp.writeFile(target, `${JSON.stringify(this.requests, null, 2)}\n`, "utf8");
      await fsp.rename(target, this.file);
    } catch (error) {
      // A journal that cannot be written must at least say so once: losing
      // the day's accounting silently (disk full, directory deleted) reads
      // as a gateway that records nothing.
      if (!this.writeFailed) {
        this.writeFailed = true;
        console.error(`lane: cannot save the request journal to ${this.file}: ${error?.message || error}`);
      }
    }
  }
}
