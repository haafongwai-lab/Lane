import http from "node:http";
import { createRequire } from "node:module";
import { readJSONBody, json, errorJSON } from "./errors.js";
import { modelList } from "./models.js";
import { FallbackProvider } from "./provider.js";
import {
  anthropicToChat,
  anthropicStreamFromChat,
  anthropicStreamError,
  anthropicMessageFromStream,
  chatToAnthropic
} from "./translate/anthropic.js";
import {
  responsesToChat,
  responsesStreamFromChat,
  responsesStreamError,
  responsesObjectFromStream,
  chatToResponses
} from "./translate/responses.js";
import { randomUUID } from "node:crypto";
import { withAliases, resolveModel, nearestEffort } from "./aliases.js";
import { projectOf } from "./project.js";
import { SSEDecoder } from "./translate/stream.js";
import { parseSSEData } from "./translate/common.js";

const require = createRequire(import.meta.url);

const NAME = "lane";
// The gateway reports the version of the package it ships in, so /healthz
// no longer drifts from the release when the number is bumped.
const VERSION = require("../package.json").version;

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

// The host:port names a request may reach this gateway by. The Host header is
// the one thing a rebinding page cannot forge — the browser always names the
// host it was told to connect to — so only these names pass.
function localHosts(req) {
  const port = req.socket.localPort;
  // The address the connection arrived on counts too, so a gateway bound to
  // a name other than the loopback keeps working; an IPv4-mapped IPv6
  // address (::ffff:127.0.0.1) stands for the IPv4 address it maps.
  const local = String(req.socket.localAddress || "").replace(/^::ffff:/i, "");
  const locals = local
    ? (local.includes(":") ? [`${local}:${port}`, `[${local}]:${port}`] : [`${local}:${port}`])
    : [];
  return [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`, ...locals];
}

function hostIsLocal(req) {
  const host = String(req.headers.host || "").toLowerCase().trim();
  if (!host || !req.socket.localPort) return false;
  return localHosts(req).includes(host);
}

// A page anywhere can POST to 127.0.0.1 with a "simple" content type: no
// CORS preflight happens, and the Host header naturally names this gateway,
// so the Host check above cannot see the request. The Origin header (which
// browsers always send on cross-site POSTs) and Sec-Fetch-Site can. No
// legitimate Lane client trips this: Codex, Claude Desktop, ZCode and the
// CLI send no Origin at all, and the desktop window talks over IPC.
function requestFromElsewhere(req) {
  const site = String(req.headers["sec-fetch-site"] || "").toLowerCase().trim();
  if (site && site !== "none" && site !== "same-origin") return true;
  const origin = String(req.headers.origin || "").toLowerCase().trim();
  if (!origin) return false;
  let host = "";
  try {
    host = new URL(origin).host;
  } catch {
    return true; // "null" (sandboxed frames) or a malformed value is not local
  }
  return host && !localHosts(req).includes(host);
}

export function createApp({ provider = new FallbackProvider(), control = null } = {}) {
  return async function handler(req, res) {
    if (!hostIsLocal(req)) {
      errorJSON(res, 403, "Lane serves the local host only: the Host header must name this gateway", "forbidden");
      return;
    }
    if (requestFromElsewhere(req)) {
      errorJSON(res, 403, "Lane serves local clients only: a browser page may not drive it", "forbidden");
      return;
    }
    let url;
    try {
      url = new URL(req.url || "/", "http://lane.local");
    } catch {
      // Outside the handler's try on purpose: an unparseable request line is
      // a client error, not a crash that takes the gateway down.
      errorJSON(res, 400, "malformed request URL", "invalid_request_error");
      return;
    }
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
        // A client that sends a request Lane cannot satisfy in one piece
        // (a body over the limit, a shape the upstream refuses) is easier to
        // help when the body that actually arrived is on record.
        if (process.env.LANE_TRACE_REQUEST === "1") {
          console.error(`chat request from ${req.socket.remoteAddress}: ${JSON.stringify(body).slice(0, 2000)}`);
        }
        const meta = await modelMeta(provider, body.model);
        await proxyChat(res, provider, body, {
          control,
          agent: "openai",
          requested,
          endpoint: url.pathname,
          model: body.model,
          accountId: await activeAccountId(provider),
          rate: meta.rate,
          contextWindow: meta.contextWindow,
          ...projectFields(projectOf(body, req.headers))
        });
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
        if (!body || typeof body !== "object" || Array.isArray(body)) {
          errorJSON(res, 400, "body must be a JSON object");
          return;
        }
        const requested = body.model || "hy3";
        body.model = await mappedModel(provider, requested, "codex");
        const chat = responsesToChat(body);
        const id = randomUUID().replaceAll("-", "");
        const meta = await modelMeta(provider, body.model);
        const record = control?.journal.start({
          agent: "codex",
          endpoint: url.pathname,
          requestedModel: requested,
          model: body.model,
          accountId: await activeAccountId(provider),
          rate: meta.rate,
          contextWindow: meta.contextWindow,
          ...projectFields(projectOf(body, req.headers))
        });
        await proxyProtocol(res, provider, chat, {
          id,
          record,
          control,
          model: body.model,
          stream: Boolean(body.stream),
          convert: (payload) => chatToResponses(payload, body.model, `resp_${id}`),
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
        if (!body || typeof body !== "object" || Array.isArray(body)) {
          errorJSON(res, 400, "body must be a JSON object");
          return;
        }
        if (!Array.isArray(body.messages)) {
          errorJSON(res, 400, "messages must be an array");
          return;
        }
        const requested = body.model || "hy3";
        const models = withAliases(await provider.listModels(), "claude");
        body.model = resolveModel(requested, models, "claude");
        fitEffort(body, models.find((model) => model.id === body.model));
        const chat = anthropicToChat(body);
        const id = randomUUID().replaceAll("-", "");
        const meta = await modelMeta(provider, body.model);
        const record = control?.journal.start({
          agent: messagesClientAgent(req),
          endpoint: url.pathname,
          requestedModel: requested,
          model: body.model,
          accountId: await activeAccountId(provider),
          rate: meta.rate,
          contextWindow: meta.contextWindow,
          ...projectFields(projectOf(body, req.headers))
        });
        await proxyProtocol(res, provider, chat, {
          id,
          record,
          control,
          model: body.model,
          stream: Boolean(body.stream),
          convert: (payload) => chatToAnthropic(payload, body.model, `msg_${id}`),
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
      // A route that already started streaming has no head left to replace:
      // forcing a JSON error head onto it would throw ERR_HTTP_HEADERS_SENT
      // out of this catch, which nothing catches. The socket goes; the
      // process stays up.
      if (res.headersSent) {
        if (!res.writableEnded) res.destroy();
        return;
      }
      errorJSON(res, status, error?.message || "internal error", status >= 500 ? "server_error" : "invalid_request_error");
    }
  };
}

async function mappedModel(provider, requested, agent) {
  const models = withAliases(await provider.listModels(), agent);
  return resolveModel(requested, models, agent);
}

// The credit multiple WorkBuddy charges for this model and the context
// window it advertises, kept on the request so a later catalogue change
// cannot rewrite what this request cost or which window it ran in. Missing
// fields stay undefined, which leaves the request uncosted and the window
// unknown rather than invented.
async function modelMeta(provider, id) {
  try {
    const model = (await provider.listModels()).find((model) => model.id === id);
    return { rate: model?.rate, contextWindow: model?.context };
  } catch {
    return { rate: undefined, contextWindow: undefined };
  }
}

// The account carrying the request, so the journal can attribute its cost to
// the account that paid it. Providers without accounts (the fallback, the
// tests) leave it empty.
async function activeAccountId(provider) {
  if (typeof provider?.activeId !== "function") return "";
  try {
    return (await provider.activeId()) || "";
  } catch {
    return "";
  }
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

// /v1/messages serves two clients: Claude Desktop and ZCode (both speak the
// Anthropic protocol). The journal's source column owes each request to its
// own client, and the Claude Desktop UA is the one reliable tell - the
// Anthropic Messages wire otherwise looks the same from both.
function messagesClientAgent(req) {
  return isClaudeDesktop(req) ? "claude-desktop" : "zcode";
}

// CJK text runs close to a token per character, while Latin text runs close
// to four characters per token; splitting the count keeps the estimate from
// reading four times too low for a Chinese prompt.
const CJK_CHARS = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\u3040-\u30FF\u31F0-\u31FF\uAC00-\uD7AF]/g;

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
  const array = (value) => (Array.isArray(value) ? value : []);
  const system = textOf(body?.system);
  const messages = array(body?.messages)
    .map((message) => textOf(message?.content))
    .join("");
  // A client counts tokens before sending; whatever shape it posts, the
  // answer is an estimate for well-formed parts and a number regardless.
  const tools = array(body?.tools)
    .map((tool) => (tool && typeof tool === "object"
      ? `${tool.name || ""}${tool.description || ""}`
      : ""))
    .join("");
  const text = system + messages + tools;
  const cjk = (text.match(CJK_CHARS) || []).length;
  return Math.round(cjk + (text.length - cjk) / 4);
}

// The journal keeps two flat fields; projectOf returns an object or null.
function projectFields(project) {
  return project ? { project: project.id, projectName: project.name } : { project: "", projectName: "" };
}

async function proxyChat(res, provider, body, options = {}) {
  const record = options.control?.journal.start({
    agent: options.agent || "openai",
    endpoint: options.endpoint || "/v1/chat/completions",
    requestedModel: options.requested || body.model,
    model: body.model,
    accountId: options.accountId,
    rate: options.rate,
    contextWindow: options.contextWindow,
    ...projectFields(options.project)
  });
  // A client that hangs up mid-generation must not keep the upstream running:
  // WorkBuddy bills the whole stream whether anyone reads it or not.
  const abort = new AbortController();
  res.on("close", () => {
    if (!res.writableEnded) abort.abort();
  });
  try {
    const upstream = await provider.chat(body, { signal: abort.signal });
    // The upstream status is the request's outcome: a chat WorkBuddy refuses
    // arrives here as a Response with ok === false, and recording it as
    // "complete" hid the refusal from the journal and the activity list.
    if (!upstream?.ok) {
      // The body is read here and the text is sent on, because reading a
      // response locks its stream: a second read finds it locked and the
      // client gets nothing at all instead of the error.
      const text = await upstream.text().catch(() => "");
      options.control?.journal.finish(record?.id, {
        status: "error",
        error: text || `upstream returned ${upstream?.status || "no response"}`
      });
      json(res, upstream?.status || 502, {
        error: {
          message: text || `upstream returned ${upstream?.status || "no response"}`,
          type: "upstream_error"
        }
      });
      return;
    }
    await relayChat(res, upstream, body, {
      control: options.control,
      record,
      model: options.model
    });
  } catch (error) {
    options.control?.journal.finish(record?.id, {
      status: "error",
      error: error?.message || "request failed"
    });
    // A streamed answer has its head already on the wire; writing a JSON
    // error head now throws ERR_HTTP_HEADERS_SENT from inside this catch,
    // which nothing catches any more. The client gets the failure as a
    // terminal SSE error event instead, and the gateway stays up.
    if (res.headersSent && !res.writableEnded) {
      res.write(`data: ${JSON.stringify({
        error: { message: error?.message || "upstream stream failed", type: "upstream_error" }
      })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }
    unavailable(res, error);
  }
}

/**
 * The OpenAI-compatible path. WorkBuddy only ever answers with a stream, so
 * the stream is read here: the client's own answer is assembled from it, the
 * tokens are counted, and the parts that are not OpenAI events — the
 * heartbeat comment, for one — never reach a client that would choke on
 * them.
 *
 * A client that asked for a plain answer gets one; a client that asked for a
 * stream gets each event as it arrives, forwarded in the upstream's order —
 * buffering the whole answer first would make the client's first byte arrive
 * only when the generation is over.
 */
async function relayChat(res, upstream, body, options = {}) {
  const record = options.record;
  const journal = options.control?.journal;
  const wantsStream = body?.stream === true;
  const decoder = new SSEDecoder();
  const events = [];
  let usage = null;
  let firstText = false;
  let finishReason = null;
  let seen = 0;
  let streamError = null;
  // The message an upstream error event carries, for both answer shapes.
  const errorOf = (event) => {
    if (!event?.error) return null;
    return typeof event.error === "string"
      ? event.error
      : event.error.message || "upstream stream failed";
  };

  // The response head waits: a client that asked for a plain answer gets
  // JSON, and one that asked for a stream gets events, so the head is only
  // written once the shape is known.
  if (wantsStream) {
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive"
    });
    // The client hanging up must stop the upstream generation too: cancelled
    // here, the read loop below ends without dragging the rest of a stream
    // nobody is reading through WorkBuddy's billing.
    res.on("close", () => {
      if (!res.writableEnded) upstream.body?.cancel?.()?.catch?.(() => {});
    });
  }

  const collect = (event, keep) => {
    if (!event || typeof event !== "object") return;
    seen += 1;
    if (event.usage) usage = event.usage;
    const choice = Array.isArray(event.choices) ? event.choices[0] : null;
    if (!choice) return;
    if (choice.finish_reason && !finishReason) finishReason = choice.finish_reason;
    const text = choice.delta?.content ?? choice.message?.content ?? "";
    if (text && !firstText) {
      firstText = true;
      journal?.note(record?.id, { firstTextMs: Date.now() - (record?.startedAt || Date.now()) });
    }
    // Only the assembled-answer path needs the events kept; a streamed one
    // has already sent them.
    if (keep) events.push(event);
  };

  if (wantsStream) {
    for await (const chunk of upstream.body || []) {
      for (const event of parseSSEData(decoder.push(chunk))) {
        collect(event, false);
        res.write(`data: ${JSON.stringify(event)}\n\n`);
        streamError ||= errorOf(event);
      }
    }
    for (const event of parseSSEData(decoder.finish())) {
      collect(event, false);
      res.write(`data: ${JSON.stringify(event)}\n\n`);
      streamError ||= errorOf(event);
    }
    if (!finishReason && !streamError) {
      // An upstream that ended without a finish_reason would leave a strict
      // client waiting for one; the same ending proxyProtocol synthesizes.
      if (!seen) throw new Error("upstream stream ended without a response");
      res.write(`data: ${JSON.stringify({
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }]
      })}\n\n`);
    }
    res.write("data: [DONE]\n\n");
    res.end();
  } else {
    const failUpstream = (event) => {
      const message = errorOf(event);
      if (message) throw Object.assign(new Error(message), { status: 502 });
    };
    for await (const chunk of upstream.body || []) {
      for (const event of parseSSEData(decoder.push(chunk))) {
        // The streamed path forwards an error event as it arrives; a plain
        // answer assembled here would otherwise read as an empty success.
        failUpstream(event);
        collect(event, true);
      }
    }
    for (const event of parseSSEData(decoder.finish())) {
      failUpstream(event);
      collect(event, true);
    }
    // A plain answer is assembled from the same events a streamed one would
    // have carried, so both see the same text — and the same tool calls:
    // the deltas are stitched back together, or a client that asked for
    // tools would receive a bare message and never see the invocation.
    const content = events.map((event) => event.choices?.[0]?.delta?.content || "").join("");
    const reasoning = events.map((event) => event.choices?.[0]?.delta?.reasoning_content || "").join("");
    const finish = events
      .map((event) => event.choices?.[0]?.finish_reason)
      .filter(Boolean)
      .pop() || "stop";
    const calls = new Map();
    for (const event of events) {
      for (const part of event.choices?.[0]?.delta?.tool_calls || []) {
        const index = part.index ?? 0;
        let call = calls.get(index);
        if (!call) {
          call = { id: "", function: { name: "", arguments: "" } };
          calls.set(index, call);
        }
        if (part.id) call.id = part.id;
        if (part.function?.name) call.function.name = part.function.name;
        call.function.arguments += part.function?.arguments || "";
      }
    }
    const message = { role: "assistant", content: calls.size && !content ? null : content };
    if (reasoning) message.reasoning_content = reasoning;
    if (calls.size) {
      message.tool_calls = [...calls.entries()]
        .sort(([a], [b]) => a - b)
        .map(([, call]) => ({
          id: call.id || `call_${randomUUID().replaceAll("-", "")}`,
          type: "function",
          function: {
            name: call.function.name || "tool",
            arguments: call.function.arguments || "{}"
          }
        }));
    }
    json(res, 200, {
      id: events[0]?.id || `chatcmpl-${randomUUID().replaceAll("-", "")}`,
      object: "chat.completion",
      created: events[0]?.created || Math.floor(Date.now() / 1000),
      model: events[0]?.model || options.model || body.model,
      choices: [{ index: 0, message, finish_reason: finish }],
      usage: usage || null
    });
  }

  // A stream that carried an upstream error event reached the client as one,
  // but the journal must not call that request complete — the same rule the
  // plain-answer path enforces by failing the assembly.
  if (usage) journal?.usage(record?.id, usage);
  journal?.finish(record?.id, streamError
    ? { status: "error", error: streamError }
    : { status: "complete" });
  options.control?.invalidateUsage?.();
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
    if (req.method === "GET" && url.pathname === "/lane/usage") {
      const range = url.searchParams.get("range") || "today";
      json(res, 200, await control.usage(range));
      return;
    }
    if (req.method === "GET" && url.pathname === "/lane/accounts") {
      json(res, 200, await control.accounts());
      return;
    }
    if (req.method === "POST" && url.pathname === "/lane/sign-in") {
      const body = await readJSONBody(req);
      const result = await control.signIn({ site: body?.site });
      json(res, 200, result);
      return;
    }
    // /lane/accounts/<id>/<action> — the id is a uid, so it is decoded as
    // one path segment rather than split on its punctuation.
    const segments = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    if (segments[0] === "lane" && segments[1] === "accounts" && segments.length === 4) {
      const [, , id, action] = segments;
      if (req.method !== "POST") {
        errorJSON(res, 405, "use POST for account actions", "invalid_request_error");
        return;
      }
      if (action === "activate") {
        json(res, 200, { account: await control.activate(id) });
        return;
      }
      if (action === "enabled") {
        const body = await readJSONBody(req);
        if (typeof body?.enabled !== "boolean") {
          errorJSON(res, 400, "enabled must be a boolean", "invalid_request_error");
          return;
        }
        json(res, 200, { account: await control.setEnabled(id, body.enabled) });
        return;
      }
      if (action === "remove") {
        json(res, 200, await control.removeAccount(id));
        return;
      }
      if (action === "checkin") {
        json(res, 200, await control.checkin(id));
        return;
      }
      errorJSON(res, 404, "unknown account action", "not_found");
      return;
    }
    if (req.method === "GET" && url.pathname === "/lane/checkin") {
      json(res, 200, await control.checkinOverview());
      return;
    }
    if (req.method === "POST" && url.pathname === "/lane/checkin") {
      json(res, 200, await control.checkin(""));
      return;
    }
    if (req.method === "POST" && url.pathname === "/lane/checkin/settings") {
      const body = await readJSONBody(req);
      json(res, 200, await control.checkinSettings(body || {}));
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
    // A percent-encoded path segment that does not decode is a client error,
    // not a gateway fault worth a stack trace.
    if (error instanceof URIError) {
      errorJSON(res, 400, "malformed percent-encoding in the path", "invalid_request_error");
      return;
    }
    errorJSON(res, Number(error?.status) || 500, error?.message || "control request failed", "control_error");
  }
}

async function proxyProtocol(res, provider, chat, options) {
  const abort = new AbortController();
  res.on("close", () => {
    if (!res.writableEnded) abort.abort();
  });
  try {
    const state = { id: options.id };
    const upstream = await provider.chat({ ...chat, stream: true }, { signal: abort.signal });
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
      // Same rule as the chat path: a client that hangs up cancels the
      // upstream generation instead of paying for the rest of it.
      res.on("close", () => {
        if (!res.writableEnded) upstream.body?.cancel?.()?.catch?.(() => {});
      });
      const decoder = new SSEDecoder();
      // First *content*, not first byte: heartbeats and usage-only pings are
      // chunks too, and the converters raise state.started only on a payload
      // with choices.
      let notedText = false;
      for await (const chunk of upstream.body || []) {
        const converted = options.streamConvert(decoder.push(chunk), state);
        if (converted) res.write(converted);
        if (!notedText && state.started && options.record) {
          notedText = true;
          options.control?.journal.note(options.record.id, { firstTextMs: Date.now() - options.record.startedAt });
        }
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
      options.control?.invalidateUsage?.();
      res.end();
      return;
    }
    const raw = await upstream.text();
    if (options.record) {
      options.control?.journal.note(options.record.id, {
        firstTextMs: Date.now() - options.record.startedAt
      });
    }
    // A 200 head says nothing about the body: a captive portal or a broken
    // proxy answers 200 with HTML. That is an upstream failure, reported as
    // one, not a syntax error thrown from the conversion.
    if (!isSSE(raw)) {
      try {
        JSON.parse(raw);
      } catch {
        throw Object.assign(
          new Error(`upstream returned invalid JSON: ${raw.slice(0, 200) || "(empty body)"}`),
          { status: 502 }
        );
      }
    }
    const output = isSSE(raw) ? options.gather(raw, state) : options.convert(JSON.parse(raw));
    // A non-SSE body carries its usage report inside the JSON; the journal
    // reads it from there, so `credit` and the cache fields survive.
    if (!isSSE(raw) && !state.usage) {
      try {
        const upstreamUsage = JSON.parse(raw)?.usage;
        if (upstreamUsage && typeof upstreamUsage === "object") state.usage = upstreamUsage;
      } catch {}
    }
    // The journal reads the upstream's own report — `credit` and the cache
    // fields ride on state.usage when the gather saw them — and falls back
    // to the converted shape's numbers only when no raw report landed.
    options.control?.journal.usage(options.record?.id, state.usage || output.usage);
    options.control?.journal.finish(options.record?.id, { status: "complete" });
    options.control?.invalidateUsage?.();
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

function unavailable(res, error) {
  if (
    error?.name === "ProviderUnavailable" ||
    /not signed in|signed out|sign in again/i.test(error?.message || "")
  ) {
    errorJSON(res, 503, error.message, "provider_unavailable");
    return;
  }
  // A failure the upstream itself produced — a refusal, a non-JSON body —
  // keeps its status and its type instead of flattening into a 500 that
  // reads as a gateway bug.
  if (Number(error?.status) === 502) {
    errorJSON(res, 502, error.message, "upstream_error");
    return;
  }
  throw error;
}

export function createServer(options) {
  return http.createServer(createApp(options));
}
