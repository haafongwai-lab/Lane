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
  rollbackPlugin,
  untar,
  writeStaged
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

test("staging parses the new entry but never executes it", async (t) => {
  const env = await tempEnv(t);
  globalThis.__laneStageProbe = false;
  try {
    const dir = await writeStaged("trae-auth", env, new Map([
      ["package/index.mjs", Buffer.from("globalThis.__laneStageProbe = true;\nexport default 1;\n")]
    ]));
    assert.equal(globalThis.__laneStageProbe, false,
      "top-level code of the staged module must not run before the diff is approved");
    const staged = await fs.readFile(path.join(dir, "index.mjs"), "utf8");
    assert.match(staged, /__laneStageProbe/);
  } finally {
    delete globalThis.__laneStageProbe;
  }
});

test("staging refuses an entry that cannot even parse", async (t) => {
  const env = await tempEnv(t);
  await assert.rejects(
    () => writeStaged("trae-auth", env, new Map([
      ["package/index.mjs", Buffer.from("this is not javascript {{{")]
    ])),
    /语法/
  );
});

test("rollback with a traversal key refuses before deleting anything", async (t) => {
  const env = await tempEnv(t);
  const victim = path.join(path.dirname(pluginRoot(env)), "victim");
  await fs.mkdir(victim, { recursive: true });
  await fs.writeFile(path.join(victim, "keep.txt"), "still here", "utf8");
  await assert.rejects(() => rollbackPlugin("../victim", env), /unknown plugin/);
  assert.equal(await fs.readFile(path.join(victim, "keep.txt"), "utf8"), "still here");
});
