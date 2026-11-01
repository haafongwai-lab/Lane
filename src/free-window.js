/**
 * What remains of the international build's free-plan allowance.
 *
 * A WorkBuddy AI *Free* account is granted a credits allowance that renews on
 * a cycle, and the models it lists as `notModels` cost nothing against it —
 * on a real account those are `hy3` and `deepseek-v4.1-flash`. The domestic
 * build bills the same models per request, which is why a journal can show
 * thousands of charged rows on `deepseek-v4.1-flash` and a Free account on
 * the other site show none: what is free is the *plan*, not the model name.
 *
 * So this card is about an account, not a model. It reads the account's own
 * usage report — the one WorkBuddy returns, `Credits` window with `used`,
 * `limit`, `runsOutAt` and `notModels` — and adds what Lane can see that the
 * report cannot: how many requests this machine has made on the free models,
 * and how long the allowance has been running.
 *
 * Nothing here is derived from the journal's credit column. A Free account's
 * rows carry `credits: 0` because the allowance covered them, so counting
 * them as "saved credits" would invent a figure the vendor never quoted.
 */

/** The plan whose allowance this is. Anyone else bills per request. */
const FREE_PLAN = /^free$/i;

/**
 * The free allowance of one account, or null when the account is not on a
 * free plan, is not signed in, or reports no usable window.
 *
 * `usage` is the provider's usage result: { plan, windows: [...] }.
 * `rows` is the journal, used only for the request count and the span.
 */
export function freeAllowance(usage, rows = [], { now = Date.now() } = {}) {
  if (!usage || usage.error) return null;
  if (!FREE_PLAN.test(String(usage.plan || "").trim())) return null;

  const windows = Array.isArray(usage.windows) ? usage.windows : [];
  // The credits window is the allowance; a build that names it something else
  // still gets one card, from whatever window it did send.
  const window = windows.find((item) => /credit/i.test(String(item?.name || ""))) || windows[0];
  if (!window) return null;

  const limit = Number(window.limit) || 0;
  if (limit <= 0) return null;
  // `amount` is what the vendor shows as spent; `used` is the same figure as
  // a percentage on some builds, so the raw amount is preferred and the
  // percentage is only a fallback.
  const used = Number.isFinite(Number(window.amount))
    ? Number(window.amount)
    : (Number(window.used) || 0) / 100 * limit;
  const left = Math.max(0, limit - used);
  const percent = Math.min(100, (100 * used) / limit);

  // The models this plan does not charge for: what makes the card worth
  // showing at all, and what the request count below is counted over.
  const freeModels = Array.isArray(window.notModels) ? window.notModels.map(String) : [];
  const free = rows.filter((row) => {
    if (row?.status === "error") return false;
    const model = String(row?.model || "");
    if (!model) return false;
    return freeModels.length ? freeModels.includes(model) : true;
  });

  const runsOutAt = window.runsOutAt || usage.runsOutAt || "";
  const days = runsOutAt
    ? Math.max(0, Math.ceil((Date.parse(runsOutAt) - now) / 86_400_000))
    : null;

  return {
    plan: usage.plan || "Free",
    used,
    limit,
    left,
    percent,
    // Credits and yuan travel together on this page elsewhere; a Free plan's
    // allowance is still quoted in the same credits, so the same conversion
    // applies.
    leftYuan: left / 20,
    runsOutAt: runsOutAt || "",
    daysLeft: days,
    freeModels,
    // This machine's traffic on the free models, so the card says what the
    // allowance has been carrying rather than only what is left of it.
    freeRequests: free.length,
    lastFreeAt: free.length ? Math.max(...free.map((row) => Number(row.startedAt) || 0)) : 0
  };
}
