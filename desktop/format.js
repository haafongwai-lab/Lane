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
