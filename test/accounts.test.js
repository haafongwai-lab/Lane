import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import {
  loadAccounts,
  readAccounts,
  upsertAccount,
  activateAccount,
  setAccountEnabled,
  removeAccount,
  publicAccount,
  crossProcessLock
} from "../src/accounts.js";

async function tempEnv() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lane-accounts-"));
  return { env: { LANE_DATA_DIR: dir }, dir };
}

const authFor = (uid, accountId, extra = {}) => ({
  type: "oauth",
  access: `access-${uid}`,
  refresh: `refresh-${uid}`,
  expires: Date.now() + 3600_000,
  domain: "www.workbuddy.cn",
  uid,
  accountId,
  ...extra
});

test("the single account Lane had before is imported once", async () => {
  const { env, dir } = await tempEnv();
  const legacy = authFor("uid-1", "ddmao");
  await fs.writeFile(path.join(dir, "workbuddy-auth.json"), JSON.stringify(legacy));

  const state = await loadAccounts(env);
  assert.equal(state.accounts.length, 1);
  assert.equal(state.activeId, "uid-1");
  assert.equal(state.accounts[0].label, "ddmao");
  assert.equal(state.accounts[0].enabled, true);

  // A second load reads accounts.json and never re-imports.
  await upsertAccount(authFor("uid-2", "second"), env);
  const again = await loadAccounts(env);
  assert.equal(again.accounts.length, 2);
});

test("several accounts stay signed in at once, one of them active", async () => {
  const { env } = await tempEnv();
  await upsertAccount(authFor("uid-1", "first"), env);
  await upsertAccount(authFor("uid-2", "second"), env);

  let state = await readAccounts(env);
  assert.deepEqual(state.accounts.map((item) => item.id), ["uid-1", "uid-2"]);
  assert.equal(state.activeId, "uid-1", "the first account becomes the route");

  await activateAccount("uid-2", env);
  state = await readAccounts(env);
  assert.equal(state.activeId, "uid-2");
  assert.equal(state.accounts.length, 2, "switching keeps the other account");
});

test("signing the same account in again updates it instead of duplicating", async () => {
  const { env } = await tempEnv();
  await upsertAccount(authFor("uid-1", "first"), env);
  await upsertAccount(authFor("uid-1", "first", { access: "renewed" }), env);

  const state = await readAccounts(env);
  assert.equal(state.accounts.length, 1);
  assert.equal(state.accounts[0].auth.access, "renewed");
});

test("a team account is a separate account from the same personal one", async () => {
  const { env } = await tempEnv();
  await upsertAccount(authFor("uid-1", "first"), env);
  await upsertAccount(authFor("uid-1", "first", { enterpriseId: "ent-9" }), env);

  const state = await readAccounts(env);
  assert.deepEqual(state.accounts.map((item) => item.id), ["uid-1", "uid-1@ent-9"]);
});

test("switching an account off hands the route to the next one that is on", async () => {
  const { env } = await tempEnv();
  await upsertAccount(authFor("uid-1", "first"), env);
  await upsertAccount(authFor("uid-2", "second"), env);
  await activateAccount("uid-1", env);

  await setAccountEnabled("uid-1", false, env);
  const state = await readAccounts(env);
  assert.equal(state.accounts[0].enabled, false);
  assert.equal(state.activeId, "uid-2", "a switched-off account can't be the route");

  await assert.rejects(() => activateAccount("uid-1", env), /switched off/);
});

test("removing the active account moves the route and clears the mirror", async () => {
  const { env, dir } = await tempEnv();
  await upsertAccount(authFor("uid-1", "first"), env);
  await upsertAccount(authFor("uid-2", "second"), env);
  await activateAccount("uid-1", env);

  const result = await removeAccount("uid-1", env);
  assert.equal(result.removed, true);
  assert.equal(result.activeId, "uid-2");

  const legacy = JSON.parse(await fs.readFile(path.join(dir, "workbuddy-auth.json"), "utf8"));
  assert.equal(legacy.uid, "uid-2", "the mirror follows the active account");
});

test("removing the route with only switched-off accounts left leaves no route", async () => {
  const { env } = await tempEnv();
  await upsertAccount(authFor("uid-1", "first"), env);
  await upsertAccount(authFor("uid-2", "second"), env);
  await setAccountEnabled("uid-2", false, env);

  const result = await removeAccount("uid-1", env);
  assert.equal(result.removed, true);
  assert.equal(result.activeId, "", "a switched-off account never becomes the route");

  // Switching an account back on takes the route again.
  await setAccountEnabled("uid-2", true, env);
  assert.equal((await readAccounts(env)).activeId, "uid-2");
});

test("the public view of an account never carries its tokens", async () => {
  const { env } = await tempEnv();
  await upsertAccount(authFor("uid-1", "first"), env);
  const state = await readAccounts(env);
  const view = publicAccount(state.accounts[0]);
  assert.equal(view.label, "first");
  assert.equal(view.id, "uid-1");
  assert.equal("auth" in view, false);
  assert.equal(JSON.stringify(view).includes("access-uid-1"), false);
});

test("an account with no uid is not silently merged into another", async () => {
  const { env } = await tempEnv();
  await assert.rejects(
    () => upsertAccount({ type: "oauth", access: "x" }, env),
    /no account id/
  );
});

test("a data directory that does not exist yet is created before the lock", async () => {
  // 0.2.7's `lane doctor`, `login`, `checkin` and `accounts` all died with
  // ENOENT on a fresh install: the lock file was opened without ever creating
  // the directory it lives in — only `lane serve` worked, because claiming the
  // seat happened to create it first.
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "lane-accounts-fresh-"));
  const env = { LANE_DATA_DIR: path.join(root, "lane") };
  try {
    await assert.rejects(fs.access(env.LANE_DATA_DIR), { code: "ENOENT" });
    const state = await loadAccounts(env);
    assert.equal(state.accounts.length, 0);
    const saved = await upsertAccount(authFor("uid-1", "first"), env);
    assert.equal(saved.id, "uid-1");
    assert.equal((await readAccounts(env)).activeId, "uid-1");
    // And the directory the lock lives in is the one the state landed in.
    assert.ok(await fs.stat(env.LANE_DATA_DIR));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("an empty stale lock file does not wedge the store", async () => {
  // A holder killed between creating the lock and writing its pid leaves an
  // empty file. It reads as pid 0, and `kill(0, 0)` succeeds on Windows, so
  // the stale-takeover branch treated it as a live holder and every account
  // and check-in command failed until the file was deleted by hand.
  const { env, dir } = await tempEnv();
  try {
    const lock = path.join(dir, "accounts.json.lock");
    await fs.writeFile(lock, "");
    const old = new Date(Date.now() - 120_000);
    await fs.utimes(lock, old, old);

    const saved = await upsertAccount(authFor("uid-1", "first"), env);
    assert.equal(saved.id, "uid-1");
    assert.equal((await readAccounts(env)).activeId, "uid-1");
    await assert.rejects(fs.access(lock), { code: "ENOENT" });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("a lock held by a live process is still respected", async () => {
  // The fix above must not turn every lock into a free-for-all: a live
  // holder's lock is refused, even when it is older than the stale window.
  const { env, dir } = await tempEnv();
  const other = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"]);
    child.once("spawn", () => resolve(child));
    child.once("error", reject);
  });
  try {
    const lock = path.join(dir, "accounts.json.lock");
    await fs.writeFile(lock, `${other.pid} ${new Date().toISOString()}`);
    const old = new Date(Date.now() - 120_000);
    await fs.utimes(lock, old, old);

    // A short wait keeps the test quick; the production wait is 15 s.
    await assert.rejects(
      () => crossProcessLock(path.join(dir, "accounts.json"), async () => "ran", { waitMs: 200 }),
      /locked by another Lane/
    );
    assert.ok(await fs.stat(lock), "the live holder's lock is left in place");
  } finally {
    other.kill();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("a corrupted accounts.json is kept aside, not silently replaced", async () => {
  const { env, dir } = await tempEnv();
  try {
    await upsertAccount(authFor("uid-1", "first"), env);
    await upsertAccount(authFor("uid-2", "second"), env);
    await activateAccount("uid-2", env);
    const raw = await fs.readFile(path.join(dir, "accounts.json"), "utf8");

    // A crash-truncated file: unreadable, but every token is still in it.
    await fs.writeFile(path.join(dir, "accounts.json"), `${raw.slice(0, raw.length - 5)}`);

    const state = await loadAccounts(env);
    // The legacy mirror restores the active account, so the gateway keeps
    // working, and the broken bytes wait beside it for recovery.
    assert.equal(state.accounts.length, 1);
    assert.equal(state.accounts[0].id, "uid-2");
    const kept = await fs.readFile(path.join(dir, "accounts.json.corrupt"), "utf8");
    assert.ok(kept.includes("uid-1"), "the other account survives in the backup");
    assert.ok(kept.includes("uid-2"));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
