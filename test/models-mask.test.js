import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The models page's source column is masked on the same switch as the accounts
 * page.
 *
 * That column names the account serving each model, so it is a screenshot
 * surface like the account list. One list hiding names while another shows them
 * is the kind of half-measure that leaks the name anyway — the mask has to be
 * one preference, applied everywhere a label is printed.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => fs.readFileSync(path.join(HERE, "..", rel), "utf8");
const APP = read("desktop/app.js");
const HTML = read("desktop/index.html");

test("the source column runs through the mask helper", () => {
  assert.match(APP, /const ownerName = \(value\) => \(accountMasked \? maskName\(value\) : value\);/);
  // Both the cell and its tooltip go through it — the tooltip lists the other
  // accounts, which are names too.
  assert.match(APP, /\$\{ownerName\(model\.ownerLabel\)\}/);
  assert.match(APP, /model\.sharedWith\.map\(\(item\) => ownerName\(item\.ownerLabel\)\)/);
});

test("the models page has its own mask toggle", () => {
  assert.match(HTML, /id="model-mask"/);
  assert.match(HTML, /id="model-mask"[^>]*aria-pressed="false"/);
  // And the label is kept in step on every render.
  assert.match(APP, /const maskButton = \$\("#model-mask"\);/);
});

test("one preference drives both pages", () => {
  // A single handler flips the stored value and repaints both lists.
  assert.match(APP, /function toggleAccountMask\(\)/);
  assert.match(APP, /\$\("#account-mask"\)\.addEventListener\("click", toggleAccountMask\);/);
  assert.match(APP, /\$\("#model-mask"\)\?\.addEventListener\("click", toggleAccountMask\);/);
  // An empty catalogue must not be repainted into the placeholder.
  assert.match(APP, /if \(snapshot\?\.catalogue\?\.length \|\| snapshot\?\.models\?\.length\) \{/);
});
