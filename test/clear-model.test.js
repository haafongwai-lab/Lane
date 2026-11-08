import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RequestJournal } from "../src/request-journal.js";
import { createControlCenter } from "../src/control-center.js";
import { createServer } from "../src/server.js";
import { summary, rangeStart, rangeEnd } from "../src/usage.js";

/**
 * Deleting one model's rows from the "模型消耗构成" table. The table is an
 * aggregate over the selected range, so the delete must use the very same
 * range boundary the summary used, spare live requests, and be reachable
 * from a follower window through the owner's HTTP route.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const APP = fs.readFileSync(path.join(ROOT, "desktop/app.js"), "utf8");
const MAIN = fs.readFileSync(path.join(ROOT, "desktop/main.js"), "utf8");
const PRELOAD = fs.readFileSync(path.join(ROOT, "desktop/preload.cjs"), "utf8");
const CSS = fs.readFileSync(path.join(ROOT, "desktop/styles.css"), "utf8");
const SERVER = fs.readFileSync(path.join(ROOT, "src/server.js"), "utf8");

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lane-clear-model-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function midnight(now = Date.now()) {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  return start.getTime();
}

function envFor(dir) {
  return {
    LANE_DATA_DIR: dir,
    USERPROFILE: dir,
    APPDATA: path.join(dir, "AppData", "Roaming"),
    LOCALAPPDATA: path.join(dir, "AppData", "Local"),
    LANE_CLAUDE_LOCALAPPDATA: path.join(dir, "AppData", "Local"),
    CODEX_HOME: path.join(dir, ".codex"),
    ZCODE_HOME: path.join(dir, ".zcode")
  };
}

test("rangeStart is exactly the boundary the models table counts from", () => {
  const now = new Date(2026, 9, 22, 18, 0, 0).getTime(); // local 18:00
  for (const range of ["today", "7d", "15d"]) {
    const since = rangeStart(range, now);
    const inside = { id: "in", model: "hy3", startedAt: since, status: "complete" };
    const outside = { id: "out", model: "hy3", startedAt: since - 1, status: "complete" };
    const tomorrow = { id: "future", model: "hy3", startedAt: rangeEnd(now), status: "complete" };
    const report = summary([inside, outside, tomorrow], { range, now });
    assert.equal(report.totals.requests, 1, `${range}: only the row at/after the boundary counts`);
    assert.deepEqual(report.models.map((row) => row.model), ["hy3"]);
    assert.ok(rangeEnd(now) > since);
  }
});

test("removeByModel drops one model's rows in the range, sparing other models and live requests", async (t) => {
  const dir = tempDir(t);
  const journal = new RequestJournal({ dir });
  const today = midnight();
  const until = rangeEnd();
  journal.requests = [
    { id: "today-a", model: "hy3", startedAt: today + 1000, status: "complete" },
    { id: "today-b", model: "gpt", startedAt: today + 2000, status: "complete" },
    { id: "old-a", model: "hy3", startedAt: today - 3 * 864e5, status: "complete" },
    { id: "running-a", model: "hy3", startedAt: today + 3000, status: "running" },
    { id: "unnamed", startedAt: today + 4000, status: "complete" },
    { id: "future-a", model: "hy3", startedAt: until + 1000, status: "complete" }
  ];
  assert.equal(journal.removeByModel("hy3", { since: today, until }), 1, "today-a only");
  assert.deepEqual(
    journal.list().map((r) => r.id).sort(),
    ["future-a", "old-a", "running-a", "today-b", "unnamed"]
  );

  // An unlabelled row is aggregated under "unknown" by summary(); deleting
  // that row must use the same name, not the empty string.
  assert.equal(journal.removeByModel("unknown", { since: today, until }), 1);
  assert.ok(!journal.list().some((r) => r.id === "unnamed"));

  // Older rows of the same model stay for the wider ranges.
  assert.equal(journal.removeByModel("hy3", { since: 0, until: today }), 1, "old-a only; the running row is spared");
  assert.deepEqual(journal.list().map((r) => r.id).sort(), ["future-a", "running-a", "today-b"]);

  // Without an upper bound the future row goes too: clearModel always passes
  // rangeEnd(), which is what keeps "shown" and "deleted" the same set.
  assert.equal(journal.removeByModel("hy3", { since: 0 }), 1);
  assert.deepEqual(journal.list().map((r) => r.id).sort(), ["running-a", "today-b"]);

  // An empty or absent model never becomes a wipe.
  assert.equal(journal.removeByModel(""), 0);
  assert.equal(journal.removeByModel("nobody", { since: 0 }), 0);
  assert.equal(journal.list().length, 2);
});

test("clearModel refuses a read-only window and normalises the range", (t) => {
  const dir = tempDir(t);
  const env = envFor(dir);
  const shared = createControlCenter({ env, shared: true, checkins: false, port: 0, host: "127.0.0.1" });
  assert.throws(() => shared.clearModel("hy3", "today"), /只读窗口/);
  t.after(() => shared.stop().catch(() => {}));

  const owner = createControlCenter({ env, checkins: false, port: 0, host: "127.0.0.1" });
  t.after(() => owner.stop().catch(() => {}));
  // An unknown key must not widen the deletion to the whole journal.
  assert.equal(owner.clearModel("nobody", "forever").range, "today");
  assert.equal(owner.clearModel("", "7d").removed, 0);
});

test("the owner route deletes the model's rows end to end", async (t) => {
  const dir = tempDir(t);
  const today = midnight();
  const rows = [
    { id: "a", model: "hy3", startedAt: today + 1000, status: "complete", owner: process.pid },
    { id: "b", model: "gpt", startedAt: today + 2000, status: "complete", owner: process.pid },
    { id: "c", model: "hy3", startedAt: today + 3000, status: "running", owner: process.pid },
    { id: "d", model: "hy3", startedAt: rangeEnd() + 1000, status: "complete", owner: process.pid }
  ];
  fs.writeFileSync(path.join(dir, "activity.jsonl"), rows.map((r) => `${JSON.stringify(r)}\n`).join(""));
  const env = envFor(dir);
  const control = createControlCenter({ env, checkins: false, port: 0, host: "127.0.0.1" });
  t.after(() => control.stop().catch(() => {}));
  const server = createServer({ provider: { async listModels() { return []; } }, control });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;

  const response = await fetch(`${base}/lane/activity/clear-model`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "hy3", range: "today" })
  });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.removed, 1, "the completed hy3 row goes, the running one stays");
  assert.equal(result.model, "hy3");

  const list = await (await fetch(`${base}/lane/activity`)).json();
  assert.deepEqual(list.data.map((r) => r.id).sort(), ["b", "c", "d"],
    "the running row and a row dated beyond the range both survive");
});

test("the desktop bridge and the table agree about the delete", () => {
  assert.match(MAIN, /handleIpc\("lane:clear-model"/);
  assert.match(MAIN, /controlWrite\("\/lane\/activity\/clear-model"/, "a follower forwards it");
  assert.match(PRELOAD, /clearModel: \(model, range\)/);
  assert.match(SERVER, /url\.pathname === "\/lane\/activity\/clear-model"/);
  assert.match(APP, /data-model-delete=/);
  assert.match(APP, /window\.lane\.clearModel\(model, range\)/);
  assert.match(APP, /modelDeleteBusy/, "no double delete against a stale table");
  assert.match(CSS, /\.model-table \.usage-table-row,\s*\.model-table \.usage-table-foot \{ grid-template-columns: minmax\(0, 2fr\) \.6fr \.9fr 24px/);
});
