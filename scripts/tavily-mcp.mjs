#!/usr/bin/env node
/**
 * A stdio MCP server that gives Lane's 问答 panel a way to look things up.
 *
 * The panel is a chat, not an agent: its models can only reason over the text
 * they are given, so anything that happened after training is invisible to
 * them. Tavily answers that with a search API built for LLM use — it returns
 * ranked results and, on request, a synthesised answer with its sources.
 *
 * The key is read from TAVILY_API_KEY in the environment, which is how Lane
 * passes it (src/mcp-servers.js keeps `env` on the entry, and mcp-session.js
 * merges it into the child's environment). Nothing is written to disk and no
 * other host is contacted: registry-free, so `node <this file>` is the whole
 * install.
 *
 * stdout carries JSON-RPC only — every log line goes to stderr, because a stray
 * line on stdout is a broken frame to a client.
 *
 * Wire: initialize -> notifications/initialized -> tools/list -> tools/call.
 */

const PROTOCOL_VERSION = "2024-11-05";
const SERVER_INFO = { name: "tavily", version: "1.0.0" };
const ENDPOINT = "https://api.tavily.com";
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_TEXT = 12_000;

const log = (...parts) => process.stderr.write(`[tavily] ${parts.join(" ")}\n`);
const out = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const ok = (id, result) => out({ jsonrpc: "2.0", id, result });
const fail = (id, code, message) => out({ jsonrpc: "2.0", id, error: { code, message } });

function apiKey() {
  const key = String(process.env.TAVILY_API_KEY || "").trim();
  if (!key) {
    throw new Error("缺少 TAVILY_API_KEY：请到 tavily.com 取得密钥，再填进 MCP 服务的环境变量");
  }
  // A key is a bearer credential; it must never reach a log line or a tool
  // result, so only its shape is reported.
  if (!/^tvly-[A-Za-z0-9_-]{10,}$/.test(key)) {
    throw new Error("TAVILY_API_KEY 格式不像 Tavily 的密钥（应以 tvly- 开头）");
  }
  return key;
}

async function post(path, body) {
  const response = await fetch(`${ENDPOINT}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey()}`
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  });
  const text = await response.text();
  if (!response.ok) {
    // Tavily reports the reason in the body; a bare status would be useless.
    let detail = text;
    try {
      const parsed = JSON.parse(text);
      detail = parsed?.detail?.error || parsed?.detail || parsed?.error || text;
    } catch {}
    if (response.status === 401) throw new Error("Tavily 拒绝了密钥（401）：请检查 TAVILY_API_KEY 是否正确");
    if (response.status === 429) throw new Error("Tavily 额度已用尽或请求过快（429）：请稍后重试或升级套餐");
    if (response.status === 432 || response.status === 433) {
      throw new Error(`Tavily 套餐额度不足（${response.status}）：${String(detail).slice(0, 200)}`);
    }
    throw new Error(`Tavily 返回 ${response.status}：${String(detail).slice(0, 300)}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("Tavily 的响应不是 JSON");
  }
}

/** A URL is shown so the model can cite it; a title may be empty. */
function resultLine(item, index) {
  const title = String(item?.title || "").trim() || "(无标题)";
  const url = String(item?.url || "").trim();
  const score = Number.isFinite(item?.score) ? `　相关度 ${item.score.toFixed(3)}` : "";
  const body = String(item?.content || "").trim();
  return [
    `${index + 1}. ${title}${score}`,
    url ? `   ${url}` : "",
    body ? `   ${body}` : ""
  ].filter(Boolean).join("\n");
}

function clip(text, maxChars) {
  const limit = Math.min(Math.max(Number(maxChars) || MAX_TEXT, 500), MAX_TEXT);
  const src = String(text || "");
  if (src.length <= limit) return src;
  return `${src.slice(0, limit)}\n…（已截断，原文 ${src.length} 字符）`;
}

const TOOLS = [
  {
    name: "web_search",
    description:
      "联网搜索。返回按相关度排序的结果（标题、链接、摘要），可选附带一段带引用的综合答案。" +
      "用于回答需要最新信息、事实核查、或训练数据之后发生的事。搜索词会发送给 Tavily。",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "搜索词，用自然语言描述要找什么" },
        count: { type: "number", description: "返回几条结果，默认 5，最多 10" },
        answer: { type: "boolean", description: "是否附带一段综合答案（默认 false）" },
        depth: {
          type: "string",
          enum: ["basic", "advanced"],
          description: "检索深度：basic 快而省，advanced 更全但更慢（默认 basic）"
        },
        topic: {
          type: "string",
          enum: ["general", "news"],
          description: "主题：general 通用，news 偏新闻（默认 general）"
        },
        days: { type: "number", description: "只取最近几天内的结果，仅 news 主题有效" },
        domains: {
          type: "array",
          items: { type: "string" },
          description: "只在这些域名内检索，例如 [\"github.com\"]"
        }
      },
      required: ["query"]
    }
  },
  {
    name: "web_extract",
    description:
      "抓取一个或多个网页的正文。用于读取用户给出的链接，或读取搜索结果里最相关的那一条。",
    inputSchema: {
      type: "object",
      properties: {
        urls: {
          type: "array",
          items: { type: "string" },
          description: "要抓取的网址，最多 5 个"
        },
        maxChars: { type: "number", description: "每条正文最多返回多少字符，默认 12000" }
      },
      required: ["urls"]
    }
  }
];

const toolImpl = {
  async web_search({ query, count, answer, depth, topic, days, domains }) {
    const q = String(query || "").trim();
    if (!q) throw new Error("缺少搜索词 query");
    if (q.length > 400) throw new Error("搜索词过长（上限 400 字符）");
    const body = {
      query: q,
      max_results: Math.min(Math.max(Number(count) || 5, 1), 10),
      search_depth: depth === "advanced" ? "advanced" : "basic",
      topic: topic === "news" ? "news" : "general",
      include_answer: answer === true
    };
    if (Array.isArray(domains) && domains.length) {
      body.include_domains = domains.map(String).filter(Boolean).slice(0, 10);
    }
    if (body.topic === "news" && Number(days) > 0) {
      body.days = Math.min(Math.max(Number(days), 1), 30);
    }
    const doc = await post("/search", body);
    const results = Array.isArray(doc?.results) ? doc.results : [];
    const lines = [`搜索：${q}`, `返回 ${results.length} 条结果`];
    if (doc?.answer) lines.push("", `综合答案：${doc.answer}`);
    if (results.length) {
      lines.push("");
      results.forEach((item, index) => lines.push(resultLine(item, index)));
    } else {
      lines.push("", "没有检索到结果。可以换一种说法，或去掉域名限制。");
    }
    return clip(lines.join("\n"));
  },

  async web_extract({ urls, maxChars }) {
    const list = (Array.isArray(urls) ? urls : [urls])
      .map((u) => String(u || "").trim())
      .filter((u) => /^https?:\/\//i.test(u))
      .slice(0, 5);
    if (!list.length) throw new Error("需要一个或多个 http(s) 网址");
    const doc = await post("/extract", { urls: list });
    const results = Array.isArray(doc?.results) ? doc.results : [];
    const failures = Array.isArray(doc?.failed_results) ? doc.failed_results : [];
    const limit = Math.min(Math.max(Number(maxChars) || MAX_TEXT, 500), MAX_TEXT);
    const parts = [];
    for (const item of results) {
      const body = String(item?.raw_content || "").trim();
      parts.push([
        `网址：${item?.url || "?"}`,
        body ? clip(body, limit) : "（没有可读正文）"
      ].join("\n"));
    }
    for (const item of failures) {
      parts.push(`网址：${item?.url || "?"}\n抓取失败：${item?.error || "未知原因"}`);
    }
    if (!parts.length) return "没有抓取到任何内容。";
    return parts.join("\n\n----\n\n");
  }
};

// ---- stdio JSON-RPC loop ---------------------------------------------------
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let cut;
  while ((cut = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, cut).trim();
    buffer = buffer.slice(cut + 1);
    if (!line) continue;
    let message;
    try { message = JSON.parse(line); } catch { continue; }
    handle(message).catch((error) => {
      log("handler error", error?.message || String(error));
      if (message?.id !== undefined) fail(message.id, -32603, error?.message || String(error));
    });
  }
});

async function handle(message) {
  const { id, method, params } = message;
  if (method === "initialize") {
    return ok(id, {
      protocolVersion: params?.protocolVersion || PROTOCOL_VERSION,
      capabilities: { tools: { listChanged: false } },
      serverInfo: SERVER_INFO
    });
  }
  // Notifications have no id and must not be answered.
  if (method === "notifications/initialized" || method === "notifications/cancelled") return;
  if (method === "ping") return ok(id, {});
  if (method === "tools/list") return ok(id, { tools: TOOLS });
  if (method === "tools/call") {
    const name = params?.name;
    const args = params?.arguments || {};
    const impl = toolImpl[name];
    let result;
    if (!impl) {
      result = { content: [{ type: "text", text: `未知工具：${name}` }], isError: true };
    } else {
      try {
        const text = await impl(args);
        result = { content: [{ type: "text", text }] };
      } catch (error) {
        result = { content: [{ type: "text", text: `查询失败：${error?.message || String(error)}` }], isError: true };
      }
    }
    return ok(id, result);
  }
  if (id !== undefined) return fail(id, -32601, `不支持的方法：${method}`);
}

log("ready; set TAVILY_API_KEY in the server's environment");
