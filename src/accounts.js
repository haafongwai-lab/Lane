import fs from "node:fs/promises";
import path from "node:path";
import { dataDir } from "./config.js";
import { readAuth, writeAuth } from "./auth-store.js";

/**
 * WorkBuddy keeps several accounts at once: every account that has signed in
 * stays in `accounts.json` with its own tokens, one of them is the active
 * route, and each can be switched off without losing its sign-in.
 *
 * The account's own uid (plus its enterprise, when it belongs to a team)
 * names it, so signing the same account in again updates the entry it
 * already has instead of adding a second one.
 */

const FILE = "accounts.json";

export function accountIdOf(auth) {
  const uid = String(auth?.uid || "").trim();
  const account = String(auth?.accountId || "").trim();
  const base = uid || account;
  if (!base) return "";
  const enterprise = String(auth?.enterpriseId || "").trim();
  return enterprise ? `${base}@${enterprise}` : base;
}

function accountLabel(auth) {
  return String(auth?.accountId || "").trim()
    || String(auth?.uid || "").trim().slice(0, 8)
    || "WorkBuddy";
}

function emptyState() {
  return { version: 1, activeId: "", accounts: [] };
}

const queues = new Map();

// Read-modify-write on one file is serialised per data directory, so two
// requests that touch different accounts can't drop each other's change.
function serial(env, work) {
  const key = path.join(dataDir(env), FILE);
  const previous = queues.get(key) || Promise.resolve();
  const next = previous.then(work, work);
  queues.set(key, next.catch(() => {}));
  return next;
}

function fileOf(env) {
  return path.join(dataDir(env), FILE);
}

export async function readAccounts(env = process.env) {
  let raw;
  try {
    raw = await fs.readFile(fileOf(env), "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    return emptyState();
  }
  try {
    const parsed = JSON.parse(raw);
    const accounts = Array.isArray(parsed?.accounts)
      ? parsed.accounts.filter((item) => item && item.id && item.auth)
      : [];
    // An explicitly empty route is meaningful (every account switched off),
    // so only a missing field falls back to the first account.
    const stored = typeof parsed?.activeId === "string" ? parsed.activeId : null;
    const activeId = stored === null
      ? accounts[0]?.id || ""
      : accounts.some((item) => item.id === stored) ? stored : "";
    return { version: 1, activeId, accounts };
  } catch {
    return emptyState();
  }
}

export async function writeAccounts(state, env = process.env) {
  const target = fileOf(env);
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const temp = `${target}.${process.pid}.tmp`;
  await fs.writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(temp, target);
  return state;
}

/**
 * The single-account file Lane used before is imported once, so an existing
 * sign-in survives the upgrade. `workbuddy-auth.json` keeps mirroring the
 * active account afterwards, which is what `lane doctor` and the CLI read.
 */
export async function loadAccounts(env = process.env) {
  return serial(env, async () => {
    const state = await readAccounts(env);
    if (state.accounts.length) return state;
    const legacy = await readAuth(env);
    const id = accountIdOf(legacy);
    if (!legacy || !id) return state;
    const account = {
      id,
      label: accountLabel(legacy),
      uid: legacy.uid || "",
      accountId: legacy.accountId || "",
      enterpriseId: legacy.enterpriseId || "",
      domain: legacy.domain || "",
      enabled: true,
      addedAt: new Date().toISOString(),
      lastUsedAt: new Date().toISOString(),
      auth: legacy
    };
    return writeAccounts({ version: 1, activeId: id, accounts: [account] }, env);
  });
}

export function activeAccount(state) {
  return state.accounts.find((item) => item.id === state.activeId) || null;
}

/**
 * Adds the account a sign-in produced, or refreshes the one it already has.
 * The first account, or one signed in while nothing is active, becomes the
 * route.
 */
export async function upsertAccount(auth, env = process.env, { activate = false } = {}) {
  const id = accountIdOf(auth);
  if (!id) throw new Error("WorkBuddy sign-in returned no account id");
  return serial(env, async () => {
    const state = await readAccounts(env);
    const now = new Date().toISOString();
    const existing = state.accounts.find((item) => item.id === id);
    if (existing) {
      existing.auth = auth;
      existing.label = accountLabel(auth);
      existing.uid = auth.uid || existing.uid;
      existing.accountId = auth.accountId || existing.accountId;
      existing.enterpriseId = auth.enterpriseId || "";
      existing.domain = auth.domain || existing.domain;
      existing.enabled = true;
      existing.lastUsedAt = now;
    } else {
      state.accounts.push({
        id,
        label: accountLabel(auth),
        uid: auth.uid || "",
        accountId: auth.accountId || "",
        enterpriseId: auth.enterpriseId || "",
        domain: auth.domain || "",
        enabled: true,
        addedAt: now,
        lastUsedAt: now,
        auth
      });
    }
    if (activate || !state.activeId || !state.accounts.some((item) => item.id === state.activeId)) {
      state.activeId = id;
    }
    await writeAccounts(state, env);
    await mirror(state, env);
    return state.accounts.find((item) => item.id === id);
  });
}

/**
 * The plugin renews a token and hands the new fields back; they land on the
 * account that asked, never on whichever account happens to be active.
 */
export async function updateAccountAuth(id, patch, env = process.env) {
  if (!id || !patch || typeof patch !== "object") return null;
  return serial(env, async () => {
    const state = await readAccounts(env);
    const account = state.accounts.find((item) => item.id === id);
    if (!account) return null;
    account.auth = { ...account.auth, ...patch };
    if (patch.domain) account.domain = patch.domain;
    await writeAccounts(state, env);
    await mirror(state, env);
    return account;
  });
}

export async function activateAccount(id, env = process.env) {
  return serial(env, async () => {
    const state = await readAccounts(env);
    const account = state.accounts.find((item) => item.id === id);
    if (!account) throw new Error(`unknown account: ${id}`);
    if (!account.enabled) throw new Error(`${account.label} is switched off`);
    state.activeId = id;
    account.lastUsedAt = new Date().toISOString();
    await writeAccounts(state, env);
    await mirror(state, env);
    return account;
  });
}

/**
 * Switching an account off keeps its sign-in but takes it out of the route:
 * an active account that is switched off hands the route to the next one
 * that is still on.
 */
export async function setAccountEnabled(id, enabled, env = process.env) {
  return serial(env, async () => {
    const state = await readAccounts(env);
    const account = state.accounts.find((item) => item.id === id);
    if (!account) throw new Error(`unknown account: ${id}`);
    account.enabled = Boolean(enabled);
    if (!account.enabled && state.activeId === id) {
      state.activeId = state.accounts.find((item) => item.id !== id && item.enabled)?.id || "";
    }
    // Switching the only account back on should also make it the route
    // again, rather than leaving the gateway signed out.
    if (account.enabled && !state.activeId) state.activeId = id;
    await writeAccounts(state, env);
    await mirror(state, env);
    return account;
  });
}

export async function removeAccount(id, env = process.env) {
  return serial(env, async () => {
    const state = await readAccounts(env);
    const before = state.accounts.length;
    state.accounts = state.accounts.filter((item) => item.id !== id);
    if (state.accounts.length === before) return { removed: false, activeId: state.activeId };
    if (state.activeId === id) {
      state.activeId = state.accounts.find((item) => item.enabled)?.id || state.accounts[0]?.id || "";
    }
    await writeAccounts(state, env);
    await mirror(state, env);
    return { removed: true, activeId: state.activeId };
  });
}

// The active account is what the older single-account file mirrors.
async function mirror(state, env) {
  const account = activeAccount(state);
  if (!account) {
    await writeAuth(null, env).catch(() => {});
    return;
  }
  await writeAuth(account.auth, env).catch(() => {});
}

export function publicAccount(account) {
  const expires = Number(account?.auth?.expires) || 0;
  return {
    id: account.id,
    label: account.label,
    accountId: account.accountId || "",
    uid: account.uid || "",
    enterpriseId: account.enterpriseId || "",
    domain: account.domain || "",
    enabled: Boolean(account.enabled),
    addedAt: account.addedAt || "",
    lastUsedAt: account.lastUsedAt || "",
    expiresAt: expires || null,
    expiresSoon: Boolean(expires) && expires - Date.now() < 10 * 60 * 1000
  };
}
