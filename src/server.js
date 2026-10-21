import http from "node:http";
import { readJSONBody, json, errorJSON } from "./errors.js";
import { modelList } from "./models.js";
import { FallbackProvider } from "./provider.js";
import { anthropicToChat, chatToAnthropic, anthropicStreamFromChat } from "./translate/anthropic.js";
import { responsesToChat, chatToResponses, responsesStreamFromChat } from "./translate/responses.js";
import { randomUUID } from "node:crypto";
import { withAliases, resolveModel } from "./aliases.js";
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

export function createApp({ provider = new FallbackProvider() } = {}) {
  return async function handler(req, res) {
    const url = new URL(req.url || "/", "http://lane.local");
    try {
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
        const agent = url.searchParams.get("agent") || "openai";
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
        body.model = await mappedModel(provider, body.model, "openai");
        await proxyChat(res, provider, body);
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
        body.model = await mappedModel(provider, body.model, "codex");
        const chat = responsesToChat(body);
        const id = randomUUID().replaceAll("-", "");
        await proxyProtocol(res, provider, chat, {
          id,
          model: body.model,
          stream: Boolean(body.stream),
          convert: (payload) => chatToResponses(payload, body.model, id),
          streamConvert: (text, state) => responsesStreamFromChat(text, state, body.model)
        });
        return;
      }

      if (req.method === "POST" && url.pathname === "/v1/messages") {
        const body = await readJSONBody(req);
        body.model = await mappedModel(provider, body.model, "claude");
        const chat = anthropicToChat(body);
        const id = randomUUID().replaceAll("-", "");
        await proxyProtocol(res, provider, chat, {
          id,
          model: body.model,
          stream: Boolean(body.stream),
          convert: (payload) => chatToAnthropic(payload, body.model, id),
          streamConvert: (text, state) => anthropicStreamFromChat(text, state, body.model)
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

async function proxyChat(res, provider, body) {
  try {
    const upstream = await provider.chat(body);
    await relay(res, upstream, 200);
  } catch (error) {
    unavailable(res, error);
  }
}

async function proxyProtocol(res, provider, chat, options) {
  try {
    const upstream = await provider.chat({ ...chat, stream: true });
    if (!upstream.ok) {
      const text = await upstream.text();
      errorJSON(res, upstream.status, text || "upstream request failed", "upstream_error");
      return;
    }
    if (options.stream) {
      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
        connection: "keep-alive"
      });
      const state = { id: options.id };
      const decoder = new SSEDecoder();
      for await (const chunk of upstream.body || []) {
        const converted = options.streamConvert(decoder.push(chunk), state);
        if (converted) res.write(converted);
      }
      const tail = options.streamConvert(decoder.finish(), state);
      if (tail) res.write(tail);
      res.end();
      return;
    }
    const payload = await upstream.json();
    json(res, 200, options.convert(payload));
  } catch (error) {
    unavailable(res, error);
  }
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
