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
// pretty JSON several times per request. finish() cancels the debounce and
// flushes at once, so a completed request is written the moment it ends;
// the write itself is async, and a final flush is awaited at shutdown.
const SAVE_DEBOUNCE_MS = 250;
// A request that has been "running" for a day is not running: Windows
// recycles pids, so the liveness check on the recorded owner can be fooled
// by whatever process inherited the pid. Longer than any real generation.
const MAX_RUN_MS = 24 * 60 * 60 * 1000;

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
    let saved;
    try {
      saved = fs.readFileSync(this.file, "utf8");
    } catch {
      // No file yet, or a transient read error (an indexer or antivirus
      // holding the file). Starting empty is right either way; a file that
      // exists is left exactly as it is.
      this.requests = [];
      return;
    }
    try {
      const rows = JSON.parse(saved);
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
          if (request.status !== "running") continue;
          const crashed = (request.owner !== process.pid && !processAlive(request.owner))
            || Date.now() - request.startedAt > MAX_RUN_MS;
          if (crashed) {
            request.status = "error";
            request.error = "Lane 上次退出时请求尚未完成";
            request.finishedAt = request.finishedAt || Date.now();
            request.durationMs = request.finishedAt - request.startedAt;
          }
        }
      }
      this.prune();
    } catch {
      // A file that does not parse is corrupt — a crash can land a
      // half-written file on disk. It is set aside for forensics rather than
      // deleted: the next save would otherwise overwrite the only copy of
      // the history with a journal that holds nothing.
      const quarantined = `${this.file}.corrupt`;
      try { fs.rmSync(quarantined, { force: true }); } catch {}
      try { fs.renameSync(this.file, quarantined); } catch {}
      this.requests = [];
      console.error(`lane: the request journal at ${this.file} is unreadable; it is kept as ${path.basename(quarantined)} and a new journal starts`);
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

  start({ agent, endpoint, requestedModel, model, accountId, rate, contextWindow }) {
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
      // The model's context window under the same rule: the request's tokens
      // are read against the window it was actually served in. The upstream
      // reports 0 when it cannot say, which reads as unknown here.
      contextWindow: Number.isFinite(contextWindow) && contextWindow > 0 ? contextWindow : null,
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
    if (!request) return Promise.resolve();
    Object.assign(request, values, {
      status: values.status || "complete",
      finishedAt: Date.now()
    });
    request.durationMs = request.finishedAt - request.startedAt;
    // The request is over: cancel the debounce and write now, so a crash
    // right after cannot leave it running forever.
    return this.flush();
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
      // Solved is solved: a failure after a successful write must be
      // reported again, not swallowed by the last outage's flag.
      this.writeFailed = false;
    } catch (error) {
      // A journal that cannot be written must at least say so: losing the
      // day's accounting silently (disk full, directory deleted) reads as a
      // gateway that records nothing. Once per failure streak — the flag
      // clears on the first successful write.
      if (!this.writeFailed) {
        this.writeFailed = true;
        console.error(`lane: cannot save the request journal to ${this.file}: ${error?.message || error}`);
      }
    }
  }
}
