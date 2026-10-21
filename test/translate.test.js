import test from "node:test";
import assert from "node:assert/strict";
import {
  anthropicToChat,
  chatToAnthropic,
  anthropicStreamFromChat,
  anthropicMessageFromStream
} from "../src/translate/anthropic.js";
import {
  responsesToChat,
  chatToResponses,
  responsesStreamFromChat,
  responsesObjectFromStream
} from "../src/translate/responses.js";
import { SSEDecoder } from "../src/translate/stream.js";

test("Anthropic messages become Chat Completions messages", () => {
  const out = anthropicToChat({
    model: "auto",
    max_tokens: 100,
    system: "be brief",
    messages: [
      { role: "user", content: [{ type: "text", text: "hello" }] }
    ]
  });
  assert.equal(out.model, "auto");
  assert.equal(out.messages[0].role, "system");
  assert.equal(out.messages[1].content, "hello");
  assert.equal(out.max_tokens, 100);
});

test("Chat Completions become an Anthropic message", () => {
  const out = chatToAnthropic({
    choices: [{ message: { content: "hi" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 2, completion_tokens: 1 }
  }, "auto", "abc");
  assert.equal(out.type, "message");
  assert.equal(out.content[0].text, "hi");
  assert.equal(out.usage.output_tokens, 1);
});

test("Responses input becomes Chat Completions messages", () => {
  const out = responsesToChat({
    model: "auto",
    instructions: "be brief",
    input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }]
  });
  assert.equal(out.messages[0].role, "system");
  assert.equal(out.messages[1].content, "hello");
});

test("Responses requests keep the selected reasoning effort", () => {
  const out = responsesToChat({
    model: "hy3",
    input: "hello",
    reasoning: { effort: "high" }
  });
  assert.equal(out.reasoning_effort, "high");
});

test("Chat Completions become a Responses object", () => {
  const out = chatToResponses({
    choices: [{ message: { content: "hi" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 }
  }, "auto", "abc");
  assert.equal(out.object, "response");
  assert.equal(out.output[0].content[0].text, "hi");
  assert.equal(out.usage.total_tokens, 3);
});

test("SSE decoding survives arbitrary chunk boundaries", () => {
  const decoder = new SSEDecoder();
  const encoder = new TextEncoder();
  assert.equal(decoder.push(encoder.encode("data: {\"a\"")), "");
  assert.equal(decoder.push(encoder.encode(":1}\n\ndata: 2\n")), 'data: {"a":1}\n\ndata: 2\n');
  assert.equal(decoder.finish(), "");
});

const toolStream = [
  'data: {"choices":[{"index":0,"delta":{"content":"checking "}}]}',
  'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"exec","arguments":"{\\"cmd\\":"}}]}}]}',
  'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"dir\\"}"}}]}}]}',
  'data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":7,"completion_tokens":5,"total_tokens":12}}',
  "data: [DONE]",
  ""
].join("\n\n");

function sseEvents(text) {
  return text
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice(6)));
}

test("Anthropic stream translates tool calls and closes every block", () => {
  const state = { id: "abc" };
  const events = sseEvents(anthropicStreamFromChat(toolStream, state, "auto"));
  const starts = events.filter((event) => event.type === "content_block_start");
  assert.deepEqual(starts.map((event) => event.content_block.type), ["text", "tool_use"]);
  assert.equal(starts[1].content_block.id, "call_1");
  assert.equal(starts[1].content_block.name, "exec");
  const args = events
    .filter((event) => event.type === "content_block_delta" && event.delta.type === "input_json_delta")
    .map((event) => event.delta.partial_json)
    .join("");
  assert.equal(args, '{"cmd":"dir"}');
  assert.deepEqual(
    events.filter((event) => event.type === "content_block_stop").map((event) => event.index),
    [0, 1]
  );
  assert.equal(events.at(-1).type, "message_stop");
  assert.deepEqual(state.usage, { prompt_tokens: 7, completion_tokens: 5, total_tokens: 12 });
});

test("Anthropic stream keeps parallel tool calls as separate blocks", () => {
  const stream = [
    'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_a","function":{"name":"one","arguments":"{\\"n\\":1}"}}]}}]}',
    'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":1,"id":"call_b","function":{"name":"two","arguments":"{\\"n\\":2}"}}]}}]}',
    'data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}',
    ""
  ].join("\n\n");
  const events = sseEvents(anthropicStreamFromChat(stream, { id: "abc" }, "auto"));
  const starts = events.filter(
    (event) => event.type === "content_block_start" && event.content_block.type === "tool_use"
  );
  assert.deepEqual(starts.map((event) => event.content_block.name), ["one", "two"]);
  assert.deepEqual(
    events.filter((event) => event.type === "content_block_stop").map((event) => event.index),
    [0, 1]
  );
});

test("Anthropic non-stream request gathers the upstream tool stream", () => {
  const message = anthropicMessageFromStream(toolStream, { id: "abc" }, "auto");
  assert.equal(message.content[0].text, "checking ");
  assert.deepEqual(message.content[1], {
    type: "tool_use",
    id: "call_1",
    name: "exec",
    input: { cmd: "dir" }
  });
  assert.equal(message.stop_reason, "tool_use");
  assert.equal(message.usage.total_tokens, undefined);
  assert.equal(message.usage.output_tokens, 5);
});

test("Responses stream translates tool calls with done events", () => {
  const state = { id: "abc" };
  const events = sseEvents(responsesStreamFromChat(toolStream, state, "auto"));
  const added = events.find((event) => event.type === "response.output_item.added" && event.item.type === "function_call");
  assert.equal(added.item.call_id, "call_1");
  assert.equal(added.item.name, "exec");
  const deltas = events
    .filter((event) => event.type === "response.function_call_arguments.delta")
    .map((event) => event.delta)
    .join("");
  assert.equal(deltas, '{"cmd":"dir"}');
  assert.ok(events.some((event) => event.type === "response.function_call_arguments.done"));
  assert.ok(events.some((event) => event.type === "response.output_item.done" && event.item.type === "function_call"));
  assert.equal(events.at(-1).type, "response.completed");
  assert.equal(events.at(-1).response.output.length, 2);
  assert.deepEqual(state.usage, { prompt_tokens: 7, completion_tokens: 5, total_tokens: 12 });
});

test("Responses stream keeps parallel calls and message indexes after a tool", () => {
  const stream = [
    'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_a","function":{"name":"one","arguments":"{}"}}]}}]}',
    'data: {"choices":[{"index":0,"delta":{"content":"after"}}]}',
    'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":1,"id":"call_b","function":{"name":"two","arguments":"{}"}}]}}]}',
    'data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}',
    ""
  ].join("\n\n");
  const events = sseEvents(responsesStreamFromChat(stream, { id: "abc" }, "auto"));
  const calls = events
    .filter((event) => event.type === "response.output_item.done" && event.item.type === "function_call")
    .map((event) => `${event.output_index}:${event.item.call_id}`);
  assert.deepEqual(calls, ["0:call_a", "2:call_b"]);
  const message = events.find(
    (event) => event.type === "response.output_item.done" && event.item.type === "message"
  );
  assert.equal(message.output_index, 1);
  assert.equal(message.item.content[0].text, "after");
});

test("Responses tool-only stream does not emit an empty message", () => {
  const stream = [
    'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_only","function":{"name":"exec","arguments":"{\\"cmd\\":\\"dir\\"}"}}]}}]}',
    'data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}',
    ""
  ].join("\n\n");
  const events = sseEvents(responsesStreamFromChat(stream, { id: "abc" }, "auto"));
  assert.equal(
    events.some((event) => event.item?.type === "message" || event.output_index === 0 && "text" in event),
    false
  );
  assert.equal(
    events.some((event) => event.type === "response.output_text.delta"),
    false
  );
  const added = events.find(
    (event) => event.type === "response.output_item.added" && event.item.type === "function_call"
  );
  assert.equal(added.output_index, 0);
  assert.deepEqual(events.at(-1).response.output.map((item) => item.type), ["function_call"]);
});

test("Responses reports an output limit as incomplete", () => {
  const stream = [
    'data: {"choices":[{"index":0,"delta":{},"finish_reason":"length"}],"usage":{"prompt_tokens":2,"completion_tokens":4,"total_tokens":6}}',
    ""
  ].join("\n\n");
  const events = sseEvents(responsesStreamFromChat(stream, { id: "abc" }, "auto"));
  const end = events.at(-1);
  assert.equal(end.type, "response.incomplete");
  assert.equal(end.response.status, "incomplete");
  assert.deepEqual(end.response.incomplete_details, { reason: "max_output_tokens" });
});

test("Responses non-stream request gathers the upstream tool stream", () => {
  const response = responsesObjectFromStream(toolStream, { id: "abc" }, "auto");
  assert.equal(response.output[0].content[0].text, "checking ");
  assert.equal(response.output[1].type, "function_call");
  assert.equal(response.output[1].call_id, "call_1");
  assert.equal(response.output[1].arguments, '{"cmd":"dir"}');
  assert.equal(response.usage.total_tokens, 12);
});
