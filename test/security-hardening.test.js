import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { assertLoopbackHost, gatewayBase, isLoopbackHost } from "../src/config.js";
import { protectText, unprotectText } from "../src/secure-auth.js";
import { createServer } from "../src/server.js";
import { ensureControlToken } from "../src/control-token.js";
import { createEgressGuard, EgressBlocked } from "../src/egress.js";
import { redactText, redactForLog } from "../src/redact.js";

// Everything in this file that touches the data directory stays in its own
// sandbox; the file runs as its own node:test process.
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "lane-hardening-"));
process.env.LANE_DATA_DIR = SANDBOX;

test("only loopback addresses are accepted", () => {
  for (const host of ["127.0.0.1", "127.0.0.2", "localhost", "LOCALHOST", "::1", "[::1]", "::ffff:127.0.0.1"]) {
    assert.equal(isLoopbackHost(host), true, host);
    assert.equal(assertLoopbackHost(host), host);
  }
  for (const host of ["0.0.0.0", "192.168.1.2", "10.0.0.1", "example.com", "", null]) {
    assert.equal(isLoopbackHost(host), false, String(host));
    assert.throws(() => assertLoopbackHost(host), /only binds loopback/);
  }
});

test("IPv6 gateway URLs are bracketed", () => {
  assert.equal(gatewayBase("::1", 3426), "http://[::1]:3426");
  assert.equal(gatewayBase("127.0.0.1", 3426), "http://127.0.0.1:3426");
});

test("encrypted auth files round-trip a Chinese display name", async () => {
  const value = "眼中尽繁星、";
  assert.equal(await unprotectText(await protectText(value)), value);
});

// ---- control-plane token ---------------------------------------------------

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`));
  });
}

test("control routes answer the local token; healthz stays open", async () => {
  const control = { status: async () => ({ ok: true }) };
  const server = createServer({ control });
  const base = await listen(server);
  try {
    const token = await ensureControlToken();
    assert.match(token, /^[0-9a-f]{64}$/, "the token file holds 32 random bytes as hex");

    const bare = await fetch(`${base}/lane/status`);
    assert.equal(bare.status, 403, "no token, no control plane");
    const wrong = await fetch(`${base}/lane/status`, { headers: { "x-lane-token": "x".repeat(64) } });
    assert.equal(wrong.status, 403, "a wrong token is as good as none");
    const good = await fetch(`${base}/lane/status`, { headers: { "x-lane-token": token } });
    assert.equal(good.status, 200);

    const health = await fetch(`${base}/healthz`);
    assert.equal(health.status, 200, "the data plane stays open to the wired agents");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

// ---- egress: every hop pays the check -------------------------------------

function hop(response, location) {
  return new Response(null, { status: response, headers: location ? { location } : {} });
}

test("enforce refuses a redirect that leaves the allowlist", async () => {
  const hops = [];
  const guard = createEgressGuard({
    mode: "enforce",
    realFetch: async (url) => {
      hops.push(String(url));
      return hop(307, "https://evil.example/collect");
    }
  });
  await assert.rejects(
    () => guard("https://copilot.tencent.com/v2/chat/completions", { method: "POST", body: "{}" }),
    (error) => error instanceof EgressBlocked && error.host === "evil.example"
  );
  assert.equal(hops.length, 1, "the forwarding hop never happens");
});

test("a 307 keeps the method and body; a 303 degrades to GET", async () => {
  const seen = [];
  let calls = 0;
  const guard = createEgressGuard({
    mode: "enforce",
    realFetch: async (url, init) => {
      calls += 1;
      seen.push({ url: String(url), method: init?.method, body: init?.body });
      if (calls === 1) return hop(307, "https://api.trae.cn/next");
      if (calls === 2) return hop(303, "https://api.trae.cn/last");
      return new Response("done");
    }
  });
  const final = await guard("https://api.trae.cn/start", { method: "POST", body: "secret" });
  assert.equal(final.status, 200);
  assert.deepEqual(seen.map((s) => `${s.method} ${s.url}${s.body ? ` ${s.body}` : ""}`), [
    "POST https://api.trae.cn/start secret",
    "POST https://api.trae.cn/next secret",
    "GET https://api.trae.cn/last"
  ]);
});

test("enforce refuses an allowed host over plain http", async () => {
  const guard = createEgressGuard({ mode: "enforce", realFetch: async () => new Response("ok") });
  await assert.rejects(
    () => guard("http://copilot.tencent.com/v2/chat/completions"),
    (error) => error instanceof EgressBlocked && error.reason === "scheme"
  );
  const monitor = createEgressGuard({ mode: "monitor", realFetch: async () => new Response("ok") });
  assert.equal((await monitor("https://copilot.tencent.com/")).status, 200);
});

test("monitor records every redirect hop", async () => {
  const hosts = [];
  let calls = 0;
  const guard = createEgressGuard({
    mode: "monitor",
    record: (entry) => hosts.push(entry.host),
    realFetch: async () => (calls += 1) === 1
      ? hop(302, "https://www.workbuddy.ai/moved")
      : new Response("ok")
  });
  await guard("https://copilot.tencent.com/x");
  assert.deepEqual(hosts, ["copilot.tencent.com", "www.workbuddy.ai"]);
});

// ---- redaction: the blind spots and the bounded scan -----------------------

test("cookie, Basic auth, query-string and bare token secrets are masked", () => {
  const cases = [
    ["Cookie: sessionid=abcdef1234567890abcdef", /abcdef1234567890/],
    ["Set-Cookie: session=abcdef1234567890; Path=/", /abcdef1234567890/],
    ["Authorization: Basic dXNlcm5hbWU6cGFzc3dvcmQxMjM=", /dXNlcm5hbWU6cGFzc3dvcmQxMjM/],
    ["https://api.example.com/v1/data?token=abcdef1234567890abcdef&x=1", /token=abcdef/],
    ["https://oauth.example/cb?code=abcdefghijklmnopqrstuvwxyz", /code=abcdefghij/],
    ["token=abcdef1234567890abcdef", /abcdef123456/]
  ];
  for (const [input, leak] of cases) {
    const out = redactText(input, { personal: false });
    assert.doesNotMatch(out, leak, input);
  }
  // The bearer rule keeps its own region when it wins: the whole value is
  // masked by the bearer rule, not by the header rule around it.
  assert.equal(
    redactText("Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456", { personal: false }),
    "Authorization: Bearer «redacted»"
  );
  // Ordinary prose keeps its words: a status code or a header name alone is
  // not a credential.
  assert.equal(redactText("code: 200 auth required", { personal: false }), "code: 200 auth required");
  assert.match(redactForLog("cookie: a=1"), /«redacted»/);
});

test("a pathological prompt cannot drive the matcher quadratic", () => {
  // 2 MB of the class every unbounded rule used to rescan, with the `@` the
  // connection rule hunts for forever missing. A quadratic scan costs
  // minutes; the windowed scan is done in well under a second.
  const adversarial = `https://user:${"a".repeat(2 * 1024 * 1024)}`;
  const started = Date.now();
  redactText(adversarial, { personal: false });
  assert.ok(Date.now() - started < 10_000, "redaction scanned 2 MB in bounded time");
  const cjk = `北京市海淀区${"口".repeat(2 * 1024 * 1024)}`;
  const startedCjk = Date.now();
  redactText(cjk, { personal: true });
  assert.ok(Date.now() - startedCjk < 10_000, "the address rule scanned 2 MB of CJK in bounded time");
});
