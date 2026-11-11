import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { processAlive } from "./pid.js";
import { billedRates } from "./usage.js";
import { kindFromText } from "./error-kind.js";
import { redactForLog } from "./redact.js";

const KEEP_DAYS = 120;
// How many rows the journal keeps. This used to be 6000, which silently
// capped the usage page: the trend chart counts the rows it is given, so once
// a busy account passed 6000 requests the daily counts stopped rising and the
// totals froze at whatever the last 6000 rows happened to hold. The window is
// still bounded — 120 days is the real limit — but the row cap has to sit well
// above what a normal account produces in that window, or it becomes a data
// loss the user never sees. Override with LANE_JOURNAL_MAX_ROWS.
const MAX_ROWS = Number(process.env.LANE_JOURNAL_MAX_ROWS) || 60000;
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

// The journal is a log, not a document. A row is rewritten several times
// over its life (start, note, usage, finish), and the old store wrote the
// whole array — pretty-printed — on every one of those changes: at thousands
// of rows that is megabytes of serialisation and disk per request, and it
// grows with every day of use. One line per change makes each write O(1), and
// a torn final line from a crash costs one row instead of the entire history.
const FILE_NAME = "activity.jsonl";
// The array-in-a-file the first versions wrote. Read once, converted to the
// log on first load, then removed.
const LEGACY_NAME = "activity.json";
// Appends allowed between compactions. Compaction rewrites the file as one
// line per surviving row; doing it after this many appends keeps the file
// within roughly twice MAX_ROWS lines. It scales with MAX_ROWS so raising the
// row cap does not turn every few hundred requests into a full rewrite.
const COMPACT_AFTER = Math.max(2000, Math.floor(MAX_ROWS / 6));
// The floor a charge has to clear before it is examined at all. This is the
// vendor's own number, so a cheap request is never even compared: below it,
// being a few times the usual is noise, not money.
const ANOMALY_CREDITS = Number(process.env.LANE_ALERT_CREDITS) || 5;

// Cost alone is not the signal, and the measured data says so plainly: of the
// 39 requests billed at five credits or more on this machine, all but two were
// a cold read of a 300k-800k-token prompt. Sending a whole conversation with
// no cached prefix is the model's own tariff - a 300k prompt costs an order of
// magnitude more than the same prompt served from cache - and flagging it told
// the user nothing they could act on.
//
// What does deserve a callout is a request billed like an expensive one while
// the cache was doing its job: a large prefix was reused and the charge still
// ran away. That is the shape a lost cache discount or a duplicated prompt
// takes, and it is the only shape the journal actually contains an outlier
// for.
//
// The comparison is against comparable requests, not against the model's
// overall median. A model's median is dragged down by small traffic: an
// 861k-token request sat 10.7x above its model's median while being billed
// correctly, because most of that model's requests are tiny. Comparing only
// with rows of a similar prompt size and a similar cache share removes that
// size effect, and the measured spread among those peers is 0.95x-1.03x.
// The ratio below is twice the worst legitimate case seen, which leaves room
// for a busy user while still catching the thing that actually goes wrong:
// losing the cache discount multiplies a charge by 10x to 100x.
const ANOMALY_CACHE_MIN_REUSE = 0.5;
// How far above its comparable requests a charge must land before it is worth
// interrupting the user about.
const ANOMALY_RATIO = Number(process.env.LANE_ALERT_RATIO) || 2;
// How many comparable requests must already be in the journal before the
// comparison means anything. A model seen a handful of times has no "usual".
const ANOMALY_PEERS = 3;
// Two requests count as comparable when their prompt sizes are within this
// factor of each other — a 300k prompt is not comparable to a 30k one — and
// their cache reuse is within this much of each other, since an uncached
// prefix and a cached one are billed at different rates.
const ANOMALY_SIZE_SPAN = 3;
const ANOMALY_REUSE_SPAN = 0.25;

// The identity of the legacy array this log has already absorbed: its mtime
// and size. Persisted rather than held in memory, because the conversion has
// to stay done across restarts.
function readStamp(file) {
  try {
    return fs.readFileSync(file, "utf8").trim();
  } catch {
    return "";
  }
}

function writeStamp(file, stamp) {
  try {
    fs.writeFileSync(file, stamp, "utf8");
  } catch {}
}

// The pid rules live in pid.js: a live owner's rows are never mistaken for a
// crash, and a row that names no process at all (pid 0, an empty owner) is not
// a live owner.

/**
 * The log as rows, latest state per id. A row can appear several times — it
 * is appended on start, on each note and on finish — so the last line for an
 * id is the one that counts. Lines that do not parse are a torn write from a
 * crash; they are counted and skipped rather than failing the whole load.
 */
function parseLog(text) {
  const byId = new Map();
  let badLines = 0;
  for (const line of String(text).split("\n")) {
    if (!line.trim()) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      badLines += 1;
      continue;
    }
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      badLines += 1;
      continue;
    }
    // A row with no id cannot be deduplicated; it is still a row, but it
    // must be told apart from the one it supersedes, so it is kept under a
    // synthetic key rather than dropped.
    const key = typeof row.id === "string" && row.id ? row.id : `#${byId.size}`;
    byId.set(key, row);
  }
  return { rows: [...byId.values()], badLines };
}

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
    this.file = path.join(dir, FILE_NAME);
    this.legacyFile = path.join(dir, LEGACY_NAME);
    // Remembers which legacy file was already converted, so a start does not
    // repeat work whose result is already in the log. Kept beside the log
    // because it is part of the journal's state, not a preference.
    this.stampFile = path.join(dir, `${FILE_NAME}.migrated`);
    // A secondary window owns no requests; it reads the file the gateway's
    // process writes and follows it as it changes.
    this.shared = shared;
    this.requests = [];
    this.saveTimer = null;
    this.writing = Promise.resolve();
    this.writeFailed = false;
    // Changes not yet appended. Each entry is the row as it stood when the
    // change happened; the latest line for an id wins on reload.
    this.pending = new Map();
    this.appends = 0;
    this.load();
  }

  load() {
    // The array-in-a-file from older versions is converted before anything
    // else looks for the log: a user upgrading mid-day must keep the rows
    // their history already held.
    this.migrateLegacy();

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
        this.markRead();
        return;
      }
      this.readOnly = true;
      this.rebuildBilledRates();
      console.error(`lane: the request journal at ${this.file} could not be read (${error?.code || error?.message}); it stays untouched until it reads again`);
      this.markRead();
      return;
    }

    const { rows, badLines } = parseLog(saved);
    // A line that does not parse is a torn write from a crash, not a
    // corrupt history: the log's whole point is that one bad line costs one
    // row. It is counted and reported, never quarantined wholesale.
    if (badLines) {
      console.error(`lane: ${badLines} line(s) in ${path.basename(this.file)} could not be read and were skipped`);
    }
    this.requests = rows
      .filter((request) => Number.isFinite(request?.startedAt))
      .sort((a, b) => b.startedAt - a.startedAt)
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
    // prune() drops rows outside the window, re-derives the calibrated prices
    // from what is left, and re-judges every surviving flag — including the
    // ones a previous build wrote, under whatever rule it had.
    this.prune();
    this.cleanupTmp();
    this.markRead();
  }

  /** Remembers the file's identity so an unchanged file is not re-read. */
  markRead() {
    try {
      const stat = fs.statSync(this.file);
      this.lastStamp = `${stat.mtimeMs}:${stat.size}`;
    } catch {
      this.lastStamp = "";
    }
  }

  /**
   * Converts the old `activity.json` array into the log, once.
   *
   * The legacy file is removed only after the log has been written, so a
   * conversion that cannot finish leaves the original in place for the next
   * start to retry. Rows the log already holds are not dropped: a machine
   * that ran the new build and then met an old file again (a backup
   * restored, a second install sharing the directory) keeps both, with the
   * log's own rows winning because they are written last.
   */
  migrateLegacy() {
    let text;
    let stamp;
    try {
      const stat = fs.statSync(this.legacyFile);
      // A legacy file this journal has already converted is skipped. An old
      // build still installed beside this one keeps rewriting that file —
      // observed on a real machine, where the previous release ran throughout
      // — so without this the conversion ran on every start and rewrote the
      // whole log each time, for rows that were already in it.
      stamp = `${stat.mtimeMs}:${stat.size}`;
      if (stamp === this.migratedStamp || stamp === readStamp(this.stampFile)) return;
      text = fs.readFileSync(this.legacyFile, "utf8");
    } catch {
      return;
    }
    let rows;
    try {
      rows = JSON.parse(text);
      if (!Array.isArray(rows)) throw new Error("not an array");
    } catch {
      // An unreadable legacy file is set aside for forensics, exactly as the
      // old loader did, and the log starts empty.
      try { fs.renameSync(this.legacyFile, `${this.legacyFile}.corrupt`); } catch {
        console.error(`lane: the old journal at ${this.legacyFile} is unreadable and could not be set aside`);
      }
      return;
    }
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      const kept = rows.filter((row) => Number.isFinite(row?.startedAt));
      let existing = "";
      try {
        existing = fs.readFileSync(this.file, "utf8");
      } catch {}
      // One line per row, the log's own rows last so they supersede any
      // older copy of the same request from the array.
      const body = kept.map((row) => `${JSON.stringify(row)}\n`).join("");
      const merged = `${existing}${existing && !existing.endsWith("\n") ? "\n" : ""}${body}`;
      // The merge is idempotent in content but not in bytes: running it
      // again appends a second copy of every row. A log that now carries the
      // same ids twice is rewritten to one line each, so a legacy file that
      // refuses to go away (a running instance still holding it) cannot grow
      // the journal without bound.
      const { rows: deduped } = parseLog(merged);
      fs.writeFileSync(
        this.file,
        `${deduped.map((row) => `${JSON.stringify(row)}\n`).join("")}`,
        { encoding: "utf8", mode: 0o600 }
      );
      this.migratedStamp = stamp;
      writeStamp(this.stampFile, stamp);
      // Only now is the legacy file redundant. A failure to remove it is
      // harmless: the stamp above stops the next start from converting the
      // same bytes again.
      fs.rmSync(this.legacyFile, { force: true });
      console.error(`lane: converted ${kept.length} request(s) to ${path.basename(this.file)}`);
    } catch (error) {
      // The log was not written: leave the old file in place so nothing is
      // lost, and let the next start try again.
      console.error(`lane: could not convert the old journal: ${error?.message || error}`);
    }
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

  /**
   * The charge a request is judged against: the median of comparable
   * requests made before it.
   *
   * Comparable means the same model, a prompt of a similar size, and a
   * similar cache share — those are the two things that move a charge by
   * orders of magnitude, and holding them fixed leaves only the price. A
   * median rather than a mean, so one runaway request does not raise the bar
   * that decides whether the next one is a runaway.
   *
   * Returns null until enough comparable rows exist to call anything usual:
   * a model seen a handful of times has no baseline, and saying nothing is
   * the honest answer.
   */
  typicalCharge(request, pool) {
    const size = request.inputTokens || 0;
    const reuse = size ? (request.cachedTokens || 0) / size : 0;
    const seen = [];
    for (const row of pool) {
      if (row.id === request.id) continue;
      // Only what had already happened: a later request must not rewrite the
      // judgement of an earlier one, or a reload would not reproduce what the
      // live run showed.
      if (row.startedAt > request.startedAt) continue;
      if (row.creditsSource !== "upstream") continue;
      if (!Number.isFinite(row.credits) || row.credits <= 0) continue;
      const rowSize = row.inputTokens || 0;
      if (!rowSize) continue;
      if (rowSize * ANOMALY_SIZE_SPAN < size || size * ANOMALY_SIZE_SPAN < rowSize) continue;
      if (Math.abs((row.cachedTokens || 0) / rowSize - reuse) > ANOMALY_REUSE_SPAN) continue;
      seen.push(row.credits);
    }
    if (seen.length < ANOMALY_PEERS) return null;
    seen.sort((a, b) => a - b);
    return seen[Math.floor(seen.length / 2)];
  }

  /**
   * Sets or clears a row's anomaly flag from the current rule.
   *
   * Only an upstream-billed charge can be anomalous: a row whose cost came
   * from the token formula must never have the gateway alarming about its own
   * guess.
   */
  judge(request, pool = this.requests) {
    request.anomaly = undefined;
    if (request.creditsSource !== "upstream") return;
    const billed = request.credits;
    // The two cheap tests come first and decide most rows. That is what keeps
    // a full re-judge affordable: only a row billed high with a working cache
    // ever scans for peers, and on a busy journal that is a few dozen rows
    // out of thousands.
    if (!(billed >= ANOMALY_CREDITS)) return;
    const reuse = request.inputTokens
      ? (request.cachedTokens || 0) / request.inputTokens
      : 0;
    if (reuse < ANOMALY_CACHE_MIN_REUSE) return;
    const typical = this.typicalCharge(request, pool);
    if (typical === null) return;
    if (billed >= typical * ANOMALY_RATIO) request.anomaly = true;
  }

  /**
   * Re-judges every stored row.
   *
   * The flag is a judgement about a charge, not something the vendor
   * reported, so the file's copy is not trusted: a row written by an older
   * rule would otherwise keep claiming an anomaly under a rule that no
   * longer says so. Grouping by model first means a row only ever scans its
   * own model's rows; at the journal's cap that is one linear pass per model.
   */
  judgeAll() {
    const pools = new Map();
    for (const request of this.requests) {
      const model = request.model || "";
      const pool = pools.get(model);
      if (pool) pool.push(request);
      else pools.set(model, [request]);
    }
    for (const request of this.requests) {
      this.judge(request, pools.get(request.model || "") || []);
    }
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
    // A row that just left may have been another row's baseline, so the
    // surviving flags are re-derived from what is left. Judging only matters
    // for rows billed high with a working cache, so this is cheap; skipping
    // it would let a flag outlive the evidence that produced it.
    this.judgeAll();
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
    // Rows left the journal: a log can only grow, so the removal becomes a
    // compaction. The next write is the last word on what the file holds.
    this.appends = COMPACT_AFTER;
    this.save();
    console.error(`lane: cleared before today - ${removed} row(s) removed, ${this.requests.length} kept`);
    return removed;
  }

  /**
   * Removes exactly the named rows. Running rows are never removed, and an
   * unknown id is simply not present - the caller gets back how many went.
   */
  removeByIds(ids = []) {
    const drop = new Set((Array.isArray(ids) ? ids : []).filter((id) => typeof id === "string"));
    if (!drop.size) return 0;
    // Why a delete came back empty: the caller's ids matched rows that are
    // running (spared), or matched nothing at all. The distinction is the
    // difference between "the client sent stale ids" and "the vendor kept
    // the request open" - without it both read as a silent no-op.
    const matched = this.requests.filter((request) => drop.has(request.id));
    const running = matched.filter((request) => request.status === "running").length;
    if (matched.length && matched.length === running) {
      console.error(`lane: delete skipped - all ${running} matched request(s) are still running`);
    } else if (!matched.length) {
      console.error(`lane: delete matched nothing - ${drop.size} id(s) not in the journal (${this.requests.length} rows held)`);
    }
    const kept = this.requests.filter(
      (request) => !drop.has(request.id) || request.status === "running"
    );
    const removed = this.requests.length - kept.length;
    this.requests = kept;
    this.rebuildBilledRates();
    this.appends = COMPACT_AFTER;
    this.save();
    console.error(`lane: deleted by id - ${removed} row(s) of ${drop.size} requested`);
    return removed;
  }

  /**
   * Removes one model's rows inside a time window. The models table is a
   * per-range aggregate, so deleting from it drops exactly the rows the
   * summary counted for that range; older rows of the same model stay put for
   * the wider ranges. `removeByIds` spares running rows and turns the removal
   * into a compaction, so a deletion cannot erase a live request or leave a
   * stale line in the log.
   */
  removeByModel(model, { since = 0, until = Number.POSITIVE_INFINITY } = {}) {
    const wanted = String(model ?? "");
    if (!wanted) return 0;
    const ids = this.requests
      .filter((request) =>
        String(request.model || "unknown") === wanted &&
        Number.isFinite(request.startedAt) &&
        request.startedAt >= since &&
        request.startedAt < until
      )
      .map((request) => request.id);
    return ids.length ? this.removeByIds(ids) : 0;
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
      // empty when the client names none. Nothing reads it today, but it is
      // the one field that says where a request came from.
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
      // Unknown until a usage report names a cache figure. A row that never
      // receives one (a failed request, or Trae, which reports no cache
      // fields) must render "—", not a fabricated 0% hit rate.
      cacheUnknown: true,
      // Null until the upstream reports a cost: 0 would claim the request was
      // free, which is a different thing from "not billed yet".
      credits: null,
      firstTextMs: null,
      error: "",
      // How many upstream attempts this request has made: 1 unless the relay
      // retried a transient failure, which lands here as 2.
      attempt: 1,
      // Why it failed, in the vocabulary of error-kind.js: "" until the
      // request ends, and "" for one that succeeded. The text of `error` says
      // what the upstream said; this says whose problem it is.
      errorKind: ""
    };
    this.requests.unshift(request);
    this.requests = this.requests.slice(0, MAX_ROWS);
    this.rebuildBilledRates();
    this.started = (this.started || 0) + 1;
    // The day limit is not checked on every request: once the list is long
    // enough for it to matter, checking every couple of hundred starts keeps
    // a long-running gateway from growing a journal nothing ever trims.
    if (this.started % TRIM_EVERY === 0) this.prune();
    this.dirty(request);
    return request;
  }

  finish(id, values = {}) {
    const request = this.requests.find((entry) => entry.id === id);
    if (!request) return Promise.resolve();
    // The journal is a file on disk. An upstream error can echo the prompt,
    // so the error text is one-way masked before it is kept or printed.
    const safe = typeof values.error === "string"
      ? { ...values, error: redactForLog(values.error) }
      : values;
    Object.assign(request, safe, {
      status: values.status || "complete",
      finishedAt: Date.now()
    });
    request.durationMs = request.finishedAt - request.startedAt;
    // The kind is recorded here rather than at each call site: every path
    // that fails a request already hands over the error, and forgetting to
    // pass a kind on one of them would leave an unexplained failure in the
    // list. An explicit `errorKind` still wins.
    if (request.status !== "complete") {
      request.errorKind = values.errorKind || request.errorKind || kindFromText(request.error);
    } else {
      request.errorKind = "";
    }
    // The request is over: cancel the debounce and append now, so a crash
    // right after cannot leave it running forever.
    this.dirty(request);
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
    // An upstream that reports no cache figure at all (Trae answers a bare
    // prompt/completion count, and its plugin flags that as
    // `magpie_cache_unknown`) is not the same as a 0% hit rate. Recording the
    // 0 as fact told every Trae request it had a full miss.
    const namedCache = usage.input_tokens_details?.cached_tokens != null
      || usage.prompt_tokens_details?.cached_tokens != null
      || usage.prompt_cache_hit_tokens != null
      || usage.cache_read_input_tokens != null
      || usage.cached_tokens != null;
    request.cacheUnknown = usage.magpie_cache_unknown === true
      || (!namedCache && !(Number(cached) > 0));
    // A hit can never exceed the input it came from; the field that says so
    // outranks a stale one left from an earlier chunk.
    request.cachedTokens = Math.min(cached, request.inputTokens || cached);
    const billed = credited(usage);
    if (billed !== undefined) {
      request.credits = billed;
      request.creditsSource = "upstream";
      // A request is worth calling out only when all three hold: it was billed
      // at an absolute high, the cache was doing its job, and it stood far
      // above requests of the same size with the same cache share. A cold read
      // of a huge prompt satisfies the first and is the model's own tariff; a
      // big prompt satisfies nothing on its own, because its peers are big
      // too. `judge` owns the comparison.
      this.judge(request);
      this.noteBilled();
    } else {
      // No upstream number: the token formula fills in, priced at the
      // model's calibrated credits-per-million. Without a calibrated price
      // the row stays uncosted — the catalogue's relative multiple is not a
      // price, and a fabricated one understates the charge wildly.
      request.credits = estimatedCredits(request, this.calibratedPrice(request.model));
      request.creditsSource = "estimate";
    }
    this.dirty(request);
  }

  note(id, values = {}) {
    const request = this.requests.find((entry) => entry.id === id);
    if (!request) return;
    const safe = typeof values.error === "string"
      ? { ...values, error: redactForLog(values.error) }
      : values;
    Object.assign(request, safe);
    this.dirty(request);
  }

  list() {
    // The gateway's own journal changes only through its requests, so its
    // copy is the truth. A reader's copy would go stale, so it follows the
    // file — but only when the file actually changed.
    //
    // Re-reading unconditionally cost ~11 ms per call at 1674 rows (a full
    // read plus a JSON parse of every line), and the window polls status
    // every three seconds: tens of milliseconds a minute spent parsing a file
    // that had not moved. The stat is microseconds and answers the same
    // question, since every write here ends in an append or a rename, both of
    // which move mtime and size.
    if (this.shared && this.changedSinceRead()) this.load();
    return this.requests;
  }

  /** Whether the file this reader follows has changed since it last loaded. */
  changedSinceRead() {
    let stat;
    try {
      stat = fs.statSync(this.file);
    } catch {
      // Gone or unreadable: let load() decide what that means.
      return true;
    }
    const stamp = `${stat.mtimeMs}:${stat.size}`;
    if (stamp === this.lastStamp) return false;
    this.lastStamp = stamp;
    return true;
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

  /**
   * Notes that a row changed. The row's current snapshot is what lands on
   * disk; a burst of changes to one row between two writes collapses into a
   * single line, and a change that supersedes one still pending replaces it
   * rather than queueing behind it.
   */
  dirty(request) {
    if (!request?.id) return;
    this.pending.set(request.id, request);
    this.save();
  }

  write() {
    // A shared journal follows the owner's file; flushing its own stale
    // snapshot over the owner's newer rows would lose them, so a reader
    // never writes.
    if (this.shared) return Promise.resolve();
    // A journal that could not read its file holds only what arrived after
    // the failure; appending to it is still safe (a log only grows), so
    // unlike the old whole-file rewrite there is nothing to recover here.
    const run = this.writing.then(() => this.writeNow());
    this.writing = run.catch(() => {});
    return run;
  }

  async writeNow() {
    if (!this.pending.size) {
      // Nothing changed, but a compaction may still be due — a long run
      // appends without a pause and needs the file trimmed.
      if (this.appends >= COMPACT_AFTER) return this.compact();
      return;
    }
    const rows = [...this.pending.values()];
    this.pending.clear();
    try {
      await fsp.mkdir(this.dir, { recursive: true });
      const body = rows.map((row) => `${JSON.stringify(row)}\n`).join("");
      // A crash can leave the log without a final newline. Appending straight
      // on would glue the first new row to that torn tail, making one
      // unreadable line instead of one skipped line and one good row.
      const separator = await this.endsWithoutNewline() ? "\n" : "";
      // `a` is the whole point: one syscall, no rewrite of what is already
      // there, and the previous content survives a crash mid-append.
      await fsp.appendFile(this.file, `${separator}${body}`, { encoding: "utf8", mode: 0o600 });
      this.appends += rows.length;
      // Solved is solved: a failure after a successful write must be
      // reported again, not swallowed by the last outage's flag.
      this.writeFailed = false;
      if (this.appends >= COMPACT_AFTER) await this.compact();
    } catch (error) {
      // The rows are put back so the next write carries them; dropping them
      // here would lose a completed request's accounting silently.
      for (const row of rows) {
        if (!this.pending.has(row.id)) this.pending.set(row.id, row);
      }
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

  /**
   * Whether the log's last byte is not a newline — a torn write from a
   * crash. Cheap: one stat and one byte read, only when the file exists.
   */
  async endsWithoutNewline() {
    let handle;
    try {
      handle = await fsp.open(this.file, "r");
      const { size } = await handle.stat();
      if (!size) return false;
      const buffer = Buffer.alloc(1);
      await handle.read(buffer, 0, 1, size - 1);
      return buffer[0] !== 0x0a;
    } catch {
      // No file yet (the append creates it) or it cannot be inspected: the
      // append is safe either way, a leading newline at the start of a fresh
      // file being an empty line the loader skips.
      return false;
    } finally {
      await handle?.close().catch(() => {});
    }
  }

  /**
   * Rewrites the log as one line per surviving row. The replacement is
   * built beside the log and renamed into place, so a crash during the
   * rewrite leaves the previous log intact; any rows that changed while it
   * was building are appended afterwards by the next write.
   */
  async compact() {
    const target = `${this.file}.${process.pid}.tmp`;
    try {
      await fsp.mkdir(this.dir, { recursive: true });
      const body = this.requests.map((row) => `${JSON.stringify(row)}\n`).join("");
      await fsp.writeFile(target, body, "utf8");
      await fsp.rename(target, this.file);
      this.appends = 0;
    } catch (error) {
      try { await fsp.rm(target, { force: true }); } catch {}
      if (!this.writeFailed) {
        this.writeFailed = true;
        console.error(`lane: cannot compact the request journal at ${this.file}: ${error?.message || error}`);
      }
    }
  }
}
