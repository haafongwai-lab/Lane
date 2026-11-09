import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (f) => fs.readFileSync(path.join(HERE, "..", f), "utf8");
const CONTROL = read("src/control-center.js");
const SERVER = read("src/server.js");
const ROUTER = read("src/provider-router.js");
const APP_SRC = read("desktop/app.js");

/**
 * The status snapshot crosses Electron IPC, which structured-clones it. A
 * function in the payload throws there, the whole lane:status call fails, and
 * the window renders with no snapshot at all: an empty model list and every
 * agent shown as connected. These assertions pin the data-only shape.
 */
test("the status snapshot carries no function, so IPC can clone it", () => {
  assert.doesNotMatch(CONTROL, /modelGate: \{[^}]*=>/,
    "a function in modelGate breaks structuredClone");
  assert.match(CONTROL, /modelGate: \{ gated: true, enabledIds, enabledKeys, corrupt: gateCorrupt \}/);
  assert.match(CONTROL, /catalogue: Array\.isArray\(catalogue\) \? catalogue : \[\]/);
});

test("no model is served until the user adds it", () => {
  const GATE = read("src/model-gate.js");
  assert.match(GATE, /return \{ ids: new Set\(\), corrupt: false \};/,
    "an absent models.json must not allow everything");
  assert.match(GATE, /return models\.filter\(\(model\) => \{/);
  // The page draws every switch unchecked when nothing is added.
  assert.match(APP_SRC, /const on = enabled\.has\(String\(model\.id\)\)/);
  assert.doesNotMatch(APP_SRC, /!gated \|\|/);
});

test("the page draws the full catalogue while agents get the allowed subset", () => {
  // `models` is what agents may use; `catalogue` is what the page lists so
  // every model can be added or removed.
  assert.match(CONTROL, /const models = Array\.isArray\(catalogue\) \? await restrictModels\(catalogue, env\) : catalogue/);
  assert.match(ROUTER, /async catalogue\(id\)/);
  assert.match(ROUTER, /async listModels\(id\) \{\s*return restrictModels\(await this\.catalogue\(id\), this\.env\)/);
});

test("an empty allowlist clears the agent catalogues, an outage does not", () => {
  // `models === []` is a real state after the user removes everything; the
  // guard must distinguish it from a null catalogue (upstream outage).
  assert.match(CONTROL, /if \(Array\.isArray\(models\)\) \{\s*await syncCodexCatalog/);
  assert.match(CONTROL, /Array\.isArray\(models\)\s*\? Promise\.allSettled/);
  const ZCODE = read("src/agents/zcode.js");
  assert.match(ZCODE, /if \(!Array\.isArray\(models\)\) return \{ changed: false \}/);
});

test("an unlisted model cannot be requested on any agent protocol", () => {
  // The allowlist is enforced through the provider's own listModels(): a model
  // the user has not added is absent from it, and the server refuses a
  // request for a model the provider does not serve. Keeping the check here
  // (rather than reading the allowlist file) also keeps the fallback and the
  // test providers working, since they serve their whole catalogue.
  assert.match(SERVER, /async function servedModel\(provider, requested, agent\)/);
  assert.match(SERVER, /const known = models\.some\(\(model\) => model\.id === id\)/);
  const chat = SERVER.slice(SERVER.indexOf('url.pathname === "/v1/chat/completions"'));
  assert.match(chat.slice(0, 2000), /await servedModel\(provider, requested, "openai"\)/);
  assert.match(chat.slice(0, 2000), /if \(!mapped\.known\)/);
  const responses = SERVER.slice(SERVER.indexOf('url.pathname === "/v1/responses"'));
  assert.match(responses.slice(0, 2500), /await servedModel\(provider, requested, "codex"\)/);
  const messages = SERVER.slice(SERVER.indexOf('url.pathname === "/v1/messages"'));
  assert.match(messages.slice(0, 3000), /is not enabled for agents/);
});
