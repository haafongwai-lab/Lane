import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readSettings, writeSettings, writeSetting, normalizePort } from "../src/settings.js";

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

// ---- the DSH name-hiding switch ------------------------------------------

test("hiding DSH's name is on unless it was explicitly turned off", async () => {
  const env = await envFor();
  try {
    assert.equal((await readSettings(env)).hideDsh, true, "a missing file reads as on");
    await writeSettings({ port: 4800 }, env);
    assert.equal((await readSettings(env)).hideDsh, true, "saving a port does not turn it off");
    await writeSetting({ hideDsh: false }, env);
    assert.equal((await readSettings(env)).hideDsh, false);
    assert.equal((await readSettings(env)).port, 4800, "the port survives the switch");
  } finally {
    await fs.rm(env.LANE_DATA_DIR, { recursive: true, force: true });
  }
});

test("the switch reads any non-false value as on", async () => {
  const env = await envFor();
  try {
    await fs.mkdir(env.LANE_DATA_DIR, { recursive: true });
    for (const stored of [{ port: 4000 }, { port: 4000, hideDsh: true }, { port: 4000, hideDsh: "no" }]) {
      await fs.writeFile(path.join(env.LANE_DATA_DIR, "settings.json"), JSON.stringify(stored));
      assert.equal((await readSettings(env)).hideDsh, true, JSON.stringify(stored));
    }
  } finally {
    await fs.rm(env.LANE_DATA_DIR, { recursive: true, force: true });
  }
});

// ---- request redaction switches ----------------------------------------

test("request redaction is on by default and survives a port save", async () => {
  const env = await envFor();
  try {
    const first = await readSettings(env);
    assert.equal(first.redactSecrets, true, "credentials are redacted unless turned off");
    assert.equal(first.redactPersonal, true, "email/phone redaction is on by default");
    await writeSettings({ port: 4800 }, env);
    assert.equal((await readSettings(env)).redactSecrets, true, "saving a port does not disable redaction");
    await writeSetting({ redactSecrets: false, redactPersonal: false }, env);
    const off = await readSettings(env);
    assert.equal(off.redactSecrets, false);
    assert.equal(off.redactPersonal, false);
    assert.equal(off.port, 4800, "the port survives the privacy switches");
  } finally {
    await fs.rm(env.LANE_DATA_DIR, { recursive: true, force: true });
  }
});

test("individual rules, allowlist and custom terms persist", async () => {
  const env = await envFor();
  try {
    await writeSetting({
      redactRules: { apiKey: false, email: false },
      redactAllowlist: [" example.com ", ""],
      redactCustom: ["Project-X"]
    }, env);
    const settings = await readSettings(env);
    assert.equal(settings.redactRules.apiKey, false);
    assert.equal(settings.redactRules.email, false);
    assert.equal(settings.redactRules.bankCard, true, "unmentioned rules keep their defaults");
    assert.deepEqual(settings.redactAllowlist, ["example.com"]);
    assert.deepEqual(settings.redactCustom, ["Project-X"]);
  } finally {
    await fs.rm(env.LANE_DATA_DIR, { recursive: true, force: true });
  }
});

test("a null settings file falls back to defaults instead of crashing", async () => {
  const env = await envFor();
  try {
    await fs.writeFile(path.join(env.LANE_DATA_DIR, "settings.json"), "null");
    const settings = await readSettings(env);
    assert.equal(settings.port, 3426);
    assert.equal(settings.source, "default");
    await writeSetting({ hideDsh: false }, env);
    assert.equal((await readSettings(env)).hideDsh, false);
  } finally {
    await fs.rm(env.LANE_DATA_DIR, { recursive: true, force: true });
  }
});
