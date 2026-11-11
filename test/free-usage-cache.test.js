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
  assert.match(status, /withCredits\(instance, accountList\)/);
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

test("the free-model report counts the whole journal, not one account's rows", () => {
  // Free models are a plan-level allowance and the route changes during a
  // day. Counting only the international account's rows showed "0 今日请求"
  // whenever a domestic account carried the traffic.
  const helper = SOURCE.slice(
    SOURCE.indexOf("const freeReportFor"),
    SOURCE.indexOf("const invalidateUsage")
  );
  assert.match(helper, /freeAllowance\(usage, rows, \{ accountId: source\.id \}\)/);
  // The helper picks one account for the allowance, but the journal it reads
  // is scoped to that account inside freeAllowance, not filtered here.
  assert.match(SOURCE, /report\.freeAllowance = await freeReportFor\(instance, rows, null, routeAccount\?\.id\)/);
  assert.match(SOURCE, /let freeReport = await freeReportFor\(instance, journal\.list\(\), accountList, account\?\.id\)/);
});

test("the model list's allowance follows the route account, not one fixed account", () => {
  // The model status used one global freeAllowance read from the overseas
  // account, so switching accounts kept showing the same exhausted models.
  // The route account now decides which allowance the model list reflects,
  // and a Trae route returns null instead of leaking a WorkBuddy account's
  // state into the model list.
  const helper = SOURCE.slice(
    SOURCE.indexOf("const freeReportFor"),
    SOURCE.indexOf("const invalidateUsage")
  );
  assert.match(helper, /routeId = null/);
  assert.match(helper, /const route = routeId \? list\.find\(\(item\) => item\.id === routeId\) : null/);
  assert.match(helper, /if \(routeId && !route\) return null/);
  // The route account alone decides; no overseas fallback may leak a
  // WorkBuddy state into a Trae route.
  assert.match(helper, /const candidates = route\s*\? \[route\]\s*: list\.filter\(\(item\) => item\.provider !== "trae"\)/);
  assert.doesNotMatch(helper, /overseas/,
    "a Trae route must not show a WorkBuddy account's allowance");
});
