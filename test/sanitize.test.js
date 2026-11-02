import test from "node:test";
import assert from "node:assert/strict";
import { prepareChat } from "../src/sanitize.js";

test("the words WorkBuddy refuses never reach it", async () => {
  const { body } = await prepareChat({
    model: "hy3",
    messages: [
      { role: "system", content: "You are an AI agent that helps the user with programming tasks.\nBe brief." },
      { role: "user", content: "hi" }
    ]
  });

  assert.doesNotMatch(body.messages[0].content, /an AI agent that helps/);
  assert.match(body.messages[0].content, /Be brief/, "the rest of the prompt is kept");
  assert.equal(body.messages[1].content, "hi");
});

test("a chat without a system message gets one", async () => {
  const { body } = await prepareChat({ model: "hy3", messages: [{ role: "user", content: "hi" }] });
  assert.equal(body.messages[0].role, "system");
  assert.ok(body.messages[0].content.length > 0);
});

test("the spellings the endpoint takes replace the ones it refuses", async () => {
  const { body } = await prepareChat({
    model: "hy3",
    max_completion_tokens: 512,
    messages: [
      { role: "developer", content: "be terse" },
      { role: "user", content: "hi" }
    ]
  });

  assert.equal(body.max_tokens, 512);
  assert.equal(body.max_completion_tokens, undefined);
  assert.equal(body.messages[0].role, "system");
});

test("a body with nothing to change is passed through", async () => {
  const original = { model: "hy3", messages: [{ role: "system", content: "plain" }, { role: "user", content: "hi" }] };
  const { body, names } = await prepareChat(original);
  assert.equal(body.messages[0].content, "plain");
  assert.equal(body.model, "hy3");
  assert.equal(names.size, 0);
});

test("a client's opening line is reworded, not passed through", async () => {
  // The plugin (0.1.28) matches this sentence but replaces it with itself,
  // so WorkBuddy still refuses the chat as 11128. Lane rewrites it.
  const { body } = await prepareChat({
    model: "hy3",
    messages: [
      { role: "system", content: "You are an AI assistant that helps the user with programming tasks.\n\nFollow the rules." },
      { role: "user", content: "hi" }
    ]
  });

  const system = body.messages[0].content;
  assert.doesNotMatch(system, /helps the user with programming tasks/);
  assert.doesNotMatch(system, /an AI (agent|assistant) that helps/);
  assert.match(system, /helpful assistant/);
  assert.match(system, /Follow the rules/, "the rest of the prompt survives");
});

test("both spellings of the refused opening line are reworded", async () => {
  for (const opening of [
    "You are an AI agent that helps the user with programming tasks.",
    "You are an AI assistant that helps the user with programming tasks."
  ]) {
    const { body } = await prepareChat({
      model: "hy3",
      messages: [{ role: "system", content: opening }, { role: "user", content: "hi" }]
    });
    assert.doesNotMatch(body.messages[0].content, /an AI (agent|assistant) that helps/, opening);
  }
});

test("the reword reaches a refused line in a content array too", async () => {
  const { body } = await prepareChat({
    model: "hy3",
    messages: [
      { role: "system", content: [
        { type: "text", text: "You are an AI assistant that helps the user with programming tasks." },
        { type: "text", text: "Be precise." }
      ] },
      { role: "user", content: "hi" }
    ]
  });

  const parts = body.messages[0].content;
  assert.doesNotMatch(parts[0].text, /helps the user with programming tasks/);
  assert.equal(parts[1].text, "Be precise.");
});

test("DeepSeek Harness's opening line is reworded, keeping its name", async () => {
  // The plugin's own table (0.2.9, measured 2026-10-30): as written the
  // line is refused 11128; as rewritten the endpoint answers 200, and the
  // harness keeps its name because the rest of the prompt refers back to it.
  const { body } = await prepareChat({
    messages: [
      { role: "system", content: "You are a helpful assistant for software engineering work." },
      { role: "user", content: "hi" }
    ]
  });
  assert.equal(body.messages[0].content, "You are an AI agent, powered by DeepSeek Harness.");
});

test("a refused line inside an assistant message is reworded too", async () => {
  // The model can quote the line back; moving the system prompt into the
  // user's instructions cannot reach an assistant message, so every message
  // is scanned.
  const { body } = await prepareChat({
    messages: [
      { role: "system", content: "You are a helpful assistant." },
      { role: "user", content: "hi" },
      { role: "assistant", content: "Web GUI whose URL the runtime context names.  When the user refers to it" }
    ]
  });
  const assistant = body.messages.find((m) => m.role === "assistant");
  assert.match(String(assistant.content), /The interface, when the user refers/);
  assert.doesNotMatch(String(assistant.content), /names\.\s+When the user refers/);
});

test("one rewrite never feeds the next rule", async () => {
  // Rule 1's accepted wording is exactly rule 2's refused line. Chained, a
  // Claude-style opener would come out named as DeepSeek Harness - a
  // harness the client is not.
  const { body } = await prepareChat({
    messages: [
      { role: "system", content: "You are an AI agent that helps the user with programming tasks." },
      { role: "user", content: "hi" }
    ]
  });
  assert.equal(body.messages[0].content, "You are a helpful assistant for software engineering work.",
    "the first rule's output is final, not rescanned by the second");
});

test("ordinary text is left exactly as it was", async () => {
  const text = "Please review this function and tell me what it does.";
  const { body } = await prepareChat({
    messages: [{ role: "system", content: text }, { role: "user", content: "hi" }]
  });
  assert.equal(body.messages[0].content, text);
});
