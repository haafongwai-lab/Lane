import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

const MAX_REQUESTS = 80;

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
      this.requests = Array.isArray(saved) ? saved.slice(0, MAX_REQUESTS) : [];
      for (const request of this.requests) {
        if (request.status === "running" && request.owner !== process.pid) {
          request.status = "error";
          request.error = "Lane 上次退出时请求尚未完成";
          request.finishedAt = request.finishedAt || Date.now();
          request.durationMs = request.finishedAt - request.startedAt;
        }
      }
    } catch {
      this.requests = [];
    }
  }

  start({ agent, endpoint, requestedModel, model }) {
    const request = {
      id: randomUUID().replaceAll("-", ""),
      owner: process.pid,
      agent,
      endpoint,
      requestedModel: requestedModel || "",
      model: model || requestedModel || "",
      status: "running",
      startedAt: Date.now(),
      finishedAt: null,
      durationMs: null,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      cachedTokens: 0,
      firstTextMs: null,
      error: ""
    };
    this.requests.unshift(request);
    this.requests = this.requests.slice(0, MAX_REQUESTS);
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

  save() {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      const target = `${this.file}.${process.pid}.tmp`;
      fs.writeFileSync(target, `${JSON.stringify(this.requests, null, 2)}\n`, "utf8");
      fs.renameSync(target, this.file);
    } catch {}
  }
}
