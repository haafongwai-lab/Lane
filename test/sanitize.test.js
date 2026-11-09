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

test("DeepSeek Harness's opening line keeps its name when hiding is off", async () => {
  // The plugin's own table (0.2.9, measured 2026-10-30): as written the
  // line is refused 11128; as rewritten the endpoint answers 200, and the
  // harness keeps its name because the rest of the prompt refers back to it.
  // Hiding is off here on purpose: with it on the name is taken out below.
  const { body } = await prepareChat({
    messages: [
      { role: "system", content: "You are an AI agent, powered by DeepSeek Harness." },
      { role: "user", content: "hi" }
    ]
  }, { hideDsh: false });
  assert.equal(body.messages[0].content, "You are an AI agent, powered by DeepSeek Harness.");
});

test("a rewrite cannot put the harness's name back after it was hidden", async () => {
  // The rewrite's accepted wording is the harness's own line. Hiding first
  // would leave the name in the text the rewrite writes, so the order is
  // rewrite then conceal; nothing the endpoint receives says the name.
  const { body } = await prepareChat({
    messages: [
      { role: "system", content: "You are a helpful assistant for software engineering work." },
      { role: "user", content: "hi" }
    ]
  });
  const system = String(body.messages[0].content);
  assert.doesNotMatch(system, /DeepSeek Harness/);
  assert.equal(system, "You are an AI agent.");
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
  // harness the client is not. Hiding is off so the rewrite itself is what
  // is checked; the next test pins that hiding then takes the name away.
  const { body } = await prepareChat({
    messages: [
      { role: "system", content: "You are a helpful assistant for software engineering work." },
      { role: "user", content: "hi" }
    ]
  }, { hideDsh: false });
  assert.equal(body.messages[0].content, "You are an AI agent, powered by DeepSeek Harness.",
    "the first rule's output is final, not rescanned by the second");
});

test("ordinary text is left exactly as it was", async () => {
  const text = "Please review this function and tell me what it does.";
  const { body } = await prepareChat({
    messages: [{ role: "system", content: text }, { role: "user", content: "hi" }]
  });
  assert.equal(body.messages[0].content, text);
});

// ---- hiding DeepSeek Harness's name (the community plugin's hide_dsh) ----

test("the harness's name is hidden by default, in prose only", async () => {
  const { body } = await prepareChat({
    model: "deepseek-v4.1-flash",
    messages: [
      { role: "system", content: "You are an AI agent, powered by DeepSeek Harness.\nRead ~/.dsh/config and run dsh-session." },
      { role: "user", content: "The DSH itself decides. Also DSH_HOME is set." }
    ]
  });
  const system = String(body.messages.find((m) => m.role === "system").content);
  const user = String(body.messages.find((m) => m.role === "user").content);
  assert.doesNotMatch(system, /DeepSeek Harness/, "the name is gone from the system prompt");
  assert.match(system, /You are an AI agent\./, "the opener keeps its first clause");
  assert.match(system, /~[\/\\]\.dsh/, "a path naming dsh stays");
  assert.match(system, /dsh-session/, "a URI/command naming dsh stays");
  assert.match(user, /the agent itself/, "the prose name is replaced");
  assert.match(user, /DSH_HOME/, "an identifier is left alone");
});

test("the switch turns name-hiding off", async () => {
  const body = {
    messages: [{ role: "system", content: "You are an AI agent, powered by DeepSeek Harness." }]
  };
  const off = await prepareChat(body, { hideDsh: false });
  assert.match(String(off.body.messages[0].content), /DeepSeek Harness/);
});

test("0.2.25: a user's path and bare name stay; DSH lines and system prose hide", async () => {
  const asked = "Bash 绝对路径: /root/DSH/Work/OC-182.92.66.95/ 请原样复述这个路径";
  const { body } = await prepareChat({
    model: "deepseek-v4.1-flash",
    messages: [
      { role: "system", content: "You are an AI agent, powered by DeepSeek Harness.\nWorking directory: /root/DSH/Work/OC-182.92.66.95/" },
      { role: "user", content: [{ type: "text", text: asked }, { type: "text", text: "I like DSH and DeepSeek Harness" }] },
      { role: "assistant", content: "/root/DSH/Work/OC-182.92.66.95/ — DSH says hi" }
    ],
    tools: [{ type: "function", function: { name: "run", description: "Runs through DeepSeek Harness" } }]
  });
  const system = String(body.messages.find((m) => m.role === "system").content);
  const user = body.messages.find((m) => m.role === "user");
  const assistant = body.messages.find((m) => m.role === "assistant");
  assert.match(system, /^You are an AI agent\./);
  assert.match(system, /Working directory: \/root\/DSH\/Work\/OC-182\.92\.66\.95\//);
  assert.equal(user.content[0].text, asked);
  assert.equal(user.content[1].text, "I like DSH and DeepSeek Harness");
  assert.equal(assistant.content, "/root/DSH/Work/OC-182.92.66.95/ — DSH says hi");
  assert.match(body.tools[0].function.description, /the agent harness/);
});

test("a tool result keeps its own words", async () => {
  // A tool's result is what a file or command said; rewriting it would
  // change what the agent reads back.
  const { body } = await prepareChat({
    messages: [
      { role: "user", content: "run it" },
      { role: "tool", content: "DeepSeek Harness printed this line" },
      { role: "user", content: [{ type: "tool_result", content: "DeepSeek Harness again" }] }
    ]
  });
  const tool = body.messages.find((m) => m.role === "tool");
  assert.equal(tool.content, "DeepSeek Harness printed this line");
  // The plugin may prepend a system message; find the part-bearing message
  // by its shape rather than by an index.
  const result = body.messages
    .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
    .find((part) => part.type === "tool_result");
  assert.equal(result.content, "DeepSeek Harness again");
});

test("a user's own text is left while a non-text part is untouched", async () => {
  const { body } = await prepareChat({
    messages: [{
      role: "user",
      content: [
        { type: "text", text: "DeepSeek Harness is running" },
        { type: "image", source: { data: "DeepSeek Harness in a filename" } }
      ]
    }]
  });
  const parts = body.messages.find((m) => Array.isArray(m.content) && m.content.some((p) => p.type === "text")).content;
  const textPart = parts.find((p) => p.type === "text");
  assert.equal(textPart.text, "DeepSeek Harness is running", "the user's own words stay as written");
  assert.equal(parts.find((p) => p.type === "image").source.data, "DeepSeek Harness in a filename");
});

test("tool descriptions are rewritten, tool schemas are not", async () => {
  const { body } = await prepareChat({
    messages: [{ role: "user", content: "hi" }],
    tools: [{
      type: "function",
      function: {
        name: "run",
        description: "Runs a command through DeepSeek Harness",
        parameters: { type: "object", properties: { cmd: { type: "string", description: "DSH command" } } }
      }
    }]
  });
  const fn = body.tools[0].function;
  assert.equal(fn.description, "Runs a command through the agent harness");
  assert.equal(fn.parameters.properties.cmd.description, "the agent harness command");
  assert.equal(fn.name, "run", "the tool's name is not prose and is left alone");
});
