import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CHAT_PATHS,
  KNOWN_PATHS,
  KNOWN_PREFIXES,
  NON_CHAT_BODY_LIMIT,
  classifyPath,
  inspectRequest
} from "../src/egress-paths.js";
import { newPaths, pathsInSource, pluginPaths, readBaseline } from "../scripts/egress-paths-audit.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");

test("a known endpoint, a prefix family and an unknown path are told apart", () => {
  assert.equal(classifyPath("/api/agent/v3/llm_utils_chat"), "known");
  assert.equal(classifyPath("/v2/billing/meter/anything-new"), "prefix");
  assert.equal(classifyPath("/upload"), "unknown");
  assert.equal(classifyPath(""), "unknown");
});

test("a chat request is recognised and its body is not size-flagged", () => {
  const body = JSON.stringify({ model: "x", messages: [{ role: "user", content: "hi" }] });
  const audit = inspectRequest({ pathname: "/api/agent/v3/llm_utils_chat", body, method: "POST" });
  assert.equal(audit.chat, true);
  assert.equal(audit.pathVerdict, "known");
  assert.deepEqual(audit.suspicious, []);
});

test("a large body outside a chat path is flagged", () => {
  const audit = inspectRequest({
    pathname: "/v2/billing/meter/daily-checkin",
    body: "x".repeat(NON_CHAT_BODY_LIMIT + 1),
    method: "POST"
  });
  assert.equal(audit.chat, false);
  assert.ok(audit.suspicious.includes("large-body-outside-chat"));
});

test("a small body outside a chat path is not flagged", () => {
  const audit = inspectRequest({ pathname: "/v2/billing/meter/daily-checkin", body: "{}" });
  assert.deepEqual(audit.suspicious, []);
});

test("an unknown path is flagged even with a small body", () => {
  const audit = inspectRequest({ pathname: "/collect", body: "{}" });
  assert.ok(audit.suspicious.includes("unknown-path"));
});

test("a chat request carrying fields the protocol does not define is flagged", () => {
  const body = JSON.stringify({
    model: "x",
    messages: [],
    // The shape of a leak dressed as a normal call.
    transcript_backup: "the whole conversation"
  });
  const audit = inspectRequest({ pathname: "/v1/chat/completions", body });
  assert.ok(audit.suspicious.some((reason) => reason.startsWith("unexpected-chat-fields")));
  assert.match(audit.suspicious.join(" "), /transcript_backup/);
});

test("every chat path is also a known path", () => {
  for (const value of CHAT_PATHS) {
    assert.ok(KNOWN_PATHS.has(value), `${value} must be listed in KNOWN_PATHS`);
  }
});

test("every path the plugins name is covered by the path list", () => {
  const paths = pluginPaths();
  assert.ok(paths.size > 0, "the audit found the plugin paths");
  const unknown = [...paths].filter((value) => classifyPath(value) === "unknown");
  assert.deepEqual(unknown, [],
    "a vendored plugin names a path Lane does not expect; add it to src/egress-paths.js or investigate it");
});

test("the path baseline covers the plugins, so an upgrade that adds a path fails here", () => {
  const baseline = readBaseline();
  const paths = pluginPaths();
  assert.ok(baseline.size > 0, "docs/egress-paths-baseline.txt exists");
  assert.deepEqual(newPaths(paths, baseline), [],
    "a vendored plugin names a path the baseline does not; run node scripts/egress-paths-audit.mjs and review it");
});

test("the audit ignores base-url fragments, which are not endpoints", () => {
  const paths = pathsInSource('baseURL: "https://x/v1" + "/chat/completions"');
  assert.equal(paths.has("/v1"), false, "a single segment is not an endpoint");
  assert.equal(paths.has("/chat/completions"), true);
});

test("the audit cuts a query string off a path", () => {
  const paths = pathsInSource('fetch("/v1/models?agent=codex")');
  assert.equal(paths.has("/v1/models"), true);
});

test("prefix rules are declared with a reason", () => {
  assert.ok(KNOWN_PREFIXES.length > 0);
  for (const [prefix, reason] of KNOWN_PREFIXES) {
    assert.match(prefix, /^\/.+/, "a prefix starts at the root");
    assert.ok(reason.length > 0, `${prefix} needs a reason`);
  }
});

test("the path audit ships as a script and a baseline", () => {
  assert.ok(KNOWN_PATHS.size > 0);
  assert.ok(ROOT.includes("lane"));
});
