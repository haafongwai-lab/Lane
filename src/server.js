import http from "node:http";
import { readJSONBody, json, errorJSON } from "./errors.js";
import { modelList } from "./models.js";
import { FallbackProvider } from "./provider.js";
import {
  anthropicToChat,
  anthropicStreamFromChat,
  anthropicStreamError,
  anthropicMessageFromStream
} from "./translate/anthropic.js";
import {
  responsesToChat,
  responsesStreamFromChat,
  responsesStreamError,
  responsesObjectFromStream
} from "./translate/responses.js";
import { randomUUID } from "node:crypto";
import { withAliases, resolveModel, nearestEffort } from "./aliases.js";
import { SSEDecoder } from "./translate/stream.js";

const NAME = "lane";
const VERSION = "0.1.0";

function health(provider) {
  return {
    ok: true,
    name: NAME,
    version: VERSION,
    provider: provider.constructor.name,
    upstream: "workbuddy",
    local: true
  };
}

export function createApp({ provider = new FallbackProvider(), control = null } = {}) {
  return async function handler(req, res) {
    const url = new URL(req.url || "/", "http://lane.local");
    try {
      if (url.pathname.startsWith("/lane/")) {
        await controlRoute(req, res, url, control);
        return;
      }
      if (
        url.pathname === "/backend-api/codex/responses" &&
        req.headers.upgrade?.toLowerCase() === "websocket"
      ) {
        res.writeHead(426, { connection: "close", "content-type": "text/plain; charset=utf-8" });
        res.end("Lane does not support Codex Responses WebSocket yet; use HTTP Responses.");
        return;
      }

      if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/healthz")) {
        json(res, 200, health(provider));
        return;
      }

      if (req.method === "GET" && url.pathname === "/v1/models") {
        const agent = isClaudeDesktop(req)
          ? "claude"
          : url.searchParams.get("agent") || "openai";
        const models = withAliases(await provider.listModels(), agent);
        const listed = models.map((model) => ({
          ...model,
          id: agent === "claude" ? model.alias : model.id,
          name: model.name,
          real_id: model.id
        }));
        json(res, 200, modelList(listed));
        return;
      }

      // Claude Desktop counts a prompt before sending it; WorkBuddy's
      // OpenAI-shaped upstream has no counting endpoint, so answer with
      // the same rough estimate magpie falls back to.
      if (req.method === "POST" && url.pathname === "/v1/messages/count_tokens") {
        const body = await readJSONBody(req);
        json(res, 200, { input_tokens: estimateTokens(body) });
        return;
      }

      if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
        const body = await readJSONBody(req);
        if (!body || typeof body !== "object" || typeof body.model !== "string") {
          errorJSON(res, 400, "model is required");
          return;
        }
        if (!Array.isArray(body.messages)) {
          errorJSON(res, 400, "messages must be an array");
          return;
        }
        const requested = body.model;
        body.model = await mappedModel(provider, requested, "openai");
        await proxyChat(res, provider, body, { control, agent: "openai", requested, endpoint: url.pathname });
        return;
      }

      if (req.method === "GET" && url.pathname === "/backend-api/codex/models") {
        const models = await provider.listModels();
        json(res, 200, { data: models.map((model) => ({ id: model.id, name: model.name })) });
        return;
      }

      if (
        req.method === "POST" &&
        (url.pathname === "/v1/responses" || url.pathname === "/backend-api/codex/responses")
      ) {
        const body = await readJSONBody(req);
        const requested = body.model || "hy3";
        body.model = await mappedModel(provider, requested, "codex");
        const chat = responsesToChat(body);
        const id = randomUUID().replaceAll("-", "");
        const record = control?.journal.start({
          agent: "codex",
          endpoint: url.pathname,
          requestedModel: requested,
          model: body.model
        });
        await proxyProtocol(res, provider, chat, {
          id,
          record,
          control,
          model: body.model,
          stream: Boolean(body.stream),
          convert: (payload) => responsesObjectFromStream(
            `data: ${JSON.stringify(payload)}`,
            { id },
            body.model
          ),
          gather: (text, state) => responsesObjectFromStream(text, state, body.model),
          streamConvert: (text, state) => responsesStreamFromChat(text, state, body.model),
          streamError: responsesStreamError,
          finish: (state) => responsesStreamFromChat(
            'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
            state,
            body.model
          )
        });
        return;
      }

      if (req.method === "POST" && url.pathname === "/v1/messages") {
        const body = await readJSONBody(req);
        const requested = body.model || "hy3";
        const models = withAliases(await provider.listModels(), "claude");
        body.model = resolveModel(requested, models, "claude");
        fitEffort(body, models.find((model) => model.id === body.model));
        const chat = anthropicToChat(body);
        const id = randomUUID().replaceAll("-", "");
        const record = control?.journal.start({
          agent: "claude-desktop",
          endpoint: url.pathname,
          requestedModel: requested,
          model: body.model
        });
        await proxyProtocol(res, provider, chat, {
          id,
          record,
          control,
          model: body.model,
          stream: Boolean(body.stream),
          convert: (payload) => anthropicMessageFromStream(
            `data: ${JSON.stringify(payload)}`,
            { id },
            body.model
          ),
          gather: (text, state) => anthropicMessageFromStream(text, state, body.model),
          streamConvert: (text, state) => anthropicStreamFromChat(text, state, body.model),
          streamError: anthropicStreamError,
          finish: (state) => anthropicStreamFromChat(
            'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
            state,
            body.model
          )
        });
        return;
      }

      errorJSON(res, 404, `no route for ${req.method} ${url.pathname}`, "not_found");
    } catch (error) {
      const status = Number(error?.status) || 500;
      if (status >= 500) console.error(error);
      errorJSON(res, status, error?.message || "internal error", status >= 500 ? "server_error" : "invalid_request_error");
    }
  };
}

async function mappedModel(provider, requested, agent) {
  const models = withAliases(await provider.listModels(), agent);
  return resolveModel(requested, models, agent);
}

// Claude Desktop asks how hard to think in output_config.effort; fit the
// level to the model's own so WorkBuddy's upstream never refuses it.
function fitEffort(body, model) {
  const effort = body.output_config?.effort || body.thinking?.effort;
  if (!effort || effort === "none") return;
  const fitted = nearestEffort(effort, model?.efforts);
  if (body.output_config) body.output_config.effort = fitted;
  if (body.thinking?.effort) body.thinking.effort = fitted;
  body.laneEffort = fitted;
}

// Claude Desktop's requests say "Mozilla/... Claude/<version>" in their
// User-Agent; that is the only signal a gateway gets.
function isClaudeDesktop(req) {
  const ua = req.headers["user-agent"] || "";
  return ua.startsWith("Mozilla/") && ua.includes(" Claude/");
}

function estimateTokens(body) {
  const textOf = (content) => {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return content
      .map((part) => part?.text || part?.content || "")
      .flat()
      .map((value) => (typeof value === "string" ? value : ""))
      .join("");
  };
  const system = textOf(body?.system);
  const messages = (body?.messages || [])
    .map((message) => textOf(message.content))
    .join("");
  const tools = (body?.tools || [])
    .map((tool) => `${tool.name || ""}${tool.description || ""}`)
    .join("");
  return Math.round((system.length + messages.length + tools.length) / 4);
}

async function proxyChat(res, provider, body, options = {}) {
  const record = options.control?.journal.start({
    agent: options.agent || "openai",
    endpoint: options.endpoint || "/v1/chat/completions",
    requestedModel: options.requested || body.model,
    model: body.model
  });
  try {
    const upstream = await provider.chat(body);
    options.control?.journal.finish(record?.id, { status: "complete" });
    await relay(res, upstream, 200);
  } catch (error) {
    options.control?.journal.finish(record?.id, {
      status: "error",
      error: error?.message || "request failed"
    });
    unavailable(res, error);
  }
}

async function controlRoute(req, res, url, control) {
  if (!control) {
    errorJSON(res, 404, "control API is not enabled", "not_found");
    return;
  }
  try {
    if (req.method === "GET" && url.pathname === "/lane/status") {
      json(res, 200, await control.status());
      return;
    }
    if (req.method === "GET" && url.pathname === "/lane/activity") {
      json(res, 200, { data: control.activity() });
      return;
    }
    if (req.method === "POST" && url.pathname === "/lane/sign-in") {
      const result = await control.signIn();
      json(res, 200, result);
      return;
    }
    if (req.method === "POST" && url.pathname === "/lane/sign-out") {
      json(res, 200, await control.signOut());
      return;
    }
    if (req.method === "POST" && url.pathname.startsWith("/lane/agents/")) {
      const [, , , agent, action] = url.pathname.split("/");
      if (action === "connect") json(res, 200, await control.connect(agent));
      else if (action === "disconnect") json(res, 200, await control.disconnect(agent));
      else errorJSON(res, 404, "unknown agent action", "not_found");
      return;
    }
    if (req.method === "POST" && url.pathname === "/lane/autostart") {
      const body = await readJSONBody(req);
      if (body.options?.desktopExe) {
        errorJSON(
          res,
          400,
          "set autostart from the Lane desktop app, not the HTTP API",
          "invalid_request_error"
        );
        return;
      }
      json(res, 200, await control.autostart(Boolean(body.enabled), body.options || {}));
      return;
    }
    errorJSON(res, 404, "unknown control route", "not_found");
  } catch (error) {
    errorJSON(res, Number(error?.status) || 500, error?.message || "control request failed", "control_error");
  }
}

async function proxyProtocol(res, provider, chat, options) {
  try {
    const state = { id: options.id };
    const upstream = await provider.chat({ ...chat, stream: true });
    if (!upstream.ok) {
      const text = await upstream.text();
      options.control?.journal.finish(options.record?.id, {
        status: "error",
        error: text || "upstream request failed"
      });
      errorJSON(res, upstream.status, text || "upstream request failed", "upstream_error");
      return;
    }
    if (options.stream) {
      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
        connection: "keep-alive"
      });
      const decoder = new SSEDecoder();
      for await (const chunk of upstream.body || []) {
        if (!state.started && options.record) {
          options.control?.journal.note(options.record.id, { firstTextMs: Date.now() - options.record.startedAt });
        }
        const converted = options.streamConvert(decoder.push(chunk), state);
        if (converted) res.write(converted);
      }
      const tail = options.streamConvert(decoder.finish(), state);
      if (tail) res.write(tail);
      if (!state.started) throw new Error("upstream stream ended without a response");
      if (!state.finished) {
        const ending = options.finish(state);
        if (ending) res.write(ending);
      }
      options.control?.journal.usage(options.record?.id, state.usage);
      options.control?.journal.finish(options.record?.id, { status: "complete" });
      res.end();
      return;
    }
    const raw = await upstream.text();
    if (options.record) {
      options.control?.journal.note(options.record.id, {
        firstTextMs: Date.now() - options.record.startedAt
      });
    }
    const output = isSSE(raw) ? options.gather(raw, state) : options.convert(JSON.parse(raw));
    options.control?.journal.usage(options.record?.id, output.usage);
    options.control?.journal.finish(options.record?.id, { status: "complete" });
    json(res, 200, output);
  } catch (error) {
    options.control?.journal.finish(options.record?.id, {
      status: "error",
      error: error?.message || "request failed"
    });
    if (res.headersSent) {
      if (!res.writableEnded) {
        const failure = options.streamError?.(error);
        if (failure) res.write(failure);
        res.end();
      }
      return;
    }
    unavailable(res, error);
  }
}

function isSSE(text) {
  return /(?:^|\n)data:/.test(text);
}

async function relay(res, upstream, fallbackStatus) {
  if (!upstream) throw new Error("provider returned no response");
  if (upstream.body && typeof upstream.body.getReader === "function") {
    const type = upstream.headers?.get?.("content-type") || "application/json";
    res.writeHead(upstream.status || fallbackStatus, {
      "content-type": type,
      "cache-control": "no-cache"
    });
    for await (const chunk of upstream.body) res.write(Buffer.from(chunk));
    res.end();
    return;
  }
  json(res, fallbackStatus, upstream);
}

function unavailable(res, error) {
  if (
    error?.name === "ProviderUnavailable" ||
    /not signed in|signed out|sign in again/i.test(error?.message || "")
  ) {
    errorJSON(res, 503, error.message, "provider_unavailable");
    return;
  }
  throw error;
}

export function createServer(options) {
  return http.createServer(createApp(options));
}
