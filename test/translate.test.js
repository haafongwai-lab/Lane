import test from "node:test";
import assert from "node:assert/strict";
import { anthropicToChat, chatToAnthropic } from "../src/translate/anthropic.js";
import { responsesToChat, chatToResponses } from "../src/translate/responses.js";
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
