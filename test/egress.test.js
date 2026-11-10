import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ALLOW_HOSTS, VENDOR_FAMILIES, underFamily } from "../src/egress-hosts.js";
import {
  DEFAULT_EGRESS_MODE,
  EGRESS_MODES,
  EgressBlocked,
  classifyHost,
  createEgressGuard,
  installEgressGuard,
  normalizeEgressMode
} from "../src/egress.js";
import { hostsInSource, newHosts, pluginHosts, readBaseline } from "../scripts/egress-audit.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");

test("an exact upstream host and a provider family are both allowed", () => {
  assert.equal(classifyHost("api.trae.cn"), "allowed");
  assert.equal(classifyHost("copilot.tencent.com"), "allowed");
  // A host the plugin builds from a server response is still the provider's.
  assert.equal(classifyHost("some-new-endpoint.trae.cn"), "family");
  assert.equal(classifyHost("coresg-normal.trae.ai"), "allowed");
  // Anything else is a third party: that is the case worth blocking.
  assert.equal(classifyHost("example.com"), "third-party");
  assert.equal(classifyHost("trae.cn.evil.example"), "third-party");
  assert.equal(classifyHost(""), "third-party");
});

test("family matching does not accept a lookalike domain", () => {
  assert.equal(underFamily("trae.cn"), true);
  assert.equal(underFamily("api.trae.cn"), true);
  assert.equal(underFamily("nottrae.cn"), false);
  assert.equal(underFamily("trae.cn.evil.com"), false);
  assert.equal(underFamily("evil-trae.cn"), false);
});

test("monitor mode records every host and blocks nothing", async () => {
  const seen = [];
  const guard = createEgressGuard({
    mode: "monitor",
    record: (entry) => seen.push(entry),
    realFetch: async () => new Response("ok")
  });
  await guard("https://example.com/x");
  await guard("https://api.trae.cn/v1/chat/completions");
  assert.equal(seen.length, 2);
  assert.equal(seen[0].blocked, false);
  assert.equal(seen[0].verdict, "third-party");
  assert.equal(seen[1].verdict, "allowed");
});

test("enforce mode refuses a third party and lets an upstream through", async () => {
  const seen = [];
  const guard = createEgressGuard({
    mode: "enforce",
    record: (entry) => seen.push(entry),
    realFetch: async () => new Response("ok")
  });
  const response = await guard("https://api.trae.cn/v1/chat/completions");
  assert.equal(response.status, 200);
  await assert.rejects(
    () => guard("https://collector.example.com/beacon"),
    (error) => error instanceof EgressBlocked && /collector\.example\.com/.test(error.message)
  );
  assert.equal(seen.some((entry) => entry.blocked), true, "the refusal is recorded, not silent");
});

test("enforce mode still allows a provider subdomain the exact list lacks", async () => {
  const guard = createEgressGuard({
    mode: "enforce",
    realFetch: async () => new Response("ok")
  });
  const response = await guard("https://brand-new.trae.ai/v1/chat/completions");
  assert.equal(response.status, 200);
});

test("off mode is the only mode that skips the check", async () => {
  assert.deepEqual(EGRESS_MODES, ["off", "monitor", "enforce"]);
  assert.equal(normalizeEgressMode("bogus"), DEFAULT_EGRESS_MODE);
  assert.equal(normalizeEgressMode("enforce"), "enforce");
  const seen = [];
  const guard = createEgressGuard({
    mode: "off",
    record: (entry) => seen.push(entry),
    realFetch: async () => new Response("ok")
  });
  // "off" is handled by the caller (withEgress returns early); the guard
  // itself must never block, so an unknown mode cannot silently enforce.
  await guard("https://example.com/x");
  assert.equal(seen[0].mode, "off");
  assert.equal(seen[0].blocked, false);
});

test("installing the guard replaces the global fetch and restores it", async () => {
  const original = globalThis.fetch;
  const { guarded, restore } = installEgressGuard({
    mode: "monitor",
    realFetch: async () => new Response("ok")
  });
  try {
    assert.equal(globalThis.fetch, guarded);
    const response = await fetch("https://api.trae.cn/x");
    assert.equal(response.status, 200);
  } finally {
    restore();
  }
  assert.equal(globalThis.fetch, original);
});

test("every host the plugins name is either exact or inside a provider family", () => {
  const hosts = pluginHosts();
  assert.ok(hosts.size > 0, "the audit found the plugin hosts");
  const unknown = [...hosts].filter((host) => classifyHost(host) === "third-party");
  assert.deepEqual(unknown, [],
    "a vendored plugin names a host Lane does not treat as an upstream; add it to src/egress-hosts.js or investigate it");
});

test("the baseline covers the plugins, so an upgrade that adds a host fails here", () => {
  const baseline = readBaseline();
  const hosts = pluginHosts();
  assert.ok(baseline.size > 0, "docs/egress-baseline.txt exists");
  assert.deepEqual(newHosts(hosts, baseline), [],
    "a vendored plugin names a host the baseline does not; run node scripts/egress-audit.mjs and review it");
});

test("the audit ignores documentation links, which are not traffic", () => {
  const hosts = hostsInSource("see https://github.com/x/y and https://api.trae.cn/v1");
  assert.equal(hosts.has("github.com"), false);
  assert.equal(hosts.has("api.trae.cn"), true);
});

test("the settings default is monitor, not enforce", () => {
  const settings = fs.readFileSync(path.join(ROOT, "src/settings.js"), "utf8");
  assert.match(settings, /egressMode/);
  assert.match(settings, /normalizeEgressMode/);
  assert.equal(DEFAULT_EGRESS_MODE, "monitor");
  assert.ok(ALLOW_HOSTS.size > 0);
  assert.ok(VENDOR_FAMILIES.length > 0);
});
