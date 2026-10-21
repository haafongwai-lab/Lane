import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createServer } from "../src/server.js";

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

test("health and model discovery work without a provider account", async () => {
  const server = createServer();
  const base = await listen(server);
  try {
    const health = await fetch(`${base}/healthz`);
    assert.equal(health.status, 200);
    assert.equal((await health.json()).name, "lane");

    const models = await fetch(`${base}/v1/models`);
    assert.equal(models.status, 200);
    const body = await models.json();
    assert.equal(body.object, "list");
    assert.ok(body.data.some((model) => model.real_id === "auto"));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("chat reports a clear unavailable-provider error when not signed in", async () => {
  const server = createServer();
  const base = await listen(server);
  try {
    const response = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "auto",
        messages: [{ role: "user", content: "hello" }]
      })
    });
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error.type, "provider_unavailable");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("unknown routes are explicit", async () => {
  const server = createServer();
  const base = await listen(server);
  try {
    const response = await fetch(`${base}/not-a-route`);
    assert.equal(response.status, 404);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("Codex websocket upgrade gets an explicit unsupported response", async () => {
  const server = createServer();
  const base = await listen(server);
  try {
    const status = await new Promise((resolve, reject) => {
      const req = http.request(`${base}/backend-api/codex/responses`, {
        method: "GET",
        agent: false,
        headers: { upgrade: "websocket", connection: "Upgrade" }
      }, (res) => {
        res.resume();
        resolve(res.statusCode);
      });
      req.on("error", reject);
      req.end();
    });
    assert.equal(status, 426);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("Anthropic and Responses endpoints translate through a fake provider", async () => {
  const provider = {
    async listModels() {
      return [{ id: "auto", name: "Auto" }];
    },
    async chat() {
      const chunk = (delta, finish = null) => `data: ${JSON.stringify({
        choices: [{ index: 0, delta, finish_reason: finish }]
      })}\n\n`;
      return new Response([
        chunk({ content: "translated" }),
        chunk({}, "stop"),
        "data: [DONE]\n\n"
      ].join(""), {
        headers: { "content-type": "text/event-stream" }
      });
    }
  };
  const server = createServer({ provider });
  const base = await listen(server);
  try {
    const anthropic = await fetch(`${base}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "auto",
        max_tokens: 10,
        messages: [{ role: "user", content: "hello" }]
      })
    });
    assert.equal(anthropic.status, 200);
    assert.equal((await anthropic.json()).content[0].text, "translated");

    const responses = await fetch(`${base}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "auto", input: "hello" })
    });
    assert.equal(responses.status, 200);
    assert.equal((await responses.json()).output[0].content[0].text, "translated");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("non-stream protocol requests gather WorkBuddy's SSE response", async () => {
  const provider = {
    async listModels() {
      return [{ id: "auto", name: "Auto" }];
    },
    async chat() {
      return new Response([
        'data: {"choices":[{"index":0,"delta":{"content":"hello"}}]}',
        'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":2,"completion_tokens":1,"total_tokens":3}}',
        "data: [DONE]",
        ""
      ].join("\n\n"), { headers: { "content-type": "text/event-stream" } });
    }
  };
  const server = createServer({ provider });
  const base = await listen(server);
  try {
    const anthropic = await fetch(`${base}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "auto",
        max_tokens: 10,
        messages: [{ role: "user", content: "hello" }]
      })
    });
    assert.equal(anthropic.status, 200);
    assert.equal((await anthropic.json()).content[0].text, "hello");

    const responses = await fetch(`${base}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "auto", input: "hello" })
    });
    assert.equal(responses.status, 200);
    assert.equal((await responses.json()).output[0].content[0].text, "hello");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("a stream failure after headers stays inside the SSE protocol", async () => {
  const provider = {
    async listModels() {
      return [{ id: "auto", name: "Auto" }];
    },
    async chat() {
      let sent = false;
      const body = new ReadableStream({
        pull(controller) {
          if (!sent) {
            sent = true;
            controller.enqueue(new TextEncoder().encode(
              'data: {"choices":[{"index":0,"delta":{"content":"partial"}}]}\n\n'
            ));
            return;
          }
          controller.error(new Error("upstream disconnected"));
        }
      });
      return new Response(body, { headers: { "content-type": "text/event-stream" } });
    }
  };
  const server = createServer({ provider });
  const base = await listen(server);
  try {
    const response = await fetch(`${base}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "auto", input: "hello", stream: true })
    });
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.match(text, /"type":"response\.output_text\.delta"/);
    assert.match(text, /"type":"error"/);
    assert.match(text, /upstream disconnected/);

    const health = await fetch(`${base}/healthz`);
    assert.equal(health.status, 200);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
