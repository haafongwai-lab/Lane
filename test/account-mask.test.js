import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Account masking: the account list can hide names and ids for screenshots
 * and screen sharing. The toggle is a renderer preference (localStorage),
 * and every place the accounts page prints a label must honour it.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const APP = fs.readFileSync(path.join(ROOT, "desktop/app.js"), "utf8");
const HTML = fs.readFileSync(path.join(ROOT, "desktop/index.html"), "utf8");
const CSS = fs.readFileSync(path.join(ROOT, "desktop/styles.css"), "utf8");

function lift(name) {
  const from = APP.indexOf(`function ${name}(`);
  const end = APP.indexOf("\n}", from);
  assert.ok(from >= 0 && end > from, `${name} is in app.js`);
  return new Function(APP.slice(from, end + 2) + `\nreturn ${name};`)();
}

const maskName = lift("maskName");
const maskId = lift("maskId");

test("maskName keeps the ends and hides the middle", () => {
  assert.equal(maskName("DDmao"), "D***o");
  assert.equal(maskName("张三"), "张*");
  assert.equal(maskName("张三丰"), "张*丰");
  assert.equal(maskName("A"), "*");
  assert.equal(maskName(""), "");
  assert.equal(maskName(null), "");
});

test("maskId keeps two characters and never grows the row", () => {
  assert.equal(maskId("18e67930e1fc4fb49fab123491576353"), "18****");
  assert.equal(maskId("ab"), "**");
  assert.equal(maskId(""), "*");
});

function renderAccounts({ masked, accounts }) {
  const nodes = {
    "#account-count": { textContent: "" },
    "#accounts-error": { hidden: false, textContent: "" },
    "#account-list": { innerHTML: "" },
    "#accounts-foot": { textContent: "" },
    "#account-mask": {
      textContent: "", attrs: {}, classes: [],
      setAttribute(k, v) { this.attrs[k] = v; },
      classList: { toggle(name, on) { this.on = on; } }
    }
  };
  const from = APP.indexOf("function renderAccounts()");
  const to = APP.indexOf("// One chip per account", from);
  const body = APP.slice(from, to);
  const esc = (v) => String(v);
  const checkinChip = () => "";
  const creditsChip = () => "";
  const snapshot = {
    accounts, activeId: accounts[0]?.id || "", signInError: "",
    checkin: { accounts: [] }
  };
  const fn = new Function(
    "$", "snapshot", "enabledPending", "routablePending", "accountMasked", "esc", "checkinChip", "creditsChip", "maskName", "maskId",
    body + "\nreturn renderAccounts;"
  );
  fn((sel) => nodes[sel], snapshot, new Map(), new Map(), masked, esc, checkinChip, creditsChip, maskName, maskId)();
  return nodes;
}

const ACCOUNTS = [{
  id: "18e67930e1fc4fb49fab123491576353", label: "DDmao", domain: "copilot.tencent.com",
  enabled: true, site: "workbuddy", enterpriseId: "", routable: true
}];

test("the list shows real names by default and masked names when on", () => {
  const open = renderAccounts({ masked: false, accounts: ACCOUNTS });
  assert.match(open["#account-list"].innerHTML, /DDmao/);
  assert.match(open["#account-list"].innerHTML, /18e67930/);
  // The footer names the accounts in the pool, not one "carrier": a request
  // goes to whichever account owns its model, so no single one carries all.
  assert.match(open["#accounts-foot"].textContent, /1 个账号供模型：DDmao/);
  assert.equal(open["#account-mask"].textContent, "打码");
  assert.equal(open["#account-mask"].attrs["aria-pressed"], "false");

  const hidden = renderAccounts({ masked: true, accounts: ACCOUNTS });
  const text = hidden["#account-list"].innerHTML;
  const title = /<b>([^<]*)<\/b>/.exec(text)?.[1] || "";
  const code = /<code>([^<]*)<\/code>/.exec(text)?.[1] || "";
  assert.doesNotMatch(title, /DDmao/);
  assert.doesNotMatch(code, /18e67930/);
  assert.equal(title, "D***o");
  assert.equal(code, "18****");
  assert.doesNotMatch(hidden["#accounts-foot"].textContent, /DDmao/);
  assert.match(hidden["#accounts-foot"].textContent, /1 个账号供模型：D\*\*\*o/);
  assert.equal(hidden["#account-mask"].textContent, "显示");
  assert.equal(hidden["#account-mask"].attrs["aria-pressed"], "true");
});

test("the footer says when nothing serves models", () => {
  const idle = renderAccounts({
    masked: false,
    accounts: [{ ...ACCOUNTS[0], routable: false }]
  });
  assert.match(idle["#accounts-foot"].textContent, /还没有账号供模型/);
});

test("the toggle is wired, persisted and present in the panel head", () => {
  assert.match(HTML, /<button[^>]+id="account-mask"[^>]*>打码<\/button>/);
  assert.match(APP, /localStorage\.getItem\("lane\.accountMasked"\)/);
  assert.match(APP, /localStorage\.setItem\("lane\.accountMasked"/);
  assert.match(APP, /\$\("#account-mask"\)\.addEventListener\("click"/);
  // The failed-checkin list names its accounts too; it must mask as well.
  assert.match(APP, /esc\(accountMasked \? maskName\(item\.label\) : item\.label\)/);
  assert.match(CSS, /\.account-tools \.text-button\.on/);
});
