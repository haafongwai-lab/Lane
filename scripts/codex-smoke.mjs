import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { createServer } from "../src/server.js";

const upstreamPort = 4196;
const gatewayPort = 4197;
const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), "lane-codex-smoke-"));
let upstreamRequests = 0;

const fakeUpstream = http.createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => { body += chunk; });
  req.on("end", () => {
    upstreamRequests += 1;
    if (!req.url.endsWith("/chat/completions")) {
      res.writeHead(404);
      res.end();
      return;
    }
    const chunk = (delta, finishReason = null) => `data: ${JSON.stringify({
      choices: [{ index: 0, delta, finish_reason: finishReason }]
    })}\n\n`;
    const turn = upstreamRequests === 1
      ? [
          chunk({ tool_calls: [{
            index: 0,
            id: "call_smoke",
            type: "function",
            function: { name: "exec_command", arguments: '{"cmd":"Write-Output LANE_TOOL_OK"}' }
          }] }),
          chunk({}, "tool_calls"),
          "data: [DONE]\n\n"
        ]
      : [
          chunk({ content: "LANE_CODEX_OK" }),
          chunk({}, "stop"),
          "data: [DONE]\n\n"
        ];
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(turn.join(""));
  });
});

const provider = {
  async listModels() {
    return [{ id: "auto", name: "Auto" }];
  },
  async chat(body) {
    const response = await fetch(`http://127.0.0.1:${upstreamPort}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
    return new Response(response.body, {
      status: response.status,
      headers: response.headers
    });
  }
};

let gateway;
let child;
try {
  await new Promise((resolve, reject) => {
    fakeUpstream.once("error", reject);
    fakeUpstream.listen(upstreamPort, "127.0.0.1", resolve);
  });
  gateway = createServer({ provider });
  await new Promise((resolve, reject) => {
    gateway.once("error", reject);
    gateway.listen(gatewayPort, "127.0.0.1", resolve);
  });

  await fs.writeFile(path.join(codexHome, "config.toml"), [
    `model_provider = "lane"`,
    `model = "auto"`,
    "",
    "[model_providers.lane]",
    `name = "Lane smoke test"`,
    `base_url = "http://127.0.0.1:${gatewayPort}/v1"`,
    `wire_api = "responses"`,
    "requires_openai_auth = false",
    "supports_websockets = false",
    "",
    `[projects.'${process.cwd().replaceAll("\\", "\\\\")}']`,
    'trust_level = "trusted"',
    ""
  ].join("\n"));

  child = spawn(process.env.ComSpec || "cmd.exe", [
    "/d",
    "/s",
    "/c",
    "codex exec --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox -"
  ], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      CODEX_HOME: codexHome,
      RUST_LOG: "warn"
    },
    stdio: ["pipe", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.stdin.end("Run the requested check, then reply with LANE_CODEX_OK.\n");

  const timer = setTimeout(() => child.kill(), 60000);
  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  clearTimeout(timer);
  if (exitCode !== 0) {
    throw new Error(`Codex exited ${exitCode}\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  }
  if (!`${stdout}\n${stderr}`.includes("LANE_TOOL_OK")) {
    throw new Error(`Codex did not run the fake tool\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  }
  if (!stdout.includes("LANE_CODEX_OK")) {
    throw new Error(`Codex did not receive the final text\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  }
  if (upstreamRequests < 2) {
    throw new Error(`expected at least two model turns, got ${upstreamRequests}`);
  }
  console.log(JSON.stringify({
    ok: true,
    upstreamRequests,
    codexHome,
    output: stdout.trim()
  }, null, 2));
} finally {
  if (child && child.exitCode === null) child.kill();
  await new Promise((resolve) => gateway ? gateway.close(resolve) : resolve());
  await new Promise((resolve) => fakeUpstream.close(resolve));
}
