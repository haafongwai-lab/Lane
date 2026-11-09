import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  runCheckins,
  readCheckin,
  forgetCheckinAccount,
  updateSettings,
  localDateKey,
  signHeaders
} from "../src/checkin.js";

async function tempEnv() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lane-checkin-"));
  return { env: { LANE_DATA_DIR: dir }, dir };
}

const ACCOUNT = { id: "uid-1", label: "first", enabled: true };
const AUTH = { type: "oauth", access: "access-1", uid: "uid-1", domain: "www.workbuddy.cn" };

function fakeProvider(accounts = [ACCOUNT]) {
  return {
    accounts: async () => accounts,
    session: async (id) => (accounts.some((item) => item.id === id)
      ? { id, auth: AUTH, hooks: {} }
      : null),
    refreshIfNeeded: async () => AUTH,
    baseURL: async () => "https://example.test/v2",
    siteOf: async () => "workbuddy"
  };
}

function responder({ status = { code: 0, data: { today_checked_in: false } }, claim } = {}) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    const body = url.endsWith("/daily-checkin")
      ? (claim ?? { code: 0, data: { today_credit: 5 } })
      : status;
    return {
      ok: (body.code ?? 0) === 0,
      status: (body.code ?? 0) === 0 ? 200 : 400,
      text: async () => JSON.stringify(body)
    };
  };
  return { calls, fetchImpl };
}

const at = (iso) => new Date(iso);

test("each enabled account claims its daily check-in once", async () => {
  const { env } = await tempEnv();
  const { calls, fetchImpl } = responder();
  const run = await runCheckins({
    provider: fakeProvider(),
    env,
    now: at("2026-10-22T10:00:00"),
    fetchImpl
  });

  assert.equal(run.results.length, 1);
  assert.equal(run.results[0].status, "done");
  assert.equal(run.results[0].reward, "5");
  assert.deepEqual(calls.map((url) => new URL(url).pathname), [
    "/v2/billing/meter/checkin-activity-status",
    "/v2/billing/meter/daily-checkin"
  ]);

  const state = await readCheckin(env);
  assert.equal(state.accounts["uid-1"].status, "done");
  assert.equal(state.accounts["uid-1"].date, localDateKey(at("2026-10-22T10:00:00")));
});

test("a fresh sign-in clears the old failed check-in record and its retry timer", async () => {
  // A "sign-in expired" failure writes a 30-minute retry time. After the user
  // signs in again that record is about a token that no longer exists, and
  // keeping it makes the account look broken until the timer runs out.
  const { env, dir } = await tempEnv();
  await fs.writeFile(path.join(dir, "checkin.json"), JSON.stringify({
    settings: { enabled: true, hour: 0, minute: 0 },
    accounts: {
      "trae-1": {
        date: "2026-11-10",
        at: "2026-11-09T16:04:00.856Z",
        status: "failed",
        message: "Trae CN's sign-in has expired",
        error: "Trae CN's sign-in has expired",
        nextTryAt: "2026-11-09T16:33:48.640Z"
      },
      "other-1": { date: "2026-11-10", status: "done", reward: "100" }
    }
  }), "utf8");
  await forgetCheckinAccount("trae-1", env);
  const state = await readCheckin(env);
  assert.equal(state.accounts["trae-1"], undefined, "the stale failure is gone");
  assert.equal(state.accounts["other-1"].status, "done", "other accounts keep their record");
});

test("a successful sign-in re-runs that account's check-in instead of waiting for the retry timer", async () => {
  const source = await fs.readFile(new URL("../src/control-center.js", import.meta.url), "utf8");
  assert.match(source, /forgetCheckinAccount\(account\.id, env\)/);
  assert.match(source, /runCheckins\(\{ provider: instance, env, only: \[account\.id\] \}\)/);
});

test("a second run the same day makes no request at all", async () => {
  const { env } = await tempEnv();
  const first = responder();
  await runCheckins({
    provider: fakeProvider(),
    env,
    now: at("2026-10-22T10:00:00"),
    fetchImpl: first.fetchImpl
  });

  const second = responder();
  const run = await runCheckins({
    provider: fakeProvider(),
    env,
    now: at("2026-10-22T18:00:00"),
    fetchImpl: second.fetchImpl
  });

  assert.equal(run.results[0].status, "done");
  assert.equal(run.results[0].skipped, true);
  assert.equal(second.calls.length, 0);
});

test("before the configured hour nothing is claimed", async () => {
  const { env } = await tempEnv();
  const { calls, fetchImpl } = responder();
  const run = await runCheckins({
    provider: fakeProvider(),
    env,
    now: at("2026-10-22T07:00:00"),
    fetchImpl
  });

  assert.equal(run.results[0].status, "waiting");
  assert.equal(calls.length, 0);
});

test("an account WorkBuddy already checked in counts as done, not failed", async () => {
  const { env } = await tempEnv();
  const { fetchImpl } = responder({ claim: { code: 10001, msg: "今天已签到，请明天再来" } });
  const run = await runCheckins({
    provider: fakeProvider(),
    env,
    now: at("2026-10-22T10:00:00"),
    fetchImpl
  });

  assert.equal(run.results[0].status, "done");
  assert.match(run.results[0].message, /已签到/);
});

test("a refusal that is not 'already done' is retried later", async () => {
  const { env } = await tempEnv();
  const { fetchImpl } = responder({ claim: { code: 500, msg: "活动太火爆了" } });
  const run = await runCheckins({
    provider: fakeProvider(),
    env,
    now: at("2026-10-22T10:00:00"),
    fetchImpl
  });

  assert.equal(run.results[0].status, "failed");
  assert.ok(run.results[0].nextTryAt, "a failure schedules a retry");

  const retry = await runCheckins({
    provider: fakeProvider(),
    env,
    now: at("2026-10-22T10:10:00"),
    fetchImpl: responder().fetchImpl
  });
  assert.equal(retry.results[0].status, "retry-later", "the retry waits for its backoff");
});

test("a point check-in on a switched-off account says why it did not run", async () => {
  // It used to filter the account away and answer "0 done" with no reason.
  const { env } = await tempEnv();
  const { fetchImpl } = responder();
  const run = await runCheckins({
    provider: fakeProvider([{ ...ACCOUNT, enabled: false }]),
    env,
    now: at("2026-10-22T10:00:00"),
    force: true,
    only: [ACCOUNT.id],
    fetchImpl
  });
  assert.equal(run.results.length, 1);
  assert.equal(run.results[0].status, "skipped");
  assert.match(run.results[0].reason, /已关闭/);
});

test("switched-off accounts and switched-off check-in are both skipped", async () => {
  const { env } = await tempEnv();
  const off = await runCheckins({
    provider: fakeProvider([{ ...ACCOUNT, enabled: false }]),
    env,
    now: at("2026-10-22T10:00:00"),
    fetchImpl: responder().fetchImpl
  });
  assert.equal(off.results.length, 0);

  await updateSettings({ enabled: false }, env);
  const disabled = await runCheckins({
    provider: fakeProvider(),
    env,
    now: at("2026-10-22T10:00:00"),
    fetchImpl: responder().fetchImpl
  });
  assert.equal(disabled.skipped, "check-in is switched off");
});

test("settings reject a time that isn't a time", async () => {
  const { env } = await tempEnv();
  await updateSettings({ hour: 25, minute: -3 }, env);
  const state = await readCheckin(env);
  assert.equal(state.settings.hour, 9);
  assert.equal(state.settings.minute, 0);

  await updateSettings({ hour: 21, minute: 30 }, env);
  const next = await readCheckin(env);
  assert.equal(next.settings.hour, 21);
  assert.equal(next.settings.minute, 30);
});

test("concurrent settings saves never corrupt the file", async () => {
  const { env, dir } = await tempEnv();
  try {
    for (let round = 0; round < 25; round += 1) {
      await Promise.all([
        updateSettings({ hour: 21, minute: 30 }, env),
        updateSettings({ hour: 9, minute: 0 }, env)
      ]);
      // Unserialised writes used to interleave on one temp file and leave a
      // body no JSON.parse could read.
      const state = JSON.parse(await fs.readFile(path.join(dir, "checkin.json"), "utf8"));
      assert.ok(state.settings);
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("check-in settings work on a data directory that does not exist yet", async () => {
  // The check-in lock had the same missing-mkdir defect as the accounts lock:
  // the lock file was opened before anything created the directory, so
  // `lane checkin on|off|at` failed with ENOENT on a fresh install.
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "lane-checkin-fresh-"));
  const env = { LANE_DATA_DIR: path.join(root, "lane") };
  try {
    await assert.rejects(fs.access(env.LANE_DATA_DIR), { code: "ENOENT" });
    const settings = await updateSettings({ hour: 8, minute: 30 }, env);
    assert.equal(settings.hour, 8);
    assert.equal(settings.minute, 30);
    assert.equal((await readCheckin(env)).settings.hour, 8);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("an empty stale check-in lock does not wedge the settings", async () => {
  // The same empty-lock-reads-as-pid-0 wedge as accounts.json.lock.
  const { env, dir } = await tempEnv();
  try {
    const lock = path.join(dir, "checkin.json.lock");
    await fs.writeFile(lock, "");
    const old = new Date(Date.now() - 120_000);
    await fs.utimes(lock, old, old);

    const settings = await updateSettings({ enabled: false }, env);
    assert.equal(settings.enabled, false);
    await assert.rejects(fs.access(lock), { code: "ENOENT" });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("the check-in call carries the account's own headers", () => {
  const headers = signHeaders(
    { access: "tok", uid: "uid-1", domain: "www.workbuddy.cn", enterpriseId: "ent-9" },
    "https://copilot.tencent.com/v2"
  );
  assert.equal(headers.authorization, "Bearer tok");
  assert.equal(headers["x-user-id"], "uid-1");
  assert.equal(headers["x-domain"], "www.workbuddy.cn");
  assert.equal(headers["x-enterprise-id"], "ent-9");
  assert.equal(headers["x-tenant-id"], "ent-9");
  assert.match(headers["user-agent"], /^WorkBuddy\//);
});

test("a build with no check-in activity is unavailable, not a failure", async () => {
  // The international build answers 10001 "签到活动未开启或已过期" to any
  // claim; that will never change, so it is recorded as unavailable and the
  // scheduler stops asking instead of retrying every half hour.
  const { env } = await tempEnv();
  const { fetchImpl, calls } = responder({
    claim: { code: 10001, msg: "签到活动未开启或已过期" }
  });
  const first = await runCheckins({
    provider: fakeProvider(),
    env,
    now: at("2026-10-22T10:00:00"),
    fetchImpl
  });
  assert.equal(first.results[0].status, "unavailable");
  assert.equal(first.results[0].error, "");
  assert.match(first.results[0].message, /自动发放/);

  const before = calls.length;
  const second = await runCheckins({
    provider: fakeProvider(),
    env,
    now: at("2026-10-22T11:00:00"),
    fetchImpl
  });
  assert.equal(second.results[0].status, "unavailable");
  assert.equal(second.results[0].skipped, true);
  assert.equal(calls.length, before, "no request is made once it is known unavailable");
});

test("the plugin's own checkin hook is used when it has one", async () => {
  // 0.2.0 moved the claim into auth.checkin, which knows the activity
  // endpoint and the outcome words. Lane asks it instead of copying them.
  const { env } = await tempEnv();
  const seen = [];
  const hooks = {
    auth: {
      checkin: async (getAuth) => {
        seen.push(await getAuth());
        return { outcome: "claimed", credit: 5, streak: 2 };
      }
    }
  };
  const provider = fakeProvider();
  const inner = provider.session;
  provider.session = async (id) => ({ ...(await inner(id)), hooks });
  const { calls, fetchImpl } = responder();
  const run = await runCheckins({ provider, env, now: at("2026-10-22T10:00:00"), fetchImpl });

  assert.equal(run.results[0].status, "done");
  assert.equal(run.results[0].reward, "5");
  assert.equal(seen.length, 1, "the hook was asked once");
  assert.equal(calls.length, 0, "Lane made no meter call of its own");
});

test("an inactive check-in from the hook is unavailable, not a failure", async () => {
  const { env } = await tempEnv();
  const hooks = { auth: { checkin: async () => ({ outcome: "inactive" }) } };
  const provider = fakeProvider();
  const inner = provider.session;
  provider.session = async (id) => ({ ...(await inner(id)), hooks });
  const run = await runCheckins({ provider, env, now: at("2026-10-22T10:00:00") });

  assert.equal(run.results[0].status, "unavailable");
  assert.equal(run.results[0].error, "");
});

test("the international build is never asked for a check-in", async () => {
  // Its plugin leaves auth.checkin off and its meter has no activity; an
  // ask would be a 404 retried every half hour.
  const { env } = await tempEnv();
  const provider = fakeProvider();
  provider.siteOf = async () => "workbuddy-ai";
  const { calls, fetchImpl } = responder();
  const run = await runCheckins({ provider, env, now: at("2026-10-22T10:00:00"), fetchImpl });

  assert.equal(run.results[0].status, "unavailable");
  assert.match(run.results[0].message, /自动发放/);
  assert.equal(calls.length, 0);
});
