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
 *     a reset time, which surfaces here as `refusedUntil`.
 */

import { creditWindowOf } from "./credit-window.js";

/** The plan whose shape this module describes. Anyone else bills per request. */
// The plugin said this plan "Free" until 0.1.34 and "Free plan" from then on
// (#337: the bare word beside the account read as the model being free).
const FREE_PLAN = /^free(?:\s+plan)?$/i;

export function freeAllowance(usage, rows = [], { now = Date.now() } = {}) {
  if (!usage || usage.error) return null;
  if (!FREE_PLAN.test(String(usage.plan || "").trim())) return null;

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
  // rides on the "Credits" window in 0.2.17 and on both split windows, never
  // on the synthesized "Total credits", so it is read from whichever window
  // carries one.
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

  // A refusal naming a reset is the one observable sign the daily allowance
  // is exhausted. The latest one still in force is shown; one whose reset has
  // passed is history, not a state. The vendor names its own offset, and it
  // is applied: reading "08:00 UTC+8" as 08:00Z would put the reset eight
  // hours late.
  let refusedUntil = "";
  for (const row of rows) {
    if (row?.status !== "error" || !isFreeModel(row?.model)) continue;
    const message = String(row?.error || "");
    const at = /reset at (\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/i.exec(message);
    if (!at) continue;
    const offset = /(?:UTC|GMT)\s*([+-])\s*(\d{1,2})(?::?(\d{2}))?/i.exec(message);
    // A reset with no named offset cannot be placed; guessing one would put
    // it hours from where the vendor meant, so it is not surfaced.
    if (!offset) continue;
    const minutes = Number(offset[2]) * 60 + Number(offset[3] ?? 0);
    if (minutes > 14 * 60) continue;
    const atMs = Date.UTC(+at[1], +at[2] - 1, +at[3], +at[4], +at[5], +at[6])
      - (offset[1] === "-" ? -minutes : minutes) * 60_000;
    if (atMs > now && atMs > (Date.parse(refusedUntil) || 0)) {
      refusedUntil = new Date(atMs).toISOString();
    }
  }

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
    refusedUntil
  };
}
