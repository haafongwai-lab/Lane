import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { connectZcode, disconnectZcode, syncZcodeCatalog, zcodePaths } from "../src/agents/zcode.js";

async function temp() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "lane-zcode-"));
  return {
    root,
    env: {
      LANE_DATA_DIR: path.join(root, "data"),
      ZCODE_HOME: path.join(root, ".zcode")
    }
  };
}

async function readConfig(env) {
  return JSON.parse(await fs.readFile(zcodePaths(env).config, "utf8"));
}

const MODELS = [
  { id: "auto", name: "Auto", context: 256000, efforts: ["low", "high"] },
  { id: "hy3", name: "Hy3", context: 192000, efforts: ["low", "high"] }
];

test("connect writes a self-sufficient lane provider and puts it first in the order", async () => {
  const { env } = await temp();
  const result = await connectZcode({
    env,
    gateway: "http://127.0.0.1:3426",
    providerModels: async () => MODELS
  });
  assert.equal(result.connected, true);

  const doc = await readConfig(env);
  const rule = doc.config.providerConfigRules.providerRules
    .find((item) => item.providerId === "lane");
  assert.ok(rule, "the lane rule exists");
  assert.equal(rule.providerName, "Lane");
  assert.equal(rule.enabled, true);
  assert.equal(rule.config.group, "standard-personal");
  assert.deepEqual(rule.config.access, { type: "api-key", apiKey: "lane" });
  assert.deepEqual(rule.config.api, {
    type: "anthropic-messages",
    baseUrl: "http://127.0.0.1:3426"
  });
  assert.deepEqual(rule.config.personalModelIds, ["auto", "hy3"]);
  assert.deepEqual(rule.config.modelOrder, ["auto", "hy3"]);
  assert.equal(doc.config.providerOrder[0], "lane");
});

test("the user's other providers survive a connect and a disconnect", async () => {
  const { env, root } = await temp();
  const config = zcodePaths(env).config;
  await fs.mkdir(path.dirname(config), { recursive: true });
  const original = {
    schemaVersion: 1,
    config: {
      providerOrder: ["deepseek"],
      providerConfigRules: {
        providerRules: [{
          providerId: "deepseek",
          templateId: "deepseek",
          providerName: "DeepSeek",
          enabled: true,
          config: {
            group: "standard-personal",
            access: { type: "api-key", apiKey: "sk-user-key" },
            personalModelIds: [],
            modelOrder: ["deepseek-flash"]
          }
        }]
      },
      someFutureField: { keep: true }
    }
  };
  await fs.writeFile(config, JSON.stringify(original, null, 2));

  await connectZcode({ env, gateway: "http://127.0.0.1:3426", providerModels: async () => MODELS });
  const after = await readConfig(env);
  const deepseek = after.config.providerConfigRules.providerRules
    .find((item) => item.providerId === "deepseek");
  assert.deepEqual(deepseek, original.config.providerConfigRules.providerRules[0],
    "the deepseek rule is byte-equal");
  assert.deepEqual(after.config.someFutureField, { keep: true }, "unknown fields are kept");
  assert.ok(after.config.providerOrder.includes("deepseek"));

  await disconnectZcode({ env });
  const restored = await readConfig(env);
  assert.deepEqual(restored, original, "disconnect puts the document back");
});

test("reconnecting updates the lane rule instead of adding a second one", async () => {
  const { env } = await temp();
  await connectZcode({ env, gateway: "http://127.0.0.1:3426", providerModels: async () => MODELS });
  await connectZcode({
    env,
    gateway: "http://127.0.0.1:3427",
    providerModels: async () => [{ id: "hy3", name: "Hy3", context: 192000 }]
  });
  const doc = await readConfig(env);
  const lanes = doc.config.providerConfigRules.providerRules
    .filter((item) => item.providerId === "lane");
  assert.equal(lanes.length, 1);
  assert.equal(lanes[0].config.api.baseUrl, "http://127.0.0.1:3427");
  assert.deepEqual(lanes[0].config.personalModelIds, ["hy3"]);
  assert.equal(doc.config.providerOrder.filter((id) => id === "lane").length, 1);
});

test("a reconnect keeps the user's own provider order", async () => {
  const { env } = await temp();
  await connectZcode({ env, gateway: "http://127.0.0.1:3426", providerModels: async () => MODELS });
  // The user demoted Lane below their default; a reconnect (a port change,
  // a reinstall) must not silently restore Lane to first place.
  const config = zcodePaths(env).config;
  const doc = await readConfig(env);
  doc.config.providerOrder = ["deepseek", "lane"];
  await fs.writeFile(config, JSON.stringify(doc, null, 2));

  await connectZcode({ env, gateway: "http://127.0.0.1:3427", providerModels: async () => MODELS });
  const after = await readConfig(env);
  assert.deepEqual(after.config.providerOrder, ["deepseek", "lane"]);
});

test("wiring.json keeps no copy of the provider config's text", async () => {
  const { env, root } = await temp();
  const config = zcodePaths(env).config;
  await fs.mkdir(path.dirname(config), { recursive: true });
  // The provider config carries the user's API keys; wiring.json must not
  // become a second plaintext copy of them. The marker below is a fixture,
  // not a credential — it only needs to be distinctive enough to grep for.
  const marker = "fixture-user-key-not-a-credential";
  await fs.writeFile(config, JSON.stringify({
    apiKey: marker,
    config: { providerConfigRules: { providerRules: [] } }
  }));
  await connectZcode({ env, gateway: "http://127.0.0.1:3426", providerModels: async () => MODELS });
  const wiring = await fs.readFile(path.join(root, "data", "wiring.json"), "utf8");
  assert.ok(!wiring.includes(marker), "the key stays out of wiring.json");
  assert.ok(!wiring.includes("savedConfig"));
});

test("a connect with no readable model list still declares Lane's own catalogue", async () => {
  const { env } = await temp();
  await connectZcode({
    env,
    gateway: "http://127.0.0.1:3426",
    providerModels: async () => { throw new Error("not signed in"); }
  });
  const doc = await readConfig(env);
  const rule = doc.config.providerConfigRules.providerRules
    .find((item) => item.providerId === "lane");
  assert.ok(rule.config.personalModelIds.length > 0, "the fallback catalogue is written");
});

test("a catalogue from another account replaces the stale one, keeping the user's order", async () => {
  const { env } = await temp();
  await connectZcode({ env, gateway: "http://127.0.0.1:3426", providerModels: async () => MODELS });
  // The user arranged the two models the other way round in ZCode's UI.
  const config = zcodePaths(env).config;
  const doc = await readConfig(env);
  const rule = doc.config.providerConfigRules.providerRules
    .find((item) => item.providerId === "lane");
  rule.config.personalModelIds = ["hy3", "auto"];
  rule.config.modelOrder = ["hy3", "auto"];
  await fs.writeFile(config, JSON.stringify(doc, null, 2));

  // Switching to an international account changes the catalogue behind the
  // same gateway URL: two ids the old list never had, one it drops.
  const result = await syncZcodeCatalog({
    env,
    models: [
      { id: "auto" },
      { id: "gpt-6-sol" },
      { id: "grok-4.7" }
    ]
  });
  assert.equal(result.changed, true);

  const after = await readConfig(env);
  const synced = after.config.providerConfigRules.providerRules
    .find((item) => item.providerId === "lane");
  // hy3 left, so auto stays first; the new ids join at the end in catalogue
  // order, and the second switch does not reorder what the first produced.
  assert.deepEqual(synced.config.personalModelIds, ["auto", "gpt-6-sol", "grok-4.7"]);
  assert.deepEqual(synced.config.modelOrder, ["auto", "gpt-6-sol", "grok-4.7"]);

  assert.equal((await syncZcodeCatalog({ env, models: [{ id: "auto" }, { id: "gpt-6-sol" }, { id: "grok-4.7" }] })).changed, false,
    "an unchanged catalogue writes nothing");
});

test("a sync leaves the provider config alone when Lane is not wired in", async () => {
  const { env } = await temp();
  const config = zcodePaths(env).config;
  await fs.mkdir(path.dirname(config), { recursive: true });
  const other = {
    schemaVersion: 1,
    config: {
      providerOrder: ["deepseek"],
      providerConfigRules: {
        providerRules: [{
          providerId: "deepseek",
          providerName: "DeepSeek",
          enabled: true,
          config: { personalModelIds: ["deepseek-flash"], modelOrder: ["deepseek-flash"] }
        }]
      }
    }
  };
  await fs.writeFile(config, JSON.stringify(other, null, 2));
  const before = await fs.readFile(config, "utf8");

  const result = await syncZcodeCatalog({ env, models: [{ id: "auto" }] });
  assert.equal(result.changed, false);
  assert.equal(await fs.readFile(config, "utf8"), before, "the file is untouched");
});

test("a sync after a disconnect does not resurrect the lane rule", async () => {
  const { env } = await temp();
  await connectZcode({ env, gateway: "http://127.0.0.1:3426", providerModels: async () => MODELS });
  await disconnectZcode({ env });
  const before = await fs.readFile(zcodePaths(env).config, "utf8");

  const result = await syncZcodeCatalog({ env, models: [{ id: "auto" }, { id: "hy3" }] });
  assert.equal(result.changed, false);
  assert.equal(await fs.readFile(zcodePaths(env).config, "utf8"), before);
});

test("disconnect with no prior connect is a no-op", async () => {
  const { env } = await temp();
  const result = await disconnectZcode({ env });
  assert.deepEqual(result, { agent: "zcode", connected: false, changed: false });
});

test("a config file that is not JSON is reported, not overwritten", async () => {
  const { env } = await temp();
  const config = zcodePaths(env).config;
  await fs.mkdir(path.dirname(config), { recursive: true });
  await fs.writeFile(config, "{ not json");
  await assert.rejects(
    () => connectZcode({ env, gateway: "http://127.0.0.1:3426", providerModels: async () => MODELS }),
    /not valid JSON/
  );
  assert.equal(await fs.readFile(config, "utf8"), "{ not json", "the file is untouched");
});

test("a config that parses but is not an object is refused, not crashed on", async () => {
  for (const content of ["null", "[]", "42", '"text"']) {
    const { env } = await temp();
    const config = zcodePaths(env).config;
    await fs.mkdir(path.dirname(config), { recursive: true });
    await fs.writeFile(config, content);
    await assert.rejects(
      () => connectZcode({ env, gateway: "http://127.0.0.1:3426", providerModels: async () => MODELS }),
      /must be a JSON object/,
      `connect on ${content}`
    );
    assert.equal(await fs.readFile(config, "utf8"), content, `the ${content} file is untouched`);
  }
});

test("a non-object config fakes no success on disconnect or sync", async () => {
  for (const content of ["null", "[]"]) {
    const { env } = await temp();
    const config = zcodePaths(env).config;
    await fs.mkdir(path.dirname(config), { recursive: true });
    // Wire against a good file, then break the file underneath.
    await connectZcode({ env, gateway: "http://127.0.0.1:3426", providerModels: async () => MODELS });
    await fs.writeFile(config, content);

    const synced = await syncZcodeCatalog({ env, models: [{ id: "auto" }] });
    assert.equal(synced.changed, false, `${content}: sync claims no change`);
    assert.match(synced.warning, /not valid JSON/);
    assert.equal(await fs.readFile(config, "utf8"), content);

    const off = await disconnectZcode({ env });
    assert.equal(off.connected, false);
    assert.match(off.warning, /not valid JSON/);
    assert.equal(await fs.readFile(config, "utf8"), content);
  }
});
