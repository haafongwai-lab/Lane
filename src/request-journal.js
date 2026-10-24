import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { processAlive } from "./pid.js";
import { billedRates } from "./usage.js";

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

// The token formula, for rows the upstream does not cost on its own. The
// price must be a calibrated credits-per-million figure (see `billedRates`
// in usage.js): the catalogue's relative multiple is not a price, and
// costing with it understated real charges by orders of magnitude. Without
// a calibrated price the row stays uncosted — no number beats a wrong one.
export function estimatedCredits(request = {}, price) {
  if (!Number.isFinite(price) || price <= 0) return null;
  return ((request.inputTokens || 0) + (request.outputTokens || 0)) / 1_000_000 * price;
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
    } catch (error) {
      // No file yet is a fresh start. A file that exists but cannot be read
      // (an indexer or antivirus holding it) is not: writing over it later
      // with a journal that started empty would erase the only history, so
      // the journal goes read-only until a load succeeds. Whatever rows the
      // session already holds stay in memory — clearing them would serve
      // no one.
      if (error?.code === "ENOENT") {
        this.requests = [];
        this.rebuildBilledRates();
        this.cleanupTmp();
        return;
      }
      this.readOnly = true;
      this.rebuildBilledRates();
      console.error(`lane: the request journal at ${this.file} could not be read (${error?.code || error?.message}); it stays untouched until it reads again`);
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
      this.readOnly = false;
      this.prune();
    } catch {
      // A file that does not parse is corrupt — a crash can land a
      // half-written file on disk. It is set aside for forensics rather than
      // deleted: the next save would otherwise overwrite the only copy of
      // the history with a journal that holds nothing. When even the
      // set-aside fails (the corrupt file is held too), the journal goes
      // read-only rather than perform that overwrite itself.
      const quarantined = `${this.file}.corrupt`;
      try { fs.rmSync(quarantined, { force: true }); } catch {}
      let setAside = true;
      try { fs.renameSync(this.file, quarantined); } catch { setAside = false; }
      this.requests = [];
      if (setAside) {
        this.readOnly = false;
        console.error(`lane: the request journal at ${this.file} is unreadable; it is kept as ${path.basename(quarantined)} and a new journal starts`);
      } else {
        this.readOnly = true;
        console.error(`lane: the request journal at ${this.file} is unreadable and could not be set aside; it is never overwritten`);
      }
    }
    this.rebuildBilledRates();
    this.cleanupTmp();
  }

  // Crash leftovers from the write-below-rename window. Their pid-suffixed
  // names are never reused, so nothing else will remove them.
  cleanupTmp() {
    try {
      const entries = fs.readdirSync(this.dir);
      const prefix = `${path.basename(this.file)}.`;
      for (const entry of entries) {
        if (!entry.startsWith(prefix) || !entry.endsWith(".tmp")) continue;
        try { fs.rmSync(path.join(this.dir, entry), { force: true }); } catch {}
      }
    } catch {}
  }

  // The calibrated price of a model, from what the upstream actually charged
  // for it — the only honest way to cost a row the upstream did not price,
  // since the catalogue's relative multiple is not a price at all.
  rebuildBilledRates() {
    this.billedRates = billedRates(this.requests);
  }

  calibratedPrice(model) {
    return this.billedRates?.get(model) ?? null;
  }

  // A billed row just landed: refresh the running prices so the next
  // estimate prices with it. The journal is capped (MAX_ROWS), so a full
  // rescan is cheap and stays consistent with prune and reload.
  noteBilled() {
    this.rebuildBilledRates();
  }

  // Totals are read per day and per model, so the journal keeps a longer
  // history than the request list shows; a busy month still fits in a file
  // the desktop app can parse on every status poll. What leaves the list
  // leaves the calibrated prices too, or row-level estimates would be priced
  // by a stale snapshot while the summary recomputes from what remains.
  prune(now = Date.now()) {
    const cutoff = now - KEEP_DAYS * 24 * 60 * 60 * 1000;
    this.requests = this.requests
      .filter((request) => request.startedAt >= cutoff)
      .slice(0, MAX_ROWS);
    this.rebuildBilledRates();
  }

  /**
   * Everything from before today's local midnight goes. Rows still running
   * survive regardless of when they started - a deletion must not erase a
   * live request the gateway is billing right now.
   */
  clearBeforeToday(now = Date.now()) {
    const midnight = new Date(now);
    midnight.setHours(0, 0, 0, 0);
    const cutoff = midnight.getTime();
    const kept = this.requests.filter(
      (request) => request.startedAt >= cutoff || request.status === "running"
    );
    const removed = this.requests.length - kept.length;
    this.requests = kept.slice(0, MAX_ROWS);
    this.rebuildBilledRates();
    this.save();
    return removed;
  }

  /**
   * Removes exactly the named rows. Running rows are never removed, and an
   * unknown id is simply not present - the caller gets back how many went.
   */
  removeByIds(ids = []) {
    const drop = new Set((Array.isArray(ids) ? ids : []).filter((id) => typeof id === "string"));
    if (!drop.size) return 0;
    const kept = this.requests.filter(
      (request) => !drop.has(request.id) || request.status === "running"
    );
    const removed = this.requests.length - kept.length;
    this.requests = kept;
    this.rebuildBilledRates();
    this.save();
    return removed;
  }

  /**
   * How many rows a clear would drop. The status snapshot carries this so
   * the UI's button reflects the whole journal - the recent list only holds
   * the newest rows, and a busy day fills it entirely with today's traffic,
   * hiding old history that is exactly what the button is for.
   */
  countBeforeToday(now = Date.now()) {
    const midnight = new Date(now);
    midnight.setHours(0, 0, 0, 0);
    const cutoff = midnight.getTime();
    return this.requests.filter(
      (request) => request.startedAt < cutoff && request.status !== "running"
    ).length;
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
    this.rebuildBilledRates();
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
      this.noteBilled();
    } else {
      // No upstream number: the token formula fills in, priced at the
      // model's calibrated credits-per-million. Without a calibrated price
      // the row stays uncosted — the catalogue's relative multiple is not a
      // price, and a fabricated one understates the charge wildly.
      request.credits = estimatedCredits(request, this.calibratedPrice(request.model));
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
    // A journal that could not read its file holds only what arrived after
    // the failure; writing would replace the unreadable original with that
    // near-empty list. Each write first tries to recover — the failure is
    // usually a transient lock — and a recovery that still fails means
    // still no write.
    if (this.readOnly && !this.recover()) return Promise.resolve();
    const run = this.writing.then(() => this.writeNow());
    this.writing = run.catch(() => {});
    return run;
  }

  // One attempt to come back from a read failure: re-read the file and fold
  // the rows this session kept in memory over it, so nothing is lost on
  // either side. False while the file still cannot be read.
  recover() {
    let rows;
    try {
      rows = JSON.parse(fs.readFileSync(this.file, "utf8"));
    } catch {
      return false;
    }
    const merged = new Map();
    for (const row of Array.isArray(rows) ? rows : []) {
      if (Number.isFinite(row?.startedAt)) merged.set(row.id, row);
    }
    for (const row of this.requests) merged.set(row.id, row);
    this.requests = [...merged.values()]
      .sort((a, b) => b.startedAt - a.startedAt)
      .slice(0, MAX_ROWS);
    this.readOnly = false;
    this.rebuildBilledRates();
    return true;
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
