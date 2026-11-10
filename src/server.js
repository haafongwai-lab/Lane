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
import { withAliases, resolveModel, nearestEffort, isLaneAlias } from "./aliases.js";
import { projectOf } from "./project.js";
import { proxyChat, proxyProtocol, projectFields } from "./relay.js";
import { redactForLog } from "./redact.js";
import { isLoopbackHost } from "./config.js";

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
  const loopback = isLoopbackHost(local);
  const locals = local
    ? (local.includes(":") ? [`${local}:${port}`, `[${local}]:${port}`] : [`${local}:${port}`])
    : [];
  // Loopback aliases are only valid when the connection itself arrived on a
  // loopback address. If someone binds 0.0.0.0, a remote client must not be
  // able to paper over its address with `Host: localhost`.
  const names = loopback
    ? [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`, ...locals]
    : locals;
  return [...new Set(names)];
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
        if (Array.isArray(body.tools) && body.tools.some((tool) => !tool || typeof tool !== "object")) {
          errorJSON(res, 400, "each tool must be an object");
          return;
        }
        const requested = body.model;
        // The allowlist lives in the provider's listModels(), so a model the
        // user has not added is absent here; refuse it instead of forwarding
        // a request the gate was meant to stop.
        const mapped = await servedModel(provider, requested, "openai");
        if (!mapped.known) {
          errorJSON(
            res,
            400,
            `model ${requested} is not enabled for agents; add it on Lane's 模型 page first`,
            "invalid_request_error"
          );
          return;
        }
        body.model = mapped.id;
        // A client that sends a request Lane cannot satisfy in one piece
        // (a body over the limit, a shape the upstream refuses) is easier to
        // help when the body that actually arrived is on record.
        if (process.env.LANE_TRACE_REQUEST === "1") {
          // Trace is a debugging aid, never a copy of the prompt: one-way mask
          // credentials and personal data before they can reach the log file.
          console.error(`chat request from ${req.socket.remoteAddress}: ${redactForLog(JSON.stringify(body)).slice(0, 2000)}`);
        }
        const meta = await modelMeta(provider, body.model);
        await proxyChat(res, provider, body, {
          control,
          agent: isDsh(req) ? "dsh" : "openai",
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
        // Same rule as /v1/messages: a non-string model cannot name one, and
        // resolving it died as a 500; a missing input reached the upstream as
        // an empty conversation and came back as a hollow "completed" answer.
        if (typeof requested !== "string") {
          errorJSON(res, 400, "model must be a string");
          return;
        }
        if (typeof body.input !== "string" && !Array.isArray(body.input)) {
          errorJSON(res, 400, "input must be a string or an array");
          return;
        }
        if (Array.isArray(body.tools) && body.tools.some((tool) => !tool || typeof tool !== "object")) {
          errorJSON(res, 400, "each tool must be an object");
          return;
        }
        const mappedCodex = await servedModel(provider, requested, "codex");
        if (!mappedCodex.known) {
          errorJSON(
            res,
            400,
            `model ${requested} is not enabled for agents; add it on Lane's 模型 page first`,
            "invalid_request_error"
          );
          return;
        }
        body.model = mappedCodex.id;
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
        // A model that is not a string cannot name a model; resolved anyway
        // it used to die inside resolveModel as a 500 that reads as a
        // gateway bug rather than the client's malformed request it is.
        if (typeof requested !== "string") {
          errorJSON(res, 400, "model must be a string");
          return;
        }
        // A null entry used to die in the converter as a 500; every message
        // must at least be an object for the protocol to make sense of it.
        if (body.messages.some((message) => !message || typeof message !== "object")) {
          errorJSON(res, 400, "each message must be an object");
          return;
        }
        if (Array.isArray(body.tools) && body.tools.some((tool) => !tool || typeof tool !== "object")) {
          errorJSON(res, 400, "each tool must be an object");
          return;
        }
        const models = withAliases(await provider.listModels(), "claude");
        body.model = resolveModel(requested, models, "claude");
        // Claude Desktop keeps the chosen model in the conversation, so a
        // switch to an account on the other WorkBuddy site leaves it asking
        // for a model this catalogue no longer has. Forwarded as-is, the
        // upstream answers 11102 in its own words, which reads as a broken
        // gateway. Name the real cause instead, and say how to recover.
        if (isLaneAlias(requested) && !models.some((model) => model.id === body.model)) {
          errorJSON(
            res,
            400,
            `model ${requested} belongs to the account Lane was routing before this one; `
            + "pick a model from the current list, or switch back",
            "invalid_request_error"
          );
          return;
        }
        // A model the user has not added is not in the served list; refuse it
        // here rather than forwarding a request the allowlist meant to stop.
        if (!models.some((model) => model.id === body.model)) {
          errorJSON(
            res,
            400,
            `model ${requested} is not enabled for agents; add it on Lane's 模型 page first`,
            "invalid_request_error"
          );
          return;
        }
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
      if (status >= 500) console.error(redactForLog(error?.stack || error?.message || String(error)));
      // A route that already started streaming has no head left to replace:
      // forcing a JSON error head onto it would throw ERR_HTTP_HEADERS_SENT
      // out of this catch, which nothing catches. The socket goes; the
      // process stays up.
      if (res.headersSent) {
        if (!res.writableEnded) res.destroy();
        return;
      }
      // A provider that cannot name its account (an expired Trae/WorkBuddy
      // sign-in) can fail during model discovery, before proxyChat's own
      // unavailable() path. Keep the same 503/provider_unavailable shape there
      // instead of turning the upstream's auth refusal into a generic 500.
      const providerUnavailable = error?.name === "ProviderUnavailable"
        || /not signed in|signed out|sign in again/i.test(error?.message || "");
      if (providerUnavailable) {
        errorJSON(res, 503, error?.message || "provider unavailable", "provider_unavailable");
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

/**
 * Whether the provider actually serves this model.
 *
 * The model allowlist is applied inside the provider's own `listModels()`, so
 * a model the user has not added is simply absent from that list. Checking
 * membership here therefore enforces the allowlist without this file knowing
 * anything about where the allowlist lives — and a provider that serves its
 * whole catalogue (the fallback, the tests) keeps working unchanged.
 */
async function servedModel(provider, requested, agent) {
  const models = withAliases(await provider.listModels(), agent);
  const id = resolveModel(requested, models, agent);
  const known = models.some((model) => model.id === id);
  return { id, known };
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

// Claude Desktop speaks through two runtimes with two different marks. The
// Electron shell sends "Mozilla/... Claude/<version>"; the 3p inference this
// install actually runs goes through the embedded claude-code runtime, whose
// UA is "claude-code/<version>" with "x-service-name: claude-code" beside it
// (read out of the shipped claude.exe after the journal started filing its
// requests under ZCode). Matching either keeps the catalogue Anthropic-shaped
// for whichever runtime asks.
function isClaudeDesktop(req) {
  const ua = String(req.headers["user-agent"] || "");
  if (/^claude-code\//i.test(ua)) return true;
  if (String(req.headers["x-service-name"] || "").toLowerCase() === "claude-code") return true;
  return ua.startsWith("Mozilla/") && ua.includes(" Claude/");
}

// /v1/messages serves two clients: Claude Desktop and ZCode (both speak the
// Anthropic protocol). The journal's source column owes each request to its
// own client, and the Claude Desktop UA is the one reliable tell - the
// Anthropic Messages wire otherwise looks the same from both.
function messagesClientAgent(req) {
  if (isClaudeDesktop(req)) return "claude-desktop";
  if (isDsh(req)) return "dsh";
  return "zcode";
}

// DeepSeek Harness speaks plain OpenAI chat completions, like any other
// compatible client, and sends no User-Agent of its own - so every request it
// makes used to be journaled as a generic "openai" one. Lane writes a marker
// header into the provider it deploys for the harness, and reads it back
// here. A client that never went through Lane's deploy simply keeps the
// generic attribution.
function isDsh(req) {
  return String(req.headers["x-lane-client"] || "").toLowerCase().trim() === "dsh";
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
    if (req.method === "POST" && url.pathname === "/lane/activity/clear") {
      const body = await readJSONBody(req);
      // `ids` names specific rows; omitting them clears everything before
      // today's midnight.
      const removed = Array.isArray(body?.ids)
        ? control.clearHistory(body.ids)
        : control.clearHistory();
      json(res, 200, { removed });
      return;
    }
    if (req.method === "POST" && url.pathname === "/lane/activity/clear-model") {
      const body = await readJSONBody(req);
      json(res, 200, await control.clearModel(String(body?.model || ""), String(body?.range || "today")));
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

    // ---- MCP & skills ------------------------------------------------------
    if (req.method === "GET" && url.pathname === "/lane/mcp") {
      json(res, 200, { servers: await control.mcpServers(), targets: await control.mcpTargets() });
      return;
    }
    if (req.method === "POST" && url.pathname === "/lane/mcp") {
      const body = await readJSONBody(req);
      json(res, 200, await control.mcpUpsert(body || {}));
      return;
    }
    if (req.method === "POST" && url.pathname === "/lane/mcp/remove") {
      const body = await readJSONBody(req);
      json(res, 200, await control.mcpRemove(String(body?.name || "")));
      return;
    }
    if (req.method === "POST" && url.pathname === "/lane/mcp/toggle") {
      const body = await readJSONBody(req);
      json(res, 200, await control.mcpToggle(String(body?.name || ""), Boolean(body?.off)));
      return;
    }
    if (req.method === "POST" && url.pathname === "/lane/mcp/agents") {
      const body = await readJSONBody(req);
      json(res, 200, await control.mcpSetAgents(String(body?.name || ""), body?.agents || []));
      return;
    }
    if (req.method === "POST" && url.pathname === "/lane/mcp/test") {
      const body = await readJSONBody(req);
      json(res, 200, await control.mcpTest(String(body?.name || "")));
      return;
    }
    if (req.method === "GET" && url.pathname === "/lane/skills") {
      json(res, 200, { skills: await control.skillsList() });
      return;
    }
    if (req.method === "POST" && url.pathname === "/lane/skills/import") {
      const body = await readJSONBody(req);
      json(res, 200, await control.skillsImport(String(body?.dir || "")));
      return;
    }
    if (req.method === "POST" && url.pathname === "/lane/skills/remove") {
      const body = await readJSONBody(req);
      json(res, 200, await control.skillsRemove(String(body?.name || "")));
      return;
    }
    if (req.method === "POST" && url.pathname === "/lane/skills/install") {
      const body = await readJSONBody(req);
      json(res, 200, await control.skillsInstall(String(body?.name || ""), String(body?.agent || "")));
      return;
    }
    if (req.method === "POST" && url.pathname === "/lane/skills/uninstall") {
      const body = await readJSONBody(req);
      json(res, 200, await control.skillsUninstall(String(body?.name || ""), String(body?.agent || "")));
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
      // Startup options (node/script/desktopExe/env) are desktop-only: they
      // choose which executable runs at logon. The HTTP API is deliberately
      // limited to the on/off bit; an empty object is accepted for old callers.
      const options = body?.options;
      if (options && (typeof options !== "object" || Array.isArray(options) || Object.keys(options).length)) {
        errorJSON(
          res,
          400,
          "autostart options are set from the Lane desktop app, not the HTTP API",
          "invalid_request_error"
        );
        return;
      }
      json(res, 200, await control.autostart(Boolean(body.enabled)));
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

export function createServer(options) {
  return http.createServer(createApp(options));
}
