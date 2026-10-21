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

test("Claude Desktop's User-Agent is served Anthropic-shaped ids", async () => {
  const provider = {
    async listModels() {
      return [{ id: "hy3", name: "Hy3" }];
    }
  };
  const server = createServer({ provider });
  const base = await listen(server);
  try {
    const desktop = await fetch(`${base}/v1/models`, {
      headers: { "user-agent": "Mozilla/5.0 Chrome/140.0.0.0 Claude/2.7032.0" }
    });
    const body = await desktop.json();
    assert.match(body.data[0].id, /^anthropic\/lane-/);
    assert.equal(body.data[0].real_id, "hy3");

    const others = await (await fetch(`${base}/v1/models`)).json();
    assert.equal(others.data[0].id, "hy3");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("count_tokens answers with a local estimate", async () => {
  const server = createServer();
  const base = await listen(server);
  try {
    const response = await fetch(`${base}/v1/messages/count_tokens`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "hy3",
        messages: [{ role: "user", content: "12345678" }]
      })
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).input_tokens, 2);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("Claude Desktop's effort request is fitted to the model's levels", async () => {
  const provider = {
    async listModels() {
      return [{ id: "hy3", name: "Hy3", efforts: ["low", "high"] }];
    },
    async chat(body) {
      const chunk = (delta, finish = null) => `data: ${JSON.stringify({
        choices: [{ index: 0, delta, finish_reason: finish }]
      })}\n\n`;
      return new Response([
        chunk({ content: body.reasoning_effort }),
        chunk({}, "stop"),
        "data: [DONE]\n\n"
      ].join(""), { headers: { "content-type": "text/event-stream" } });
    }
  };
  const server = createServer({ provider });
  const base = await listen(server);
  const digest = (id) =>
    import("node:crypto").then(({ createHash }) =>
      createHash("sha256").update(id).digest("hex").slice(0, 10)
    );
  const alias = `mythos-lane-${await digest("hy3")}`;
  try {
    for (const [asked, want] of [["low", "low"], ["max", "high"], ["medium", "high"]]) {
      const response = await fetch(`${base}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: alias,
          max_tokens: 100,
          output_config: { effort: asked },
          messages: [{ role: "user", content: "hi" }]
        })
      });
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.content[0].text, want);
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("account routes switch, switch off, remove and check in", async () => {
  const calls = [];
  const control = {
    accounts: async () => ({
      accounts: [{ id: "uid-1", label: "first", enabled: true }],
      activeId: "uid-1"
    }),
    activate: async (id) => {
      calls.push(["activate", id]);
      return { id };
    },
    setEnabled: async (id, enabled) => {
      calls.push(["enabled", id, enabled]);
      return { id, enabled };
    },
    removeAccount: async (id) => {
      calls.push(["remove", id]);
      return { removed: true, activeId: "" };
    },
    checkin: async (id) => {
      calls.push(["checkin", id]);
      return { results: [{ id, status: "done" }] };
    },
    checkinOverview: async () => ({
      settings: { enabled: true, hour: 9, minute: 0 },
      today: "2026-10-22",
      accounts: []
    }),
    checkinSettings: async (patch) => {
      calls.push(["settings", patch]);
      return { settings: { enabled: true, hour: 8, minute: 5 } };
    }
  };
  const server = createServer({ control });
  const base = await listen(server);
  const post = (pathname, body) => fetch(`${base}${pathname}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  try {
    const listed = await fetch(`${base}/lane/accounts`);
    assert.equal(listed.status, 200);
    assert.equal((await listed.json()).activeId, "uid-1");

    assert.equal((await post("/lane/accounts/uid-1/activate")).status, 200);
    assert.equal((await post("/lane/accounts/uid-1/enabled", { enabled: false })).status, 200);
    assert.equal((await post("/lane/accounts/uid-1/remove")).status, 200);
    assert.equal((await post("/lane/accounts/uid-1/checkin")).status, 200);
    // A team account's id carries an "@", so it arrives URL-encoded.
    assert.equal((await post("/lane/accounts/uid-1%40ent-9/activate")).status, 200);
    assert.equal((await post("/lane/checkin")).status, 200);
    assert.equal((await post("/lane/checkin/settings", { hour: 8, minute: 5 })).status, 200);

    assert.deepEqual(calls, [
      ["activate", "uid-1"],
      ["enabled", "uid-1", false],
      ["remove", "uid-1"],
      ["checkin", "uid-1"],
      ["activate", "uid-1@ent-9"],
      ["checkin", ""],
      ["settings", { hour: 8, minute: 5 }]
    ]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("switching an account needs an explicit boolean", async () => {
  const control = {
    setEnabled: async () => {
      throw new Error("should not be called");
    }
  };
  const server = createServer({ control });
  const base = await listen(server);
  try {
    const response = await fetch(`${base}/lane/accounts/uid-1/enabled`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: "yes" })
    });
    assert.equal(response.status, 400);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
