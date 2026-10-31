import { randomUUID } from "node:crypto";
import { json, errorJSON } from "./errors.js";
import { SSEDecoder } from "./translate/stream.js";
import { parseSSEData } from "./translate/common.js";
import { ERROR_KIND, withKind, kindOf } from "./error-kind.js";

/**
 * The upstream side of every protocol: how a provider's answer becomes the
 * client's answer.
 *
 * Three shapes meet here. The OpenAI-compatible path (`proxyChat` →
 * `relayChat`) assembles or forwards chat-completion events; the two
 * protocol paths (`proxyProtocol`, one call site for Anthropic and one for
 * Responses) share a single relay driven by the caller's converters.
 *
 * What the two relays have in common is the rule they were both missing at
 * one point or another: an upstream that answers 200 with nothing usable is
 * a failure, not an empty success. Every branch below that reports
 * "complete" has first established that something arrived.
 */

// The journal keeps two flat fields; projectOf returns an object or null.
export function projectFields(project) {
  return project ? { project: project.id, projectName: project.name } : { project: "", projectName: "" };
}

/**
 * The upstream's answer as chat-completion events, whatever shape it arrived
 * in. WorkBuddy itself always streams, but a proxy in between may hand back
 * a 200 with a whole JSON answer, and one answering 200 with garbage used to
 * reach the client as a successful empty message — the worst of both worlds.
 * A lost content-type is survived by sniffing the body for SSE's `data:`
 * lines; JSON is turned into the two events it stands for; anything else is
 * an upstream error, never an empty success.
 */
export async function* upstreamEvents(upstream) {
  const contentType = String(upstream?.headers?.get?.("content-type") || "");
  if (/text\/event-stream/i.test(contentType)) {
    const decoder = new SSEDecoder();
    for await (const chunk of upstream.body || []) {
      yield* parseSSEData(decoder.push(chunk));
    }
    yield* parseSSEData(decoder.finish());
    return;
  }
  const raw = await upstream.text();
  if (isSSE(raw)) {
    const decoder = new SSEDecoder();
    const bytes = new TextEncoder().encode(raw);
    yield* parseSSEData(decoder.push(bytes));
    yield* parseSSEData(decoder.finish());
    return;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw Object.assign(
      new Error(`upstream returned invalid JSON: ${raw.slice(0, 200) || "(empty body)"}`),
      { status: 502 }
    );
  }
  if (parsed?.error) {
    const message = typeof parsed.error === "string"
      ? parsed.error
      : parsed.error.message || "upstream failed";
    throw Object.assign(new Error(message), { status: 502 });
  }
  if (!Array.isArray(parsed?.choices)) {
    throw Object.assign(
      new Error(`upstream returned a 200 without choices: ${raw.slice(0, 200) || "(empty body)"}`),
      { status: 502 }
    );
  }
  const choice = parsed.choices[0] || {};
  const message = choice.message || null;
  const delta = {};
  if (message?.role) delta.role = message.role;
  if (typeof message?.content === "string") delta.content = message.content;
  if (message?.reasoning_content) delta.reasoning_content = message.reasoning_content;
  if (Array.isArray(message?.tool_calls) && message.tool_calls.length) {
    delta.tool_calls = message.tool_calls.map((call, index) => ({ index, ...call }));
  }
  yield { ...parsed, choices: [{ index: 0, delta, finish_reason: null }] };
  yield { choices: [{ index: 0, delta: {}, finish_reason: choice.finish_reason || "stop" }] };
}

export async function proxyChat(res, provider, body, options = {}) {
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
  // WorkBuddy bills the whole stream whether anyone reads it or not. The
  // reason carries the kind, because an AbortError on its own cannot tell
  // this apart from the provider's own timeout.
  const abort = new AbortController();
  res.on("close", () => {
    if (!res.writableEnded) {
      abort.abort(withKind(new Error("client closed the connection"), ERROR_KIND.clientClosed));
    }
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
      error: error?.message || "request failed",
      errorKind: kindOf(error)
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
export async function relayChat(res, upstream, body, options = {}) {
  const record = options.record;
  const journal = options.control?.journal;
  const wantsStream = body?.stream === true;
  const events = [];
  let usage = null;
  let firstText = false;
  let finishReason = null;
  let usable = 0;
  let streamError = null;
  // The message an upstream error event carries, for both answer shapes.
  const errorOf = (event) => {
    if (!event?.error) return null;
    return typeof event.error === "string"
      ? event.error
      : event.error.message || "upstream stream failed";
  };
  // An event that carries part of an answer: content, reasoning, tool
  // calls, a finish decision, or the request's own metering. Heartbeats,
  // usage-only pings and `{"choices":[]}` parse cleanly and carry none of
  // those — a stream made only of them answered nothing, and used to be
  // reported as a success with an empty message.
  const usableEvent = (event) => {
    if (event?.usage) return true;
    const choice = Array.isArray(event?.choices) ? event.choices[0] : null;
    if (!choice) return false;
    const delta = choice.delta || {};
    const message = choice.message || null;
    return Boolean(
      choice.finish_reason
      || delta.content || delta.reasoning_content || delta.tool_calls?.length
      || message?.content || message?.tool_calls?.length
    );
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
    if (usableEvent(event)) usable += 1;
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
    for await (const event of upstreamEvents(upstream)) {
      collect(event, false);
      res.write(`data: ${JSON.stringify(event)}\n\n`);
      streamError ||= errorOf(event);
    }
    if (!finishReason && !streamError) {
      // An upstream that ended without a finish_reason would leave a strict
      // client waiting for one; the same ending proxyProtocol synthesizes.
      // Events that parse but answer nothing do not count: synthesizing a
      // stop over them reported a silent upstream as an empty success.
      if (!usable) throw Object.assign(new Error("upstream returned no usable events"), { status: 502 });
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
    for await (const event of upstreamEvents(upstream)) {
      // The streamed path forwards an error event as it arrives; a plain
      // answer assembled here would otherwise read as an empty success.
      failUpstream(event);
      collect(event, true);
    }
    // The same rule the streamed path enforces before synthesizing its
    // ending: nothing usable, nothing to report as success.
    if (!usable) {
      throw Object.assign(new Error("upstream returned no usable events"), { status: 502 });
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

/**
 * The Anthropic and Responses paths. Their shapes differ only in the
 * converters the caller supplies, so one relay serves both: streamed answers
 * go through `streamConvert` chunk by chunk, plain ones through `gather`
 * (SSE body) or `convert` (JSON body).
 */
export async function proxyProtocol(res, provider, chat, options) {
  const abort = new AbortController();
  // Hoisted for the catch: whether the answer was already delivered decides
  // how a late abort is recorded.
  let state = null;
  res.on("close", () => {
    if (!res.writableEnded) {
      abort.abort(withKind(new Error("client closed the connection"), ERROR_KIND.clientClosed));
    }
  });
  try {
    state = { id: options.id };
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
      if (!state.started) throw Object.assign(new Error("upstream returned no usable events"), { status: 502 });
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
    let output;
    if (isSSE(raw)) {
      output = options.gather(raw, state);
      // Events that parse but answer nothing (a bare heartbeat, an empty
      // choices array) reach here with nothing started: reporting them as a
      // complete empty message dressed a silent upstream up as a success.
      if (!state.started) {
        throw Object.assign(new Error("upstream returned no usable events"), { status: 502 });
      }
    } else {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed?.choices) || !parsed.choices.length) {
        throw Object.assign(
          new Error(`upstream returned a 200 without choices: ${raw.slice(0, 200) || "(empty body)"}`),
          { status: 502 }
        );
      }
      state.started = true;
      output = options.convert(parsed);
    }
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
    // The client can close the connection the moment it has the whole answer
    // (reqwest cancels on drop; Codex does this after `response.completed`)
    // while Lane is still waiting for the upstream's trailing bytes. The
    // abort then lands here, after the completed event was already written.
    // That is a delivered answer, not a failure: recording it as one filled
    // the activity list with phantom "客户端断开" failures on every turn.
    if (state && state.started && state.finished) {
      options.control?.journal.usage(options.record?.id, state.usage);
      options.control?.journal.finish(options.record?.id, { status: "complete" });
      options.control?.invalidateUsage?.();
      if (!res.writableEnded) res.end();
      return;
    }
    options.control?.journal.finish(options.record?.id, {
      status: "error",
      error: error?.message || "request failed",
      errorKind: kindOf(error)
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

export function isSSE(text) {
  return /(?:^|\n)data:/.test(text);
}

/**
 * A failure with a status the client can act on keeps it; anything else is
 * rethrown for the top-level handler to report as a gateway error. The
 * distinction matters because a 502 from the upstream used to flatten into a
 * 500, which reads as a Lane bug rather than what the upstream said.
 *
 * A client that closed its own connection gets no response at all — there is
 * nobody left to read it, and writing one only produces a second error on a
 * socket that is already gone.
 */
export function unavailable(res, error) {
  if (error?.kind === ERROR_KIND.clientClosed || kindOf(error) === ERROR_KIND.clientClosed) {
    if (!res.writableEnded) res.end();
    return;
  }
  // The upstream accepted the request and never answered. 504 says exactly
  // that; left to the generic path it became a 500, which blames Lane for
  // the upstream's silence.
  if (kindOf(error) === ERROR_KIND.upstreamTimeout) {
    errorJSON(res, 504, error.message || "upstream did not answer in time", "upstream_timeout");
    return;
  }
  if (
    error?.name === "ProviderUnavailable" ||
    /not signed in|signed out|sign in again/i.test(error?.message || "")
  ) {
    errorJSON(res, 503, error.message, "provider_unavailable");
    return;
  }
  // A failure the upstream itself produced — a refusal, a non-JSON body —
  // keeps its status and its type instead of flattening into a 500 that
  // reads as a gateway bug. The kind is checked as well as the status: an
  // error already classified as the upstream's does not need to carry a
  // number to be reported as one.
  const kind = kindOf(error);
  if (
    Number(error?.status) === 502 ||
    kind === ERROR_KIND.upstreamError ||
    kind === ERROR_KIND.upstreamUnreadable ||
    kind === ERROR_KIND.upstreamStream
  ) {
    errorJSON(res, 502, error.message, "upstream_error");
    return;
  }
  throw error;
}
