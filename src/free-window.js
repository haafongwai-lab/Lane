/**
 * The free-model window WorkBuddy AI grants on deepseek-v4.1-flash.
 *
 * WorkBuddy gives that model a rolling 24-hour allowance: a window opens with
 * the first request answered after the previous one lapsed, and ends 24 hours
 * later (or at a refusal's named reset). Requests inside it are not billed.
 * No endpoint reports the window, so it has to be derived from the traffic —
 * which is what this module does, from Lane's own journal.
 *
 * The rules mirror the plugin's (`freeWindowOf` in
 * @magpie-community/opencode-workbuddy-auth), which reads magpie's usage
 * ledger instead. Lane keeps its own journal, so the same reading runs over
 * that: a gap of 24 hours between two answered rows ends every window before
 * it, and a refusal that names a reset time ends the window it refused in.
 *
 * What the derived figure is and is not: it is a lower bound on what the
 * window has used, counted from this machine's traffic. The account can be
 * spending the same allowance from another client, and nothing local can see
 * that. The page says "本机统计" for exactly that reason.
 */

// The model the allowance belongs to; the -sg variant shares it.
export const FREE_WINDOW_MODEL = "deepseek-v4.1-flash";
export const FREE_WINDOW_MODELS = ["deepseek-v4.1-flash", "deepseek-v4.1-flash-sg"];
export const FREE_WINDOW_SPAN = 24 * 60 * 60 * 1000;
// The allowance, in tokens, as the plugin models it.
export const FREE_WINDOW_CAP = 100_000_000;
// Only this build grants it. The domestic build bills these models like any
// other, so a window derived from its rows would be a fiction.
const FREE_WINDOW_DOMAINS = ["www.workbuddy.ai"];

/** Whether a request's model is one the free window covers. */
export function isFreeWindowModel(model) {
  const name = String(model || "");
  return FREE_WINDOW_MODELS.some((id) => name === id || name.startsWith(id));
}

/** The tokens a row moved: what the vendor counts against the allowance. */
function counted(row) {
  const input = Number(row?.inputTokens) || 0;
  const output = Number(row?.outputTokens) || 0;
  // The cache-read part is server-side context the vendor does not bill
  // again, but it does count against a token allowance; the plugin counts
  // `in + cache_read + out`, and `inputTokens` here already includes the
  // cached part, so the sum is input + output.
  return input + output;
}

/** The instant a refusal names as the window's end, or NaN. */
export function resetInstant(text) {
  const message = String(text ?? "");
  const at = /reset at (\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/i.exec(message);
  if (!at) return NaN;
  const offset = /(?:UTC|GMT)\s*([+-])\s*(\d{1,2})(?::?(\d{2}))?/i.exec(message);
  // A reset that names no offset cannot be placed; guessing one would put it
  // hours from where the vendor meant.
  if (!offset) return NaN;
  const minutes = Number(offset[2]) * 60 + Number(offset[3] ?? 0);
  if (minutes > 14 * 60) return NaN;
  const signed = offset[1] === "-" ? -minutes : minutes;
  return Date.UTC(+at[1], +at[2] - 1, +at[3], +at[4], +at[5], +at[6]) - signed * 60_000;
}

/**
 * The window this account is in now, or null when none is open.
 *
 * `rows` is the journal's list (newest first is fine; this sorts its own).
 * `accountId` narrows the reading to one account's traffic — a window belongs
 * to an account, and mixing two accounts' rows would merge allowances that
 * are counted separately upstream.
 */
export function freeWindow(rows = [], { accountId = "", now = Date.now() } = {}) {
  const mine = (Array.isArray(rows) ? rows : []).filter((row) => {
    if (!isFreeWindowModel(row?.model)) return false;
    if (!Number.isFinite(row?.startedAt)) return false;
    if (accountId && row.accountId !== accountId) return false;
    const domain = String(row.domain || "");
    if (domain && !FREE_WINDOW_DOMAINS.includes(domain)) return false;
    return true;
  });
  if (!mine.length) return null;

  // Refusals that named a reset close the window they were refused in. Lane
  // has never recorded one of these (the upstream reports exhaustion in the
  // stream rather than as a 429), so this mostly matters for a build that
  // does; it costs nothing to honour.
  const edges = [];
  for (const row of mine) {
    if (row.status !== "error") continue;
    const at = resetInstant(row.error);
    if (Number.isFinite(at)) edges.push(at);
  }
  edges.sort((a, b) => a - b);

  const answered = mine
    .filter((row) => row.status !== "error" && row.startedAt > 0)
    .sort((a, b) => a.startedAt - b.startedAt);
  if (!answered.length) return null;

  // Walk forward from a row that opens a window, accumulating until the
  // window either lapses or a named reset closes it.
  const walk = (from) => {
    let start = null;
    let used = 0;
    let edge = 0;
    for (let i = from; i < answered.length; i += 1) {
      const at = answered[i].startedAt;
      while (edge < edges.length && edges[edge] <= at) {
        start = null;
        used = 0;
        edge += 1;
      }
      if (start === null) start = at;
      else if (at - start >= FREE_WINDOW_SPAN) {
        start = at;
        used = 0;
      }
      used += counted(answered[i]);
    }
    return start === null ? null : { start, used };
  };

  // The chain only begins at a row with no answered row of this account's
  // within a day before it; reading it from anywhere else would shift every
  // window that follows.
  let current = null;
  for (let i = 0; i < answered.length; i += 1) {
    if (i && answered[i].startedAt - answered[i - 1].startedAt < FREE_WINDOW_SPAN) continue;
    const found = walk(i);
    if (!found) continue;
    if (found.start + FREE_WINDOW_SPAN <= now) continue; // already lapsed
    current = found;
    break;
  }
  if (!current || !(current.start > 0)) return null;

  const end = current.start + FREE_WINDOW_SPAN;
  if (now >= end) return null; // lapsed: the next request opens a new one

  return {
    model: FREE_WINDOW_MODEL,
    models: FREE_WINDOW_MODELS.slice(),
    start: current.start,
    end,
    resetsAt: new Date(end).toISOString(),
    spanSeconds: FREE_WINDOW_SPAN / 1000,
    usedTokens: current.used,
    limitTokens: FREE_WINDOW_CAP,
    // Percent of the allowance this machine's traffic accounts for.
    percent: Math.min(100, (100 * current.used) / FREE_WINDOW_CAP),
    // How much of the window is gone, for the card's progress bar.
    elapsedPercent: Math.min(100, (100 * (now - current.start)) / FREE_WINDOW_SPAN),
    // Rows counted, so the page can say what the figure is made of.
    requests: answered.filter((row) => row.startedAt >= current.start && row.startedAt < end).length
  };
}
