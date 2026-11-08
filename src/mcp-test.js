import { spawn } from "node:child_process";
import path from "node:path";

const WINDOWS_SHELL_SHIMS = new Set(["npx", "npm", "pnpm", "yarn", "bun"]);

function isWindowsShim(command) {
  return WINDOWS_SHELL_SHIMS.has(path.basename(String(command || "")).toLowerCase().replace(/\.cmd$/i, ""));
}

function shellSafeArgs(args) {
  return (args || []).every((arg) => !/[&|<>^%!\r\n]/.test(String(arg)));
}

/**
 * A live connection test for a registered stdio MCP server.
 *
 * The extensions page's lamps say a configuration was *written*; they cannot
 * say the server *starts* — and the first deployment of 12306-mcp proved the
 * gap: the args were wrong, every client held a dead entry, and nothing in
 * the UI noticed. This speaks just enough MCP over stdio to know the server
 * is alive: spawn, initialize, initialized, tools/list. The tool names come
 * back, which also tells the user what they just wired up.
 *
 * Everything is bounded: a server that never speaks is killed after the
 * timeout, and one that exits early reports its last words on stderr, which
 * is where npm's "unknown config" and Windows' own spawn errors surface.
 *
 * The spawn mirrors what the clients do, and on Windows that means a shell.
 * `npx` there is a `.cmd` batch shim, which a bare spawn cannot execute — the
 * attempt fails with ENOENT, delivered asynchronously on the child's error
 * event, for a server the clients run fine because they go through cmd.exe.
 * So on Windows one ENOENT falls back to a shell-resolved attempt; a real
 * executable (an absolute python.exe, say) still starts directly.
 */

export function testMcpServer(server, { timeoutMs = 30_000, spawnImpl = spawn, fetchImpl = globalThis.fetch } = {}) {
  // A remote server has no command to spawn. The lamps only say a config was
  // written; this handshake says the URL, the headers and the token all work.
  if (server?.transport === "http") return testHttpMcpServer(server, { timeoutMs, fetchImpl });
  return new Promise((resolve) => {
    const phases = [];
    const args = server.transport === "stdio" ? server.args || [] : [];
    let timer = null;
    let child = null;
    let settled = false;

    const finish = (result) => {
      if (timer) clearTimeout(timer);
      try { child?.kill(); } catch {}
      resolve(result);
    };

    const settle = (result) => {
      if (settled) return;
      settled = true;
      finish(result);
    };

    timer = setTimeout(() => {
      settle({ ok: false, error: `${Math.round(timeoutMs / 1000)}s 内未完成握手（已终止）`, phases: phases.slice() });
    }, timeoutMs);

    const wire = (childProcess) => {
      let buffer = "";
      let stderrTail = "";
      childProcess.on("error", (error) => {
        // Windows only, and only for the known package-manager shims: a
        // `.cmd` file needs cmd.exe, but a plain missing command must stay a
        // clean failure instead of becoming an arbitrary shell invocation.
        if (process.platform === "win32"
          && String(error?.code || "") === "ENOENT"
          && isWindowsShim(server.command)
          && shellSafeArgs(args)) {
          phases.push("直接启动失败（.cmd 垫片需经 shell），改经 shell 启动");
          attempt(true);
          return;
        }
        settle({ ok: false, error: `无法启动：${error.message}`, phases: phases.slice() });
      });
      childProcess.stderr.on("data", (chunk) => {
        stderrTail = `${stderrTail}${chunk}`.slice(-400);
      });
      childProcess.on("exit", (code) => {
        if (settled) return;
        const last = stderrTail.trim().split("\n").pop() || "";
        settle({
          ok: false,
          error: `进程已退出（code ${code}）${last ? `：${last}` : ""}`,
          phases: phases.slice()
        });
      });
      childProcess.stdout.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        let index;
        while ((index = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, index).trim();
          buffer = buffer.slice(index + 1);
          if (!line) continue;
          let message;
          try {
            message = JSON.parse(line);
          } catch {
            continue; // only JSON-RPC lines count; servers may chatter elsewhere
          }
          if (message.id === 1) {
            phases.push(`握手成功：${message.result?.serverInfo?.name || "?"} ${message.result?.serverInfo?.version || ""}`.trim());
            childProcess.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
            childProcess.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })}\n`);
          } else if (message.id === 2) {
            if (message.error) {
              settle({ ok: false, error: `工具列表请求被拒绝：${message.error.message || message.error.code}`, phases: phases.slice() });
              return;
            }
            const tools = (message.result?.tools || []).map((tool) => tool.name);
            settle({ ok: true, serverInfo: message.result || {}, tools, phases: phases.slice() });
            return;
          }
        }
      });
      childProcess.stdin.write(`${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "lane", version: "1.0.0" }
        }
      })}\n`);
    };

    const attempt = (useShell) => {
      try {
        child = spawnImpl(server.command, args, { stdio: ["pipe", "pipe", "pipe"], shell: useShell });
      } catch (error) {
        settle({ ok: false, error: `无法启动：${error.message}`, phases: phases.slice() });
        return;
      }
      wire(child);
    };

    attempt(false);
  });
}

/**
 * The same handshake over streamable HTTP: initialize, initialized, tools/list.
 * GitHub's hosted MCP server is the reason this exists — a remote entry can
 * be deployed with a URL that is wrong, a token that is expired, or a header
 * that never made it into the config, and all three look identical until a
 * request is actually sent.
 *
 * Answers arrive either as a bare JSON object or as an SSE `data:` frame, and
 * the session id from initialize has to ride along on the two later calls.
 */
async function testHttpMcpServer(server, { timeoutMs, fetchImpl }) {
  const phases = [];
  const base = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    ...(server.headers || {})
  };

  const call = (message, sessionId) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const headers = { ...base };
    if (sessionId) headers["mcp-session-id"] = sessionId;
    return Promise.resolve(fetchImpl(server.url, {
      method: "POST",
      headers,
      body: JSON.stringify(message),
      signal: controller.signal,
      // Do not let a remote MCP endpoint turn a test into a hop to an
      // unrelated internal URL; the configured endpoint is the only target.
      redirect: "manual"
    })).finally(() => clearTimeout(timer));
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
    try {
      return JSON.parse(text);
    } catch {}
    // streamable HTTP may answer with an SSE frame instead of a JSON body.
    for (const line of text.split(/\r?\n/)) {
      if (!line.startsWith("data:")) continue;
      try {
        const parsed = JSON.parse(line.slice(5).trim());
        if (parsed && (parsed.id !== undefined || parsed.result || parsed.error)) return parsed;
      } catch {}
    }
    throw new Error(`无法解析响应（前 160 字）：${text.trim().slice(0, 160) || "(空)"}`);
  };

  try {
    const init = await call({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "lane", version: "1.0.0" }
      }
    }, "");
    const hello = await readMessage(init);
    if (hello?.error) throw new Error(`握手被拒绝：${hello.error.message || hello.error.code}`);
    phases.push(`握手成功：${hello?.result?.serverInfo?.name || "?"} ${hello?.result?.serverInfo?.version || ""}`.trim());

    const sessionId = init.headers?.get?.("mcp-session-id") || "";
    // A notification has no reply worth reading; a 202 with an empty body is
    // normal, and a transport error here must not hide the tool list.
    await call({ jsonrpc: "2.0", method: "notifications/initialized" }, sessionId).catch(() => {});

    const listed = await call({ jsonrpc: "2.0", id: 2, method: "tools/list" }, sessionId);
    const reply = await readMessage(listed);
    if (reply?.error) throw new Error(`工具列表请求被拒绝：${reply.error.message || reply.error.code}`);
    const tools = (reply?.result?.tools || []).map((tool) => tool.name);
    return { ok: true, serverInfo: reply?.result || {}, tools, phases };
  } catch (error) {
    const message = error?.name === "AbortError"
      ? `${Math.round(timeoutMs / 1000)}s 内未完成握手（已终止）`
      : error?.message || String(error);
    return { ok: false, error: message, phases };
  }
}
