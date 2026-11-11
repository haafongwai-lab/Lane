import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(HERE, "..", "desktop", "index.html"), "utf8");
const app = fs.readFileSync(path.join(HERE, "..", "desktop", "app.js"), "utf8");

/**
 * Trae is a second upstream, so the chrome must stop describing the whole
 * gateway as WorkBuddy-only. The supplier choices themselves still name
 * WorkBuddy — that is a choice, not a description of the product.
 */
test("the account page and status chrome speak of an upstream, not one vendor", () => {
  assert.match(html, /账号与上游/);
  assert.match(html, /共用一个本地出口/);
  assert.match(html, /登录上游账号/);
  assert.match(html, /上游可用模型/);
  assert.match(html, /账户周期额度/);
  assert.doesNotMatch(html, /共用一个 WorkBuddy 出口/);
  assert.doesNotMatch(html, /WorkBuddy 可用模型/);
  assert.doesNotMatch(html, /登录 WorkBuddy/);
});

test("all four upstream choices carry an icon, Trae uses the official one", () => {
  const menu = html.slice(html.indexOf('id="add-menu"'), html.indexOf("</div>", html.indexOf('id="add-menu"')));
  assert.equal((menu.match(/data-site=/g) || []).length, 4, "WorkBuddy CN/AI and Trae CN/Global");
  assert.match(menu, /data-site="trae-cn"[^>]*>[\s\S]*?trae-official-256\.png/);
  assert.match(menu, /data-site="trae-global"[^>]*>[\s\S]*?trae-official-256\.png/);
  // The route node's logo follows the active upstream instead of staying a
  // fixed WorkBuddy mark.
  assert.match(html, /id="provider-logo"/);
  assert.match(app, /#provider-logo"\)\.src/);
  assert.match(app, /trae-official-256\.png/);
});

test("the quick sign-in button opens the upstream picker", () => {
  assert.doesNotMatch(app, /\$\("#quick-signin"\)\.addEventListener\("click", \(\) => signIn\(\)\)/);
  assert.match(app, /go\("accounts"\)/);
});

test("cycle-billed traffic is visible in the spend view instead of a silent zero", () => {
  // Trae reports tokens but no per-request charge. The page must name that
  // billing model and show the tokens Lane did count, not just print 0.
  assert.match(app, /unbilledRequests/);
  assert.match(app, /上游未逐请求计费/);
  assert.match(app, /按周期额度结算/);
  assert.match(app, /上游按周期额度结算，未逐请求返回扣费/);
  assert.match(app, /剩余额度/);
});

test("the model status track never follows content, so exhausted rows stay aligned", () => {
  const css = fs.readFileSync(path.join(HERE, "..", "desktop", "styles.css"), "utf8");
  const block = css.slice(css.indexOf(".model-head, .model-row"), css.indexOf(".model-head > :last-child"));
  assert.doesNotMatch(block, /max-content/,
    "each row is its own grid: max-content widened only the exhausted rows");
  assert.match(block, /minmax\(150px, 1\.05fr\)/);
  assert.match(css, /\.model-status small \{/);
  // The recovery time is a second line, not one long status string.
  assert.match(app, /status\.hint \? `<small>/);
});

test("the model list carries a per-model add switch and only added models are served", () => {
  const html = fs.readFileSync(path.join(HERE, "..", "desktop", "index.html"), "utf8");
  const css = fs.readFileSync(path.join(HERE, "..", "desktop", "styles.css"), "utf8");
  assert.match(html, /给 Agent 用/);
  assert.match(html, /models-hint/);
  assert.match(html, /只有打开开关的模型才会出现在 Agent 的模型列表中/);
  assert.match(css, /\.model-switch input:checked \+ span/);
  // The renderer renders a checkbox per row and wires its change to the gate.
  assert.match(app, /data-model-add/);
  assert.match(app, /window\.lane\.setModel/);
  // The page renders the full catalogue, and every switch starts unchecked
  // until the model is added.
  assert.match(app, /gate\?\.enabledIds/);
});

test("account masking reaches the route and health cards too", () => {
  assert.match(app, /function renderAccountIdentity\(\)/);
  assert.match(app, /const shown = accountMasked \? maskName\(account\) : account/);
  // The PROVIDER node names the account it is describing (the first one
  // switched into the pool unless another is picked), and masking applies to
  // that name as much as to the account list's.
  assert.match(app, /const nameOf = \(item\) => \(accountMasked \? maskName\(item\.label\) : item\.label\)/);
  assert.match(app, /\$\("#account-name"\)\.textContent = view \? nameOf\(view\) : \(shown \|\| "上游账号"\)/);
  assert.match(app, /\$\("#health-account"\)\.textContent = shown/);
  assert.match(app, /renderAccounts\(\);\s*renderAccountIdentity\(\)/);
});
