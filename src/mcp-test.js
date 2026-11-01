import { spawn } from "node:child_process";

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

export function testMcpServer(server, { timeoutMs = 30_000, spawnImpl = spawn } = {}) {
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
        // Windows only, and only once: a .cmd shim (npx) needs the shell.
        if (process.platform === "win32" && String(error?.code || "") === "ENOENT") {
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
