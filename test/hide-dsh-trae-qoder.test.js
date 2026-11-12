import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { TraeProvider } from "../src/trae.js";
import { concealDshName } from "../src/sanitize.js";

/**
 * Hiding the harness name is risk control, not cosmetics.
 *
 * WorkBuddy's `prepareChat` has always scrubbed the name in the request Lane
 * builds — its own system prompt and tool descriptions — because an account
 * used through DSH was banned for exactly that. Trae and Qoder skip
 * `prepareChat` (its rewrites are WorkBuddy's), so before this they sent the
 * harness's own system text upstream verbatim. Both now run the one step that
 * matters.
 *
 * What is scrubbed, and what is not, is deliberate: the harness's own lines
 * are rewritten, a user's sentence naming it is sent as written (rewriting a
 * user's own words would change what they asked). These tests pin both sides.
 */

async function tempEnv(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "lane-hidedsh-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { LANE_DATA_DIR: root };
}

function traeHooks(seen) {
  return {
    config(config) {
      config.provider["trae-cn"] = {
        name: "Trae",
        npm: "@ai-sdk/openai-compatible",
        api: "https://trae.test/v1",
        models: { "trae-model": { name: "Trae Model", limit: { context: 128000 } } }
      };
    },
    provider: {
      models: async () => ({ "trae-model": { name: "Trae Model", limit: { context: 128000, output: 64000 } } })
    },
    auth: {
      loader: async () => ({
        baseURL: "https://trae.test/v1",
        fetch: async (url, init) => {
          seen.body = JSON.parse(init.body);
          return new Response("data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
        }
      }),
      usage: async () => ({ plan: "Free", windows: [] })
    }
  };
}

const OPENING = "You are an AI agent, powered by DeepSeek Harness. Follow the rules.";

test("the harness's own system prompt is rewritten", () => {
  const out = concealDshName({ messages: [{ role: "system", content: OPENING }] });
  assert.doesNotMatch(out.body.messages[0].content, /DeepSeek Harness/);
  assert.match(out.body.messages[0].content, /You are an AI agent\./);
});

test("a user's own sentence naming the harness is left as written", () => {
  // Rewriting a user's words would change what they asked; the protection is
  // the harness's own text, not the person's.
  const said = "I use DeepSeek Harness and DSH daily";
  const out = concealDshName({ messages: [{ role: "user", content: said }] });
  assert.equal(out.body.messages[0].content, said);
});

test("a Trae chat scrubs the system prompt it forwards", async (t) => {
  const env = await tempEnv(t);
  const seen = {};
  const provider = new TraeProvider({ env, factory: async () => traeHooks(seen) });
  await provider.init();
  await provider.finishSignIn(null, "trae-cn", {
    type: "success", access: "a", refresh: "r", expires: Date.now() + 3600_000,
    uid: "trae-dsh", accountId: "Tester"
  });
  await provider.chat({
    model: "trae-model",
    messages: [
      { role: "system", content: OPENING },
      { role: "user", content: "hello" }
    ],
    stream: true
  });
  assert.ok(seen.body, "the request was captured");
  const system = seen.body.messages.find((m) => m.role === "system");
  assert.doesNotMatch(JSON.stringify(system), /DeepSeek Harness/, "the name never goes upstream");
});

test("hideDsh:false leaves the system prompt as written", async (t) => {
  const env = await tempEnv(t);
  await fs.mkdir(env.LANE_DATA_DIR, { recursive: true });
  await fs.writeFile(path.join(env.LANE_DATA_DIR, "settings.json"), JSON.stringify({ hideDsh: false }));
  const seen = {};
  const provider = new TraeProvider({ env, factory: async () => traeHooks(seen) });
  await provider.init();
  await provider.finishSignIn(null, "trae-cn", {
    type: "success", access: "a", refresh: "r", expires: Date.now() + 3600_000,
    uid: "trae-dsh2", accountId: "Tester"
  });
  await provider.chat({
    model: "trae-model",
    messages: [{ role: "system", content: OPENING }, { role: "user", content: "hi" }],
    stream: true
  });
  assert.match(JSON.stringify(seen.body), /DeepSeek Harness/, "opted out means untouched");
});

test("the Qoder chat applies the same scrub", async () => {
  const src = await fs.readFile(new URL("../src/qoder.js", import.meta.url), "utf8");
  assert.match(src, /import \{ concealDshName \} from "\.\/sanitize\.js"/);
  assert.match(src, /settings\.hideDsh === false \? outgoing : concealDshName\(outgoing\)\.body/);
});
