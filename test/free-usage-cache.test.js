import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The free-allowance cache lives inside createControlCenter's closure and
 * needs a live provider to drive, so it cannot be exercised directly here.
 * What can be pinned is the two properties whose loss caused real defects:
 * the cache is keyed per account (a single slot handed a second overseas
 * account the first one's figures), and invalidating usage clears it too (a
 * finished request spends credits, and the card exists to stay current).
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SOURCE = fs.readFileSync(path.join(HERE, "..", "src", "control-center.js"), "utf8");

test("the free-allowance cache is keyed per account, not a single slot", () => {
  // A Map keyed by the account id; a bare `let freeUsageCache = null` is the
  // shape that leaked one account's allowance into another's card.
  assert.match(SOURCE, /const freeUsageCache = new Map\(\)/);
  assert.match(SOURCE, /const key = String\(id \|\| ""\)/);
  assert.match(SOURCE, /freeUsageCache\.get\(key\)/);
  assert.match(SOURCE, /freeUsageCache\.set\(key,/);
  assert.doesNotMatch(SOURCE, /let freeUsageCache = null/);
});

test("invalidating usage also drops the free allowance's entry", () => {
  const invalidate = SOURCE.slice(
    SOURCE.indexOf("const invalidateUsage"),
    SOURCE.indexOf("const forgetUsage")
  );
  assert.match(invalidate, /usageCache\.clear\(\)/);
  assert.match(invalidate, /freeUsageCache\.clear\(\)/);
});

test("changing the route drops both caches", () => {
  const forget = SOURCE.slice(
    SOURCE.indexOf("const forgetUsage"),
    SOURCE.indexOf("// Only the process that owns the gateway")
  );
  assert.match(forget, /usageCache\.clear\(\)/);
  assert.match(forget, /freeUsageCache\.clear\(\)/);
});

test("the free allowance read never blocks the usage route", () => {
  // Stale-while-revalidate: the call answers from cache (or null) and the
  // refresh runs behind, so the page's charts are never held for a round
  // trip. An `await instance.usage(...)` here would block it again.
  const fn = SOURCE.slice(
    SOURCE.indexOf("const cachedFreeUsage"),
    SOURCE.indexOf("const invalidateUsage")
  );
  assert.match(fn, /Promise\.resolve\(freeUsageCache\.get\(key\)\?\.value \?\? null\)/);
  assert.doesNotMatch(fn, /await instance\.usage\(/);
});

test("a batch delete records each project's outcome instead of aborting", () => {
  // One failing project used to throw out of the loop: the earlier ones were
  // already gone, the later ones never ran, and the user saw a single error
  // with no account of either. Every project now reports, and the summary
  // names the ones that failed.
  const APP = fs.readFileSync(path.join(HERE, "..", "desktop", "app.js"), "utf8");
  const handler = APP.slice(
    APP.indexOf('$("#clear-projects-selected").addEventListener'),
    APP.indexOf('$("#usage-range").addEventListener')
  );
  assert.match(handler, /const failed = \[\]/);
  assert.match(handler, /for \(const row of picked\)/);
  assert.match(handler, /try \{[\s\S]*await window\.lane\.clearProject\(row\.id\)[\s\S]*\} catch \(error\) \{[\s\S]*failed\.push/,
    "each project is wrapped in its own try");
  assert.match(handler, /ctxSelected\.delete\(row\.id\)/,
    "only the successful project leaves the selection");
  assert.match(handler, /成功 \$\{ok\} 个、失败 \$\{failed\.length\} 个/,
    "the summary states both counts");
  assert.match(handler, /failed\.map\(\(item\) => `「\$\{item\.name\}」/,
    "the failures are named");
});
