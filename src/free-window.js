/**
 * The international build's two allowances, which are not one.
 *
 * Measured on a real Free account: paid models are refused outright (11158,
 * "not allowed for user type personal_free_user"), the free models
 * (WorkBuddy's own `notModels` list) never charged a credit across 28.6M
 * tokens, and yet the account's Credits window still reports usage — consumed
 * outside Lane, or by the vendor's own rules for an exhausted free allowance.
 * What is certain: the Credits window and the free models are two separate
 * allowances, and conflating them misstates both.
 *
 * So this module reports them separately, and invents nothing:
 *
 *   - credits: the account's credit window as WorkBuddy returns it — the
 *     paid allowance. Used, limit, reset, verbatim, from the same window
 *     rule the desktop card uses (`creditWindowOf`): 0.2.11 splits the plan's
 *     and the extra credits, 0.2.24 adds their total, and the token window
 *     is not credits.
 *   - freeUsageToday: this machine's requests on the free models, counted
 *     over the local day from the journal. No limit is shown because no
 *     endpoint reports one; when the vendor does exhaust it, it refuses with
 *     a reset time, which surfaces here as `refusedUntil`. The refusal is
 *     scoped to the account it belongs to; the traffic totals stay
 *     machine-wide, because the route changes during a day.
 */

import { creditWindowOf } from "./credit-window.js";

/** The plan whose shape this module describes. Anyone else bills per request. */
// The plugin said this plan "Free" until 0.1.34 and "Free plan" from then on
// (#337: the bare word beside the account read as the model being free).
const FREE_PLAN = /^free(?:\s+plan)?$/i;

// The two spellings of "this model's allowance is exhausted, it comes back
// at <time>". The domestic build answers Chinese; the international one and
// the older builds answer English.
const RESET_AT = new RegExp(
  [
    "reset at (\\d{4})-(\\d{2})-(\\d{2})[ T](\\d{2}):(\\d{2}):(\\d{2})",
    "(\\d{4})-(\\d{2})-(\\d{2})[ T](\\d{2}):(\\d{2}):(\\d{2})\\s*重置",
    "将在\\s*(\\d{4})-(\\d{2})-(\\d{2})[ T](\\d{2}):(\\d{2}):(\\d{2})"
  ].join("|"),
  "i"
);
const RESET_OFFSET = /(?:UTC|GMT)\s*([+-])\s*(\d{1,2})(?::?(\d{2}))?/i;

/**
 * The first non-empty capture group of `match`, as a [y, m, d, h, mi, s]
 * tuple. RESET_AT has three alternatives, so the date sits in whichever
 * group that alternative uses.
 */
function resetParts(match) {
  for (const start of [1, 7, 13]) {
    const parts = match.slice(start, start + 6);
    if (parts[0]) return parts.map(Number);
  }
  return null;
}

export function freeAllowance(usage, rows = [], { now = Date.now(), accountId = "" } = {}) {
  if (!usage || usage.error) return null;
  if (!FREE_PLAN.test(String(usage.plan || "").trim())) return null;

  // `accountId` scopes the refusal state, not the traffic totals. A 429 on
  // one account must not mark another account's free models exhausted, but
  // "今日请求 / 本机累计" still describes this machine's traffic: scoping the
  // counts too made them show 0 whenever the route account was not the one
  // that had carried today's requests.
  const statusRows = accountId
    ? rows.filter((row) => String(row?.accountId || "") === String(accountId))
    : rows;

  const windows = Array.isArray(usage.windows) ? usage.windows : [];
  const window = creditWindowOf(usage);
  if (!window) return null;
  // A prepaid balance has no cycle allowance to describe; it is already shown
  // on the account card, and the free-model side below does not depend on it.
  const limit = Number(window.limit) || 0;
  if (limit <= 0) return null;
  // `amount` is the credits spent; `used` is the same figure as a percentage
  // on some builds, so the raw amount is preferred and the percentage only a
  // fallback.
  const used = Number.isFinite(Number(window.amount))
    ? Number(window.amount)
    : (Number(window.used) || 0) / 100 * limit;
  const runsOutAt = window.runsOutAt || usage.runsOutAt || "";

  // The models WorkBuddy itself says are not charged. A build that names none
  // falls back to counting every answered request as free traffic. The list
  // rides on the credit windows: one "Credits" window in 0.2.17, and on every
  // split and total window since 0.2.24 (0.2.27 adds the measured per-model
  // token windows, which are not credit windows); it is read from whichever
  // window carries one.
  const notModelsWindow = windows.find((item) => Array.isArray(item?.notModels));
  const freeModels = Array.isArray(notModelsWindow?.notModels) ? notModelsWindow.notModels.map(String) : [];
  const isFreeModel = (model) => {
    const name = String(model || "");
    if (!name) return false;
    return freeModels.length ? freeModels.includes(name) : true;
  };

  // Today, local to this machine: the day a user means by "每天".
  const day = new Date(now);
  day.setHours(0, 0, 0, 0);
  const dayStart = day.getTime();

  const freeRows = rows.filter((row) => row?.status !== "error" && isFreeModel(row?.model));
  const todayRows = freeRows.filter((row) => row.startedAt >= dayStart);
  const todayTokens = todayRows.reduce(
    (sum, row) => sum + (Number(row.inputTokens) || 0) + (Number(row.outputTokens) || 0),
    0
  );

  // A refusal naming a reset is the one observable sign a model's allowance
  // is exhausted. Two things this has to get right:
  //
  //   - the wording. The vendor answers in Chinese on the domestic build
  //     ("您的使用量已超出频率限制，将在 2026-11-11 21:48:41 UTC+8 重置") and in
  //     English elsewhere ("reset at ..."). Only the English form used to be
  //     read, so a Chinese refusal left every model looking available.
  //   - the scope. An allowance belongs to one model: WorkBuddy refuses the
  //     model that ran out and keeps serving the others ("您也可以切换其他
  //     模型继续使用"). One global "exhausted" mark therefore greyed out the
  //     whole free list, which is not what the upstream said.
  const refusedByModel = new Map();
  for (const row of statusRows) {
    // A refusal belongs to the model it names, whether that model is on the
    // free list or a paid one: an allowance can be per model for either. The
    // free-model list is only used to count traffic below.
    if (row?.status !== "error" || !row?.model) continue;
    const message = String(row?.error || "");
    const match = RESET_AT.exec(message);
    if (!match) continue;
    const parts = resetParts(match);
    if (!parts) continue;
    const offset = RESET_OFFSET.exec(message);
    // A reset with no named offset cannot be placed; guessing one would put
    // it hours from where the vendor meant, so it is not surfaced.
    if (!offset) continue;
    const minutes = Number(offset[2]) * 60 + Number(offset[3] ?? 0);
    if (minutes > 14 * 60) continue;
    const atMs = Date.UTC(parts[0], parts[1] - 1, parts[2], parts[3], parts[4], parts[5])
      - (offset[1] === "-" ? -minutes : minutes) * 60_000;
    if (!(atMs > now)) continue;
    const model = String(row.model);
    const seen = refusedByModel.get(model);
    if (!seen || atMs > seen) refusedByModel.set(model, atMs);
  }
  // The latest reset still in force, for the card's one-line summary. The
  // per-model map is what the model list reads.
  let refusedUntil = "";
  for (const atMs of refusedByModel.values()) {
    if (atMs > (Date.parse(refusedUntil) || 0)) refusedUntil = new Date(atMs).toISOString();
  }
  const refusedModels = {};
  for (const [model, atMs] of refusedByModel) refusedModels[model] = new Date(atMs).toISOString();

  return {
    plan: usage.plan || "Free",
    credits: {
      used,
      limit,
      left: Math.max(0, limit - used),
      percent: Math.min(100, (100 * used) / limit),
      // The cycle starting over, not the day unused credits lapse: the card
      // used to label the latter "重置" and told users their credits return
      // on the day they expire.
      resetsAt: window.resetsAt || usage.resetsAt || "",
      runsOutAt
    },
    freeModels,
    // Today's free-model traffic from this machine, local day.
    freeRequestsToday: todayRows.length,
    freeTokensToday: todayTokens,
    freeRequestsTotal: freeRows.length,
    lastFreeAt: freeRows.length ? Math.max(...freeRows.map((row) => Number(row.startedAt) || 0)) : 0,
    // The latest reset across every exhausted model: the card's one line.
    refusedUntil,
    // Per-model, because the vendor refuses only the model that ran out and
    // tells the user to switch to another ("您也可以切换其他模型继续使用").
    // The model list reads this; a model absent here is still usable.
    refusedModels
  };
}
