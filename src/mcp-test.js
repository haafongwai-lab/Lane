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
 */

export function testMcpServer(server, { timeoutMs = 30_000, spawnImpl = spawn } = {}) {
  return new Promise((resolve) => {
    const finish = (result) => {
      clearTimeout(timer);
      try { child?.kill(); } catch {}
      resolve(result);
    };

    let child = null;
    const timer = setTimeout(() => {
      finish({ ok: false, error: `${Math.round(timeoutMs / 1000)}s 内未完成握手（已终止）`, phases: phases.slice() });
    }, timeoutMs);

    const phases = [];
    const args = server.transport === "stdio" ? server.args || [] : [];
    try {
      child = spawnImpl(server.command, args, { stdio: ["pipe", "pipe", "pipe"] });
    } catch (error) {
      finish({ ok: false, error: `无法启动：${error.message}`, phases });
      return;
    }

    let buffer = "";
    let stderrTail = "";
    let settled = false;
    const settle = (result) => {
      if (settled) return;
      settled = true;
      finish(result);
    };

    child.on("error", (error) => {
      settle({ ok: false, error: `无法启动：${error.message}`, phases: phases.slice() });
    });
    child.stderr.on("data", (chunk) => {
      stderrTail = `${stderrTail}${chunk}`.slice(-400);
    });
    child.on("exit", (code) => {
      if (settled) return;
      const last = stderrTail.trim().split("\n").pop() || "";
      settle({
        ok: false,
        error: `进程已退出（code ${code}）${last ? `：${last}` : ""}`,
        phases: phases.slice()
      });
    });

    child.stdout.on("data", (chunk) => {
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
          continue; // servers may log non-JSON lines on stdout's neighbour; only JSON-RPC counts
        }
        if (message.id === 1) {
          phases.push(`握手成功：${message.result?.serverInfo?.name || "?"} ${message.result?.serverInfo?.version || ""}`.trim());
          child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
          child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })}\n`);
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

    child.stdin.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "lane", version: "1.0.0" }
      }
    })}\n`);
  });
}
