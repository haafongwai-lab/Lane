#!/usr/bin/env node
/**
 * A stdio MCP server that answers questions about npm packages.
 *
 * Lane's 问答 panel is a chat, not an agent: its models can only reason over
 * the text they are given. Extending the panel with this server gives them a
 * way to look up what actually shipped — version lists, publish dates, dist
 * tags, metadata, a README, or a before/after file diff between two releases.
 *
 * It uses only Node built-ins and the global fetch, so `node <this file>` is
 * the whole install. Nothing is cached to disk and no credentials are needed;
 * registry.npmjs.org is public. stdout carries JSON-RPC only — every log line
 * goes to stderr, because a stray line on stdout is a broken frame to a client.
 *
 * Wire: initialize -> notifications/initialized -> tools/list -> tools/call.
 */

import zlib from "node:zlib";

const PROTOCOL_VERSION = "2024-11-05";
const SERVER_INFO = { name: "npm-registry", version: "1.0.0" };
const REQUEST_TIMEOUT_MS = 12_000;
const MAX_TEXT = 12_000;
const MAX_TARBALL_BYTES = 8 * 1024 * 1024;

const log = (...parts) => process.stderr.write(`[npm-registry] ${parts.join(" ")}\n`);
const out = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const ok = (id, result) => out({ jsonrpc: "2.0", id, result });
const fail = (id, code, message) => out({ jsonrpc: "2.0", id, error: { code, message } });

// A scoped name must keep its leading @ but escape the slash.
const registryPath = (name) => encodeURIComponent(String(name)).replace(/^%40/, "@");

async function getJson(url) {
  const response = await fetch(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  });
  if (!response.ok) throw new Error(`registry HTTP ${response.status} for ${url}`);
  return response.json();
}

async function packument(name) {
  if (!name || typeof name !== "string") throw new Error("缺少包名 name");
  return getJson(`https://registry.npmjs.org/${registryPath(name)}`);
}

function checkName(name) {
  if (typeof name !== "string" || !name.trim()) throw new Error("缺少包名 name");
  // A name that turns into a path traversal or a non-registry host is refused
  // before it reaches fetch: names come from a model, not from the user.
  if (!/^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/i.test(name.trim())) {
    throw new Error(`包名不合法：${name}`);
  }
  return name.trim();
}

const daysAgo = (iso) => {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "?";
  return Math.max(0, Math.round((Date.now() - t) / 86_400_000));
};

const shortDate = (iso) => (Number.isFinite(Date.parse(iso)) ? String(iso).slice(0, 10) : String(iso || "?"));

function clip(text, limit = MAX_TEXT) {
  const s = String(text || "");
  return s.length > limit ? `${s.slice(0, limit)}\n…（已截断，共 ${s.length} 字符）` : s;
}

// ---- tarball reading -------------------------------------------------------
// npm tarballs are gzipped ustar. Only names and sizes are needed for a diff;
// the README needs its bytes, so the whole archive is walked once.
function untar(buffer) {
  const files = new Map();
  let offset = 0;
  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/, "");
    const size = parseInt(header.subarray(124, 136).toString("utf8").replace(/\0.*$/, "").trim(), 8) || 0;
    const data = buffer.subarray(offset + 512, offset + 512 + size);
    if (name && !name.endsWith("/")) files.set(name.replace(/^\.\//, ""), Buffer.from(data));
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}

async function tarballFiles(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`tarball HTTP ${response.status}`);
  const length = Number(response.headers.get("content-length") || 0);
  if (length > MAX_TARBALL_BYTES) throw new Error(`tarball 过大（${length} 字节），跳过文件级对比`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > MAX_TARBALL_BYTES) throw new Error(`tarball 过大（${bytes.length} 字节），跳过文件级对比`);
  return untar(zlib.gunzipSync(bytes));
}

// ---- tools ----------------------------------------------------------------
const TOOLS = [
  {
    name: "npm_versions",
    description: "列出某个 npm 包最近发布的版本及发布日期（按时间倒序）。用于回答「最近几次版本更新」「什么时候发的」这类问题。",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "包名，可带 scope，例如 @magpie-community/opencode-workbuddy-auth" },
        count: { type: "number", description: "返回最近几个版本，默认 10，最多 50" }
      },
      required: ["name"]
    }
  },
  {
    name: "npm_dist_tags",
    description: "读取包的 dist-tags（latest / next / beta 等）及其指向的版本和发布时间。",
    inputSchema: { type: "object", properties: { name: { type: "string", description: "包名" } }, required: ["name"] }
  },
  {
    name: "npm_package",
    description: "包的概览：描述、许可证、仓库、主页、维护者、dist-tags、版本总数、创建与最后修改时间、最新版及发布时间。",
    inputSchema: { type: "object", properties: { name: { type: "string", description: "包名" } }, required: ["name"] }
  },
  {
    name: "npm_version",
    description: "某个具体版本的详情：发布时间、tarball、integrity、依赖、 engines、发布者等。",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "包名" },
        version: { type: "string", description: "版本号；省略则用 dist-tags.latest" }
      },
      required: ["name"]
    }
  },
  {
    name: "npm_readme",
    description: "读取某个版本的 README（默认最新版），常包含版本历史和变更说明。返回纯文本，可能截断。",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "包名" },
        version: { type: "string", description: "版本号；省略则用最新版" },
        maxChars: { type: "number", description: "最多返回多少字符，默认 12000" }
      },
      required: ["name"]
    }
  },
  {
    name: "npm_compare",
    description: "对比两个版本的 tarball 文件清单与大小变化（新增/删除/改动的文件），用来判断一次升级具体改了哪些文件。",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "包名" },
        from: { type: "string", description: "旧版本号" },
        to: { type: "string", description: "新版本号" }
      },
      required: ["name", "from", "to"]
    }
  }
];

const toolImpl = {
  async npm_versions({ name, count }) {
    const pkg = checkName(name);
    const doc = await packument(pkg);
    const limit = Math.min(Math.max(Number(count) || 10, 1), 50);
    const time = doc.time || {};
    const rows = Object.keys(doc.versions || {})
      .map((version) => ({ version, at: time[version] || "" }))
      .sort((a, b) => (Date.parse(b.at) || 0) - (Date.parse(a.at) || 0))
      .slice(0, limit);
    const lines = rows.map((row) => `- ${row.version}  ${shortDate(row.at)}（${daysAgo(row.at)} 天前）`);
    return [
      `包：${pkg}`,
      `共 ${Object.keys(doc.versions || {}).length} 个版本，以下为最近 ${rows.length} 个：`,
      ...lines,
      `数据来自 registry.npmjs.org 的 time 字段，按发布时间倒序。`
    ].join("\n");
  },

  async npm_dist_tags({ name }) {
    const pkg = checkName(name);
    const doc = await packument(pkg);
    const tags = doc["dist-tags"] || {};
    const time = doc.time || {};
    const lines = Object.entries(tags).map(([tag, version]) => `- ${tag} → ${version}（${shortDate(time[version])}）`);
    return [`包：${pkg}`, "dist-tags：", ...(lines.length ? lines : ["（无）"])].join("\n");
  },

  async npm_package({ name }) {
    const pkg = checkName(name);
    const doc = await packument(pkg);
    const versions = Object.keys(doc.versions || {});
    const tags = doc["dist-tags"] || {};
    const latest = tags.latest || versions[versions.length - 1] || "";
    const meta = doc.versions?.[latest] || {};
    const time = doc.time || {};
    const repo = doc.repository?.url || meta.repository?.url || "";
    const maintainers = (doc.maintainers || []).map((m) => m.name).join("、");
    return [
      `包：${pkg}`,
      `描述：${doc.description || meta.description || "（无）"}`,
      `许可证：${doc.license || meta.license || "（未声明）"}`,
      `仓库：${repo || "（未声明）"}`,
      `主页：${doc.homepage || meta.homepage || "（未声明）"}`,
      `维护者：${maintainers || "（未声明）"}`,
      `版本总数：${versions.length}`,
      `创建：${shortDate(time.created)}　最后修改：${shortDate(time.modified)}`,
      `dist-tags：${JSON.stringify(tags)}`,
      `最新版：${latest}（${shortDate(time[latest])}，${daysAgo(time[latest])} 天前）`
    ].join("\n");
  },

  async npm_version({ name, version }) {
    const pkg = checkName(name);
    const doc = await packument(pkg);
    const wanted = version || doc["dist-tags"]?.latest;
    const meta = doc.versions?.[wanted];
    if (!meta) throw new Error(`找不到版本 ${wanted}；可用版本请用 npm_versions 查询`);
    const time = doc.time || {};
    const deps = Object.keys(meta.dependencies || {});
    const devDeps = Object.keys(meta.devDependencies || {});
    return [
      `包：${pkg}　版本：${wanted}`,
      `发布时间：${shortDate(time[wanted])}（${daysAgo(time[wanted])} 天前）`,
      `tarball：${meta.dist?.tarball || "（无）"}`,
      `integrity：${meta.dist?.integrity || "（无）"}`,
      `解包大小：${meta.dist?.unpackedSize ?? "?"} 字节`,
      `engines：${JSON.stringify(meta.engines || {})}`,
      `依赖（${deps.length}）：${deps.join(", ") || "无"}`,
      `开发依赖（${devDeps.length}）：${devDeps.join(", ") || "无"}`,
      `gitHead：${meta.gitHead || "（无）"}`
    ].join("\n");
  },

  async npm_readme({ name, version, maxChars }) {
    const pkg = checkName(name);
    const doc = await packument(pkg);
    const wanted = version || doc["dist-tags"]?.latest;
    const limit = Math.min(Math.max(Number(maxChars) || MAX_TEXT, 500), 40_000);
    let readme = "";
    // The packument's own readme is the latest version's; an explicit older
    // version needs its tarball.
    if (!version && typeof doc.readme === "string" && doc.readme) {
      readme = doc.readme;
    } else {
      const meta = doc.versions?.[wanted];
      if (!meta?.dist?.tarball) throw new Error(`找不到版本 ${wanted} 的 tarball`);
      const files = await tarballFiles(meta.dist.tarball);
      const key = [...files.keys()].find((k) => /(^|\/)readme(\.md|\.txt|\.markdown)?$/i.test(k));
      if (!key) throw new Error(`版本 ${wanted} 的包里没有 README`);
      readme = files.get(key).toString("utf8");
    }
    return `包：${pkg}　版本：${wanted}　README（可能截断）：\n\n${clip(readme, limit)}`;
  },

  async npm_compare({ name, from, to }) {
    const pkg = checkName(name);
    if (!from || !to) throw new Error("需要 from 和 to 两个版本号");
    const doc = await packument(pkg);
    const a = doc.versions?.[from];
    const b = doc.versions?.[to];
    if (!a || !b) throw new Error(`找不到版本 ${!a ? from : to}；可用版本请用 npm_versions 查询`);
    const [oldFiles, newFiles] = await Promise.all([
      tarballFiles(a.dist.tarball),
      tarballFiles(b.dist.tarball)
    ]);
    const oldNames = new Set(oldFiles.keys());
    const newNames = new Set(newFiles.keys());
    const added = [...newNames].filter((k) => !oldNames.has(k)).sort();
    const removed = [...oldNames].filter((k) => !newNames.has(k)).sort();
    const changed = [...newNames]
      .filter((k) => oldNames.has(k) && oldFiles.get(k).length !== newFiles.get(k).length)
      .sort();
    const bytes = (files) => [...files.values()].reduce((sum, buf) => sum + buf.length, 0);
    const lines = [
      `包：${pkg}　${from} → ${to}`,
      `文件数：${oldNames.size} → ${newNames.size}`,
      `包内总字节：${bytes(oldFiles)} → ${bytes(newFiles)}`,
      `新增文件（${added.length}）：${added.join(", ") || "无"}`,
      `删除文件（${removed.length}）：${removed.join(", ") || "无"}`,
      `大小变化的文件（${changed.length}）：${changed.map((k) => `${k} ${oldFiles.get(k).length}→${newFiles.get(k).length}`).join("；") || "无"}`
    ];
    return lines.join("\n");
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
