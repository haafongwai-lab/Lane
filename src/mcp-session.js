import { spawn } from "node:child_process";
import path from "node:path";

/**
 * A live MCP session, kept open for a conversation.
 *
 * `mcp-test.js` answers "does this server start and what tools does it have"
 * with a one-shot handshake. The console needs the next step: a session that
 * stays open, lists its tools once, and can call one repeatedly while the model
 * asks for them.
 *
 * Two transports, the same protocol version the test uses:
 *   stdio  a local command, JSON-RPC over stdin/stdout, one object per line
 *   http   a streamable-HTTP endpoint, the session id from initialize riding
 *          along on every later call
 *
 * Everything is bounded: a request that never answers is rejected on timeout,
 * and close() ends a spawned process so a conversation cannot leak children.
 */

const PROTOCOL_VERSION = "2024-11-05";
const CLIENT_INFO = { name: "lane", version: "1.0.0" };

// Only these are known package-manager shims that need cmd.exe on Windows. A
// plain missing command must fail cleanly instead of becoming a shell call.
const WINDOWS_SHELL_SHIMS = new Set(["npx", "npm", "pnpm", "yarn", "bun"]);

function isWindowsShim(command) {
  return WINDOWS_SHELL_SHIMS.has(path.basename(String(command || "")).toLowerCase().replace(/\.cmd$/i, ""));
}

function shellSafeArgs(args) {
  return (args || []).every((arg) => !/[&|<>^%!\r\n]/.test(String(arg)));
}

function toTools(list) {
  return (Array.isArray(list) ? list : [])
    .filter((tool) => tool && typeof tool.name === "string")
    .map((tool) => ({
      name: tool.name,
      description: typeof tool.description === "string" ? tool.description : "",
      inputSchema: tool.inputSchema && typeof tool.inputSchema === "object" ? tool.inputSchema : { type: "object", properties: {} }
    }));
}

function openStdio(server, { timeoutMs, spawnImpl }) {
  const args = Array.isArray(server.args) ? server.args.map(String) : [];
  // On Windows `npx` is a `.cmd` shim a bare spawn cannot execute; go through
  // the shell only for the known shims and only when the args are shell-safe.
  const useShell = process.platform === "win32" && isWindowsShim(server.command) && shellSafeArgs(args);
  const child = spawnImpl(server.command, args, {
    stdio: ["pipe", "pipe", "pipe"],
    shell: useShell,
    env: { ...process.env, ...(server.env || {}) }
  });

  let buffer = "";
  let stderrTail = "";
  let nextId = 0;
  let closed = false;
  const pending = new Map();

  const failAll = (error) => {
    for (const [, entry] of pending) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    pending.clear();
  };

  child.on("error", (error) => failAll(new Error(`无法启动：${error.message}`)));
  child.stderr.on("data", (chunk) => { stderrTail = `${stderrTail}${chunk}`.slice(-400); });
  child.on("exit", (code) => {
    closed = true;
    const last = stderrTail.trim().split("\n").pop() || "";
    failAll(new Error(`MCP 进程已退出（code ${code}）${last ? `：${last}` : ""}`));
  });
  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      const entry = pending.get(message.id);
      if (!entry) continue; // a notification or a stray line
      pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error) entry.reject(new Error(message.error.message || `JSON-RPC 错误 ${message.error.code}`));
      else entry.resolve(message.result);
    }
  });

  const request = (method, params) => new Promise((resolve, reject) => {
    if (closed) { reject(new Error("MCP 会话已关闭")); return; }
    nextId += 1;
    const id = nextId;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${Math.round(timeoutMs / 1000)}s 内未响应：${method}`));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    try {
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    } catch (error) {
      clearTimeout(timer);
      pending.delete(id);
      reject(error);
    }
  });

  const notify = (method, params) => {
    try { child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`); } catch {}
  };

  return { child, request, notify, close: () => { try { child.kill(); } catch {} } };
}

function openHttp(server, { timeoutMs, fetchImpl }) {
  let sessionId = "";
  let nextId = 0;
  const baseHeaders = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    ...(server.headers || {})
  };

  const readMessage = async (response) => {
    const text = await response.text().catch(() => "");
    if (!response.ok) {
      const auth = response.headers?.get?.("www-authenticate") || "";
      const reason = response.status === 401
        ? "认证失败（401）：请在「请求头」里填写 Authorization: Bearer <令牌>"
        : `HTTP ${response.status}`;
      throw new Error([reason, auth.slice(0, 180), text.trim().slice(0, 160)].filter(Boolean).join(" · "));
    }
    try { return JSON.parse(text); } catch {}
    for (const line of text.split(/\r?\n/)) {
      if (!line.startsWith("data:")) continue;
      try {
        const parsed = JSON.parse(line.slice(5).trim());
        if (parsed && (parsed.id !== undefined || parsed.result || parsed.error)) return parsed;
      } catch {}
    }
    throw new Error(`无法解析 MCP 响应（前 160 字）：${text.trim().slice(0, 160) || "(空)"}`);
  };

  const call = async (message) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const headers = { ...baseHeaders };
    if (sessionId) headers["mcp-session-id"] = sessionId;
    try {
      const response = await fetchImpl(server.url, {
        method: "POST",
        headers,
        body: JSON.stringify(message),
        signal: controller.signal,
        redirect: "manual"
      });
      return { response, message: await readMessage(response) };
    } finally {
      clearTimeout(timer);
    }
  };

  const request = async (method, params) => {
    nextId += 1;
    const { message } = await call({ jsonrpc: "2.0", id: nextId, method, params });
    if (message?.error) throw new Error(message.error.message || `JSON-RPC 错误 ${message.error.code}`);
    return message?.result;
  };

  const initialize = async () => {
    const { response, message } = await call({
      jsonrpc: "2.0", id: nextId + 1, method: "initialize", params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO }
    });
    nextId += 1;
    if (message?.error) throw new Error(`握手被拒绝：${message.error.message || message.error.code}`);
    sessionId = response.headers?.get?.("mcp-session-id") || "";
    await call({ jsonrpc: "2.0", method: "notifications/initialized" }).catch(() => {});
    return message?.result;
  };

  return { request, initialize, notify: () => {}, close: () => {} };
}

/**
 * Opens a session and returns the tool list plus a caller.
 *
 * `callTool` returns `{ ok, text, raw }`: MCP answers with a `content` array of
 * typed parts, and the model wants one string back — the text parts joined, an
 * error flagged when `isError` is set.
 */
export async function openMcpSession(server, { timeoutMs = 20_000, spawnImpl = spawn, fetchImpl = globalThis.fetch } = {}) {
  if (!server || (server.transport !== "http" && !server.command)) {
    throw new Error("MCP 服务器配置不完整");
  }

  const transport = server.transport === "http" ? openHttp(server, { timeoutMs, fetchImpl }) : openStdio(server, { timeoutMs, spawnImpl });

  try {
    if (server.transport === "http") {
      await transport.initialize();
      const listed = await transport.request("tools/list", {});
      return shape(server, transport, toTools(listed?.tools));
    }
    const hello = await transport.request("initialize", { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO });
    transport.notify("notifications/initialized", {});
    const listed = await transport.request("tools/list", {});
    return shape(server, transport, toTools(listed?.tools), hello);
  } catch (error) {
    transport.close();
    throw error;
  }
}

function shape(server, transport, tools, hello) {
  return {
    name: server.name,
    serverInfo: hello || {},
    tools,
    async callTool(name, args) {
      const result = await transport.request("tools/call", { name, arguments: args && typeof args === "object" ? args : {} });
      const parts = Array.isArray(result?.content) ? result.content : [];
      const text = parts
        .map((part) => {
          if (!part || typeof part !== "object") return "";
          if (typeof part.text === "string") return part.text;
          if (part.type === "resource" && part.resource) return part.resource.text || part.resource.uri || "";
          if (part.type === "image") return `[image ${part.mimeType || ""}]`.trim();
          return "";
        })
        .filter(Boolean)
        .join("\n");
      return { ok: result?.isError !== true, text: text || "(工具没有返回文本)", raw: result };
    },
    close: () => transport.close()
  };
}
