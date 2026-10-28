import test from "node:test";
import assert from "node:assert/strict";
import { esc, credits, rmb, percent, requestState, CREDITS_PER_YUAN } from "../desktop/format.js";

/**
 * esc() is the only thing between a model name or a filesystem path and
 * innerHTML. Every label the renderer prints — account names, project
 * paths, upstream error text — goes through it, so a hole here is script
 * injection in the app window.
 */
test("esc neutralises every character that can break out of markup", () => {
  assert.equal(esc('<img src=x onerror="alert(1)">'),
    "&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
  assert.equal(esc("a & b"), "a &amp; b");
  assert.equal(esc("it's"), "it&#39;s");
  assert.equal(esc("</script><script>"), "&lt;/script&gt;&lt;script&gt;");
});

test("esc escapes the ampersand first, so no double-encoding appears", () => {
  // "&lt;" as input must become "&amp;lt;", not stay "&lt;" and re-render as
  // a bracket.
  assert.equal(esc("&lt;"), "&amp;lt;");
});

test("esc handles non-strings and empty input", () => {
  assert.equal(esc(), "");
  assert.equal(esc(null), "null");
  assert.equal(esc(0), "0");
  assert.equal(esc(42), "42");
});

/**
 * A credit value rendered as "0" reads as free. The journal keeps six
 * decimals precisely because a flash-model request can cost a ten-
 * thousandth of one credit.
 */
test("a tiny non-zero cost never renders as zero", () => {
  // 0.0001 is exactly representable at the default precision, so it prints
  // as itself; below that the value would round to "0", which reads as free,
  // and an upper bound is printed instead.
  assert.equal(credits(0.0001), "0.0001");
  assert.equal(credits(0.00001), "＜0.0001");
  assert.equal(credits(0.000001), "＜0.0001");
  assert.equal(credits(0), "0");
});

test("credits scale their precision to the magnitude", () => {
  assert.equal(credits(1.5), "1.5");
  assert.equal(credits(2), "2");
  assert.equal(credits(0.25), "0.25");
  assert.equal(credits(1234.56), new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 1 }).format(1234.56));
});

test("junk credit values read as zero rather than NaN", () => {
  for (const value of [undefined, null, "", "abc", NaN]) {
    assert.equal(credits(value), "0", String(value));
  }
});

test("rmb converts at the measured rate: 20 credits to the yuan", () => {
  assert.equal(CREDITS_PER_YUAN, 20);
  assert.equal(rmb(20), "1.00");
  assert.equal(rmb(2000), "100");
  assert.equal(rmb(2), "0.1");
  assert.equal(rmb(0), "0");
});

test("percent renders a ratio as one decimal", () => {
  assert.equal(percent(0.5), "50.0%");
  assert.equal(percent(1), "100.0%");
  assert.equal(percent(0), "0.0%");
  assert.equal(percent(undefined), "0.0%");
});

test("a failed row says whose problem it is, not just that it failed", () => {
  // The status column used to read "失败" for all of these.
  assert.deepEqual(requestState({ status: "error", errorKind: "upstream-timeout" }),
    { text: "上游未响应", tone: "err" });
  assert.deepEqual(requestState({ status: "error", errorKind: "upstream-error" }),
    { text: "上游拒绝", tone: "err" });
  assert.deepEqual(requestState({ status: "error", errorKind: "upstream-unreadable" }),
    { text: "响应无法解析", tone: "err" });
  assert.deepEqual(requestState({ status: "error", errorKind: "not-signed-in" }),
    { text: "未登录", tone: "err" });
});

test("a client closing its window is muted, not red", () => {
  assert.deepEqual(requestState({ status: "error", errorKind: "client-closed" }),
    { text: "客户端断开", tone: "muted" });
});

test("a row written before errorKind existed falls back to its message", () => {
  assert.equal(requestState({ status: "error", error: "WorkBuddy did not answer within 120s" }).text,
    "上游未响应");
  assert.equal(requestState({ status: "error", error: "This operation was aborted" }).text,
    "客户端断开");
  assert.equal(requestState({ status: "error", error: "upstream returned no usable events" }).text,
    "响应无法解析");
  assert.equal(requestState({ status: "error", error: "something else" }).text, "失败");
});

test("a successful or running row keeps its own state", () => {
  assert.deepEqual(requestState({ status: "complete" }), { text: "完成", tone: "ok" });
  assert.deepEqual(requestState({ status: "running" }), { text: "进行中", tone: "live" });
  assert.deepEqual(requestState(null), { text: "—", tone: "ok" });
});
