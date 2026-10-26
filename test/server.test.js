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

test("an alias the current account cannot serve is named, not forwarded", async () => {
  const provider = {
    async listModels() {
      // The international catalogue: no "auto", which the domestic one has.
      return [{ id: "default-model", name: "Default", efforts: ["low"] }];
    },
    async chat() {
      throw new Error("the gateway must not reach the upstream");
    }
  };
  const server = createServer({ provider });
  const base = await listen(server);
  const digest = (id) =>
    import("node:crypto").then(({ createHash }) =>
      createHash("sha256").update(id).digest("hex").slice(0, 10)
    );
  // Claude Desktop still holds the alias for "auto" from the previous account.
  const stale = `anthropic/lane-${await digest("auto")}`;
  try {
    const response = await fetch(`${base}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: stale,
        max_tokens: 10,
        messages: [{ role: "user", content: "hi" }]
      })
    });
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.match(body.error.message, /belongs to the account Lane was routing before/);
    assert.match(body.error.message, /pick a model from the current list/);
    // The id Claude Desktop knows is what the user has to act on, so it is
    // in the message rather than a digest they cannot match to a model.
    assert.ok(body.error.message.includes(stale));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("an alias the current account does serve still resolves", async () => {
  const provider = {
    async listModels() {
      return [{ id: "default-model", name: "Default", efforts: ["low"] }];
    },
    async chat() {
      return new Response([
        'data: {"choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":null}]}\n\n',
        'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
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
  const alias = `mythos-lane-${await digest("default-model")}`;
  try {
    const response = await fetch(`${base}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: alias,
        max_tokens: 10,
        messages: [{ role: "user", content: "hi" }]
      })
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).content[0].text, "ok");
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

test("the usage route answers the overview and passes the range through", async () => {
  const calls = [];
  const control = {
    usage: async (range) => {
      calls.push(range);
      return { range, totals: { requests: 2, credits: 0.07 }, series: [] };
    }
  };
  const server = createServer({ control });
  const base = await listen(server);
  try {
    const today = await fetch(`${base}/lane/usage`);
    assert.equal(today.status, 200);
    assert.deepEqual(await today.json(), {
      range: "today",
      totals: { requests: 2, credits: 0.07 },
      series: []
    });

    const week = await fetch(`${base}/lane/usage?range=7d`);
    assert.equal((await week.json()).range, "7d");
    assert.deepEqual(calls, ["today", "7d"]);
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

test("a chat completion that asks for no stream gets a plain answer", async () => {
  const provider = {
    async listModels() { return [{ id: "auto", name: "Auto" }]; },
    async chat() {
      const chunk = (delta, finish = null) => `data: ${JSON.stringify({
        id: "c1", model: "auto", created: 1,
        choices: [{ index: 0, delta, finish_reason: finish }]
      })}\n\n`;
      return new Response([
        ": heartbeat\n",
        chunk({ content: "Hello" }),
        chunk({ content: " there" }),
        chunk({}, "stop"),
        "data: [DONE]\n\n"
      ].join(""), { headers: { "content-type": "text/event-stream" } });
    }
  };
  const server = createServer({ provider });
  const base = await listen(server);
  try {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "auto", messages: [{ role: "user", content: "hi" }] })
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") || "", /application\/json/);
    const body = await res.json();
    assert.equal(body.object, "chat.completion");
    assert.equal(body.choices[0].message.content, "Hello there");
    assert.equal(body.choices[0].finish_reason, "stop");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("a chat completion that asks for a stream keeps the upstream events", async () => {
  const provider = {
    async listModels() { return [{ id: "auto", name: "Auto" }]; },
    async chat() {
      const chunk = (delta, finish = null) => `data: ${JSON.stringify({
        id: "c1", model: "auto", created: 1,
        choices: [{ index: 0, delta, finish_reason: finish }]
      })}\n\n`;
      return new Response([
        ": heartbeat\n",
        chunk({ content: "Hi" }),
        chunk({}, "stop"),
        "data: [DONE]\n\n"
      ].join(""), { headers: { "content-type": "text/event-stream" } });
    }
  };
  const server = createServer({ provider });
  const base = await listen(server);
  try {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "auto", messages: [{ role: "user", content: "hi" }], stream: true })
    });
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.match(text, /"content":"Hi"/);
    assert.match(text, /"finish_reason":"stop"/);
    assert.match(text, /data: \[DONE\]/);
    // The heartbeat is not an OpenAI event, and a client that parses strictly
    // must not see it.
    assert.doesNotMatch(text, /heartbeat/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("a streamed upstream error event is forwarded and journalled as an error", async () => {
  // The plain-answer path already failed the assembly on an error event;
  // the streamed path used to forward it and still record the request as
  // complete, hiding the failure from the activity list.
  const provider = {
    async listModels() { return [{ id: "auto", name: "Auto" }]; },
    async chat() {
      return new Response([
        `data: ${JSON.stringify({ id: "c1", model: "auto", created: 1, choices: [{ index: 0, delta: { content: "par" } }] })}\n\n`,
        `data: ${JSON.stringify({ error: { message: "quota exhausted" } })}\n\n`,
        "data: [DONE]\n\n"
      ].join(""), { headers: { "content-type": "text/event-stream" } });
    }
  };
  const finished = [];
  const control = {
    journal: {
      start: () => ({ id: "r1", startedAt: Date.now() }),
      note() {},
      usage() {},
      finish: (id, values) => finished.push(values)
    },
    invalidateUsage() {}
  };
  const server = createServer({ provider, control });
  const base = await listen(server);
  try {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "auto", messages: [{ role: "user", content: "hi" }], stream: true })
    });
    assert.equal(res.status, 200);
    const text = await res.text();
    // The client sees the error event exactly as the upstream sent it, and
    // the stream still terminates cleanly.
    assert.match(text, /quota exhausted/);
    assert.match(text, /data: \[DONE\]/);
    assert.equal(finished.length, 1);
    assert.equal(finished[0].status, "error");
    assert.match(finished[0].error, /quota exhausted/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("a non-stream chat completion stitches tool calls back together", async () => {
  const provider = {
    async listModels() { return [{ id: "auto", name: "Auto" }]; },
    async chat() {
      const chunk = (delta, finish = null) => `data: ${JSON.stringify({
        choices: [{ index: 0, delta, finish_reason: finish }]
      })}\n\n`;
      return new Response([
        chunk({ content: "Let me check." }),
        chunk({ tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "get_weather", arguments: '{"city"' } }] }),
        chunk({ tool_calls: [{ index: 0, function: { arguments: ':"Paris"}' } }] }),
        chunk({ tool_calls: [{ index: 1, id: "call_2", type: "function", function: { name: "get_time", arguments: "{}" } }] }),
        chunk({}, "tool_calls"),
        "data: [DONE]\n\n"
      ].join(""), { headers: { "content-type": "text/event-stream" } });
    }
  };
  const server = createServer({ provider });
  const base = await listen(server);
  try {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "auto",
        messages: [{ role: "user", content: "weather?" }],
        tools: [{ type: "function", function: { name: "get_weather", parameters: {} } }]
      })
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.choices[0].finish_reason, "tool_calls");
    assert.equal(body.choices[0].message.content, "Let me check.");
    assert.deepEqual(body.choices[0].message.tool_calls, [
      {
        id: "call_1",
        type: "function",
        function: { name: "get_weather", arguments: '{"city":"Paris"}' }
      },
      {
        id: "call_2",
        type: "function",
        function: { name: "get_time", arguments: "{}" }
      }
    ]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("the journal records the account carrying the request", async () => {
  const started = [];
  const control = {
    journal: {
      start: (values) => {
        started.push(values);
        return { id: "r1", startedAt: Date.now() };
      },
      note: () => {},
      usage: () => {},
      finish: () => {}
    },
    invalidateUsage: () => {}
  };
  const provider = {
    async listModels() { return [{ id: "auto", name: "Auto", context: 168000 }]; },
    async activeId() { return "uid-9"; },
    async chat() {
      const chunk = (delta, finish = null) => `data: ${JSON.stringify({
        choices: [{ index: 0, delta, finish_reason: finish }]
      })}\n\n`;
      return new Response([chunk({ content: "ok" }), chunk({}, "stop"), "data: [DONE]\n\n"].join(""), {
        headers: { "content-type": "text/event-stream" }
      });
    }
  };
  const server = createServer({ provider, control });
  const base = await listen(server);
  try {
    const chat = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "auto", messages: [{ role: "user", content: "hi" }] })
    });
    assert.equal(chat.status, 200);
    assert.equal(started[0].accountId, "uid-9");
    assert.equal(started[0].contextWindow, 168000);

    const messages = await fetch(`${base}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "auto", max_tokens: 10, messages: [{ role: "user", content: "hi" }] })
    });
    assert.equal(messages.status, 200);
    assert.equal(started[1].accountId, "uid-9");
    assert.equal(started[1].contextWindow, 168000);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("a 200 with a non-JSON body is an upstream error, not a 500", async () => {
  // A captive portal or broken proxy answers 200 with HTML; the client must
  // hear "upstream failed", not an internal parse error.
  const provider = {
    async listModels() { return [{ id: "auto", name: "Auto" }]; },
    async chat() {
      return new Response("<html>portal</html>", {
        status: 200,
        headers: { "content-type": "text/html" }
      });
    }
  };
  const server = createServer({ provider });
  const base = await listen(server);
  try {
    const response = await fetch(`${base}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "auto", max_tokens: 10, messages: [{ role: "user", content: "hi" }] })
    });
    assert.equal(response.status, 502);
    const body = await response.json();
    assert.equal(body.error.type, "upstream_error");
    assert.match(body.error.message, /invalid JSON/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("count_tokens answers a number for whatever body arrives", async () => {
  const server = createServer({ provider: { async listModels() { return []; } } });
  const base = await listen(server);
  try {
    const response = await fetch(`${base}/v1/messages/count_tokens`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tools: [null, "x"], messages: "oops" })
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(typeof body.input_tokens, "number");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("a refused chat reaches the client as an error, not an empty body", async () => {
  const provider = {
    async listModels() { return [{ id: "auto", name: "Auto" }]; },
    async chat() {
      return new Response('{"error":{"message":"Illegal API invocation"}}', {
        status: 400,
        headers: { "content-type": "application/json" }
      });
    }
  };
  const server = createServer({ provider });
  const base = await listen(server);
  try {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "auto", messages: [{ role: "user", content: "hi" }] })
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.error.message, /Illegal API invocation/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("a Host header naming another domain is refused; loopback names pass", async () => {
  const server = createServer();
  const base = await listen(server);
  const port = new URL(base).port;
  // fetch pins Host to the URL's, so the forged header is sent raw.
  const statusWith = (host) => new Promise((resolve, reject) => {
    const req = http.request(`http://127.0.0.1:${port}/healthz`, {
      agent: false,
      headers: host ? { host } : {}
    }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on("error", reject);
    req.end();
  });
  try {
    assert.equal(await statusWith("evil.example:3426"), 403, "a rebound domain cannot reach the gateway");
    assert.equal(await statusWith(`localhost:${port}`), 200);
    assert.equal(await statusWith(`127.0.0.1:${port}`), 200);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

// The upstream failing mid-stream used to take the whole gateway down: the
// catch wrote a JSON error head onto a response that had already sent its
// SSE head, ERR_HTTP_HEADERS_SENT escaped every handler, and Node exited.
test("a chat stream whose upstream dies mid-answer stays inside the protocol", async (t) => {
  const provider = {
    async listModels() { return [{ id: "auto", name: "Auto" }]; },
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
  t.after(() => server.closeAllConnections?.());
  try {
    const response = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "auto", stream: true, messages: [{ role: "user", content: "hi" }] })
    });
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.match(text, /"content":"partial"/);
    assert.match(text, /upstream disconnected/);
    assert.match(text, /data: \[DONE\]/);
    // The gateway itself survived the failure.
    const health = await fetch(`${base}/healthz`);
    assert.equal(health.status, 200);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("a chat stream that ends without any event reports an error, not an empty success", async () => {
  const provider = {
    async listModels() { return [{ id: "auto", name: "Auto" }]; },
    async chat() {
      // Only a heartbeat: no OpenAI event ever arrives.
      return new Response(": keep-alive\n\n", { headers: { "content-type": "text/event-stream" } });
    }
  };
  const server = createServer({ provider });
  const base = await listen(server);
  try {
    const response = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "auto", stream: true, messages: [{ role: "user", content: "hi" }] })
    });
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.match(text, /upstream stream ended without a response/);
    assert.match(text, /data: \[DONE\]/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("a chat stream missing its finish_reason still ends with one", async () => {
  const provider = {
    async listModels() { return [{ id: "auto", name: "Auto" }]; },
    async chat() {
      // Content, then the stream simply stops: no finish_reason anywhere.
      return new Response(
        'data: {"choices":[{"index":0,"delta":{"content":"tailless"}}]}\n\n',
        { headers: { "content-type": "text/event-stream" } }
      );
    }
  };
  const server = createServer({ provider });
  const base = await listen(server);
  try {
    const response = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "auto", stream: true, messages: [{ role: "user", content: "hi" }] })
    });
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.match(text, /"content":"tailless"/);
    assert.match(text, /"finish_reason":"stop"/);
    assert.match(text, /data: \[DONE\]/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("count_tokens counts CJK text at a token a character", async () => {
  const server = createServer();
  const base = await listen(server);
  try {
    const response = await fetch(`${base}/v1/messages/count_tokens`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "hy3",
        messages: [{ role: "user", content: "你好世界" }]
      })
    });
    // Four CJK characters are about four tokens, not the one that a flat
    // chars/4 estimate would have answered.
    assert.equal((await response.json()).input_tokens, 4);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("a request from a foreign Origin cannot drive the gateway", async () => {
  const provider = {
    async listModels() {
      return [{ id: "auto", name: "Auto" }];
    },
    async chat() {
      return new Response('data: {"choices":[{"index":0,"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n', {
        headers: { "content-type": "text/event-stream" }
      });
    }
  };
  const control = {
    journal: { start: () => null, note: () => {}, usage: () => {}, finish: () => {} },
    checkinSettings: async (patch) => patch,
    connect: async () => ({ connected: true })
  };
  const server = createServer({ provider, control });
  const base = await listen(server);
  const port = new URL(base).port;
  try {
    // A page at another origin: no preflight is needed for a text/plain POST,
    // so the gateway itself must refuse it.
    for (const path of ["/lane/checkin/settings", "/v1/chat/completions"]) {
      const response = await fetch(base + path, {
        method: "POST",
        headers: { "content-type": "text/plain", origin: "https://evil.example" },
        body: JSON.stringify(path === "/v1/chat/completions"
          ? { model: "auto", messages: [{ role: "user", content: "hi" }] }
          : { hour: 3 })
      });
      assert.equal(response.status, 403, path);
    }
    const fetchSite = await fetch(`${base}/lane/status`, {
      headers: { "sec-fetch-site": "cross-site" }
    });
    assert.equal(fetchSite.status, 403);

    // No Origin at all is what Codex, ZCode and the CLI send: allowed.
    const plain = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "auto", messages: [{ role: "user", content: "hi" }] })
    });
    assert.equal(plain.status, 200);
    // A same-origin browser request names the gateway itself: allowed.
    const own = await fetch(`${base}/lane/checkin/settings`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: `http://127.0.0.1:${port}` },
      body: "{}"
    });
    assert.equal(own.status, 200);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("a malformed request URL is answered with 400, not a crash", async () => {
  const server = createServer();
  const base = await listen(server);
  try {
    const status = await new Promise((resolve, reject) => {
      const req = http.request(`${base}//`, { method: "GET", agent: false }, (res) => {
        res.resume();
        resolve(res.statusCode);
      });
      req.on("error", reject);
      req.end();
    });
    assert.equal(status, 400);
    // The gateway must still be serving afterwards.
    const health = await fetch(`${base}/healthz`);
    assert.equal(health.status, 200);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("an ultra effort on a model without declared levels is fitted, not failed", async () => {
  const provider = {
    async listModels() {
      return [{ id: "auto", name: "Auto" }];
    },
    async chat() {
      return new Response('data: {"choices":[{"index":0,"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n', {
        headers: { "content-type": "text/event-stream" }
      });
    }
  };
  const server = createServer({ provider });
  const base = await listen(server);
  try {
    const response = await fetch(`${base}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "auto",
        max_tokens: 10,
        output_config: { effort: "ultra" },
        messages: [{ role: "user", content: "hello" }]
      })
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).content[0].text, "ok");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("an upstream error inside a 200 SSE is not read as an empty answer", async () => {
  const provider = {
    async listModels() {
      return [{ id: "auto", name: "Auto" }];
    },
    async chat() {
      return new Response('data: {"error":{"message":"quota gone"}}\n\n', {
        headers: { "content-type": "text/event-stream" }
      });
    }
  };
  const server = createServer({ provider });
  const base = await listen(server);
  try {
    const response = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "auto", messages: [{ role: "user", content: "hi" }] })
    });
    assert.equal(response.status, 502);
    assert.equal((await response.json()).error.message, "quota gone");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("protocol bodies that are not objects answer 400", async () => {
  const server = createServer();
  const base = await listen(server);
  try {
    for (const path of ["/v1/messages", "/v1/responses"]) {
      const response = await fetch(base + path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "null"
      });
      assert.equal(response.status, 400, path);
    }
    const messages = await fetch(`${base}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "auto", messages: "no" })
    });
    assert.equal(messages.status, 400);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("a control path with malformed percent-encoding answers 400", async () => {
  const control = { activate: async () => ({}) };
  const server = createServer({ control });
  const base = await listen(server);
  try {
    const response = await fetch(`${base}/lane/accounts/%E0%A4%A/activate`, { method: "POST" });
    assert.equal(response.status, 400);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("/v1/messages attributes its source by client, not by endpoint", async () => {
  // Claude Desktop and ZCode both speak Anthropic Messages; the journal used
  // to name them all claude-desktop. The Claude Desktop UA is the tell.
  const provider = {
    async listModels() { return [{ id: "auto", name: "Auto" }]; },
    async chat() {
      return new Response('data: {"choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', {
        headers: { "content-type": "text/event-stream" }
      });
    }
  };
  const started = [];
  const control = {
    journal: {
      start: (fields) => { started.push(fields); return { id: `r${started.length}`, startedAt: Date.now() }; },
      note() {}, usage() {}, finish() {}
    }
  };
  const server = createServer({ provider, control });
  const base = await listen(server);
  try {
    await fetch(`${base}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": "Mozilla/5.0 Chrome/140.0.0.0 Claude/2.7032.0" },
      body: JSON.stringify({ model: "auto", messages: [{ role: "user", content: "hi" }] })
    });
    // No Claude marker in the UA: ZCode's anthropic client, or anything else
    // speaking the same protocol.
    await fetch(`${base}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": "zcode/1.0" },
      body: JSON.stringify({ model: "auto", messages: [{ role: "user", content: "hi" }] })
    });
    // No UA at all must not be pinned on Claude Desktop either.
    await fetch(`${base}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "auto", messages: [{ role: "user", content: "hi" }] })
    });
    assert.deepEqual(started.map((fields) => fields.agent), ["claude-desktop", "zcode", "zcode"]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("a long-session body over the old 8 MB floor passes", async () => {
  // ZCode resends the whole conversation each turn; sessions outgrew the
  // old 8 MB limit and came back 413. The floor is now 64 MB - a ~9 MB body
  // must reach the provider (it answers by failing auth, not by size).
  const provider = {
    async listModels() { return [{ id: "auto", name: "Auto" }]; },
    async chat() { throw new Error("not signed in"); }
  };
  const server = createServer({ provider });
  const base = await listen(server);
  try {
    const filler = "x".repeat(9 * 1024 * 1024);
    const response = await fetch(`${base}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "auto", messages: [{ role: "user", content: filler }] })
    });
    assert.notEqual(response.status, 413);
    const body = await response.json();
    assert.ok(body.error, "the provider answers, not the size gate");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
