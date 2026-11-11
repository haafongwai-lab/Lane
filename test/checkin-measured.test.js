import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runCheckins, readCheckin } from "../src/checkin.js";

/**
 * Qoder's campaign reports one amount for the whole campaign — a live account
 * read 500 while the day grants 100 — so its hook's figure is not a reward
 * Lane can print. A provider that says so (`checkinRewardMeasured`) is
 * measured instead: the balance before and after the claim is the difference
 * the user can check in Qoder's own app.
 */

async function tempEnv(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lane-checkin-measured-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return { LANE_DATA_DIR: dir };
}

function measuredProvider({ credit, lefts, outcome = "claimed" }) {
  let read = 0;
  return {
    checkinRewardMeasured: true,
    accounts: async () => [{ id: "q-1", label: "Qoder", enabled: true }],
    session: async (id) => ({
      id,
      auth: { type: "oauth", access: "a", uid: "q-1", domain: "qoder.com" },
      hooks: { auth: { checkin: async () => ({ outcome, credit }) } }
    }),
    refreshIfNeeded: async () => ({}),
    siteOf: async () => "qoder",
    // Each call answers the next balance in the list: before, then after.
    usage: async () => {
      const left = lefts[Math.min(read, lefts.length - 1)];
      read += 1;
      return { windows: [{ name: "Credits", amount: 500 - left, limit: 500, unit: "credits" }] };
    }
  };
}

test("a measured check-in reports the balance change, not the campaign's amount", async (t) => {
  const env = await tempEnv(t);
  // The hook says 500; the balance moves by 100 that day.
  const provider = measuredProvider({ credit: 500, lefts: [400, 500] });
  const run = await runCheckins({
    provider, env, now: new Date("2026-11-12T10:00:00"), force: true,
    fetchImpl: async () => { throw new Error("no HTTP path for Qoder"); }
  });
  assert.equal(run.results[0].status, "done");
  assert.equal(run.results[0].reward, "100", "the day's grant, not the campaign total");
  const state = await readCheckin(env);
  assert.equal(state.accounts["q-1"].reward, "100");
});

test("a check-in whose balance cannot be read prints no number", async (t) => {
  const env = await tempEnv(t);
  const provider = measuredProvider({ credit: 500, lefts: [400, 500] });
  // An unreadable balance must not fall back to the campaign's figure.
  provider.usage = async () => { throw new Error("usage is down"); };
  const run = await runCheckins({
    provider, env, now: new Date("2026-11-12T10:00:00"), force: true,
    fetchImpl: async () => { throw new Error("no HTTP path"); }
  });
  assert.equal(run.results[0].status, "done");
  assert.equal(run.results[0].reward, "", "no measured figure means no figure");
});

test("a provider that measures nothing keeps its own hook number", async (t) => {
  const env = await tempEnv(t);
  // WorkBuddy reports the day's grant directly; nothing is measured for it.
  const provider = {
    accounts: async () => [{ id: "wb-1", label: "WorkBuddy", enabled: true }],
    session: async (id) => ({
      id,
      auth: { type: "oauth", access: "a", uid: "wb-1" },
      hooks: { auth: { checkin: async () => ({ outcome: "claimed", credit: 100 }) } }
    }),
    refreshIfNeeded: async () => ({}),
    siteOf: async () => "workbuddy",
    usage: async () => { throw new Error("must not be read"); }
  };
  const run = await runCheckins({
    provider, env, now: new Date("2026-11-12T10:00:00"), force: true,
    fetchImpl: async () => { throw new Error("no HTTP path"); }
  });
  assert.equal(run.results[0].reward, "100");
});
