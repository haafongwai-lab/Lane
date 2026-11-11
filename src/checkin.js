import fs from "node:fs/promises";
import path from "node:path";
import { dataDir } from "./config.js";
import { writeJSON } from "./agents/store.js";
import { crossProcessLock } from "./accounts.js";
import { creditWindowOf } from "./credit-window.js";

/**
 * WorkBuddy hands out a daily check-in reward per account. Its own client
 * claims it with two calls:
 *
 *   POST /v2/billing/meter/checkin-activity-status   what today's check-in looks like
 *   POST /v2/billing/meter/daily-checkin             claim it
 *
 * The plugin has carried the same two calls as `auth.checkin` since 0.2.0
 * (which also knows the China build is the only one with a check-in). Lane
 * prefers that hook and keeps this fallback for a plugin without it.
 *
 * The paths are relative to the `/v2` base the plugin already resolved for
 * the account, so a China and an international account both work without
 * Lane hardcoding a host.
 */

const FILE = "checkin.json";
const STATUS_PATH = "/billing/meter/checkin-activity-status";
const CLAIM_PATH = "/billing/meter/daily-checkin";
const RETRY_MS = 30 * 60 * 1000;
// WorkBuddy/<version> is the User-Agent its API accepts; the plugin sends the
// desktop client's (5.9.3 since 0.1.40) and this fallback follows it.
// Overridable so a version bump never needs a code change here.
const UA_VERSION = process.env.LANE_WB_UA || "5.9.3";

const DEFAULT_SETTINGS = { enabled: true, hour: 9, minute: 0 };

const queues = new Map();

// A forced run from the window and the scheduler's tick read the file, claim
// and write back; run at the same moment, the later write loses the earlier
// one's results. Serialised per data directory — the in-process queue orders
// this Lane's runs, and the cross-process lock (the same one accounts.json
// uses) keeps a `lane checkin` in a terminal from claiming against the
// gateway's tick in another process.
function serial(env, work) {
  const key = fileOf(env);
  const previous = queues.get(key) || Promise.resolve();
  const run = () => crossProcessLock(key, work);
  const next = previous.then(run, run);
  queues.set(key, next.catch(() => {}));
  return next;
}

function fileOf(env) {
  return path.join(dataDir(env), FILE);
}

export function localDateKey(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export async function readCheckin(env = process.env) {
  let raw;
  try {
    raw = await fs.readFile(fileOf(env), "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    return { settings: { ...DEFAULT_SETTINGS }, accounts: {} };
  }
  try {
    const parsed = JSON.parse(raw);
    const settings = { ...DEFAULT_SETTINGS, ...(parsed?.settings || {}) };
    settings.hour = clampInt(settings.hour, 0, 23, DEFAULT_SETTINGS.hour);
    settings.minute = clampInt(settings.minute, 0, 59, DEFAULT_SETTINGS.minute);
    settings.enabled = settings.enabled !== false;
    return { settings, accounts: parsed?.accounts && typeof parsed.accounts === "object" ? parsed.accounts : {} };
  } catch {
    return { settings: { ...DEFAULT_SETTINGS }, accounts: {} };
  }
}

async function writeCheckin(state, env = process.env) {
  const target = fileOf(env);
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  await writeJSON(target, state);
  return state;
}

/**
 * Drops one account's check-in record. A successful sign-in replaces the
 * token a failed record was written with, so keeping that record (and its
 * 30-minute retry time) left a newly signed-in account showing the old
 * "sign-in expired" failure until the timer ran out.
 */
export async function forgetCheckinAccount(id, env = process.env) {
  const accountId = String(id || "");
  if (!accountId) return;
  return serial(env, async () => {
    const state = await readCheckin(env);
    if (!state.accounts?.[accountId]) return state;
    delete state.accounts[accountId];
    return writeCheckin(state, env);
  });
}

export async function updateSettings(patch, env = process.env) {
  // Through the same queue as a claim round: a save that races a round in
  // flight would be overwritten when the round writes back the state it read
  // before the save, and two unserialised writes share a temp file.
  return serial(env, async () => {
    const state = await readCheckin(env);
    if (patch && typeof patch === "object") {
      if (typeof patch.enabled === "boolean") state.settings.enabled = patch.enabled;
      if (patch.hour !== undefined) state.settings.hour = clampInt(patch.hour, 0, 23, state.settings.hour);
      if (patch.minute !== undefined) state.settings.minute = clampInt(patch.minute, 0, 59, state.settings.minute);
    }
    await writeCheckin(state, env);
    return state.settings;
  });
}

function clampInt(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) return fallback;
  return number;
}

/**
 * The headers WorkBuddy's own client sends with these calls. A team account
 * also names its enterprise, or the API answers as the personal account.
 */
export function signHeaders(auth, baseURL = "") {
  let host = "";
  try {
    host = new URL(baseURL).host;
  } catch {}
  const headers = {
    "content-type": "application/json",
    accept: "application/json",
    authorization: `Bearer ${auth?.access || ""}`,
    "x-user-id": String(auth?.uid || ""),
    "x-domain": String(auth?.domain || host || ""),
    "x-product": "SaaS",
    "x-ide-type": "WorkBuddy",
    "x-ide-name": "WorkBuddy",
    "x-ide-version": UA_VERSION,
    "user-agent": `WorkBuddy/${UA_VERSION}`,
    "x-requested-with": "XMLHttpRequest",
    "x-agent-intent": "craft",
    "x-agent-purpose": "conversation"
  };
  const enterprise = String(auth?.enterpriseId || "").trim();
  if (enterprise) {
    headers["x-enterprise-id"] = enterprise;
    headers["x-tenant-id"] = enterprise;
  }
  return headers;
}

/**
 * A refused claim is a normal answer from WorkBuddy, not a transport error:
 * "今天已签到" arrives with a non-2xx status and a readable message. Only a
 * failed request throws, so the caller can tell "already done" from "down".
 */
async function post(pathname, { auth, baseURL, fetchImpl = fetch, timeoutMs = 15000 }) {
  if (!baseURL) throw new Error("WorkBuddy endpoint is unknown");
  if (!auth?.access) throw new Error("WorkBuddy is not signed in");
  const response = await fetchImpl(`${baseURL}${pathname}`, {
    method: "POST",
    headers: signHeaders(auth, baseURL),
    body: "{}",
    signal: AbortSignal.timeout(timeoutMs)
  });
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {}
  return { status: response.status, ok: response.ok, body: body || {}, text };
}

async function checkinStatus(options) {
  const { ok, body, text } = await post(STATUS_PATH, options);
  if (!ok || body?.code !== 0) {
    throw new Error(body?.msg || text || "check-in status failed");
  }
  return body?.data ?? null;
}

async function claimCheckin(options) {
  const { ok, body, text } = await post(CLAIM_PATH, options);
  const data = body?.data ?? null;
  return {
    ok: ok && body?.code === 0,
    code: body?.code ?? -1,
    message: String(body?.msg || (ok ? "" : text) || "").trim(),
    reward: rewardOf(data),
    data
  };
}

// WorkBuddy answers snake_case: today_credit is what this check-in grants,
// daily_credit the day's rate. Both spellings are read so a rename on the
// server does not blank the number in the UI.
const REWARD_KEYS = [
  "today_credit", "daily_credit", "credit", "credits", "creditAmount",
  "credit_amount", "amount", "reward", "reward_value", "rewardValue", "points", "score"
];

function rewardOf(data) {
  if (!data || typeof data !== "object") return "";
  for (const key of REWARD_KEYS) {
    const value = data[key];
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
    if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return value.trim();
  }
  for (const value of Object.values(data)) {
    if (value && typeof value === "object") {
      const nested = rewardOf(value);
      if (nested) return nested;
    }
  }
  return "";
}

// WorkBuddy refuses a second check-in the same day; that is a success for
// Lane's purpose, not a failure to retry.
const ALREADY = /already|repeated|duplicate|checked[\s_-]?in|已签到|已经签到|重复签到/i;

// The international build has no daily check-in at all: it answers
// 10001 "签到活动未开启或已过期" to any claim. That is a permanent condition
// for that account, not a transient failure — reporting it as "签到失败"
// sent the user looking for a problem Lane cannot fix.
const NO_ACTIVITY = /签到活动未开启|活动未开启|未开启或已过期/i;
const NO_ACTIVITY_CODE = 10001;

function looksCheckedIn(status) {
  if (!status || typeof status !== "object") return false;
  const today = localDateKey();
  for (const key of [
    "today_checked_in", "checked_in", "has_checked_in", "todayChecked",
    "checkedIn", "hasCheckedIn", "isChecked", "signed", "done"
  ]) {
    if (status[key] === true) return true;
  }
  for (const key of ["last_checkin_date", "checkin_date", "lastCheckinDate", "checkinDate", "date", "lastSignDate"]) {
    if (typeof status[key] === "string" && status[key].startsWith(today)) return true;
  }
  const dates = status.checkin_dates || status.checkinDates;
  if (Array.isArray(dates) && dates.some((item) => String(item).startsWith(today))) return true;
  const label = String(status.status || status.state || "").toLowerCase();
  return ["checked", "checked_in", "done", "completed", "signed"].includes(label);
}

/**
 * Claims today's check-in for every account that is switched on, once per
 * day, after the configured local time. A failure is retried half an hour
 * later; the whole run is idempotent, so a restart never double-claims.
 */
export function runCheckins(options = {}) {
  return serial(options.env || process.env, () => claimRound(options));
}

async function claimRound({
  provider,
  env = process.env,
  now = new Date(),
  force = false,
  only = null,
  fetchImpl = fetch
} = {}) {
  const state = await readCheckin(env);
  const settings = state.settings;
  const today = localDateKey(now);
  const minutes = now.getHours() * 60 + now.getMinutes();
  const due = minutes >= settings.hour * 60 + settings.minute;
  const results = [];
  if (!settings.enabled && !force) {
    return { skipped: "check-in is switched off", settings, results };
  }
  const all = await provider.accounts();
  const list = Array.isArray(only) ? only : (only ? [only] : null);
  // A scheduled round takes the enabled accounts silently; a named one is
  // answered even when switched off — a point check-in used to come back
  // "0 done" with no reason at all.
  const selected = list
    ? all.filter((account) => list.includes(account.id))
    : all.filter((account) => account.enabled);
  if (list) {
    for (const account of selected) {
      if (account.enabled) continue;
      results.push({ id: account.id, label: account.label, status: "skipped", reason: "该账号已关闭，启用后再签到" });
    }
  }
  const accounts = selected.filter((account) => account.enabled);
  for (const account of accounts) {
    const record = state.accounts[account.id] || null;
    if (!force) {
      if (record?.date === today && record.status === "done") {
        results.push({ id: account.id, label: account.label, status: "done", skipped: true, record });
        continue;
      }
      // A build with no check-in activity answers the same way forever; the
      // scheduler keeps its record and skips the network entirely.
      if (record?.date === today && record.status === "unavailable") {
        results.push({ id: account.id, label: account.label, status: "unavailable", skipped: true, record });
        continue;
      }
      if (!due) {
        results.push({ id: account.id, label: account.label, status: "waiting", record });
        continue;
      }
      if (record?.nextTryAt && new Date(record.nextTryAt).getTime() > now.getTime()) {
        results.push({ id: account.id, label: account.label, status: "retry-later", record });
        continue;
      }
    }
    const outcome = await claimFor(provider, account, { env, fetchImpl });
    // A build with no check-in activity at all: recorded as unavailable and
    // never retried, instead of looking like a failure every half hour.
    if (outcome.skip) {
      const skipEntry = {
        date: today,
        at: new Date().toISOString(),
        status: "unavailable",
        reward: "",
        message: outcome.message || "",
        error: "",
        nextTryAt: ""
      };
      state.accounts[account.id] = skipEntry;
      results.push({ id: account.id, label: account.label, ...skipEntry });
      continue;
    }
    const entry = {
      date: today,
      at: new Date().toISOString(),
      status: outcome.ok ? "done" : "failed",
      reward: outcome.reward || "",
      message: outcome.message || "",
      error: outcome.ok ? "" : outcome.message || "check-in failed",
      nextTryAt: outcome.ok ? "" : new Date(now.getTime() + RETRY_MS).toISOString()
    };
    state.accounts[account.id] = entry;
    results.push({ id: account.id, label: account.label, ...entry });
  }
  await writeCheckin(state, env);
  return { settings, results };
}

/**
 * An account's spendable credit total, or null when it cannot be read.
 *
 * Used to measure what a check-in actually granted: a provider whose campaign
 * reports one figure for a whole campaign (Qoder: 500 while the day grants
 * 100) leaves the balance as the only honest answer to "how much did this
 * claim add".
 */
async function creditLeft(provider, id) {
  try {
    const usage = await provider.usage(id);
    const window = creditWindowOf(usage);
    if (!window) return null;
    if (window.balance != null && !(Number(window.limit) > 0)) {
      const balance = Number(window.balance);
      return Number.isFinite(balance) ? balance : null;
    }
    const limit = Number(window.limit);
    const used = Number(window.amount);
    if (!Number.isFinite(limit) || !Number.isFinite(used)) return null;
    return limit - used;
  } catch {
    return null;
  }
}

async function claimFor(provider, account, { env, fetchImpl }) {
  let session;
  try {
    session = await provider.session(account.id);
  } catch (error) {
    return { ok: false, message: error?.message || "session failed" };
  }
  if (!session?.auth) return { ok: false, message: "not signed in" };
  try {
    // The international build has no check-in activity at all (the plugin
    // leaves the hook off its site for that reason). Asking its meter would
    // be a 404 to retry forever, so the answer is the same one the old
    // 10001 path reached: credits come with the plan, nothing to claim.
    const site = typeof provider.siteOf === "function"
      ? await provider.siteOf(account.id).catch(() => "")
      : "";
    if (site === "workbuddy-ai") {
      return { ok: false, skip: true, message: "海外版积分随账户自动发放，无需签到" };
    }
    await provider.refreshIfNeeded(session);
    // The plugin's own claim (0.2.0+) knows the activity endpoint, the
    // outcome words and that only the China build has a check-in. Prefer it:
    // a copy here would drift from the vendor the way checkin-status did.
    const hook = session.hooks?.auth?.checkin;
    if (typeof hook === "function") {
      // A provider whose hook reports something other than the day's grant
      // has to be measured instead. Qoder's campaign carries one `amount` for
      // the whole campaign (500 on a 100-credit day), so its number is not a
      // reward Lane can print — the balance is. Measured before and after the
      // claim, the difference is what actually landed.
      const measure = provider.checkinRewardMeasured === true;
      const before = measure ? await creditLeft(provider, account.id) : null;
      const outcome = await hook.call(session.hooks.auth, async () => session.auth);
      const mapped = fromHook(outcome);
      if (!measure) return mapped;
      const after = mapped.ok ? await creditLeft(provider, account.id) : null;
      const gained = before != null && after != null ? Math.round((after - before) * 100) / 100 : 0;
      return { ...mapped, reward: gained > 0 ? String(gained) : "" };
    }
    const baseURL = await provider.baseURL(account.id);
    const options = { auth: session.auth, baseURL, fetchImpl };
    let status = null;
    try {
      status = await checkinStatus(options);
    } catch {}
    if (looksCheckedIn(status)) {
      return { ok: true, message: "already checked in today", reward: rewardOf(status) };
    }
    const claimed = await claimCheckin(options);
    if (claimed.ok) return { ok: true, message: claimed.message, reward: claimed.reward };
    if (ALREADY.test(claimed.message)) {
      return { ok: true, message: claimed.message || "already checked in today", reward: claimed.reward };
    }
    // 该站点没有签到活动：不是失败，也不会因重试而改变。
    if (claimed.code === NO_ACTIVITY_CODE || NO_ACTIVITY.test(claimed.message)) {
      // The international build grants credits with the plan itself; there
      // is no daily claim to make. That is a normal state, not a shorter
      // version of a check-in, so the wording says so.
      return { ok: false, skip: true, message: "海外版积分随账户自动发放，无需签到" };
    }
    return { ok: false, message: claimed.message || `check-in refused (${claimed.code})` };
  } catch (error) {
    return { ok: false, message: error?.message || "check-in failed" };
  }
}

/**
 * Turns the plugin's checkin outcome into Lane's record. `done` and `claimed`
 * are successes; `inactive` and `ineligible` are the build/account having no
 * check-in at all, which must not be retried; anything else is a failure.
 */
function fromHook(outcome) {
  const kind = String(outcome?.outcome || "").toLowerCase();
  const credit = Number(outcome?.credit);
  const reward = Number.isFinite(credit) && credit > 0 ? String(credit) : "";
  if (kind === "done") {
    return { ok: true, message: outcome?.message || "already checked in today", reward };
  }
  if (kind === "claimed") {
    return { ok: true, message: outcome?.message || "checked in", reward };
  }
  if (kind === "inactive" || kind === "ineligible") {
    return { ok: false, skip: true, message: outcome?.message || "该账户没有签到活动" };
  }
  return { ok: false, message: outcome?.message || "check-in failed" };
}

/**
 * Runs once on start and then every few minutes. The tick is cheap: accounts
 * already checked in today are skipped before any network call.
 */
export function startCheckinScheduler({
  provider,
  env = process.env,
  intervalMs = 5 * 60 * 1000,
  fetchImpl = fetch,
  onError = (error) => console.error("check-in failed:", error?.message || error)
} = {}) {
  let stopped = false;
  let running = false;
  const tick = async () => {
    if (stopped || running) return;
    running = true;
    try {
      await runCheckins({ provider, env, fetchImpl });
    } catch (error) {
      onError(error);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  setTimeout(tick, 8000).unref?.();
  return {
    runNow: (options = {}) => runCheckins({ provider, env, fetchImpl, force: true, ...options }),
    stop() {
      stopped = true;
      clearInterval(timer);
    }
  };
}

export async function checkinOverview(provider, env = process.env) {
  const state = await readCheckin(env);
  const today = localDateKey();
  let accounts = [];
  try {
    accounts = await provider.accounts();
  } catch {}
  return {
    settings: state.settings,
    today,
    accounts: accounts.map((account) => {
      const record = state.accounts[account.id] || null;
      return {
        id: account.id,
        label: account.label,
        enabled: account.enabled,
        date: record?.date || "",
        status: record?.date === today ? record.status : record ? "stale" : "none",
        reward: record?.reward || "",
        message: record?.message || "",
        at: record?.at || "",
        error: record?.error || ""
      };
    })
  };
}
