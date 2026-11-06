import test from "node:test";
import assert from "node:assert/strict";
import { esc, credits, rmb, percent, requestState, rateBadge, parseMcpJson, CREDITS_PER_YUAN, creditView, creditWindowOf } from "../desktop/format.js";

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

test("a free model is marked free, not shown as a dash", () => {
  // usage.js used to fold a rate of 0 into null, so a free model rendered the
  // same dash as a model whose rate was simply unknown.
  assert.deepEqual(rateBadge(0), { text: "免费", tone: "free" });
  assert.deepEqual(rateBadge(0.03), { text: "×0.03", tone: "rate" });
  assert.deepEqual(rateBadge(1), { text: "×1", tone: "rate" });
  assert.deepEqual(rateBadge(null), { text: "—", tone: "unknown" });
  assert.deepEqual(rateBadge(undefined), { text: "—", tone: "unknown" });
  assert.deepEqual(rateBadge(NaN), { text: "—", tone: "unknown" });
});

test("parseMcpJson reads the Claude Desktop shape", () => {
  const r = parseMcpJson(JSON.stringify({
    mcpServers: { "12306-mcp": { command: "npx", args: ["-y", "12306-mcp"] } }
  }));
  assert.equal(r.ok, true);
  assert.equal(r.server.name, "12306-mcp");
  assert.equal(r.server.transport, "stdio");
  assert.equal(r.server.command, "npx");
  assert.deepEqual(r.server.args, ["-y", "12306-mcp"]);
});

test("parseMcpJson reads the ZCode and OpenCode shapes", () => {
  const zcode = parseMcpJson(JSON.stringify({
    mcp: { servers: { weather: { type: "stdio", command: "node", args: ["w.js"], env: { KEY: "v" } } } }
  }));
  assert.equal(zcode.ok, true);
  assert.equal(zcode.server.name, "weather");
  assert.deepEqual(zcode.server.env, { KEY: "v" });

  // OpenCode folds the argv into one array.
  const opencode = parseMcpJson(JSON.stringify({
    mcpServers: { fs: { command: ["npx", "-y", "fs-server"] } }
  }));
  assert.equal(opencode.ok, true);
  assert.equal(opencode.server.command, "npx");
  assert.deepEqual(opencode.server.args, ["-y", "fs-server"]);
});

test("parseMcpJson reads bare objects and http entries", () => {
  const bare = parseMcpJson(JSON.stringify({ command: "npx", args: ["-y", "x"] }));
  assert.equal(bare.ok, true);
  assert.equal(bare.server.command, "npx");
  assert.equal(bare.server.name, undefined, "no name in the snippet; the form's name field decides");

  const named = parseMcpJson(JSON.stringify({ weather: { command: "w.exe" } }));
  assert.equal(named.ok, true);
  assert.equal(named.server.name, "weather");

  const http = parseMcpJson(JSON.stringify({
    mcpServers: { remote: { type: "http", url: "https://x/mcp", headers: { Authorization: "Bearer t" } } }
  }));
  assert.equal(http.ok, true);
  assert.equal(http.server.transport, "http");
  assert.equal(http.server.url, "https://x/mcp");
  assert.deepEqual(http.server.headers, { Authorization: "Bearer t" });
});

test("parseMcpJson refuses junk with a reason", () => {
  for (const [text, match] of [
    ["{ not json", /不是有效的 JSON/],
    ["[1,2]", /需要是一个对象/],
    ['{"foo": 1, "bar": 2}', /找不到服务器定义/],
    [JSON.stringify({ mcpServers: {} }), /找不到服务器定义|需要是一个对象/],
    [JSON.stringify({ mcpServers: { bad: {} } }), /既没有 command 也没有 url/],
    [JSON.stringify({ mcpServers: { "bad name!": { command: "x" } } }), /不合法/],
    [JSON.stringify({ mcpServers: { stdio: { type: "stdio" } } }), /缺少 command/]
  ]) {
    const r = parseMcpJson(text);
    assert.equal(r.ok, false, text);
    assert.match(r.error, match, text);
  }
});

// ---- credits windows (the plugin's usage hook) ----

const windows = (list) => ({ plan: "Pro", windows: list });

test("a build with one combined Credits window keeps it as it is", () => {
  // 0.1.30 through 0.2.10: there is one window and it is the plan's own.
  const usage = windows([{ name: "Credits", amount: 117.58, limit: 310, used: 37.93, runsOutAt: "2026-11-19T16:14:43.000Z" }]);
  assert.equal(creditWindowOf(usage).name, "Credits");
  assert.equal(creditWindowOf(usage).limit, 310);
  const view = creditView(usage);
  assert.equal(view.limit, 310);
  assert.ok(Math.abs(view.left - 192.42) < 1e-9);
});

test("0.2.24's Total credits window wins over the two it sets aside", () => {
  const usage = windows([
    { name: "Credits", amount: 100, limit: 500, used: 20, aside: true },
    { name: "Extra credits", amount: 30, limit: 200, used: 15, aside: true },
    { name: "Total credits", amount: 130, limit: 700, used: 18.57, runsOutAt: "2026-11-10T00:00:00.000Z" }
  ]);
  const w = creditWindowOf(usage);
  assert.equal(w.name, "Total credits");
  assert.equal(w.limit, 700);
  assert.equal(w.amount, 130);
});

test("0.2.17's two windows are summed the way 0.2.24's totalOf does", () => {
  // The build Lane pins has no Total window. Summing plan + extra is the
  // figure 0.2.24 would print, so the card reads the same after an upgrade.
  const usage = windows([
    { name: "Credits", amount: 100, limit: 500, used: 20, resetsAt: "2026-12-01T00:00:00.000Z", runsOutAt: "2026-12-01T00:00:00.000Z", runsOut: 5 },
    { name: "Extra credits", amount: 30, limit: 200, used: 15, runsOutAt: "2026-11-10T00:00:00.000Z", runsOut: 3 }
  ]);
  const w = creditWindowOf(usage);
  assert.equal(w.name, "Total credits");
  assert.equal(w.amount, 130);
  assert.equal(w.limit, 700);
  assert.equal(w.resetsAt, "2026-12-01T00:00:00.000Z");
  assert.equal(w.runsOutAt, "2026-11-10T00:00:00.000Z", "the earlier of the two dates runs the account out first");
  assert.equal(w.runsOut, 3);
  assert.ok(Math.abs(creditView(usage).percent - (130 / 700) * 100) < 1e-9);
});

test("a plan-only window beside an extra one is not doubled", () => {
  const usage = windows([
    { name: "Credits", amount: 100, limit: 500, used: 20 },
    { name: "Extra credits", amount: 0, limit: 0, used: 0 }
  ]);
  const w = creditWindowOf(usage);
  assert.equal(w.name, "Credits", "an empty extra window leaves the plan's own figures alone");
});

test("a token window is never read as a credit allowance", () => {
  // 0.2.0+ reports "Free model tokens" beside the credit windows. Shown as
  // credits it printed "176,000,000 / 200,000,000" with "积分" beside it.
  const usage = windows([{ name: "Free model tokens", amount: 24e6, limit: 2e8, unit: "tokens" }]);
  assert.equal(creditWindowOf(usage), null);
  assert.equal(creditView(usage), null);
  assert.equal(creditView(null), null);
  assert.equal(creditView({ error: "not signed in" }), null);
});

test("a prepaid balance is credits with no cycle to meter", () => {
  // 0.2.0+ reports packages with a remainder but no total as this window.
  const usage = windows([
    { name: "Prepaid credits", balance: 42.5, display: "42.5 credits", unit: "credits" },
    { name: "Free model tokens", amount: 24e6, limit: 2e8, unit: "tokens" }
  ]);
  const w = creditWindowOf(usage);
  assert.equal(w.name, "Prepaid credits");
  const view = creditView(usage);
  assert.equal(view.prepaid, true);
  assert.equal(view.left, 42.5);
  assert.equal(view.limit, 42.5);
  assert.equal(view.percent, 0);
});

// ---- the two copies of the credit-window rule must agree ----

test("the renderer's credit window rule matches the gateway's", async () => {
  // desktop/format.js cannot import from src/ (see its own note), so
  // src/credit-window.js is a second copy. One that drifted would show the
  // page a different allowance than the Free-plan card beside it.
  const { creditWindowOf: gateway } = await import("../src/credit-window.js");
  const payloads = [
    { plan: "Pro", windows: [{ name: "Credits", amount: 1, limit: 2, used: 50 }] },
    { plan: "Pro", windows: [
      { name: "Credits", amount: 100, limit: 500, used: 20, resetsAt: "2026-12-01T00:00:00.000Z", runsOutAt: "2026-12-01T00:00:00.000Z", runsOut: 5 },
      { name: "Extra credits", amount: 30, limit: 200, used: 15, runsOutAt: "2026-11-10T00:00:00.000Z", runsOut: 3 }
    ] },
    { plan: "Pro", windows: [
      { name: "Credits", amount: 100, limit: 500, used: 20, aside: true },
      { name: "Extra credits", amount: 30, limit: 200, used: 15, aside: true },
      { name: "Total credits", amount: 130, limit: 700, used: 18.57 }
    ] },
    { plan: "Free plan", windows: [{ name: "Prepaid credits", balance: 42.5, unit: "credits" }] },
    { plan: "Free plan", windows: [{ name: "Free model tokens", amount: 1, limit: 2, unit: "tokens" }] },
    { plan: "Free plan", windows: [] },
    null
  ];
  for (const usage of payloads) {
    assert.deepEqual(creditWindowOf(usage), gateway(usage), JSON.stringify(usage));
  }
});
