/**
 * The usage figures the desktop app shows, read from the request journal.
 *
 * Two kinds of credits live side by side here, and they are never added:
 *
 *   - billed credits: what WorkBuddy itself charged, from the `credit` field
 *     of the usage report its stream carries. Measured against a real
 *     account, this is the number the quota meter moves by.
 *   - estimated credits: `(tokens ÷ 1,000,000) × price`, for rows written
 *     before the upstream number was read and for upstreams that do not
 *     report one. The price is calibrated from the journal's own billed rows
 *     (`billedRates` below) — the catalogue's `rate` is a relative multiple
 *     (×0.08), not a credits-per-million price, and costing with it
 *     understated WorkBuddy's charge by two orders of magnitude.
 *
 * Context capacity and cache hit are computed per project (the working
 * directory a request came from): one long-running repository and a one-shot
 * question are not comparable, and averaging them hides which of the two is
 * filling the window.
 */

export const RANGES = [
  { key: "today", label: "今天", days: 1 },
  { key: "7d", label: "近 7 天", days: 7 },
  { key: "15d", label: "近 15 天", days: 15 }
];

// Credits are shown to more decimals than the meter, but a billed credit is
// quantized to 0.01 upstream; the digits only matter for estimates, which a
// single flash-model request puts in the ten-thousandths.
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

const newCounter = () => ({
  requests: 0,
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  cachedTokens: 0,
  billableTokens: 0,
  credits: 0,
  estimatedCredits: 0,
  failed: 0
});

// A running total's view of one request.
function accumulate(row, { input, output, total, cached, credits, estimatedCredits, failed }) {
  row.requests += 1;
  row.inputTokens += input;
  row.outputTokens += output;
  row.totalTokens += total;
  row.cachedTokens += cached;
  row.billableTokens += input - cached + output;
  row.credits += credits;
  row.estimatedCredits += estimatedCredits;
  if (failed) row.failed += 1;
}

/**
 * What one request cost, split by where the number came from.
 *
 * A row the upstream cost carries `creditsSource: "upstream"`; rows written
 * before that field existed carry no source at all, and every one of them was
 * costed by the token formula — so both read as estimates, and only the
 * upstream's own number counts as billed. The formula's price comes from
 * `rateFor` alone: the row's own `rate` field is the catalogue's relative
 * multiple (×0.08), not a credits-per-million price, so it never costs
 * anything here.
 */
function creditSplit(request, rateFor) {
  if (request.creditsSource === "upstream" && Number.isFinite(request.credits)) {
    return { credits: request.credits, estimatedCredits: 0 };
  }
  const price = Number(rateFor(request.model)) || 0;
  const estimated = price > 0
    ? ((request.inputTokens || 0) + (request.outputTokens || 0)) / 1_000_000 * price
    : 0;
  return { credits: 0, estimatedCredits: estimated };
}

/**
 * The calibrated price of each model, as credits per million tokens, read
 * from the journal's own upstream-billed rows. A model needs at least
 * CALIBRATION_MIN_TOKENS billed tokens before its average is trusted: one
 * tiny request makes a wildly wrong price, and no price at all is better
 * than a fabricated one.
 */
export function billedRates(requests = []) {
  const billed = new Map();
  for (const request of requests) {
    if (request?.creditsSource !== "upstream" || !Number.isFinite(request.credits) || request.credits <= 0) continue;
    const tokens = (request.inputTokens || 0) + (request.outputTokens || 0);
    if (tokens <= 0) continue;
    const entry = billed.get(request.model) || { credits: 0, tokens: 0 };
    entry.credits += request.credits;
    entry.tokens += tokens;
    billed.set(request.model, entry);
  }
  const rates = new Map();
  for (const [model, { credits, tokens }] of billed) {
    if (tokens >= CALIBRATION_MIN_TOKENS) rates.set(model, credits / (tokens / 1_000_000));
  }
  return rates;
}

const CALIBRATION_MIN_TOKENS = 100_000;

/**
 * `summary(requests, { range, now, rateFor })`
 *
 * `rateFor(model)` is the calibrated credits-per-million price (see
 * `billedRates`) — it costs estimates only, never billed credits. A row's
 * own `rate` field is the catalogue's declared multiple and is kept for
 * display, not for costing. `requests` is the journal's list, newest first.
 */
export function summary(requests = [], { range = "today", now = Date.now(), rateFor = () => null } = {}) {
  const days = rangeDays(range);
  const keys = dayKeys(days, now);
  const wanted = new Set(keys);
  const startAt = new Date(`${keys[0]}T00:00:00`).getTime();

  const totals = newCounter();
  const byDay = new Map(keys.map((key) => [key, { date: key, ...newCounter() }]));
  const byModel = new Map();
  const byAgent = new Map();
  const byProject = new Map();
  // Per project, the newest request whose input landed in a window the
  // catalogue named — a chat request resends the whole conversation, so that
  // input is the conversation's context size. The journal is newest first,
  // so the first request that qualifies wins for its project.
  const projectContext = new Map();

  for (const request of requests) {
    if (!Number.isFinite(request?.startedAt) || request.startedAt < startAt) continue;
    const day = localDateKey(new Date(request.startedAt));
    if (!wanted.has(day)) continue;

    // The declared multiple is display-only (the models table shows ×rate);
    // costing goes through the calibrated price inside creditSplit.
    const rate = Number.isFinite(request.rate) ? request.rate : null;
    const { credits, estimatedCredits } = creditSplit(request, rateFor);
    const input = request.inputTokens || 0;
    const output = request.outputTokens || 0;
    const total = request.totalTokens || input + output;
    // A cache hit can never exceed the input it came from.
    const cached = Math.min(request.cachedTokens || 0, input);
    const failed = request.status === "error";
    const piece = { input, output, total, cached, credits, estimatedCredits, failed };

    accumulate(totals, piece);
    const column = byDay.get(day);
    if (column) accumulate(column, piece);

    const model = request.model || "unknown";
    const modelRow = byModel.get(model) || {
      model,
      ...newCounter(),
      rate: Number.isFinite(rate) && rate > 0 ? rate : null
    };
    accumulate(modelRow, piece);
    byModel.set(model, modelRow);

    const agent = request.agent || "unknown";
    const agentRow = byAgent.get(agent) || { agent, ...newCounter() };
    accumulate(agentRow, piece);
    byAgent.set(agent, agentRow);

    // The project the request came from; an unreadable one stays
    // unattributed rather than being bucketed under a made-up name.
    const projectId = request.project || "";
    const projectRow = byProject.get(projectId) || {
      id: projectId,
      name: request.projectName || (projectId ? projectId : ""),
      ...newCounter()
    };
    accumulate(projectRow, piece);
    byProject.set(projectId, projectRow);
    if (input > 0 && request.contextWindow > 0 && !projectContext.has(projectId)) {
      projectContext.set(projectId, {
        used: input,
        window: request.contextWindow,
        model: request.model || "",
        fill: input / request.contextWindow
      });
    }
  }

  const order = (a, b) =>
    b.credits - a.credits || b.estimatedCredits - a.estimatedCredits || b.totalTokens - a.totalTokens;

  const models = [...byModel.values()].sort(order);
  const billedTotal = totals.credits;
  models.forEach((row) => {
    row.share = billedTotal > 0 ? row.credits / billedTotal : 0;
  });

  const projects = [...byProject.values()].map((row) => ({
    ...row,
    // Cache hit is weighted by input tokens, not averaged per request: a
    // tiny request's 100% says less than a large one's 90%.
    cacheHit: row.inputTokens > 0 ? row.cachedTokens / row.inputTokens : null,
    context: projectContext.get(row.id) || null
  })).sort(order);

  const previous = previousTotals(requests, { keys, startAt, rateFor });

  return {
    range,
    spanDays: days,
    from: keys[0],
    to: keys[keys.length - 1],
    totals: round(totals),
    series: [...byDay.values()].map(round),
    models,
    projects,
    agents: [...byAgent.values()].sort(order),
    // The newest request overall that named a window, for clients that have
    // not caught up with the per-project view.
    context: projectContext.get("") || [...projectContext.values()][0] || null,
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
  const seen = { requests: 0, credits: 0, estimatedCredits: 0, totalTokens: 0 };
  for (const request of requests) {
    if (!Number.isFinite(request?.startedAt)) continue;
    if (request.startedAt < from || request.startedAt >= until) continue;
    const { credits, estimatedCredits } = creditSplit(request, rateFor);
    seen.requests += 1;
    seen.totalTokens += request.totalTokens || (request.inputTokens || 0) + (request.outputTokens || 0);
    seen.credits += credits;
    seen.estimatedCredits += estimatedCredits;
  }
  return round(seen);
}

// Keep the running totals exact and round only what leaves the module.
function round(row) {
  const out = { ...row };
  if (Number.isFinite(out.credits)) out.credits = Number(out.credits.toFixed(CREDIT_DIGITS));
  if (Number.isFinite(out.estimatedCredits)) {
    out.estimatedCredits = Number(out.estimatedCredits.toFixed(CREDIT_DIGITS));
  }
  return out;
}
