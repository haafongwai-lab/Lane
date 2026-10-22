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
