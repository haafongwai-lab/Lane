import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The quota card's default account.
 *
 * It used to default to the route account (`snapshot.activeId`), which is a
 * field left over from the single-account design: it stays on whatever was
 * chosen last and never follows the pool, so the card sat on one account
 * forever while the PROVIDER node above it named another. Both now describe
 * the same account — the first one switched into the pool — unless the user
 * picks one explicitly.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = fs.readFileSync(path.join(HERE, "..", "desktop", "app.js"), "utf8");

test("the quota card follows the PROVIDER node's account by default", () => {
  const at = APP.indexOf("function quotaAccountId()");
  assert.ok(at > 0, "the resolver exists");
  const body = APP.slice(at, APP.indexOf("\n}", at));
  assert.match(body, /usageAccountId \|\|/, "an explicit pick still wins");
  assert.match(body, /providerViewAccount\(\)\?\.id/, "otherwise the pool's account");
  // The route account is the last resort only, for an install with an empty pool.
  assert.ok(
    body.indexOf("providerViewAccount") < body.indexOf("activeId"),
    "the route account must not outrank the pool"
  );
});

test("both the read and the label use that one resolver", () => {
  // A second copy of the fallback chain is how the two cards drifted apart.
  assert.equal(
    (APP.match(/usageAccountId \|\| snapshot\?\.activeId/g) || []).length,
    0,
    "the old default is gone"
  );
  assert.match(APP, /window\.lane\.usage\(usageRange, quotaAccountId\(\)\)/);
  assert.match(APP, /const current = quotaAccountId\(\)/);
});
