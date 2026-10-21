import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  loadAccounts,
  readAccounts,
  upsertAccount,
  activateAccount,
  setAccountEnabled,
  removeAccount,
  publicAccount
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
