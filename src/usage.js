/**
 * The usage figures the desktop app shows: what the gateway spent, read from
 * the request journal rather than from WorkBuddy's billing page.
 *
 * A request's cost is the model's credit multiple (the `×0.03` WorkBuddy's
 * picker shows) applied per million tokens, on input and output alike. The
 * multiple is kept on each request when it starts, so a catalogue that
 * changes later does not rewrite history.
 *
 * Cached input is billed at the same multiple here: WorkBuddy's billing page
 * reports whole-account credits, which cannot be split per request, so these
 * figures are Lane's own accounting and are labelled as such in the UI.
 */

export const RANGES = [
  { key: "today", label: "今天", days: 1 },
  { key: "7d", label: "近 7 天", days: 7 },
  { key: "15d", label: "近 15 天", days: 15 }
];

// Credits are shown to two decimals, but a single flash-model request costs
// a ten-thousandth of one; rounding before summing would lose it entirely.
const CREDIT_DIGITS = 6;

export function rangeDays(key) {
  return RANGES.find((range) => range.key === key)?.days || 1;
}

export function localDateKey(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function midnight(now) {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  return start;
}

// Every local day the range covers, oldest first, so a day with no traffic
// still gets a column in the chart instead of silently shrinking the axis.
function dayKeys(days, now) {
  const start = midnight(now);
  const keys = [];
  // Walk the calendar rather than subtracting fixed 24-hour days: a
  // daylight-saving day lasts 23 or 25 hours, and the fixed sum would skip
  // or repeat that date.
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const day = new Date(start);
    day.setDate(day.getDate() - offset);
    keys.push(localDateKey(day));
  }
  return keys;
}

function creditsOf(request) {
  if (Number.isFinite(request.credits)) return request.credits;
  if (!Number.isFinite(request.rate)) return 0;
  return ((request.inputTokens || 0) + (request.outputTokens || 0)) / 1_000_000 * request.rate;
}

/**
 * `summary(requests, { range, now, rateFor })`
 *
 * `rateFor(model)` fills in the multiple for requests recorded before the
 * journal kept one. `requests` is the journal's list, newest first.
 */
export function summary(requests = [], { range = "today", now = Date.now(), rateFor = () => null } = {}) {
  const days = rangeDays(range);
  const keys = dayKeys(days, now);
  const wanted = new Set(keys);
  const startAt = new Date(`${keys[0]}T00:00:00`).getTime();

  const totals = {
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cachedTokens: 0,
    credits: 0,
    failed: 0
  };
  const byDay = new Map(keys.map((key) => [key, {
    date: key,
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    credits: 0
  }]));
  const byModel = new Map();
  const byAgent = new Map();
  const context = { used: null, window: null, model: "", fill: null, cacheHit: null };

  for (const request of requests) {
    if (!Number.isFinite(request?.startedAt) || request.startedAt < startAt) continue;
    const day = localDateKey(new Date(request.startedAt));
    if (!wanted.has(day)) continue;

    const rate = Number.isFinite(request.rate) ? request.rate : Number(rateFor(request.model)) || 0;
    const credit = Number.isFinite(request.credits)
      ? request.credits
      : creditsOf({ ...request, rate });
    const input = request.inputTokens || 0;
    const output = request.outputTokens || 0;
    const total = request.totalTokens || input + output;
    const cached = Math.min(request.cachedTokens || 0, input);

    // The capacity gauge reads the newest request in the range whose input
    // landed in a window the catalogue named: a chat request resends the
    // whole conversation, so that input is the conversation's context size.
    // The journal is newest first, so the first request that qualifies wins.
    if (context.used === null && input > 0 && request.contextWindow > 0) {
      context.used = input;
      context.window = request.contextWindow;
      context.model = request.model || "";
      context.fill = input / request.contextWindow;
    }

    totals.requests += 1;
    totals.inputTokens += input;
    totals.outputTokens += output;
    totals.totalTokens += total;
    totals.cachedTokens += cached;
    totals.credits += credit;
    if (request.status === "error") totals.failed += 1;

    const column = byDay.get(day);
    if (column) {
      column.requests += 1;
      column.inputTokens += input;
      column.outputTokens += output;
      column.totalTokens += total;
      column.credits += credit;
    }

    const model = request.model || "unknown";
    const modelRow = byModel.get(model) || {
      model,
      requests: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      cachedTokens: 0,
      credits: 0,
      rate
    };
    modelRow.requests += 1;
    modelRow.inputTokens += input;
    modelRow.outputTokens += output;
    modelRow.totalTokens += total;
    modelRow.cachedTokens += cached;
    modelRow.credits += credit;
    if (!Number.isFinite(modelRow.rate)) modelRow.rate = rate;
    byModel.set(model, modelRow);

    const agent = request.agent || "unknown";
    const agentRow = byAgent.get(agent) || { agent, requests: 0, totalTokens: 0, credits: 0 };
    agentRow.requests += 1;
    agentRow.totalTokens += total;
    agentRow.credits += credit;
    byAgent.set(agent, agentRow);
  }

  const models = [...byModel.values()].sort((a, b) => b.credits - a.credits || b.totalTokens - a.totalTokens);
  models.forEach((row) => {
    row.share = totals.credits > 0 ? row.credits / totals.credits : 0;
  });

  // Cache hit is weighted by input tokens, not averaged per request: a tiny
  // request's 100% says less than a large one's 90%.
  context.cacheHit = totals.inputTokens > 0 ? totals.cachedTokens / totals.inputTokens : null;

  const previous = previousTotals(requests, { keys, startAt, rateFor, now });

  return {
    range,
    spanDays: days,
    from: keys[0],
    to: keys[keys.length - 1],
    totals: round(totals),
    series: [...byDay.values()].map(round),
    models,
    context,
    agents: [...byAgent.values()].sort((a, b) => b.credits - a.credits),
    // The same length of time immediately before this range, for the
    // "vs 上一周期" line. Undefined when the journal does not reach back.
    previous
  };
}

function previousTotals(requests, { keys, startAt, rateFor }) {
  // The previous period is the same number of calendar days, not the same
  // number of milliseconds: a daylight-saving boundary in between would
  // otherwise skew the comparison window by an hour.
  const firstPrevious = new Date(startAt);
  firstPrevious.setDate(firstPrevious.getDate() - keys.length);
  const from = firstPrevious.getTime();
  const until = startAt;
  const seen = { requests: 0, credits: 0, totalTokens: 0 };
  for (const request of requests) {
    if (!Number.isFinite(request?.startedAt)) continue;
    if (request.startedAt < from || request.startedAt >= until) continue;
    const rate = Number.isFinite(request.rate) ? request.rate : Number(rateFor(request.model)) || 0;
    seen.requests += 1;
    seen.totalTokens += request.totalTokens || (request.inputTokens || 0) + (request.outputTokens || 0);
    seen.credits += Number.isFinite(request.credits)
      ? request.credits
      : creditsOf({ ...request, rate });
  }
  return round(seen);
}

// Keep the running totals exact and round only what leaves the module.
function round(row) {
  const out = { ...row };
  if (Number.isFinite(out.credits)) out.credits = Number(out.credits.toFixed(CREDIT_DIGITS));
  return out;
}
