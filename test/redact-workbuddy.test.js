import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WorkBuddyProvider } from "../src/workbuddy.js";

/**
 * The full provider path: a secret in the user's message must leave Lane as
 * a placeholder, and the model's streamed reply must come back carrying the
 * original value. This is where redaction order matters — prepareChat runs
 * first, then the body is redacted, and only the final Response is restored.
 */

function tempEnv(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lane-redact-chat-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return {
    LANE_DATA_DIR: dir,
    USERPROFILE: dir,
    APPDATA: path.join(dir, "AppData", "Roaming"),
    LOCALAPPDATA: path.join(dir, "AppData", "Local"),
    LANE_CLAUDE_LOCALAPPDATA: path.join(dir, "AppData", "Local"),
    CODEX_HOME: path.join(dir, ".codex"),
    ZCODE_HOME: path.join(dir, ".zcode")
  };
}

test("the provider sends a placeholder and restores the streamed answer", async (t) => {
  const env = tempEnv(t);
  const secret = "ghp_abcdefghijklmnopqrstuvwxyz012345";
  const calls = [];
  const hooks = {};
  const provider = new WorkBuddyProvider({ env, hooks });
  provider.ready = true;
  provider.state = {
    version: 1,
    activeId: "u1",
    accounts: [{ id: "u1", label: "one", enabled: true, auth: { access: "token" } }]
  };
  provider.sessions.set("u1", {
    id: "u1",
    auth: { access: "token" },
    hooks,
    loader: {
      baseURL: "https://example.test/v2",
      fetch: async (_url, init) => {
        const body = JSON.parse(init.body);
        calls.push(body);
        const text = body.messages.map((message) => message.content).join("\n");
        return new Response(
          `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`,
          { headers: { "content-type": "text/event-stream" } }
        );
      }
    }
  });

  const answer = await provider.chat({
    model: "hy3",
    messages: [{ role: "user", content: `my token is ${secret}` }]
  });
  const text = await answer.text();

  assert.equal(calls.length, 1);
  assert.doesNotMatch(JSON.stringify(calls[0]), /ghp_abcdefghijklmnopqrstuvwxyz012345/);
  assert.match(JSON.stringify(calls[0]), /\{\{secret:api_key:[0-9a-f]{8}\}\}/);
  assert.match(text, /my token is ghp_abcdefghijklmnopqrstuvwxyz012345/);
});

test("with redaction off the request carries the original value", async (t) => {
  const env = tempEnv(t);
  fs.writeFileSync(path.join(env.LANE_DATA_DIR, "settings.json"), JSON.stringify({ redactSecrets: false }));
  const calls = [];
  const hooks = {};
  const provider = new WorkBuddyProvider({ env, hooks });
  provider.ready = true;
  provider.state = {
    version: 1,
    activeId: "u1",
    accounts: [{ id: "u1", label: "one", enabled: true, auth: { access: "token" } }]
  };
  provider.sessions.set("u1", {
    id: "u1",
    auth: { access: "token" },
    hooks,
    loader: {
      baseURL: "https://example.test/v2",
      fetch: async (_url, init) => {
        calls.push(JSON.parse(init.body));
        return new Response("data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
      }
    }
  });

  await provider.chat({
    model: "hy3",
    messages: [{ role: "user", content: "my token is ghp_abcdefghijklmnopqrstuvwxyz012345" }]
  });
  assert.match(JSON.stringify(calls[0]), /ghp_abcdefghijklmnopqrstuvwxyz012345/);
});
