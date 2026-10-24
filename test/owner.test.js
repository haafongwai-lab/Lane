import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import fss from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { claimOwnership, releaseOwnership } from "../src/owner.js";

function tempEnv(t) {
  const root = fss.mkdtempSync(path.join(os.tmpdir(), "lane-owner-"));
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  return { root, env: { LANE_DATA_DIR: root } };
}

function pidFile(env) {
  return path.join(env.LANE_DATA_DIR, "lane.pid");
}

// A pid that really exited, like request-journal.test's helper.
function deadPid() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", "process.exit(0)"]);
    const pid = child.pid;
    child.once("exit", () => resolve(pid));
    child.once("error", reject);
  });
}

function livePid() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"]);
    child.once("spawn", () => resolve(child));
    child.once("error", reject);
  });
}

test("a fresh data directory claims the seat", async (t) => {
  const { env } = tempEnv(t);
  const seat = await claimOwnership(env);
  assert.equal(seat.claimed, true);
  assert.equal(await fs.readFile(pidFile(env), "utf8"), String(process.pid));
  // And the owner releases what it claimed.
  await releaseOwnership(env);
  await assert.rejects(() => fs.readFile(pidFile(env), "utf8"), { code: "ENOENT" });
});

test("an absent, empty, or zero seat file never blocks a fresh start", async (t) => {
  // A released build once refused every fresh install with "pid 0 owns the
  // data directory": the absent file read as pid 0, and pid 0 read as alive.
  for (const content of [undefined, "", " ", "0"]) {
    const { env } = tempEnv(t);
    if (content !== undefined) {
      await fs.mkdir(env.LANE_DATA_DIR, { recursive: true });
      await fs.writeFile(pidFile(env), content, "utf8");
    }
    const seat = await claimOwnership(env);
    assert.equal(seat.claimed, true, `content ${JSON.stringify(content)} claims`);
  }
});

test("a live owner's seat is refused, a dead one's is taken over", async (t) => {
  const { env } = tempEnv(t);
  const other = await livePid();
  t.after(() => other.kill());
  await fs.writeFile(pidFile(env), String(other.pid), "utf8");
  const refused = await claimOwnership(env);
  assert.deepEqual(refused, { claimed: false, owner: other.pid });

  const dead = await deadPid();
  await fs.writeFile(pidFile(env), String(dead), "utf8");
  const seat = await claimOwnership(env);
  assert.equal(seat.claimed, true);
});

test("release only removes one's own seat", async (t) => {
  const { env } = tempEnv(t);
  await fs.writeFile(pidFile(env), "424242\n", "utf8");
  await releaseOwnership(env);
  assert.equal(await fs.readFile(pidFile(env), "utf8"), "424242\n");

  await fs.writeFile(pidFile(env), String(process.pid), "utf8");
  await releaseOwnership(env);
  await assert.rejects(() => fs.readFile(pidFile(env), "utf8"), { code: "ENOENT" });
});
