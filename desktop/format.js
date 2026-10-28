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
