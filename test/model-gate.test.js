import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { allowedModels, modelGateCorrupt, restrictModels, setModelEnabled, isModelEnabled } from "../src/model-gate.js";

async function tempEnv(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "lane-gate-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { LANE_DATA_DIR: root };
}

test("a fresh install adds nothing: no model is served to agents by default", async (t) => {
  // The list is opt-in. An empty models.json (or none at all) means agents
  // see no models until the user turns a switch on.
  const env = await tempEnv(t);
  assert.deepEqual([...(await allowedModels(env))], []);
  assert.equal(await isModelEnabled("any-model", env), false);
  const models = [{ id: "a" }, { id: "b" }];
  assert.deepEqual(await restrictModels(models, env), []);
});

test("adding one model serves exactly that model", async (t) => {
  const env = await tempEnv(t);
  await setModelEnabled("a", true, env);
  assert.equal(await isModelEnabled("a", env), true);
  assert.equal(await isModelEnabled("b", env), false);
  const models = [{ id: "a" }, { id: "b" }, { id: "c" }];
  assert.deepEqual((await restrictModels(models, env)).map((m) => m.id), ["a"]);
  // The stored file is a {version, ids} document.
  const raw = JSON.parse(await fs.readFile(path.join(env.LANE_DATA_DIR, "models.json"), "utf8"));
  assert.deepEqual(raw.ids, ["a"]);
});

test("removing the last id leaves nothing served, and the page still lists all", async (t) => {
  const env = await tempEnv(t);
  await setModelEnabled("a", true, env);
  await setModelEnabled("a", false, env);
  assert.equal(await isModelEnabled("a", env), false);
  assert.deepEqual(await restrictModels([{ id: "a" }], env), []);
});

test("restrictModels keeps unadded ids out but never invents ones", async (t) => {
  const env = await tempEnv(t);
  await setModelEnabled("a", true, env);
  await setModelEnabled("zzz", true, env);
  const models = [{ id: "a" }, { id: "other" }];
  assert.deepEqual((await restrictModels(models, env)).map((m) => m.id), ["a"]);
});

test("the allowlist is scoped to the provider that owns the model", async (t) => {
  const env = await tempEnv(t);
  await setModelEnabled("hy3", true, env, "workbuddy");
  const models = [
    { id: "hy3", owned_by: "workbuddy" },
    { id: "hy3", owned_by: "trae" }
  ];
  assert.deepEqual((await restrictModels(models, env)).map((m) => m.owned_by), ["workbuddy"]);
  await setModelEnabled("hy3", true, env, "trae");
  assert.deepEqual((await restrictModels(models, env)).map((m) => m.owned_by), ["workbuddy", "trae"]);
  await setModelEnabled("hy3", false, env, "workbuddy");
  assert.deepEqual((await restrictModels(models, env)).map((m) => m.owned_by), ["trae"]);
});

test("a corrupt models.json keeps the last good selection and reports the damage", async (t) => {
  const env = await tempEnv(t);
  await setModelEnabled("a", true, env);
  await fs.writeFile(path.join(env.LANE_DATA_DIR, "models.json"), "{ broken", "utf8");
  assert.equal(await modelGateCorrupt(env), true);
  assert.deepEqual([...(await allowedModels(env))], ["a"], "the last good selection survives");
  assert.deepEqual((await restrictModels([{ id: "a" }, { id: "b" }], env)).map((m) => m.id), ["a"]);
});
