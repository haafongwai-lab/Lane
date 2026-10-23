import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readSettings, writeSettings, normalizePort } from "../src/settings.js";

async function envFor() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lane-settings-"));
  return { LANE_DATA_DIR: dir };
}

test("missing settings file falls back to the default port", async () => {
  const env = await envFor();
  try {
    const settings = await readSettings(env);
    assert.equal(settings.port, 3426);
    assert.equal(settings.source, "default");
  } finally {
    await fs.rm(env.LANE_DATA_DIR, { recursive: true, force: true });
  }
});

test("a saved port is read back; an env override wins over it", async () => {
  const env = await envFor();
  try {
    await writeSettings({ port: 4800 }, env);
    assert.equal((await readSettings(env)).port, 4800);
    assert.equal((await readSettings(env)).source, "saved");
    assert.equal((await readSettings({ ...env, LANE_PORT: 5000 })).port, 5000);
  } finally {
    await fs.rm(env.LANE_DATA_DIR, { recursive: true, force: true });
  }
});

test("out-of-range ports are rejected and never stored", async () => {
  const env = await envFor();
  try {
    assert.equal(normalizePort(80), 0);
    assert.equal(normalizePort(70000), 0);
    assert.equal(normalizePort("abc"), 0);
    await assert.rejects(() => writeSettings({ port: 80 }, env));
    // The rejection must not have written a file with the bad value.
    const settings = await readSettings(env);
    assert.equal(settings.port, 3426);
  } finally {
    await fs.rm(env.LANE_DATA_DIR, { recursive: true, force: true });
  }
});
