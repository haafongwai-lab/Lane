import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { processAlive } from "./pid.js";

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

// The pid rules live in pid.js: a live owner's rows are never mistaken for a
// crash, and a row that names no process at all (pid 0, an empty owner) is not
// a live owner.

// The credits WorkBuddy says the request cost, in the unit its billing page
// counts. Absent (undefined) when the upstream did not send one, which is not
// the same as free — a free model still sends 0.
export function credited(usage = {}) {
  const value = usage.credit ?? usage.credits;
  return Number.isFinite(value) ? value : undefined;
}

// The token formula, for rows the upstream does not cost on its own. It is
// Lane's own arithmetic and does not equal the meter — on real traffic it
// lands around 1/230th of it — so callers label the result an estimate.
export function estimatedCredits(request = {}) {
  if (!Number.isFinite(request.rate)) return null;
  return ((request.inputTokens || 0) + (request.outputTokens || 0)) / 1_000_000 * request.rate;
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

  start({ agent, endpoint, requestedModel, model, accountId, rate, contextWindow, project, projectName }) {
    const request = {
      id: randomUUID().replaceAll("-", ""),
      owner: process.pid,
      agent,
      // The working directory the request came from, as `projectOf` read it;
      // empty when the client names none, which the usage page reports as
      // unattributed rather than bucketing it under a made-up project.
      project: project || "",
      projectName: projectName || "",
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
      // Null until the upstream reports a cost: 0 would claim the request was
      // free, which is a different thing from "not billed yet".
      credits: null,
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

  /**
   * The numbers WorkBuddy itself reported for the request.
   *
   * `credit` is the one that matters: it is what the request drew from the
   * account's quota, in the same credits the billing page counts. Lane used
   * to cost a request as `(tokens ÷ 1,000,000) × rate` and call that credits;
   * measured against a real account that figure came out about 1/230th of
   * what the quota actually moved, because `rate` is a per-million-token
   * multiple on a much smaller scale than the meter. The upstream number is
   * kept as sent and only the token formula (now labelled an estimate) is
   * left for rows the upstream does not cost.
   *
   * Cache reads are reported three ways and any of them may be the one the
   * upstream fills: `cached_tokens` is 0 on this build while
   * `prompt_cache_hit_tokens` and `prompt_tokens_details.cached_tokens`
   * carry the hit — reading only the first made every row look uncached.
   */
  usage(id, usage = {}) {
    const request = this.requests.find((entry) => entry.id === id);
    if (!request) return;
    request.inputTokens = usage.input_tokens || usage.prompt_tokens || request.inputTokens;
    request.outputTokens = usage.output_tokens || usage.completion_tokens || request.outputTokens;
    request.totalTokens = usage.total_tokens || request.totalTokens ||
      request.inputTokens + request.outputTokens;
    const cached = usage.input_tokens_details?.cached_tokens
      || usage.prompt_tokens_details?.cached_tokens
      || usage.prompt_cache_hit_tokens
      || usage.cache_read_input_tokens
      || usage.cached_tokens
      || 0;
    // A hit can never exceed the input it came from; the field that says so
    // outranks a stale one left from an earlier chunk.
    request.cachedTokens = Math.min(cached, request.inputTokens || cached);
    const billed = credited(usage);
    if (billed !== undefined) {
      request.credits = billed;
      request.creditsSource = "upstream";
    } else {
      // No upstream number: the token formula fills in, but it is an
      // estimate on a much smaller scale than the meter, and the summary
      // keeps the two apart.
      request.credits = estimatedCredits(request);
      request.creditsSource = "estimate";
    }
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
