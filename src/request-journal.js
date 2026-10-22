import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

const KEEP_DAYS = 120;
const MAX_ROWS = 6000;
// The window polls status every 3 seconds; sending the whole journal each
// time would repeat tens of kilobytes that only the usage page reads.
const MAX_RECENT = 20;
const TRIM_EVERY = 200;

export class RequestJournal {
  constructor({ dir }) {
    this.dir = dir;
    this.file = path.join(dir, "activity.json");
    this.requests = [];
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
      for (const request of this.requests) {
        if (request.status === "running" && request.owner !== process.pid) {
          request.status = "error";
          request.error = "Lane 上次退出时请求尚未完成";
          request.finishedAt = request.finishedAt || Date.now();
          request.durationMs = request.finishedAt - request.startedAt;
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
    this.save();
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
    return this.requests;
  }

  // What the status snapshot carries: enough for the route card and the
  // activity list, without repeating the whole journal every poll.
  recent(limit = MAX_RECENT) {
    return this.requests.slice(0, limit);
  }

  save() {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      const target = `${this.file}.${process.pid}.tmp`;
      fs.writeFileSync(target, `${JSON.stringify(this.requests, null, 2)}\n`, "utf8");
      fs.renameSync(target, this.file);
    } catch {}
  }
}
