import test from "node:test";
import assert from "node:assert/strict";
import { esc, credits, rmb, percent, CREDITS_PER_YUAN } from "../desktop/format.js";

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
