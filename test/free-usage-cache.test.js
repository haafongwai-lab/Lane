import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The per-account usage cache lives inside createControlCenter's closure and
 * needs a live provider to drive, so it cannot be exercised directly here.
 * What can be pinned is the properties whose loss caused real defects: the
 * cache is keyed per account (a single slot handed a second account the
 * first one's figures), a billed request revalidates the account it billed
 * (its balance moved; the others' did not, and re-reading every account per
 * request puts a billing call per account on the wire), and the read never
 * blocks a route or poll.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SOURCE = fs.readFileSync(path.join(HERE, "..", "src", "control-center.js"), "utf8");

test("the per-account usage cache is keyed per account, not a single slot", () => {
  // A Map keyed by the account id; a bare `let freeUsageCache = null` is the
  // shape that leaked one account's figures into another's row.
  assert.match(SOURCE, /const freeUsageCache = new Map\(\)/);
  assert.match(SOURCE, /const key = String\(id \|\| ""\)/);
  assert.match(SOURCE, /freeUsageCache\.get\(key\)/);
  assert.match(SOURCE, /freeUsageCache\.set\(key,/);
  assert.doesNotMatch(SOURCE, /let freeUsageCache = null/);
});

test("a billed account's entry is dropped; the others keep theirs", () => {
  const invalidate = SOURCE.slice(
    SOURCE.indexOf("const invalidateUsage"),
    SOURCE.indexOf("// Only the process that owns the gateway")
  );
  assert.match(invalidate, /usageCache\.clear\(\)/);
  // An id names one account: only its balance moved.
  assert.match(invalidate, /if \(accountId\) freeUsageCache\.delete\(String\(accountId\)\)/);
  // No id means every account changed (a check-in run over all of them).
  assert.match(invalidate, /else freeUsageCache\.clear\(\)/);
});

test("the relay names the account it billed when invalidating", () => {
  const relay = fs.readFileSync(path.join(HERE, "..", "src", "relay.js"), "utf8");
  assert.doesNotMatch(relay, /invalidateUsage\?\.\(\)/,
    "a bare call would re-read every account's balance after each request");
  assert.match(relay, /invalidateUsage\?\.\(options\.accountId\)/);
});

test("the accounts list reads credits through the same cache", () => {
  const status = SOURCE.slice(
    SOURCE.indexOf("async status()"),
    SOURCE.indexOf("async accounts()")
  );
  assert.match(status, /withCredits\(instance, await instance\.accounts\(\)\)/);
  const withCredits = SOURCE.slice(
    SOURCE.indexOf("const withCredits"),
    SOURCE.indexOf("const activeAccount")
  );
  assert.match(withCredits, /cachedAccountUsage\(instance, account\.id\)/);
  assert.doesNotMatch(withCredits, /await instance\.usage\(/,
    "the status poll must not wait on a billing round trip");
});

test("changing the route drops both caches", () => {
  const forget = SOURCE.slice(
    SOURCE.indexOf("const forgetUsage"),
    SOURCE.indexOf("// Only the process that owns the gateway")
  );
  assert.match(forget, /usageCache\.clear\(\)/);
  assert.match(forget, /freeUsageCache\.clear\(\)/);
});

test("the per-account read never blocks its caller", () => {
  // Stale-while-revalidate: the call answers from cache (or null) and the
  // refresh runs behind, so the page's charts are never held for a round
  // trip. An `await instance.usage(...)` here would block it again.
  const fn = SOURCE.slice(
    SOURCE.indexOf("const cachedAccountUsage"),
    SOURCE.indexOf("const withCredits")
  );
  assert.match(fn, /Promise\.resolve\(freeUsageCache\.get\(key\)\?\.value \?\? null\)/);
  assert.doesNotMatch(fn, /await instance\.usage\(/);
});
