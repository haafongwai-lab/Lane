/**
 * The tools that make Lane's own 问答 panel worth opening.
 *
 * Every one of these reads local state — the journal, the account list, the
 * plugin registry, the model catalogue, the MCP registry. None of them sends
 * anything upstream, so none of them changes the request shape the vendor sees:
 * the model simply gets a tool result like it already does for MCP tools.
 *
 * They are deliberately read-only. Anything that would *change* Lane (sign in,
 * enable a model, install a plugin) is left to its page, where the user can see
 * the consequence; an answer that silently flipped a switch would be worse than
 * useless.
 */

const RANGES = new Set(["today", "7d", "30d", "all"]);

const num = (value) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  return n >= 10000 ? `${(n / 10000).toFixed(1)}万` : new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2 }).format(n);
};

const date = (ts) => {
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return "—";
  const d = new Date(n);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

export const LOCAL_TOOL_DEFS = [
  {
    type: "function",
    function: {
      name: "lane_usage",
      description: "查询 Lane 记录的积分花费：总请求数、已计费积分、未计费请求数，以及按模型和按客户端的分布。用于回答「今天花了多少」「哪个模型最费」这类问题。",
      parameters: {
        type: "object",
        properties: {
          range: { type: "string", enum: ["today", "7d", "30d", "all"], description: "时间范围，默认 today" }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "lane_balance",
      description: "查询各账号的剩余积分/额度、总额度、重置或到期时间。用于回答「我还有多少额度」「什么时候重置」这类问题。",
      parameters: {
        type: "object",
        properties: {
          account: { type: "string", description: "账号名称或 id 的一部分；省略则列出全部账号" }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "lane_plugins",
      description: "查询 Lane 内置与已安装插件的版本、是否安装在外部、是否可回滚。可选联网检查最新版本。用于回答「插件什么版本」「有没有新版」。",
      parameters: {
        type: "object",
        properties: {
          check: { type: "boolean", description: "是否联网查询 npm 上的最新版本，默认 false（只读本地）" }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "lane_models",
      description: "查询当前可用的模型：所属供应商、积分倍率、上下文窗口，以及免费模型额度。用于回答「有哪些模型」「哪个最省」这类问题。",
      parameters: { type: "object", properties: {} }
    }
  },
  {
    type: "function",
    function: {
      name: "lane_mcp",
      description: "查询 Lane 里注册的 MCP 服务器：传输方式、启用状态、归属客户端。可选对某一个做连通性测试。",
      parameters: {
        type: "object",
        properties: {
          test: { type: "string", description: "要测试连通性的 MCP 服务器名称；省略则只列清单" }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "lane_skills",
      description: "查询技能库：每个技能的名称、描述，以及安装在哪些客户端。用于回答「我装了哪些技能」「某个技能装到哪了」。",
      parameters: { type: "object", properties: {} }
    }
  },
  {
    type: "function",
    function: {
      name: "lane_settings",
      description: "查询 Lane 的网关设置：端口、是否隐藏 DSH 名称、出站拦截模式、脱敏开关。用于回答「端口是多少」「脱敏开了吗」这类问题。",
      parameters: { type: "object", properties: {} }
    }
  },
  {
    type: "function",
    function: {
      name: "lane_accounts",
      description: "查询已登录的上游账号：标签、站点、是否参与模型池、签到状态与今日签到积分。",
      parameters: { type: "object", properties: {} }
    }
  }
];

function formatUsage(report) {
  const totals = report?.totals || {};
  const lines = [
    `范围：${report?.range || "today"}${report?.spanDays ? `（${report.spanDays} 天）` : ""}`,
    `请求数：${num(totals.requests)}　已计费积分：${num(totals.credits)}　未计费请求：${num(totals.unbilledRequests)}`
  ];
  const models = Array.isArray(report?.models) ? report.models.slice(0, 8) : [];
  if (models.length) {
    lines.push("按模型：");
    for (const model of models) {
      lines.push(`- ${model.model || "?"}：${num(model.requests)} 次，${num(model.credits)} 积分`);
    }
  }
  const agents = Array.isArray(report?.agents) ? report.agents.slice(0, 8) : [];
  if (agents.length) {
    lines.push("按客户端：");
    for (const agent of agents) {
      lines.push(`- ${agent.agent || "?"}：${num(agent.requests)} 次，${num(agent.credits)} 积分`);
    }
  }
  if (!models.length && !agents.length) lines.push("这段时间没有记录到请求。");
  return lines.join("\n");
}

function formatCredits(credits) {
  if (!credits) return "额度不可用";
  if (credits.error) return `额度读取失败：${credits.error}`;
  const unit = credits.unit === "usd" ? "$" : "积分";
  const left = num(credits.left);
  const limit = num(credits.limit);
  const parts = [credits.prepaid || !(Number(credits.limit) > 0) ? `剩余 ${left} ${unit}` : `剩余 ${left} / ${limit} ${unit}`];
  if (credits.resetsAt) parts.push(`重置 ${date(credits.resetsAt)}`);
  if (credits.lapsesAt) parts.push(`到期 ${date(credits.lapsesAt)}`);
  if (credits.plan) parts.push(credits.plan);
  return parts.join("，");
}

/**
 * Builds the tool table. `control` is the gateway's control center, injected so
 * this module stays testable with a stub.
 */
export function createLocalTools({ control, settings = null } = {}) {
  const need = () => {
    if (!control) throw new Error("控制中心还不可用");
    return control;
  };

  const impl = {
    async lane_usage({ range } = {}) {
      const chosen = RANGES.has(String(range)) ? String(range) : "today";
      return formatUsage(await need().usage(chosen));
    },

    async lane_balance({ account } = {}) {
      const { accounts = [], activeId } = await need().accounts();
      if (!accounts.length) return "还没有登录任何账号。";
      const wanted = String(account || "").trim().toLowerCase();
      const matched = wanted
        ? accounts.filter((item) => String(item.label || "").toLowerCase().includes(wanted) || String(item.id || "").toLowerCase().includes(wanted))
        : accounts;
      if (!matched.length) return `没有找到名称或 id 匹配「${account}」的账号。`;
      const lines = [];
      for (const item of matched) {
        // The list already carries each account's own credits figure.
        const credits = item.credits || null;
        const marks = [item.id === activeId ? "（当前路由）" : "", item.routable ? "" : "（未参与模型池）"].filter(Boolean).join("");
        lines.push(`- ${item.label || item.id}${marks}：${formatCredits(credits)}`);
      }
      return lines.join("\n");
    },

    async lane_plugins({ check } = {}) {
      const list = await need().plugins();
      const lines = list.map((item) => {
        const state = item.installed ? "外部安装" : "内置";
        return `- ${item.title || item.key}：${item.version || "?"}（${state}${item.canRollback ? "，可回滚" : ""}）`;
      });
      if (check === true) {
        const rows = await need().pluginCheck();
        lines.push("", "最新版本：");
        for (const row of rows) {
          if (row.error) lines.push(`- ${row.title || row.key}：检查失败（${row.error}）`);
          else lines.push(`- ${row.title || row.key}：当前 ${row.installedVersion || "?"}，最新 ${row.latestVersion || "?"}${row.updateAvailable ? "（可更新）" : "（已是最新）"}`);
        }
      }
      return lines.join("\n");
    },

    async lane_models() {
      const status = await need().status();
      const models = Array.isArray(status?.models) ? status.models : [];
      if (!models.length) return "还没有启用任何模型。";
      const lines = models.map((model) => {
        const rate = Number.isFinite(model.rate) ? (model.free ? "免费" : `×${num(model.rate)}${model.rateUnit === "request" ? " 每次请求" : ""}`) : "倍率未知";
        const window = model.context ? `，上下文 ${num(model.context)}` : "";
        return `- ${model.name || model.id}（${model.provider || "?"}）：${rate}${window}`;
      });
      const free = status?.freeAllowance;
      if (free && Array.isArray(free.models) && free.models.length) {
        lines.push("", "免费模型：");
        for (const item of free.models.slice(0, 6)) {
          const left = Number.isFinite(item.left) ? `${num(item.left)} 次` : "未知";
          lines.push(`- ${item.model || "?"}：剩余 ${left}`);
        }
      }
      return lines.join("\n");
    },

    async lane_mcp({ test } = {}) {
      const servers = await need().mcpServers();
      if (!Array.isArray(servers) || !servers.length) return "还没有注册任何 MCP 服务器。";
      const lines = servers.map((server) => {
        const where = server.transport === "http" ? server.url || "HTTP" : [server.command, ...(server.args || [])].filter(Boolean).join(" ");
        const agents = Array.isArray(server.agents) && server.agents.length ? `，归属 ${server.agents.join("/")}` : "，仅问答使用";
        return `- ${server.name}（${server.transport}${server.off ? "，已停用" : ""}）：${where}${agents}`;
      });
      if (test) {
        const target = servers.find((server) => server.name === String(test));
        if (!target) return `${lines.join("\n")}\n\n没有名为「${test}」的服务器。`;
        const result = await need().mcpTest(target.name);
        lines.push("", `连通性测试 ${target.name}：${result?.ok ? "正常" : `失败（${result?.error || "未知原因"}）`}`);
        // The tool names are what the model can actually call, so they are
        // listed rather than only counted.
        if (Array.isArray(result?.tools) && result.tools.length) {
          lines.push(`可用工具（${result.tools.length}）：${result.tools.slice(0, 30).join("、")}`);
        }
      }
      return lines.join("\n");
    },

    async lane_skills() {
      const library = await need().skillsList();
      if (!Array.isArray(library) || !library.length) return "技能库是空的。";
      return library.map((skill) => {
        const targets = (skill.installs || []).map((item) => `${item.agent}${item.linked ? "（已装）" : "（占用）"}`);
        const where = targets.length ? `装于 ${targets.join("、")}` : "未安装到任何客户端";
        return `- ${skill.name}${skill.builtin ? "（内置）" : ""}：${skill.description || "无描述"}；${where}`;
      }).join("\n");
    },

    async lane_settings() {
      if (typeof settings !== "function") return "设置读取器不可用。";
      const current = (await settings()) || {};
      const egress = { off: "关闭", monitor: "只记录", enforce: "拦截第三方" }[current.egressMode] || current.egressMode || "?";
      return [
        `端口：${current.port ?? "?"}`,
        `隐藏 DSH 名称：${current.hideDsh === false ? "关闭" : "开启"}`,
        `出站拦截：${egress}`,
        `请求脱敏：${current.redactSecrets === false ? "关闭" : "开启"}`
      ].join("\n");
    },

    async lane_accounts() {
      const { accounts = [], activeId } = await need().accounts();
      if (!accounts.length) return "还没有登录任何账号。";
      let checkins = {};
      try {
        const overview = await need().checkinOverview();
        for (const row of overview?.results || []) checkins[row.id] = row;
      } catch {}
      const lines = accounts.map((item) => {
        const marks = [item.id === activeId ? "当前路由" : "", item.routable ? "参与模型池" : "未参与"].filter(Boolean).join("、");
        const checkin = checkins[item.id];
        const signed = checkin ? `，签到 ${checkin.status === "done" ? `已签${checkin.reward ? ` +${checkin.reward}` : ""}` : checkin.status}` : "";
        return `- ${item.label || item.id}（${item.site || "?"}）：${marks || "—"}${signed}`;
      });
      return lines.join("\n");
    }
  };

  return { defs: LOCAL_TOOL_DEFS, impl };
}
