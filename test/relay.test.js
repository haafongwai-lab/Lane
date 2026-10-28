import test from "node:test";
import assert from "node:assert/strict";
import { upstreamEvents, isSSE, projectFields } from "../src/relay.js";

/**
 * The relay layer used to be reachable only through a live HTTP request.
 * These cover the pieces that decide "what did the upstream actually send",
 * which is where three separate defects lived: a JSON 200 thrown away, an
 * SSE line that was not JSON swallowed, and an event with nothing in it
 * counted as an answer.
 */

async function collect(source) {
  const out = [];
  for await (const event of upstreamEvents(source)) out.push(event);
  return out;
}

test("a streaming response is decoded as events", async () => {
  const upstream = new Response([
    'data: {"choices":[{"index":0,"delta":{"content":"hi"}}]}\n\n',
    'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
    "data: [DONE]\n\n"
  ].join(""), { headers: { "content-type": "text/event-stream" } });

  const events = await collect(upstream);
  assert.equal(events.length, 2);
  assert.equal(events[0].choices[0].delta.content, "hi");
  assert.equal(events[1].choices[0].finish_reason, "stop");
});

test("a whole JSON answer becomes the two events it stands for", async () => {
  const upstream = new Response(JSON.stringify({
    id: "c1",
    model: "hy3",
    choices: [{
      index: 0,
      message: { role: "assistant", content: "whole answer" },
      finish_reason: "stop"
    }]
  }), { headers: { "content-type": "application/json" } });

  const events = await collect(upstream);
  assert.equal(events.length, 2);
  assert.equal(events[0].choices[0].delta.content, "whole answer");
  assert.equal(events[0].choices[0].delta.role, "assistant");
  assert.equal(events[1].choices[0].finish_reason, "stop");
  assert.equal(events[0].id, "c1");
});

test("tool calls in a whole JSON answer keep their index", async () => {
  const upstream = new Response(JSON.stringify({
    choices: [{
      index: 0,
      message: {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "a", type: "function", function: { name: "one", arguments: "{}" } },
          { id: "b", type: "function", function: { name: "two", arguments: "{}" } }
        ]
      },
      finish_reason: "tool_calls"
    }]
  }), { headers: { "content-type": "application/json" } });

  const [first] = await collect(upstream);
  assert.deepEqual(first.choices[0].delta.tool_calls.map((call) => call.index), [0, 1]);
  assert.equal(first.choices[0].delta.tool_calls[1].function.name, "two");
});

test("SSE without a content-type is still recognised", async () => {
  const upstream = new Response(
    'data: {"choices":[{"index":0,"delta":{"content":"naked"}}]}\n\n'
  );
  const events = await collect(upstream);
  assert.equal(events[0].choices[0].delta.content, "naked");
});

test("a 200 that is neither SSE nor JSON is a 502", async () => {
  const upstream = new Response("<html>portal</html>", {
    headers: { "content-type": "text/html" }
  });
  await assert.rejects(() => collect(upstream), (error) => {
    assert.equal(error.status, 502);
    assert.match(error.message, /invalid JSON/);
    return true;
  });
});

test("a 200 JSON body without choices is a 502, not an empty answer", async () => {
  const upstream = new Response(JSON.stringify({ object: "chat.completion" }), {
    headers: { "content-type": "application/json" }
  });
  await assert.rejects(() => collect(upstream), (error) => {
    assert.equal(error.status, 502);
    assert.match(error.message, /without choices/);
    return true;
  });
});

test("a JSON error body is raised with the upstream's own message", async () => {
  const upstream = new Response(JSON.stringify({
    error: { message: "model is not allowed", code: 11158 }
  }), { headers: { "content-type": "application/json" } });
  await assert.rejects(() => collect(upstream), (error) => {
    assert.equal(error.status, 502);
    assert.equal(error.message, "model is not allowed");
    return true;
  });
});

test("a data line that is not JSON is a 502, never silence", async () => {
  const upstream = new Response("data: not-json\n\n", {
    headers: { "content-type": "text/event-stream" }
  });
  await assert.rejects(() => collect(upstream), (error) => {
    assert.equal(error.status, 502);
    assert.match(error.message, /non-JSON SSE payload/);
    return true;
  });
});

test("isSSE tells a body that carries events from one that does not", () => {
  assert.equal(isSSE('data: {"a":1}\n\n'), true);
  assert.equal(isSSE('{\n  "data": 1\n}'), false);
  assert.equal(isSSE(""), false);
});

test("projectFields flattens a project and defaults to empty", () => {
  assert.deepEqual(projectFields({ id: "p1", name: "lane" }), { project: "p1", projectName: "lane" });
  assert.deepEqual(projectFields(null), { project: "", projectName: "" });
});
