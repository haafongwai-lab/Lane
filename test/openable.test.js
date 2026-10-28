import test from "node:test";
import assert from "node:assert/strict";
import { openableUrl, openableHosts } from "../desktop/openable.js";

/**
 * The shell's one security decision, held by a test.
 *
 * The three hosts below are measured, not guessed: the plugin's
 * authorize() returns `https://www.workbuddy.cn/login?...` for the domestic
 * build and `https://www.workbuddy.ai/login?...` for the international one,
 * and API traffic goes to copilot.tencent.com. A host added here without a
 * reason, or a loosened comparison, would widen what a compromised renderer
 * can make the shell open.
 */

test("the sign-in pages the plugin actually returns are openable", () => {
  // Shapes taken from a live authorize() call, trimmed to the host part.
  for (const url of [
    "https://www.workbuddy.cn/login?platform=workbuddy&state=abc",
    "https://www.workbuddy.ai/login?platform=workbuddy-ai&state=abc",
    "https://copilot.tencent.com/"
  ]) {
    assert.equal(openableUrl(url), new URL(url).href, url);
  }
});

test("any other host is refused", () => {
  for (const url of [
    "https://evil.example/login",
    "https://workbuddy.cn.evil.example/login",
    "https://evil.example/www.workbuddy.cn",
    "https://www.workbuddy.com/",
    "https://workbuddy.cn/"
  ]) {
    assert.equal(openableUrl(url), null, url);
  }
});

test("a host that merely looks like one of ours is refused", () => {
  // The comparison is by parsed hostname, never by substring: a lookalike
  // login page is exactly what a phishing flow would try.
  assert.equal(openableUrl("https://www.workbuddy.cn.attacker.test/"), null);
  assert.equal(openableUrl("https://attacker.test/?next=https://www.workbuddy.cn"), null);
});

test("only https is openable", () => {
  for (const url of [
    "http://www.workbuddy.cn/login",
    "file:///C:/Windows/System32/calc.exe",
    "javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>"
  ]) {
    assert.equal(openableUrl(url), null, url);
  }
});

test("junk input is refused rather than thrown on", () => {
  for (const value of [null, undefined, 42, {}, [], "", "not a url"]) {
    assert.equal(openableUrl(value), null, String(value));
  }
});

test("the allowlist is exactly the three hosts", () => {
  assert.deepEqual(
    [...openableHosts].sort(),
    ["copilot.tencent.com", "www.workbuddy.ai", "www.workbuddy.cn"]
  );
});
