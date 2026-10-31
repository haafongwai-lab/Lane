/**
 * The renderer's pure formatting helpers.
 *
 * These live outside app.js because app.js talks to `window.lane` and the
 * DOM the moment it loads, so nothing in it can be imported by a test. The
 * functions here are the ones where a wrong answer is user-visible or a
 * security problem: unescaped text in innerHTML, and credit values rendered
 * as "0" when the request actually cost something.
 */

/** HTML-escapes text for interpolation into innerHTML. */
export function esc(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

// Credits carry a lot of leading zeros at flash-model prices; show enough of
// them to be meaningful, and never claim more precision than was recorded.
export function credits(value, digits = 4) {
  const number = Number(value) || 0;
  if (number === 0) return "0";
  if (number >= 1000) return new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 1 }).format(number);
  if (number >= 1) return number.toFixed(2).replace(/\.?0+$/, "");
  const text = number.toFixed(digits).replace(/0+$/, "").replace(/\.$/, "");
  // The journal keeps six decimals because a flash-model request can cost a
  // ten-thousandth of one credit; rendering that as "0" reads as free. The
  // bound is written with a full-width less-than: a "<" here would be
  // interpolated into innerHTML as the start of a tag, and the cost would
  // vanish from the page entirely — worse than the zero it replaced.
  return text === "0" ? `＜0.${"0".repeat(digits - 1)}1` : text;
}

// The RMB value of WorkBuddy credits: 10 yuan buys 200 credits, so a credit
// is a twentieth of a yuan. Billed credits are the only input — the
// token-formula estimates proved untrustworthy and no longer show anywhere.
export const CREDITS_PER_YUAN = 20;

export function rmb(value) {
  const yuan = (Number(value) || 0) / CREDITS_PER_YUAN;
  if (yuan >= 100) return yuan.toFixed(0);
  if (yuan >= 1) return yuan.toFixed(2);
  return yuan.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
}

export function percent(value) {
  return `${(Number(value || 0) * 100).toFixed(1)}%`;
}

/**
 * The request row's status cell.
 *
 * A failed request used to read "失败" whatever happened, so a client
 * closing its window, an upstream that never answered and an upstream that
 * refused the model all looked identical — during one real outage the list
 * showed fifteen identical failures and the only way to tell them apart was
 * to read the gateway log. The row says whose problem it is instead; the
 * journal stores `errorKind`, and a row written before it existed falls back
 * to the same reading of its message.
 */
const KIND_LABELS = {
  "client-closed": "客户端断开",
  "upstream-timeout": "上游未响应",
  "upstream-error": "上游拒绝",
  "upstream-stream": "上游中断",
  "upstream-unreadable": "响应无法解析",
  "not-signed-in": "未登录",
  unknown: "失败"
};

// The same reading error-kind.js applies, repeated here because the renderer
// cannot import from src/. Only rows written before `errorKind` existed and
// rows whose kind is empty need it.
function kindFromText(text) {
  const message = String(text ?? "");
  if (/did not answer within/i.test(message)) return "upstream-timeout";
  if (/aborted|abort|client closed/i.test(message)) return "client-closed";
  if (/not signed in|signed out|sign in again/i.test(message)) return "not-signed-in";
  if (/invalid JSON|without choices|no usable events|non-JSON/i.test(message)) return "upstream-unreadable";
  return "unknown";
}

export function requestState(item) {
  if (!item) return { text: "—", tone: "ok" };
  if (item.status === "running") return { text: "进行中", tone: "live" };
  if (item.status !== "error") return { text: "完成", tone: "ok" };
  const kind = item.errorKind || kindFromText(item.error);
  return { text: KIND_LABELS[kind] || KIND_LABELS.unknown, tone: kind === "client-closed" ? "muted" : "err" };
}

/**
 * A model's declared cost multiple, as the usage table shows it.
 *
 * The catalogue's number is a relative multiplier, not a price, and 0 means
 * the model is free. That used to render as the same dash as "no rate
 * known", because usage.js folded 0 into null on the way out — free models
 * looked like models Lane had no information about. Returns `{ text, tone }`
 * so the caller can colour it without repeating the rule.
 */
export function rateBadge(rate) {
  if (rate === 0) return { text: "免费", tone: "free" };
  if (!Number.isFinite(rate)) return { text: "—", tone: "unknown" };
  const value = new Intl.NumberFormat("zh-CN", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2
  }).format(rate);
  return { text: `×${value}`, tone: "rate" };
}

/**
 * Parses an MCP server out of the JSON snippets servers publish.
 *
 * Every source uses a slightly different wrapper for the same information:
 * Claude Desktop style {"mcpServers": {name: {...}}}, ZCode style
 * {"mcp": {"servers": {...}}}, OpenCode-style entries with command as an
 * array, or a bare server object. Accepting all of them here is what makes
 * "paste the config from the README" work; the form stays the single place
 * that validates and saves.
 *
 * Returns { ok, server } with the fields the form expects — name optional
 * (the form's own name field wins when filled) — or { ok: false, error }.
 */
export function parseMcpJson(text) {
  var doc;
  try {
    doc = JSON.parse(String(text || ""));
  } catch (error) {
    return { ok: false, error: "不是有效的 JSON：" + error.message };
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
    return { ok: false, error: "JSON 需要是一个对象" };
  }

  var raw = null;
  var name = "";
  if (doc.mcpServers && typeof doc.mcpServers === "object") {
    var first = firstEntry(doc.mcpServers);
    raw = first.value; name = first.name;
  } else if (doc.mcp && typeof doc.mcp === "object" && doc.mcp.servers && typeof doc.mcp.servers === "object") {
    var first2 = firstEntry(doc.mcp.servers);
    raw = first2.value; name = first2.name;
  } else if (typeof doc.command === "string" || typeof doc.url === "string") {
    raw = doc; name = String(doc.name || "");
  } else {
    var keys = Object.keys(doc);
    var only = keys.length === 1 && doc[keys[0]] && typeof doc[keys[0]] === "object" && !Array.isArray(doc[keys[0]]);
    if (only) { raw = doc[keys[0]]; name = keys[0]; }
    else return { ok: false, error: "找不到服务器定义：需要 mcpServers、mcp.servers 或含 command/url 的对象" };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "服务器定义需要是一个对象" };
  }

  // OpenCode-style command arrays fold into command + args.
  var command = raw.command;
  var args = Array.isArray(raw.args) ? raw.args.map(String) : [];
  if (Array.isArray(command)) {
    args = command.slice(1).map(String).concat(args);
    command = command.length ? String(command[0]) : "";
  } else if (command != null) {
    command = String(command);
  }
  var url = raw.url != null ? String(raw.url) : "";
  var type = String(raw.type || "").toLowerCase();
  var transport;
  if (type === "http" || type === "sse" || type === "remote") transport = "http";
  else if (type === "local" || type === "stdio") transport = "stdio";
  else transport = command ? "stdio" : url ? "http" : "";
  if (!transport) {
    return { ok: false, error: "条目里既没有 command 也没有 url，无法判断类型" };
  }

  var server = { transport: transport };
  if (name) {
    if (!/^[\w][\w.-]*$/.test(name)) {
      return { ok: false, error: "名称「" + name + "」不合法：需为字母、数字、点、连字符或下划线" };
    }
    server.name = name;
  }
  if (transport === "stdio") {
    if (!command) return { ok: false, error: "stdio 服务缺少 command" };
    server.command = command;
    if (args.length) server.args = args;
    if (raw.env && typeof raw.env === "object" && !Array.isArray(raw.env)) {
      var env = {};
      for (var k in raw.env) {
        if (String(k).trim() && raw.env[k] != null) env[String(k).trim()] = String(raw.env[k]);
      }
      if (Object.keys(env).length) server.env = env;
    }
  } else {
    if (!url) return { ok: false, error: "http 服务缺少 url" };
    server.url = url;
    if (raw.headers && typeof raw.headers === "object" && !Array.isArray(raw.headers)) {
      var headers = {};
      for (var h in raw.headers) {
        if (String(h).trim() && raw.headers[h] != null) headers[String(h).trim()] = String(raw.headers[h]);
      }
      if (Object.keys(headers).length) server.headers = headers;
    }
  }
  return { ok: true, server: server };
}

function firstEntry(map) {
  for (var key of Object.keys(map)) {
    var value = map[key];
    if (value && typeof value === "object") return { name: key, value: value };
  }
  return { name: "", value: null };
}
