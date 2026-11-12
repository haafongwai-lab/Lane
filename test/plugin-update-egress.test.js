import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The plugin updater talks to the npm registry, which is not an upstream.
 *
 * The egress guard replaces `globalThis.fetch` for the duration of a provider's
 * work. A status poll doing a usage read while the user pressed 检查更新 made
 * every registry request look like third-party plugin traffic, and with
 * `egressMode: "enforce"` it was refused:
 *
 *   outbound request blocked: registry.npmjs.org is not an allowed upstream host
 *
 * The check then reported no update for a plugin that had one — and a rollback
 * made it look as if rolling back had broken the check. The updater captures
 * the native fetch at import time so its own network calls sit outside that
 * window.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STORE = fs.readFileSync(path.join(HERE, "..", "src", "plugin-store.js"), "utf8");

test("the updater captures the native fetch before any guard can replace it", () => {
  assert.match(STORE, /const nativeFetch = globalThis\.fetch;/);
});

test("every registry request goes through that capture", () => {
  // The metadata read and the tarball download are the two network calls.
  assert.match(STORE, /await nativeFetch\(url, \{/);
  assert.match(STORE, /await nativeFetch\(latest\.tarball, \{/);
  // No bare fetch left that a guard could intercept.
  const bare = STORE.match(/(^|[^.\w])fetch\(/gm) || [];
  assert.equal(bare.length, 0, "plugin-store must not call the global fetch directly");
});

test("the egress guard is only installed for provider work, never around the updater", () => {
  const egress = fs.readFileSync(path.join(HERE, "..", "src", "egress.js"), "utf8");
  // installEgressGuard swaps the global; the store captures it beforehand.
  assert.match(egress, /globalThis\.fetch = guarded/);
  assert.match(egress, /globalThis\.fetch === guarded\) globalThis\.fetch = previous/);
});
