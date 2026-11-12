import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { rollbackPlugin, listPlugins } from "../src/plugin-store.js";

/**
 * A rollback always lands on an older copy.
 *
 * Applying the same release twice leaves a backup of the version it replaced,
 * so an unconditional "restore the backup" rolled back to the same version —
 * and the row then showed no update, hiding the release the user had already
 * found. A backup that is not older is dropped and the built-in copy is used.
 */

async function scratch(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "lane-rb-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, env: { ...process.env, LANE_DATA_DIR: root } };
}

async function seedCopy(dir, version) {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "package.json"), JSON.stringify({ name: "x", version }));
  await fs.writeFile(path.join(dir, "index.mjs"), `// ${version}\n`);
}

const installed = async (env, key) =>
  (await listPlugins(env)).find((p) => p.key === key);

test("an older backup is the one restored", async (t) => {
  const { root, env } = await scratch(t);
  const key = "trae-auth";
  const base = path.join(root, "plugins");
  await seedCopy(path.join(base, key), "0.2.34");
  await seedCopy(path.join(base, ".backup", key), "0.2.33");

  const info = await rollbackPlugin(key, env);
  assert.equal(info.installed, true, "an external copy is live again");
  assert.equal(info.version, "0.2.33", "the older backup was restored");
});

test("a backup of the same version is dropped, not restored", async (t) => {
  const { root, env } = await scratch(t);
  const key = "trae-auth";
  const base = path.join(root, "plugins");
  await seedCopy(path.join(base, key), "0.2.34");
  await seedCopy(path.join(base, ".backup", key), "0.2.34");

  const info = await rollbackPlugin(key, env);
  assert.equal(info.installed, false, "falls back to the built-in copy");
  assert.equal(info.version, "0.2.33", "the shipped version, which is older than what was installed");

  // The unhelpful backup is gone, so a later rollback is still a real one.
  const leftover = await fs.readdir(path.join(base, ".backup")).catch(() => []);
  assert.deepEqual(leftover, [], "the same-version backup was removed");
});

test("a newer backup (a bad state) is also dropped", async (t) => {
  const { root, env } = await scratch(t);
  const key = "trae-auth";
  const base = path.join(root, "plugins");
  await seedCopy(path.join(base, key), "0.2.33");
  await seedCopy(path.join(base, ".backup", key), "0.2.34");

  const info = await rollbackPlugin(key, env);
  assert.equal(info.installed, false, "no forward move is a rollback");
});
