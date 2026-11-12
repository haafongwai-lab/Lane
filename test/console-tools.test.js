import test from "node:test";
import assert from "node:assert/strict";
import { LOCAL_TOOL_DEFS, createLocalTools } from "../src/console-tools.js";

/**
 * Lane's own read-only tools.
 *
 * They exist so the 问答 panel can answer what no other client can — how much
 * was spent, what is left, which plugins are current — and they do it by
 * reading local state only. Nothing here sends a request upstream, so adding
 * them changes no request shape the vendor sees.
 */

const EXPECTED = ["lane_usage", "lane_balance", "lane_plugins", "lane_models", "lane_mcp", "lane_skills", "lane_settings", "lane_accounts"];

function stubControl() {
  const calls = [];
  const control = {
    usage: async (range) => { calls.push(["usage", range]); return {
      range,
      spanDays: 1,
      totals: { requests: 12, credits: 34.5, unbilledRequests: 2 },
      models: [{ model: "hy4free", requests: 8, credits: 20 }],
      agents: [{ agent: "codex", requests: 5, credits: 10 }]
    }; },
    accounts: async () => { calls.push(["accounts"]); return {
      activeId: "a1",
      accounts: [
        { id: "a1", label: "主账号", site: "workbuddy", routable: true, credits: { left: 120, limit: 500, resetsAt: 1_700_000_000_000, plan: "Free" } },
        { id: "a2", label: "备用", site: "trae-cn", routable: false, credits: { left: 30, limit: 0, prepaid: true } }
      ]
    }; },
    plugins: async () => { calls.push(["plugins"]); return [
      { key: "workbuddy-auth", title: "WorkBuddy Auth", version: "0.2.27", installed: false, canRollback: false },
      { key: "qoder-auth", title: "Qoder Auth", version: "0.2.66", installed: true, canRollback: true }
    ]; },
    pluginCheck: async () => { calls.push(["pluginCheck"]); return [
      { key: "qoder-auth", title: "Qoder Auth", installedVersion: "0.2.66", latestVersion: "0.2.67", updateAvailable: true, error: "" }
    ]; },
    status: async () => { calls.push(["status"]); return {
      models: [
        { id: "hy4free", name: "Hy4", provider: "workbuddy", rate: 0, free: true, context: 960000 },
        { id: "qoder:qfmodel", name: "QF", provider: "qoder", rate: 0.4, rateUnit: "request", context: 1000000 }
      ],
      freeAllowance: { models: [{ model: "hy4free", left: 42 }] }
    }; },
    mcpServers: async () => { calls.push(["mcpServers"]); return [
      { name: "npm-registry", transport: "stdio", command: "node", args: ["x.mjs"], agents: [] },
      { name: "github", transport: "http", url: "https://example/mcp", agents: ["codex"], off: true }
    ]; },
    mcpTest: async (name) => { calls.push(["mcpTest", name]); return { ok: true, tools: ["a", "b"] }; },
    skillsList: async () => { calls.push(["skillsList"]); return [
      { name: "find-skills", description: "查找技能", builtin: true, installs: [{ agent: "codex", linked: true }] },
      { name: "demo", description: "示例", builtin: false, installs: [] }
    ]; },
    checkinOverview: async () => { calls.push(["checkinOverview"]); return { results: [
      { id: "a1", status: "done", reward: "100" }
    ] }; }
  };
  return { control, calls };
}

test("the six tools are declared with schemas", () => {
  assert.deepEqual(LOCAL_TOOL_DEFS.map((tool) => tool.function.name), EXPECTED);
  for (const tool of LOCAL_TOOL_DEFS) {
    assert.equal(tool.type, "function");
    assert.ok(tool.function.description);
    assert.equal(tool.function.parameters.type, "object");
  }
});

const SETTINGS = { port: 3426, hideDsh: true, egressMode: "enforce", redactSecrets: true };

test("each tool returns readable text from local state", async () => {
  const { control } = stubControl();
  const { impl } = createLocalTools({ control, settings: async () => SETTINGS });

  const usage = await impl.lane_usage({ range: "7d" });
  assert.match(usage, /范围：7d/);
  assert.match(usage, /请求数：12/);
  assert.match(usage, /hy4free/);
  assert.match(usage, /codex/);

  const balance = await impl.lane_balance({});
  assert.match(balance, /主账号/);
  assert.match(balance, /剩余 120 \/ 500 积分/);

  const onlyOne = await impl.lane_balance({ account: "备用" });
  assert.match(onlyOne, /备用/);
  assert.equal(/主账号/.test(onlyOne), false, "the filter narrows the list");

  const plugins = await impl.lane_plugins({});
  assert.match(plugins, /Qoder Auth：0\.2\.66（外部安装，可回滚）/);
  assert.match(plugins, /WorkBuddy Auth：0\.2\.27（内置）/);

  const checked = await impl.lane_plugins({ check: true });
  assert.match(checked, /最新 0\.2\.67（可更新）/);

  const models = await impl.lane_models();
  assert.match(models, /免费/);
  assert.match(models, /×0\.4 每次请求/);

  const mcp = await impl.lane_mcp({});
  assert.match(mcp, /npm-registry/);
  assert.match(mcp, /github.*已停用/);

  const tested = await impl.lane_mcp({ test: "npm-registry" });
  assert.match(tested, /连通性测试 npm-registry：正常/);

  const skills = await impl.lane_skills();
  assert.match(skills, /find-skills（内置）：查找技能；装于 codex（已装）/);
  assert.match(skills, /demo：示例；未安装到任何客户端/);

  const settings = await impl.lane_settings();
  assert.match(settings, /端口：3426/);
  assert.match(settings, /出站拦截：拦截第三方/);
  assert.match(settings, /请求脱敏：开启/);

  // The MCP test now lists tool names, not just a count.
  assert.match(tested, /可用工具（2）：a、b/);

  const accounts = await impl.lane_accounts();
  assert.match(accounts, /主账号/);
  assert.match(accounts, /签到 已签 \+100/);
});

test("a bad account filter says so rather than returning everything", async () => {
  const { control } = stubControl();
  const { impl } = createLocalTools({ control });
  const text = await impl.lane_balance({ account: "不存在" });
  assert.match(text, /没有找到/);
});

test("the tools only read; nothing that mutates Lane is reachable", async () => {
  const { control, calls } = stubControl();
  const { impl } = createLocalTools({ control });
  await impl.lane_usage({});
  await impl.lane_balance({});
  await impl.lane_plugins({});
  await impl.lane_models();
  await impl.lane_mcp({});
  await impl.lane_accounts({});
  const used = new Set(calls.map(([name]) => name));
  for (const forbidden of ["signIn", "setModelEnabled", "setEnabled", "setRoutable", "removeAccount", "pluginApply", "pluginRollback", "mcpRemove", "mcpToggle", "connect", "disconnect"]) {
    assert.equal(used.has(forbidden), false, `${forbidden} must never be called`);
  }
});

test("a missing control centre is reported, not crashed into", async () => {
  const { impl } = createLocalTools({});
  await assert.rejects(() => impl.lane_usage({}), /控制中心/);
});
