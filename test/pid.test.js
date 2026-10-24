import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { parsePid, processAlive } from "../src/pid.js";

// These two rules are shared by the data-directory seat, the accounts lock,
// the check-in lock and the request journal. They used to be three copies, and
// a fix to one did not reach the others: 0.2.7 fixed the seat check against
// pid 0 while the identical defect kept the accounts lock wedged forever.

test("only a positive integer names an owner", () => {
  assert.equal(parsePid("4242"), 4242);
  assert.equal(parsePid("  4242  "), 4242);
  // The accounts lock writes `<pid> <timestamp>`; the pid is the first field.
  assert.equal(parsePid("4242 2026-10-24T09:51:48.309Z"), 4242);
  assert.equal(parsePid("4242\n"), 4242);
});

test("a file that names no process is not pid 0", () => {
  // `Number("")` is 0, and 0 is a finite number — which is how an empty lock
  // file came to read as a live holder.
  for (const text of ["", " ", "\n", "0", "0 2026-10-24T09:51:48.309Z", "-1", "abc", "12px", "NaN", undefined, null]) {
    assert.ok(Number.isNaN(parsePid(text)), `${JSON.stringify(text)} names no owner`);
  }
  // A half-written header ("4242" is complete, "424" is not a pid the writer
  // could have meant) still reads as the number it spells; the staleness
  // window, not the parser, decides about a live-looking pid.
  assert.equal(parsePid("424"), 424);
});

test("pid 0 and every non-pid read as dead", () => {
  assert.equal(processAlive(0), false);
  assert.equal(processAlive(-1), false);
  assert.equal(processAlive(Number.NaN), false);
  assert.equal(processAlive(undefined), false);
});

test("this process is alive, and so is a child that has not exited", async () => {
  assert.equal(processAlive(process.pid), true);
  const child = await new Promise((resolve, reject) => {
    const spawned = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"]);
    spawned.once("spawn", () => resolve(spawned));
    spawned.once("error", reject);
  });
  try {
    assert.equal(processAlive(child.pid), true);
  } finally {
    child.kill();
  }
});

test("a pid that has exited reads as dead", async () => {
  const pid = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", "process.exit(0)"]);
    const value = child.pid;
    child.once("exit", () => resolve(value));
    child.once("error", reject);
  });
  assert.equal(processAlive(pid), false);
});
