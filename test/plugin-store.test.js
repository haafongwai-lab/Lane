import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  PLUGIN_KEYS,
  autoUpdate,
  listPlugins,
  pluginEntryUrl,
  pluginInfo,
  pluginRoot,
  untar
} from "../src/plugin-store.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");

async function tempEnv(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "lane-plugins-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { LANE_DATA_DIR: root };
}

test("the built-in copies are listed with their real versions and licenses", async (t) => {
  const env = await tempEnv(t);
  const rows = await listPlugins(env);
  assert.deepEqual(rows.map((row) => row.key), PLUGIN_KEYS);
  for (const row of rows) {
    assert.equal(row.installed, false, `${row.key} starts on the built-in copy`);
    assert.match(row.version, /^\d+\.\d+\.\d+/);
    assert.equal(row.license, "MIT");
    assert.match(row.sha, /^[a-f0-9]{64}$/);
  }
});

test("a provider loads the built-in copy until an external install exists", async (t) => {
  const env = await tempEnv(t);
  const url = await pluginEntryUrl("trae-auth", env);
  assert.match(url.href, /vendor\/trae-auth\/index\.mjs$/);

  const target = path.join(pluginRoot(env), "trae-auth");
  await fs.cp(path.join(ROOT, "vendor/trae-auth"), target, { recursive: true });
  const installed = await pluginInfo("trae-auth", env);
  assert.equal(installed.installed, true);
  assert.equal(installed.path, target);
  const externalUrl = await pluginEntryUrl("trae-auth", env);
  assert.equal(externalUrl.href, new URL(`file:///${target.replaceAll("\\", "/")}/index.mjs`).href);
});

test("the archived npm tarball still yields the vendored file", async () => {
  const tgz = await fs.readFile(path.join(ROOT, "vendor/originals/opencode-trae-auth-0.2.33.tgz"));
  const files = untar(tgz);
  const index = files.get("package/index.mjs");
  assert.ok(index, "package/index.mjs is in the tarball");
  assert.equal(
    (await fs.readFile(path.join(ROOT, "vendor/trae-auth/index.mjs"))).toString("utf8"),
    index.toString("utf8")
  );
});

test("automatic update is off unless explicitly enabled", async (t) => {
  const env = await tempEnv(t);
  const result = await autoUpdate(env);
  assert.equal(result.skipped, true);
  assert.deepEqual(result.results, []);
});

test("an unknown plugin key is refused", async (t) => {
  const env = await tempEnv(t);
  await assert.rejects(() => pluginInfo("not-a-plugin", env), /unknown plugin/);
  await assert.rejects(() => pluginEntryUrl("not-a-plugin", env), /unknown plugin/);
});
