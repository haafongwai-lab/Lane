import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 检查更新 used to do nothing visible.
 *
 * Two causes. The panel stored a failed check and rendered no trace of it, so a
 * failed press looked identical to a press that never ran. And the read went to
 * registry.npmjs.org alone, which answers with a connect timeout from a mainland
 * connection — so every check failed and every press looked dead. The registry
 * list now carries a mirror, a failure names its cause, and the row shows it.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => fs.readFileSync(path.join(HERE, "..", rel), "utf8");
const APP = read("desktop/app.js");
const CSS = read("desktop/styles.css");
const STORE = read("src/plugin-store.js");

test("the registry read falls back to a mirror", () => {
  assert.match(STORE, /const REGISTRIES = \[/);
  assert.match(STORE, /"https:\/\/registry\.npmjs\.org"/);
  assert.match(STORE, /"https:\/\/registry\.npmmirror\.com"/);
  // The first call races them so an unreachable host cannot delay the answer.
  assert.match(STORE, /Promise\.any\(attempts\)/);
  // And the winner is remembered, so later calls skip the dead host.
  assert.match(STORE, /let preferredRegistry = ""/);
  assert.match(STORE, /preferredRegistry = first\.base/);
});

test("a network failure is reported in words, not as fetch failed", () => {
  assert.match(STORE, /function reasonOf\(error\)/);
  assert.match(STORE, /UND_ERR_CONNECT_TIMEOUT[^\n]*连接超时/);
  assert.match(STORE, /ENOTFOUND[^\n]*域名解析失败/);
  // Both registries report their own outcome.
  assert.match(STORE, /throw new Error\(failures\.join\("；"\)/);
});

test("a failed check is visible in the row", () => {
  // The badge names it...
  assert.match(APP, /if \(check\?\.error\) return '<span class="plugin-badge error">检查失败<\/span>'/);
  // ...the reason is printed under the row...
  assert.match(APP, /plugin-check-error">检查更新失败：\$\{esc\(check\.error\)\}/);
  // ...and the row is tinted.
  assert.match(APP, /plugin-row\$\{check\?\.error \? " failed" : ""\}/);
  assert.match(CSS, /\.plugin-check-error \{/);
  assert.match(CSS, /\.plugin-badge\.error \{/);
});

test("an up-to-date plugin says so instead of staying blank", () => {
  assert.match(APP, /check\.latestVersion && !check\.updateAvailable\) return '<span class="plugin-badge good">已是最新/);
  assert.match(CSS, /\.plugin-badge\.good \{/);
});

test("the press reports progress and an outcome", () => {
  assert.match(APP, /check\.textContent = "检查中…"/);
  assert.match(APP, /const failed = rows\.filter\(\(row\) => row\.error\)/);
  assert.match(APP, /检查更新失败：\$\{failed\[0\]\.error\}/);
  assert.match(APP, /个插件有新版本/);
  assert.match(APP, /全部已是最新版本/);
});
