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
import { parseSSEData } from "../src/translate/common.js";

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

test("Responses tool_choice is spelled the way Chat Completions takes it", () => {
  const named = responsesToChat({
    model: "hy3",
    input: "hi",
    tool_choice: { type: "function", name: "get_weather" }
  });
  assert.deepEqual(named.tool_choice, { type: "function", function: { name: "get_weather" } });

  assert.equal(responsesToChat({ model: "hy3", input: "hi", tool_choice: "required" }).tool_choice, "required");
  assert.equal(responsesToChat({ model: "hy3", input: "hi", tool_choice: "none" }).tool_choice, "none");
  // A shape with no Chat Completions spelling degrades to "auto" rather
  // than being forwarded in a form the upstream refuses.
  assert.equal(
    responsesToChat({
      model: "hy3",
      input: "hi",
      tool_choice: { type: "allowed_tools", mode: "auto", tools: [] }
    }).tool_choice,
    "auto"
  );
});

test("parallel Responses calls replay as one assistant message", () => {
  const out = responsesToChat({
    model: "auto",
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "check the project" }] },
      { type: "reasoning", summary: [] },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "reading the files" }] },
      { type: "function_call", call_id: "call_00", name: "exec_command", arguments: '{"cmd":"ls"}' },
      { type: "function_call", call_id: "call_01", name: "exec_command", arguments: '{"cmd":"git status"}' },
      { type: "function_call_output", call_id: "call_00", output: "files listed" },
      { type: "function_call_output", call_id: "call_01", output: "clean tree" }
    ]
  });
  assert.deepEqual(out.messages.map((message) => message.role), [
    "user", "assistant", "assistant", "tool", "tool"
  ]);
  assert.deepEqual(
    out.messages[2].tool_calls.map((call) => call.id),
    ["call_00", "call_01"]
  );
  assert.deepEqual(
    out.messages.slice(3).map((message) => message.tool_call_id),
    ["call_00", "call_01"]
  );
});

test("calls of separate turns stay on separate assistant messages", () => {
  const out = responsesToChat({
    model: "auto",
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "go" }] },
      { type: "function_call", call_id: "call_a", name: "exec", arguments: "{}" },
      { type: "function_call_output", call_id: "call_a", output: "done" },
      { type: "message", role: "user", content: [{ type: "input_text", text: "again" }] },
      { type: "function_call", call_id: "call_b", name: "exec", arguments: "{}" },
      { type: "function_call_output", call_id: "call_b", output: "done" }
    ]
  });
  const groups = out.messages.filter((message) => message.tool_calls);
  assert.deepEqual(groups.map((message) => message.tool_calls.map((call) => call.id)), [
    ["call_a"], ["call_b"]
  ]);
});

test("Chat Completions calls without ids stay distinct in a Responses object", () => {
  const out = chatToResponses({
    choices: [{
      message: {
        content: null,
        tool_calls: [
          { function: { name: "one", arguments: "{}" } },
          { function: { name: "two", arguments: "{}" } }
        ]
      },
      finish_reason: "tool_calls"
    }]
  }, "auto", "abc");
  assert.deepEqual(out.output.map((item) => item.call_id), ["call_abc_0", "call_abc_1"]);
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

test("an interleaved parallel tool stream keeps every block's JSON whole", () => {
  // An upstream may interleave the deltas of parallel calls; a block that
  // already closed must never receive another input_json_delta, or a client
  // assembling per index would concatenate two objects.
  const stream = [
    'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_a","function":{"name":"one","arguments":"{\\"n\\":"}}]}}]}',
    'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":1,"id":"call_b","function":{"name":"two","arguments":"{\\"m\\":"}}]}}]}',
    'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"1}"}}]}}]}',
    'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":1,"function":{"arguments":"2}"}}]}}]}',
    'data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}',
    ""
  ].join("\n\n");
  const events = sseEvents(anthropicStreamFromChat(stream, { id: "abc" }, "auto"));
  for (const stop of events.filter((event) => event.type === "content_block_stop")) {
    const laterDeltas = events
      .slice(events.indexOf(stop) + 1)
      .filter((event) => event.type === "content_block_delta" && event.index === stop.index);
    assert.deepEqual(laterDeltas, [], `block ${stop.index} gets deltas after its stop`);
  }
  // Each block's assembled arguments are the JSON the upstream sent.
  const args = new Map();
  for (const event of events) {
    if (event.type === "content_block_delta" && event.delta?.type === "input_json_delta") {
      args.set(event.index, (args.get(event.index) || "") + event.delta.partial_json);
    }
  }
  assert.equal(args.get(0), '{"n":1}');
  assert.equal(args.get(1), '{"m":2}');
});

test("a tool call that omits its index stays one call", () => {
  const stream = [
    'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"id":"call_x","function":{"name":"exec"}}]}}]}',
    'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"function":{"arguments":"{\\"cmd\\":\\"ls\\"}"}}]}}]}',
    'data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}',
    ""
  ].join("\n\n");
  const message = anthropicMessageFromStream(stream, { id: "abc" }, "auto");
  const tools = message.content.filter((block) => block.type === "tool_use");
  assert.equal(tools.length, 1);
  assert.equal(tools[0].name, "exec");
  assert.deepEqual(tools[0].input, { cmd: "ls" });
});

test("interleaved parallel tool calls stay whole in the non-stream path", () => {
  // The gather path sees the whole stream at once, but it must survive the
  // same interleaving the streaming path already does: index-keyed blocks,
  // not a split that turns one call into broken blocks with empty inputs.
  const stream = [
    'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_a","function":{"name":"one","arguments":"{\\"n\\":"}}]}}]}',
    'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":1,"id":"call_b","function":{"name":"two","arguments":"{\\"m\\":"}}]}}]}',
    'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"1}"}}]}}]}',
    'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":1,"function":{"arguments":"2}"}}]}}]}',
    'data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}',
    ""
  ].join("\n\n");
  const message = anthropicMessageFromStream(stream, { id: "abc" }, "auto");
  const tools = message.content.filter((block) => block.type === "tool_use");
  assert.equal(tools.length, 2);
  assert.deepEqual(tools[0].input, { n: 1 });
  assert.deepEqual(tools[1].input, { m: 2 });
  assert.equal(tools[0].id, "call_a");
  assert.equal(tools[1].id, "call_b");
});

test("chat tool calls without ids keep distinct fallback ids", () => {
  const out = chatToAnthropic({
    choices: [{
      message: {
        role: "assistant",
        content: null,
        tool_calls: [
          { type: "function", function: { name: "one", arguments: "{}" } },
          { type: "function", function: { name: "two", arguments: "{}" } }
        ]
      },
      finish_reason: "tool_calls"
    }]
  }, "auto", "msg_abc");
  const [first, second] = out.content;
  assert.notEqual(first.id, second.id, "the client cannot tell two identical ids apart");
  assert.ok(first.id.startsWith("toolu_msg_abc_"));
});

test("a data payload wrapped across two SSE lines arrives as one event", () => {
  // The SSE spec concatenates the data: lines of one event with a newline;
  // wrapped or pretty-printed JSON is one document, not two broken ones.
  const events = parseSSEData('data: {"choices":[{"index":0,\ndata:  "delta":{"content":"hi"}}]}\n\n');
  assert.equal(events.length, 1);
  assert.equal(events[0].choices[0].delta.content, "hi");
});

test("a tool result's image parts are forwarded, not dropped", () => {
  const out = anthropicToChat({
    model: "auto",
    messages: [
      { role: "user", content: "check the screen" },
      { role: "assistant", content: [{ type: "tool_use", id: "call_1", name: "shot", input: {} }] },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "call_1", content: [
            { type: "image", source: { type: "base64", media_type: "image/png", data: "aGk=" } },
            { type: "text", text: "the screenshot" }
          ] }
        ]
      }
    ]
  });
  const tool = out.messages.find((message) => message.role === "tool");
  assert.ok(Array.isArray(tool.content));
  assert.deepEqual(tool.content[0], {
    type: "image_url",
    image_url: { url: "data:image/png;base64,aGk=" }
  });
  assert.equal(tool.content[1].text, "the screenshot");
});

test("an Anthropic stream says nothing after message_stop", () => {
  // An upstream that keeps talking after its finish_reason would open a new
  // content block after message_stop — a stream no strict client accepts.
  const stream = [
    'data: {"choices":[{"index":0,"delta":{"content":"hi"}}]}',
    'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
    'data: {"choices":[{"index":0,"delta":{"content":"late"}}]}',
    ""
  ].join("\n\n");
  const events = sseEvents(anthropicStreamFromChat(stream, { id: "abc" }, "auto"));
  const stopAt = events.findIndex((event) => event.type === "message_stop");
  assert.ok(stopAt >= 0);
  assert.ok(events.slice(stopAt + 1).every((event) => event.type !== "content_block_start"));
  assert.ok(events.slice(stopAt + 1).every((event) => event.type !== "content_block_delta"));
});

test("a Responses stream says nothing after response.completed", () => {
  const stream = [
    'data: {"choices":[{"index":0,"delta":{"content":"hi"}}]}',
    'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
    'data: {"choices":[{"index":0,"delta":{"content":"late"}}]}',
    ""
  ].join("\n\n");
  const events = sseEvents(responsesStreamFromChat(stream, { id: "abc" }, "auto"));
  const doneAt = events.findIndex((event) => event.type === "response.completed");
  assert.ok(doneAt >= 0);
  assert.ok(events.slice(doneAt + 1).every((event) => !event.type?.startsWith("response.")));
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
