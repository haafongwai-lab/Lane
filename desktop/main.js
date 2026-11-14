import { app, BrowserWindow, Menu, Tray, dialog, ipcMain, nativeTheme, screen, shell } from "electron";
import net from "node:net";
import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createControlCenter } from "../src/control-center.js";
import { createServer } from "../src/server.js";
import { ProviderRouter } from "../src/provider-router.js";
import { dataDir } from "../src/config.js";
import { claimOwnership, releaseOwnership } from "../src/owner.js";
import { readSettings, writeSettings, writeSetting } from "../src/settings.js";
import { readState, restrictToOwner } from "../src/agents/store.js";
import { openableUrl } from "./openable.js";
import { openMcpSession } from "../src/mcp-session.js";
import { readServers } from "../src/mcp-servers.js";
import { readConsolePrefs, writeConsolePrefs } from "../src/console-prefs.js";
import { createLocalTools } from "../src/console-tools.js";
import { CONTROL_TOKEN_HEADER, ensureControlToken } from "../src/control-token.js";
import { redactForLog } from "../src/redact.js";

const HOST = "127.0.0.1";
const isSmokeTest = process.argv.includes("--smoke-test");
const startHidden = process.argv.includes("--hidden");
const DESKTOP_DIR = path.dirname(fileURLToPath(import.meta.url));
const RENDERER_FILE = path.resolve(DESKTOP_DIR, "index.html");

function isTrustedRenderer(event) {
  const value = event?.senderFrame?.url || event?.sender?.getURL?.() || "";
  try {
    const parsed = new URL(value);
    return parsed.protocol === "file:" && path.resolve(fileURLToPath(parsed)) === RENDERER_FILE;
  } catch {
    return false;
  }
}

// Every IPC handler is registered through this wrapper: a page that manages
// to navigate the BrowserWindow must not inherit the preload bridge.
function handleIpc(channel, listener) {
  ipcMain.handle(channel, (event, ...args) => {
    if (!isTrustedRenderer(event)) throw new Error("IPC request from an untrusted renderer");
    return listener(event, ...args);
  });
}

// The port is a setting: read before the gateway starts, written by the
// settings page. Cached here because every fetch in this file addresses it.
let PORT = 3426;
// Where PORT came from — an env override must not make "save this port" a
// no-op, or the setting never lands in settings.json.
let portSource = "default";
let GATEWAY = `http://${HOST}:${PORT}`;

let window;
let tray;
let server;
let control;
let quitting = false;
let starting;
let ownsGateway = false;
// Set once this window has attached itself to an external `lane serve`
// gateway. startGateway() runs for every IPC handler; without this the
// follower branch (which never assigns `server`) rebuilt `control` on each
// call, discarding sign-in dedup and usage caches without stopping the old
// instance. The port is kept so a settings change re-attaches, and the flag
// clears when the external gateway disappears so this window can take over.
let attached = null;
let logStream;
let consolePatched = false;
let lastStartError = "";

app.setAppUserModelId("local.lane.control");
if (!isSmokeTest) {
  if (!app.requestSingleInstanceLock()) app.exit(0);
  // A second launch that was itself started hidden (the autostart entry)
  // must not pop the window the first instance is keeping in the tray; a
  // second launch by hand — no --hidden — is a user asking for the window.
  app.on("second-instance", (_event, argv) => {
    if (quitting) return;
    if (!argv.includes("--hidden")) showWindow();
  });
}

async function startGateway() {
  if (server?.listening) return;
  if (starting) return starting;
  starting = (async () => {
    // The port comes from settings.json (or LANE_PORT) and must be known
    // before both the health probe and the listen call below.
    const settings = await readSettings().catch(() => ({ port: PORT }));
    PORT = settings.port;
    portSource = settings.source || "default";
    GATEWAY = `http://${HOST}:${PORT}`;
    // Warm the control-plane token cache so the first status poll carries it
    // instead of being refused once before the read lands.
    ensureControlToken().then((token) => { controlTokenCache = token; }).catch(() => {});
    let alreadyRunning = false;
    try {
      alreadyRunning = await healthy();
    } catch {}
    if (alreadyRunning) {
      // Another Lane owns the gateway, so it also owns the daily check-in and
      // the journal; this window follows the journal's file as it changes.
      // Reuse the follower control across IPC calls: rebuilding it drops the
      // per-site sign-in dedup and every cached usage read.
      if (attached?.port === PORT && control) return;
      if (control && !ownsGateway) await control.stop?.().catch(() => {});
      control = createControlCenter({
        port: PORT,
        host: HOST,
        checkins: false,
        shared: true,
        onSignIn: (result, error) => {
          // The plugin's authorize result holds a callback, which cannot cross
          // the IPC boundary; only the URL is any use to the window.
          window?.webContents.send("lane:signin", {
            result: result ? { url: result.url || "" } : null,
            error: error?.message || ""
          });
        }
      });
      attached = { port: PORT };
      ownsGateway = false;
      return;
    }
    // The external gateway is gone (or moved): drop the attachment so this
    // window can claim the seat and serve again instead of following a ghost.
    attached = null;
    // The health probe only sees a gateway on this address; a `lane serve`
    // on another port would be invisible to it and race this window for the
    // journal. The pid seat refuses that before anything is built.
    const seat = await claimOwnership();
    if (!seat.claimed) {
      throw new Error(
        `另一个 Lane 进程（pid ${seat.owner}）已拥有数据目录，请先退出它再启动`
      );
    }
    const provider = await new ProviderRouter().init();
    await fs.mkdir(dataDir(), { recursive: true });
    if (!logStream) {
      const logFile = path.join(dataDir(), "desktop.log");
      logStream = await fs.open(logFile, "a", 0o600);
      await restrictToOwner(logFile).catch(() => {});
    }
    if (!consolePatched) {
      // Patched once: a retry after a failed start used to wrap console
      // again, double-writing every line through the previous wrapper and
      // leaking the earlier file handle.
      consolePatched = true;
      const originalLog = console.log;
      const originalError = console.error;
      const writeLine = (line) => {
        const written = logStream?.write(line);
        if (written) written.catch(() => {});
      };
      // The file outlives any one call site, so the one-way mask runs here at
      // the sink: a future console.error that carries credentials cannot put
      // them on disk no matter which module printed them.
      console.log = (...args) => {
        writeLine(`${new Date().toISOString()} ${redactForLog(args.join(" "))}\n`);
        originalLog(...args);
      };
      console.error = (...args) => {
        writeLine(`${new Date().toISOString()} ERROR ${redactForLog(args.join(" "))}\n`);
        originalError(...args);
      };
    }
    control = createControlCenter({
      port: PORT,
      host: HOST,
      // A smoke run must stay read-only against the live account: the check-in
      // scheduler's first tick lands at 8s, inside the ~11s smoke window.
      checkins: !isSmokeTest,
      onSignIn: (result, error) => {
        window?.webContents.send("lane:signin", {
          result: result ? { url: result.url || "" } : null,
          error: error?.message || ""
        });
      }
    });
    server = createServer({ provider, control });
    try {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(PORT, HOST, resolve);
      });
    } catch (error) {
      // A start that failed after the control was built must not leave its
      // check-in scheduler running behind it, nor a stopped control that
      // lane:status would mistake for a live gateway and never retry.
      server = null;
      await control?.stop?.();
      control = null;
      throw error;
    }
    ownsGateway = true;
  })();
  try {
    await starting;
  } finally {
    starting = null;
  }
}

async function stopGateway() {
  await logStream?.close().catch(() => {});
  logStream = null;
  if (control) {
    // Stops the check-in scheduler and flushes the debounced journal before
    // the process goes. A locked pid file must not abort the quit.
    await control.stop?.().catch(() => {});
  }
  // The seat is ours from the moment the claim succeeded — even when the
  // listen call after it failed — so it is always released here.
  await releaseOwnership().catch(() => {});
  // The handles clear before the server wait: a shared window owns no
  // server, and before-quit only lets the quit through once `control` is
  // null — the early return below used to skip that clearing, and the quit
  // retried forever.
  const gateway = server;
  server = null;
  control = null;
  ownsGateway = false;
  attached = null;
  if (!gateway) return;
  await new Promise((resolve) => {
    // In-flight SSE streams would otherwise hold close() open until each
    // generation ends on its own; the gateway is stopping, so they go.
    gateway.closeAllConnections?.();
    gateway.close(resolve);
  });
}

async function healthy() {
  try {
    const response = await fetch(`${GATEWAY}/healthz`, { signal: AbortSignal.timeout(1200) });
    if (!response.ok) return false;
    // A 200 alone can be any local server that happens to answer /healthz;
    // only another Lane is one this window should follow.
    const body = await response.json().catch(() => ({}));
    return body?.name === "lane";
  } catch {
    return false;
  }
}

async function fetchExternalStatus() {
  try {
    const response = await fetch(`${GATEWAY}/lane/status`, {
      headers: controlHeaders(),
      signal: AbortSignal.timeout(4000)
    });
    if (response.ok) {
      const status = await response.json();
      // A follower can attach to an older `lane serve` whose status predates
      // the model gate. Merge the shapes here so the page still renders its
      // model rows (and shows the old gateway's all-enabled state) instead of
      // looking like an empty, broken catalogue.
      const models = Array.isArray(status.models) ? status.models : [];
      const catalogue = Array.isArray(status.catalogue) ? status.catalogue : models;
      const enabledKeys = Array.isArray(status.modelGate?.enabledKeys)
        ? status.modelGate.enabledKeys
        : models.map((model) => {
          const provider = model?.owned_by || model?.provider || "workbuddy";
          return `${provider}:${model?.id}`;
        });
      return {
        ...status,
        models,
        catalogue,
        modelGate: status.modelGate
          ? { ...status.modelGate, enabledKeys }
          : { gated: false, enabledIds: models.map((model) => model?.id), enabledKeys, corrupt: false },
        ownsGateway: false
      };
    }
  } catch {}
  // startGateway may still be bringing the server up; answer with a
  // neutral status rather than throwing "网关连接失败" at the UI.
  if (!control) {
    return {
      signedIn: false,
      account: "",
      domain: "",
      models: [],
      catalogue: [],
      modelGate: { gated: true, enabledIds: [], enabledKeys: [], corrupt: false },
      agents: {},
      recent: [],
      usage: null,
      starting: true,
      ownsGateway: false
    };
  }
  return { ...await control.status(), ownsGateway: false };
}

/**
 * A follower window owns no journal: control-center refuses every write with
 * "只读窗口不能…" so a second Lane cannot rewrite the owner's data behind its
 * back. The owner exposes those same operations over loopback, so writes go
 * there instead of being rejected. Reads stay local — the shared journal
 * follows the owner's file. The comment in control-center.js has always said
 * this is how a follower's clear request works; the forwarding was missing.
 */
// The control plane's local credential, read from the shared data directory.
// The gateway requires it on every /lane/* route; the file is owner-only, so
// another Windows session can read neither it nor this window's meaning.
function controlHeaders(extra = {}) {
  return { [CONTROL_TOKEN_HEADER]: readControlTokenSync(), ...extra };
}

// A cached read: the token file only changes when it is re-created, and the
// status poll runs every few seconds — the sync read keeps the callers
// synchronous-shaped without a token fetch on every tick.
let controlTokenCache;
function readControlTokenSync() {
  if (controlTokenCache === undefined) {
    // The async read lands on the next tick; the first poll may go out
    // without a token and be refused, which the caller already treats as
    // "gateway not ready".
    ensureControlToken().then((token) => { controlTokenCache = token; }).catch(() => { controlTokenCache = null; });
    controlTokenCache = null;
  }
  return controlTokenCache;
}

async function ownerWrite(pathname, body, { timeoutMs = 15_000 } = {}) {
  const response = await fetch(`${GATEWAY}${pathname}`, {
    method: "POST",
    headers: controlHeaders({ "content-type": "application/json" }),
    body: JSON.stringify(body || {}),
    signal: AbortSignal.timeout(timeoutMs)
  });
  const text = await response.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch {}
  if (!response.ok) {
    const detail = payload?.error?.message || payload?.error || text || `HTTP ${response.status}`;
    throw new Error(typeof detail === "string" ? detail : JSON.stringify(detail));
  }
  return payload;
}

/** Owned windows act locally; followers forward to the gateway they follow. */
function controlWrite(pathname, body, local, timeoutMs) {
  return ownsGateway ? local() : ownerWrite(pathname, body, { timeoutMs });
}

function showWindow() {
  if (!window) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

/**
 * The window chrome palette: the titlebar and the desk are the same colour,
 * so the window reads as one surface from its top edge down.
 * @returns {{ color: string, symbolColor: string }} fill and button-ink.
 */
function chromeColors() {
  return nativeTheme.shouldUseDarkColors
    ? { color: "#151517", symbolColor: "#f9fafb" }
    : { color: "#f2f1ed", symbolColor: "#0f1115" };
}

// The titlebar's height in CSS pixels. The stylesheet reserves the same strip
// at the top of the page (--titlebar-h) so nothing hides under the buttons.
const TITLEBAR_HEIGHT = 40;

function createWindow() {
  const chrome = chromeColors();
  window = new BrowserWindow({
    // The size it opens at before maximizing: a sensible restore size for a
    // user who un-maximizes, and the fallback on a display too small to
    // maximize into usefully.
    width: 1440,
    height: 920,
    minWidth: 1040,
    minHeight: 680,
    backgroundColor: chrome.color,
    title: "Lane",
    icon: path.join(DESKTOP_DIR, "assets", "lane.ico"),
    // Frameless: the page draws the window's own titlebar strip and its three
    // buttons (see .titlebar in styles.css). DSH's Windows build uses the OS
    // overlay for this, but that layer cannot be verified from a screenshot
    // and cannot be styled per element; drawing it ourselves makes the colour
    // exact and the buttons certain.
    ...(process.platform === "win32" ? { frame: false, thickFrame: true } : {}),
    webPreferences: {
      preload: path.join(DESKTOP_DIR, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  Menu.setApplicationMenu(null);
  // A fresh window starts at a normal size: the state and restore bounds
  // belong to this window, not to whatever was open before it.
  winMaximized = false;
  winRestoreBounds = null;
  // A frameless window's system maximise overruns the desktop by the invisible
  // resize border, so that path is closed: the titlebar button and a double-
  // click both go through maximizeToWorkArea(), and Win+Up / snap-to-top can
  // no longer land the window eight pixels past every edge.
  if (process.platform === "win32") window.setMaximizable(false);
  // Keep the tracked state honest if the window is still maximised by some
  // other route (a shell shortcut): the glyph follows the window.
  window.on("maximize", () => { winMaximized = true; });
  window.on("unmaximize", () => { winMaximized = false; });
  const sameRenderer = (value) => {
    try {
      const parsed = new URL(value);
      return parsed.protocol === "file:" && path.resolve(fileURLToPath(parsed)) === RENDERER_FILE;
    } catch {
      return false;
    }
  };
  // The app never needs to navigate away from its own file. If a future link,
  // redirect or injected page tries, close the hole before it can inherit the
  // preload IPC bridge. External URLs use the same allowlist as window.open.
  const blockNavigation = (event, url) => {
    if (sameRenderer(url)) return;
    event.preventDefault();
    const allowed = openableUrl(url);
    if (allowed) shell.openExternal(allowed);
  };
  window.webContents.on("will-navigate", blockNavigation);
  window.webContents.on("will-redirect", blockNavigation);
  window.webContents.on("will-attach-webview", (event) => event.preventDefault());
  // Tell the renderer which platform it is on before the stylesheet lays out:
  // the reserved titlebar strip exists only where the OS draws a titlebar.
  window.webContents.on("dom-ready", () => {
    window.webContents
      .executeJavaScript(`document.documentElement.dataset.platform = ${JSON.stringify(process.platform)}`)
      .catch(() => {});
  });
  window.loadFile(path.join(DESKTOP_DIR, "index.html"));
  window.on("close", (event) => {
    if (!quitting) {
      // Hiding is only safe when a tray can bring the window back. A failed
      // tray creation used to leave a hidden, unreachable process with no
      // 退出 menu and no double-click handler.
      if (!tray) {
        quitting = true;
        app.quit();
        return;
      }
      event.preventDefault();
      window.hide();
    }
  });
  // Open at the designed 1440x920 size. It is a normal resizable window:
  // maximizing is the user's choice, not something Lane forces on every start.
  window.once("ready-to-show", () => {
    if (startHidden) return;
    window.show();
  });
  // Windows can turn a drag-to-resize whose pointer reaches the top edge into
  // an Aero Snap maximize on release. That is not a user choosing Maximize;
  // keep the resize and undo the snap. A real Maximize button/gesture does not
  // fire will-resize, so it is still allowed.
  let resizing = false;
  let resizeEnd;
  window.on("will-resize", () => {
    resizing = true;
    clearTimeout(resizeEnd);
  });
  window.on("resized", () => {
    clearTimeout(resizeEnd);
    resizeEnd = setTimeout(() => {
      resizing = false;
    }, 200);
  });
  window.on("maximize", () => {
    if (resizing) window.unmaximize();
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    const allowed = openableUrl(url);
    if (allowed) shell.openExternal(allowed);
    return { action: "deny" };
  });
}

function createTray() {
  try {
    tray = new Tray(path.join(DESKTOP_DIR, "assets", "tray.ico"));
    tray.setToolTip("Lane · 本地网关");
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: "打开 Lane", click: showWindow },
      { type: "separator" },
      {
        label: "退出",
        click: async () => {
          quitting = true;
          await stopGateway().catch(() => {});
          app.quit();
        }
      }
    ]));
    tray.on("double-click", showWindow);
  } catch (error) {
    // A missing/corrupt icon or a session without a tray must not silently
    // remove the only way to reopen or quit a hidden window. createWindow's
    // close handler sees tray === null and quits instead of hiding.
    tray = null;
    console.error(`lane: could not create the tray: ${error?.message || error}`);
  }
}

handleIpc("lane:status", async () => {
  // A start that failed (port taken, data directory owned elsewhere) must
  // not reject the poll: the renderer swallows quiet errors, and the window
  // would sit on a stale "运行中" forever. fetchExternalStatus answers with
  // its neutral 启动中 payload when the control never came up. The poll
  // retries every 3 seconds, so only a change in the failure is logged.
  try {
    if (!control) await startGateway();
    lastStartError = "";
  } catch (error) {
    const message = error?.message || String(error);
    if (message !== lastStartError) {
      lastStartError = message;
      console.error(`lane: gateway start failed: ${message}`);
    }
  }
  // `version` is this app's own every time, not a followed gateway's: the
  // settings page reports the build the user installed. The external
  // gateway's /lane/status may name a different Lane.
  if (control && ownsGateway) {
    return {
      ...await control.status(),
      ownsGateway: true,
      version: app.getVersion(),
      executable: app.isPackaged ? process.execPath : ""
    };
  }
  return { ...await fetchExternalStatus(), version: app.getVersion() };
});
handleIpc("lane:usage", async (_event, { range, accountId } = {}) => {
  await startGateway();
  return control.usage(range || "today", typeof accountId === "string" ? accountId : "");
});
handleIpc("lane:set-model", async (_event, { id, enabled, provider } = {}) => {
  await startGateway();
  return control.setModelEnabled(id, Boolean(enabled), typeof provider === "string" ? provider : "");
});
handleIpc("lane:plugins", async () => {
  await startGateway();
  return control.plugins();
});
handleIpc("lane:plugin-check", async () => {
  await startGateway();
  return control.pluginCheck();
});
handleIpc("lane:plugin-stage", async (_event, { key } = {}) => {
  await startGateway();
  return control.pluginStage(String(key || ""));
});
handleIpc("lane:plugin-apply", async (_event, { key } = {}) => {
  await startGateway();
  return control.pluginApply(String(key || ""));
});
handleIpc("lane:plugin-rollback", async (_event, { key } = {}) => {
  await startGateway();
  return control.pluginRollback(String(key || ""));
});

// ---- Lane's own 问答 panel ------------------------------------------------
//
// The renderer cannot call the gateway itself: its CSP is default-src 'self',
// so a fetch to 127.0.0.1 is blocked. The main process makes the call instead -
// the same loopback request any client would make, with one marker header so
// the journal owes it its own source ("lane") and no agent's stats absorb it.
//
// MCP tools are opt-in (console.json). When on, the selected servers are opened
// once per question, their tools are offered to the model, and a returned
// tool_call is executed here and fed back. Every budget is enforced in this
// loop, not in the page: rounds, total tokens and wall-clock time - so a model
// that keeps asking for tools stops instead of spending the account.
const consoleControllers = new Map();
let consoleBusy = false;

// MCP tool names must be [A-Za-z0-9_-]{1,64} for the OpenAI schema; a server's
// own name and tool are folded into one and mapped back for the call.
function consoleToolName(serverName, toolName) {
  const cleaned = `${serverName}__${toolName}`.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
  return cleaned || "tool";
}

function roughTokens(text) {
  const s = String(text || "");
  const cjk = (s.match(/[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/g) || []).length;
  return Math.ceil(cjk + (s.length - cjk) / 4);
}

// Opens the selected servers and turns their tools into OpenAI tool defs.
// A server that fails to open is reported, never fatal: the question still runs.
async function openConsoleTools(prefs, emit) {
  const chosen = Array.isArray(prefs.mcpServers) ? prefs.mcpServers : [];
  const servers = (await readServers())
    .filter((server) => server && !server.off && chosen.includes(server.name));
  const defs = [];
  const byName = new Map();
  const sessions = [];
  for (const server of servers) {
    try {
      const session = await openMcpSession(server, { timeoutMs: 15_000 });
      sessions.push(session);
      for (const tool of session.tools) {
        let name = consoleToolName(server.name, tool.name);
        let n = 2;
        while (byName.has(name)) { name = consoleToolName(server.name, `${tool.name}_${n}`); n += 1; }
        byName.set(name, { session, tool: tool.name });
        defs.push({
          type: "function",
          function: {
            name,
            description: tool.description || `${server.name} / ${tool.name}`,
            parameters: tool.inputSchema || { type: "object", properties: {} }
          }
        });
      }
    } catch (error) {
      emit({ toolServers: { name: server.name, error: error?.message || String(error) } });
    }
  }
  return { defs, byName, sessions };
}

// SSE from the gateway: `data: {json}` lines, `[DONE]` to end. Collects the
// text, any reasoning, the finish reason, any usage block, and the tool calls
// the model asked for (arguments arrive as fragments keyed by index).
async function pumpConsoleStream(body, onDelta, signal) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let said = "";
  let reasoning = "";
  let finish = "";
  let usage = null;
  const calls = [];
  const handleFrame = (frame) => {
    for (const rawLine of frame.split("\n")) {
      const line = rawLine.replace(/\r$/, "");
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      let event;
      try { event = JSON.parse(payload); } catch { continue; }
      if (event.usage && typeof event.usage === "object") usage = event.usage;
      const choice = event?.choices?.[0];
      if (choice?.finish_reason) finish = String(choice.finish_reason);
      const delta = choice?.delta || {};
      if (Array.isArray(delta.tool_calls)) {
        for (const part of delta.tool_calls) {
          const index = Number.isInteger(part?.index) ? part.index : calls.length;
          const current = calls[index] || (calls[index] = { id: "", name: "", arguments: "" });
          if (part?.id) current.id = part.id;
          if (part?.function?.name) current.name += part.function.name;
          if (part?.function?.arguments) current.arguments += part.function.arguments;
        }
      }
      if (typeof delta.content === "string" && delta.content) {
        said += delta.content;
        onDelta({ text: delta.content });
      } else if (typeof delta.reasoning_content === "string" && delta.reasoning_content) {
        reasoning += delta.reasoning_content;
        onDelta({ reasoning: delta.reasoning_content });
      }
    }
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (value) buffer += decoder.decode(value, { stream: true });
    if (done) { buffer += decoder.decode(); break; }
    if (signal.aborted) break;
    buffer = buffer.replace(/\r\n/g, "\n");
    let cut;
    while ((cut = buffer.indexOf("\n\n")) >= 0) {
      handleFrame(buffer.slice(0, cut));
      buffer = buffer.slice(cut + 2);
    }
  }
  if (buffer.trim()) handleFrame(buffer.replace(/\r\n/g, "\n"));
  return { text: said, reasoning, finish, usage, calls: calls.filter((c) => c && (c.name || c.id)) };
}

function parseToolArgs(raw) {
  if (!raw || typeof raw !== "string") return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

handleIpc("lane:console-prefs", async (_event, { patch } = {}) => {
  await startGateway();
  if (patch && typeof patch === "object") return writeConsolePrefs(patch);
  return readConsolePrefs();
});

handleIpc("lane:console-chat", async (event, { id, model, messages, maxTokens } = {}) => {
  await startGateway();
  const sender = event.sender;
  const requestId = String(id || "");
  if (!requestId) throw new Error("missing request id");
  // One at a time. A second concurrent call would be exactly the pattern a
  // risk model treats as a script rather than a person.
  if (consoleBusy) return { ok: false, error: "上一条还在回答，请稍候" };
  consoleBusy = true;
  const controller = new AbortController();
  consoleControllers.set(requestId, controller);
  const emit = (payload) => {
    if (!sender.isDestroyed()) sender.send("lane:console-delta", { id: requestId, ...payload });
  };
  const prefs = await readConsolePrefs().catch(() => null);
  const rounds = prefs?.maxRounds || 6;
  const tokenBudget = prefs?.maxTokens || 131_072;
  const durationBudget = prefs?.maxDurationMs || 180_000;
  // A chat answer must not be cut short. 32768 output tokens leaves room for a
  // long answer while staying well under the models' context windows. A model
  // with a lower own ceiling refuses this before generating anything; the
  // max_tokens fallback below resends without the cap in that case.
  const cap = Math.min(Math.max(Number(maxTokens) || 131072, 256), 131072);
  const started = Date.now();

  // Reasoning and answer share one max_tokens, so a model that thinks a lot can
  // spend the whole budget before writing a word: finish_reason "length" with
  // an empty content field. Measured on deepseek-v4.1-flash: the default spent
  // 84 reasoning tokens, reasoning_effort "none" spent 0. The chosen level
  // rides on every request; the retry path can drop it for one attempt.
  const effort = prefs?.effort === undefined ? "" : String(prefs.effort || "");
  const send = (withCap, body, effortOverride) => {
    const level = effortOverride === undefined ? effort : effortOverride;
    return fetch(`${GATEWAY}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-lane-client": "lane" },
      body: JSON.stringify({
        model: model || undefined,
        ...body,
        ...(level ? { reasoning_effort: level } : {}),
        ...(withCap ? { max_tokens: cap } : {}),
        stream: true
      }),
      signal: controller.signal
    });
  };
  const failure = async (response) => {
    const text = await response.text().catch(() => "");
    let message = text;
    try { message = JSON.parse(text)?.error?.message || text; } catch {}
    return { ok: false, error: String(message || `HTTP ${response.status}`) };
  };

  let toolSet = { defs: [], byName: new Map(), sessions: [] };
  try {
    if (prefs?.mcpEnabled) toolSet = await openConsoleTools(prefs, emit);
    // Lane's own read-only tools ride along with whatever MCP offers. They are
    // local reads, so they cost nothing upstream and are on by default.
    const local = prefs?.localTools === false ? null : createLocalTools({ control, settings: () => readSettings() });
    if (local) {
      toolSet = { ...toolSet, defs: [...local.defs, ...toolSet.defs], local: local.impl };
    }
    const convo = Array.isArray(messages) ? messages.slice() : [];
    let text = "";
    // Budget accounting counts only what a round actually ADDED: the context is
    // re-sent every round, so summing each round's total billed the same prompt
    // again and again (five rounds of one question measured 49922 against a
    // 32000 budget while the new content was only ~26877). `prevInput` is the
    // previous round's prompt size; the delta plus this round's output is the
    // real growth.
    let prevInput = 0;
    let totalTokens = 0;
    let lastFinish = "";
    let stop = "";

    const growth = (usage, said) => {
      const input = Number(usage?.prompt_tokens);
      const output = Number(usage?.completion_tokens);
      if (Number.isFinite(input)) {
        const added = Math.max(0, input - prevInput);
        prevInput = input;
        return added + (Number.isFinite(output) ? output : roughTokens(said));
      }
      // No usage block: fall back to the text's own size, which is new content
      // by definition.
      return roughTokens(said);
    };

    for (let round = 1; round <= rounds; round += 1) {
      if (Date.now() - started > durationBudget) { stop = "time"; break; }
      const body = { messages: convo };
      if (toolSet.defs.length) { body.tools = toolSet.defs; body.tool_choice = "auto"; }
      let response = await send(true, body);
      if (!response.ok) {
        const raw = await response.text().catch(() => "");
        // A model whose own output ceiling is below `cap` refuses the whole
        // request with a max_tokens error before generating anything. Nothing
        // was produced, so resending once without the cap is not a replay of a
        // charge - it is the same question in a form the model accepts.
        if (/max_tokens|max output|maximum context/i.test(raw)) {
          response = await send(false, body);
          if (!response.ok) return failure(response);
        } else {
          let message = raw;
          try { message = JSON.parse(raw)?.error?.message || raw; } catch {}
          return { ok: false, error: String(message || `HTTP ${response.status}`) };
        }
      }
      let out = await pumpConsoleStream(response.body, emit, controller.signal);
      // Reasoning and answer share max_tokens. When the budget runs out while
      // the model is still thinking, the stream ends with finish_reason
      // "length" and no content at all, so the panel shows nothing. One retry
      // with reasoning switched off is the reliable cure: same request, no
      // thinking, so the whole budget is available for the answer.
      if (!out.text && !out.calls.length && out.finish === "length" && effort !== "none") {
        emit({ tool: { phase: "notice", text: "思考占满了输出预算，已关闭思考重试" } });
        const retry = await send(true, body, "none");
        if (retry.ok) {
          const second = await pumpConsoleStream(retry.body, emit, controller.signal);
          if (second.text || second.calls.length) out = second;
        }
      }
      // Keep the last thing the model actually said: a round that only asks for
      // a tool returns no text, and overwriting with that empty string threw
      // away words it had already produced.
      if (out.text) text = out.text;
      lastFinish = out.finish;
      totalTokens += growth(out.usage, out.text);

      if (out.calls.length) {
        // Record what the model asked for, then run each call in order.
        convo.push({
          role: "assistant",
          content: out.text || null,
          tool_calls: out.calls.map((call) => ({
            id: call.id || `call_${consoleToolName("t", call.name)}`,
            type: "function",
            function: { name: call.name, arguments: call.arguments || "{}" }
          }))
        });
        for (const call of out.calls) {
          const target = toolSet.byName.get(call.name);
          const args = parseToolArgs(call.arguments);
          const localTool = toolSet.local?.[call.name];
          const where = localTool ? "Lane 本地" : (target?.session?.name || "");
          emit({ tool: { phase: "start", name: call.name, server: where, args } });
          let result;
          try {
            if (localTool) {
              result = { ok: true, text: String(await localTool(args) || "") };
            } else if (target) {
              result = await target.session.callTool(target.tool, args);
            } else {
              result = { ok: false, text: `未知工具：${call.name}` };
            }
          } catch (error) {
            result = { ok: false, text: error?.message || String(error) };
          }
          emit({ tool: { phase: "end", name: call.name, server: where, ok: result.ok, text: String(result.text || "").slice(0, 400) } });
          convo.push({
            role: "tool",
            tool_call_id: call.id || `call_${consoleToolName("t", call.name)}`,
            content: String(result.text || "").slice(0, 8000)
          });
        }
        if (totalTokens > tokenBudget) { stop = "tokens"; break; }
        if (Date.now() - started > durationBudget) { stop = "time"; break; }
        continue;
      }
      return { ok: true, text, truncated: lastFinish === "length", rounds: round, meta: { model, tokens: totalTokens, prompt: prevInput, elapsedMs: Date.now() - started } };
    }

    if (!stop) stop = "rounds";

    // Every budget ended the loop the same unhelpful way: a bare return, with
    // whatever text happened to exist. One last round with NO tools offered
    // gives the model the chance to answer from what it already gathered - the
    // tool results are in `convo` - instead of the panel showing nothing but
    // "the model produced no text".
    if (convo.length && Date.now() - started < durationBudget) {
      try {
        const response = await send(true, { messages: convo });
        if (response.ok) {
          const final = await pumpConsoleStream(response.body, emit, controller.signal);
          if (final.text) text = final.text;
          if (final.finish) lastFinish = final.finish;
        }
      } catch {
        // The wrap-up is a courtesy: if it fails, the text so far still stands.
      }
    }
    return { ok: true, text, stopped: stop, rounds, truncated: lastFinish === "length", meta: { model, tokens: totalTokens, prompt: prevInput, elapsedMs: Date.now() - started } };
  } catch (error) {
    if (controller.signal.aborted) return { ok: false, cancelled: true, error: "已停止" };
    return { ok: false, error: error?.message || String(error) };
  } finally {
    for (const session of toolSet.sessions) { try { session.close(); } catch {} }
    consoleControllers.delete(requestId);
    consoleBusy = false;
  }
});

handleIpc("lane:console-cancel", async (_event, { id } = {}) => {
  const controller = consoleControllers.get(String(id || ""));
  if (controller) controller.abort();
  return { ok: true };
});

handleIpc("lane:clear-history", async (_event, { ids } = {}) => {
  await startGateway();
  const wanted = Array.isArray(ids) ? ids : null;
  // { removed } rather than the bare number: the renderer reads
  // result.removed, and a number's .removed is undefined - which turned
  // every successful delete's toast into "0 条" while the rows went.
  return controlWrite("/lane/activity/clear", { ids: wanted }, () => ({
    removed: control.clearHistory(wanted)
  }));
});
handleIpc("lane:clear-model", async (_event, { model, range } = {}) => {
  await startGateway();
  const wanted = String(model || "");
  const key = String(range || "today");
  return controlWrite("/lane/activity/clear-model", { model: wanted, range: key },
    () => control.clearModel(wanted, key));
});
handleIpc("lane:mcp", async (_event, { server } = {}) => {
  await startGateway();
  if (server) return controlWrite("/lane/mcp", server, () => control.mcpUpsert(server));
  return { servers: await control.mcpServers(), targets: await control.mcpTargets() };
});
handleIpc("lane:mcp-remove", async (_event, { name } = {}) => {
  await startGateway();
  const wanted = String(name || "");
  return controlWrite("/lane/mcp/remove", { name: wanted }, () => control.mcpRemove(wanted));
});
handleIpc("lane:mcp-toggle", async (_event, { name, off } = {}) => {
  await startGateway();
  const wanted = String(name || "");
  const state = Boolean(off);
  return controlWrite("/lane/mcp/toggle", { name: wanted, off: state }, () => control.mcpToggle(wanted, state));
});
handleIpc("lane:mcp-agents", async (_event, { name, agents } = {}) => {
  await startGateway();
  const wanted = String(name || "");
  const list = Array.isArray(agents) ? agents : [];
  return controlWrite("/lane/mcp/agents", { name: wanted, agents: list }, () => control.mcpSetAgents(wanted, list));
});
handleIpc("lane:mcp-test", async (_event, { name } = {}) => {
  await startGateway();
  const wanted = String(name || "");
  // A live spawn/HTTP handshake can take 30s; the local path has its own
  // timeout, so the forwarded one must not cut it short.
  return controlWrite("/lane/mcp/test", { name: wanted }, () => control.mcpTest(wanted), 40_000);
});
handleIpc("lane:skills", async () => {
  await startGateway();
  // The renderer reads result.skills, and the HTTP route /lane/skills wraps
  // the same list the same way. Returning the bare array here made a skill
  // that imported successfully still render as an empty library.
  return { skills: await control.skillsList() };
});
// The folder the picker most recently returned. The import IPC accepts only
// that path: without the check, a compromised renderer could hand any local
// folder straight to skillsImport and junction it into the agents' skill
// folders, bypassing the dialog the user is meant to have answered.
let lastPickedSkillFolder = null;

handleIpc("lane:skills-import", async (_event, { dir } = {}) => {
  await startGateway();
  const wanted = String(dir || "");
  if (!lastPickedSkillFolder || wanted !== lastPickedSkillFolder) {
    throw new Error("请先在文件夹选择对话框中选择要导入的技能文件夹");
  }
  return controlWrite("/lane/skills/import", { dir: wanted }, () => control.skillsImport(wanted));
});
handleIpc("lane:skills-pick-folder", async () => {
  const result = await dialog.showOpenDialog(window, {
    properties: ["openDirectory"],
    title: "选择技能文件夹"
  });
  if (result.canceled || !result.filePaths.length) return null;
  lastPickedSkillFolder = result.filePaths[0];
  return lastPickedSkillFolder;
});
handleIpc("lane:skills-remove", async (_event, { name } = {}) => {
  await startGateway();
  const wanted = String(name || "");
  return controlWrite("/lane/skills/remove", { name: wanted }, () => control.skillsRemove(wanted));
});
handleIpc("lane:skills-install", async (_event, { name, agent } = {}) => {
  await startGateway();
  const wanted = String(name || "");
  const target = String(agent || "");
  return controlWrite("/lane/skills/install", { name: wanted, agent: target }, () => control.skillsInstall(wanted, target));
});
handleIpc("lane:skills-uninstall", async (_event, { name, agent } = {}) => {
  await startGateway();
  const wanted = String(name || "");
  const target = String(agent || "");
  return controlWrite("/lane/skills/uninstall", { name: wanted, agent: target }, () => control.skillsUninstall(wanted, target));
});
handleIpc("lane:command", async (_event, { command, agent, enabled }) => {
  await startGateway();
  const targetControl = control;
  if (command === "connect" || command === "disconnect") return targetControl[command](agent);
  if (command === "autostart") {
    if (!ownsGateway && enabled) {
      throw new Error("请先关闭正在运行的 Lane 网关，再开启登录时启动");
    }
    return targetControl.autostart(enabled, app.isPackaged ? {
      desktopExe: process.execPath
    } : {});
  }
  throw new Error(`unknown command: ${command}`);
});
handleIpc("lane:signin", async (_event, options) => {
  await startGateway();
  return control.signIn({ site: options?.site });
});
// Account actions run against whichever Lane owns the gateway, so the list
// stays the same whether this window started it or joined one.
handleIpc("lane:account", async (_event, { action, id, enabled, routable }) => {
  await startGateway();
  if (action === "activate") return control.activate(id);
  if (action === "enabled") return control.setEnabled(id, Boolean(enabled));
  if (action === "routable") return control.setRoutable(id, Boolean(routable));
  if (action === "remove") return control.removeAccount(id);
  throw new Error(`unknown account action: ${action}`);
});
handleIpc("lane:checkin", async (_event, { id }) => {
  await startGateway();
  return control.checkin(id || "");
});
handleIpc("lane:checkin-settings", async (_event, patch) => {
  await startGateway();
  return control.checkinSettings(patch || {});
});
handleIpc("lane:gateway-settings", async () => {
  await startGateway();
  const settings = await readSettings();
  return { ...settings, portInUse: PORT, host: HOST };
});
async function autostartOn() {
  const startup = path.join(
    process.env.APPDATA || "",
    "Microsoft", "Windows", "Start Menu", "Programs", "Startup"
  );
  try {
    await Promise.any([
      fs.access(path.join(startup, "Lane Gateway.lnk")),
      fs.access(path.join(startup, "Lane.lnk"))
    ]);
    return true;
  } catch {
    return false;
  }
}

// The privacy switch is its own call: flipping it must not go through the
// port validation, and it takes effect on the next request without a restart.
handleIpc("lane:hide-dsh", async (_event, { hideDsh } = {}) => {
  await startGateway();
  const next = await writeSetting({ hideDsh: Boolean(hideDsh) });
  return { hideDsh: next.hideDsh !== false };
});
handleIpc("lane:redact-settings", async (_event, patch = {}) => {
  await startGateway();
  await writeSetting(patch);
  const saved = await readSettings();
  return {
    redactSecrets: saved.redactSecrets !== false,
    redactPersonal: saved.redactPersonal !== false,
    redactRules: saved.redactRules,
    redactAllowlist: saved.redactAllowlist,
    redactCustom: saved.redactCustom,
    egressMode: saved.egressMode,
    pluginAutoUpdate: saved.pluginAutoUpdate === true
  };
});

handleIpc("lane:save-gateway-settings", async (_event, patch) => {
  await startGateway();
  const port = Number(patch?.port);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error("端口需为 1024–65535 之间的整数");
  }
  // Only a port that both matches the running one and actually came from
  // settings.json needs no write: under a LANE_PORT override the same number
  // still has to be persisted, or it evaporates with the environment.
  if (port === PORT && portSource !== "env") return { changed: false, port: PORT, host: HOST };
  // Probe before saving: a port something else already listens on would
  // only fail at the next start, which reads as a broken gateway instead
  // of a bad setting.
  const busy = await new Promise((resolve) => {
    const probe = net.createServer();
    probe.once("error", () => resolve(true));
    probe.once("listening", () => probe.close(() => resolve(false)));
    probe.listen(port, HOST);
  });
  if (busy) throw new Error(`端口 ${port} 已被其他程序占用`);
  await writeSettings({ port });
  // The agent wirings carry the old address; rewrite the ones that are on
  // with the address the gateway will listen on after the restart. Calling
  // connect() without the override would stamp the port the control center
  // was built with — the old one — back into every config, and the three
  // clients would keep pointing at a port nothing listens on.
  // A LANE_PORT env override still wins after a restart, so the effective
  // port comes from readSettings, not from the value just saved.
  const afterSave = await readSettings().catch(() => ({ port, source: "saved" }));
  const effectivePort = afterSave.port;
  PORT = effectivePort;
  portSource = afterSave.source || "default";
  const nextGateway = `http://${HOST}:${effectivePort}`;
  const state = await readState().catch(() => ({}));
  const stateKey = { codex: "lane", "claude-desktop": "claude-desktop", zcode: "zcode" };
  const rewritten = [];
  const failures = [];
  for (const agent of ["codex", "claude-desktop", "zcode"]) {
    try {
      // Only rewrite wirings that are on: an agent the user disconnected
      // must not be silently reconnected by a port save.
      if (!state[stateKey[agent]]?.connected) continue;
      const result = await control.connect(agent, { gateway: nextGateway });
      if (result?.connected !== false) rewritten.push(agent);
      else failures.push({ agent, message: "客户端拒绝了新的接入地址" });
    } catch (error) {
      // The port is already saved above. Silently dropping a failed rewrite
      // left the client pointing at the old dead port while the UI reported
      // success; carry the failure back so the page can say so.
      failures.push({ agent, message: error?.message || String(error) });
    }
  }
  // The autostart runner carries the old port in the node branch's --addr;
  // an installed autostart is rewritten with the new one so the next logon
  // starts the gateway where the settings say it will be.
  let autostartUpdated = false;
  let autostartError = "";
  if (await autostartOn().catch(() => false)) {
    try {
      await control.autostart(true, {
        ...(app.isPackaged ? { desktopExe: process.execPath } : {}),
        port: effectivePort
      });
      autostartUpdated = true;
    } catch (error) {
      autostartError = error?.message || String(error);
    }
  }
  return {
    changed: true,
    port: effectivePort,
    host: HOST,
    rewritten,
    failures,
    autostartUpdated,
    autostartError,
    restartNeeded: ownsGateway
  };
});
// The page owns the theme preference (localStorage, read before first paint);
// the main process only mirrors it so Windows' title bar, menus and native
// scrollbars follow the same side. "system" keeps nativeTheme on the OS.
handleIpc("lane:set-theme", async (_event, { mode } = {}) => {
  const next = ["light", "dark", "system"].includes(mode) ? mode : "system";
  nativeTheme.themeSource = next;
  const dark = nativeTheme.shouldUseDarkColors;
  if (window) window.setBackgroundColor(dark ? "#151517" : "#f4f3ef");
  return { mode: next, dark };
});
handleIpc("lane:open", async (_event, target) => {
  if (target === "data") return shell.openPath(dataDir());
  if (target === "log") {
    // The owner writes desktop.log; a node runner writes lane.log. Either
    // window should open whichever of them exists.
    const laneLog = path.join(dataDir(), "lane.log");
    const hasLaneLog = await fs.access(laneLog).then(() => true, () => false);
    const file = ownsGateway || !hasLaneLog ? path.join(dataDir(), "desktop.log") : laneLog;
    return shell.openPath(file);
  }
  return "";
});
// The only pages Lane itself ever opens are the upstreams' sign-in hosts; the
// allowlist and its reasoning live in openable.js, where they can be tested
// without an Electron runtime.
handleIpc("lane:open-url", async (_event, url) => {
  const allowed = openableUrl(url);
  if (allowed) await shell.openExternal(allowed);
});
handleIpc("lane:test", async () => {
  await startGateway();
  // The smoke run clicks #test-route to exercise the renderer, not to spend a
  // live request on the user's account. A real /v1/responses here bills the
  // signed-in account every time CI opens the window.
  if (isSmokeTest) {
    return { ok: true, status: 200, elapsed: 0, text: "smoke test (upstream skipped)" };
  }
  // Ask the live catalogue which model to try: a fixed name would report a
  // broken link whenever the account's catalogue does not carry it.
  const model = await control.status()
    .then((status) => status.models?.[0]?.id || "")
    .catch(() => "");
  const started = Date.now();
  try {
    const response = await fetch(`${GATEWAY}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: model || undefined,
        input: "Reply with exactly LANE_OK",
        stream: false
      }),
      signal: AbortSignal.timeout(90000)
    });
    const body = await response.json();
    return {
      ok: response.ok,
      status: response.status,
      elapsed: Date.now() - started,
      text: body.output_text || body.error?.message || ""
    };
  } catch (error) {
    return { ok: false, status: 0, elapsed: Date.now() - started, text: error.message };
  }
});
handleIpc("lane:view", async (_event, view) => {
  if (isSmokeTest && /^[a-z]+$/.test(view)) {
    await window.webContents.executeJavaScript(
      `document.querySelector('.nav[data-view="${view}"]')?.click()`
    );
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
});
/**
 * The three buttons the frameless titlebar draws. Keeping this a small,
 * explicit set rather than exposing the whole BrowserWindow is what makes a
 * compromised renderer no worse than a compromised page: it can minimise,
 * maximise or close this one window, nothing else.
 */
// Maximise state is tracked here, not by the OS: the window is resized by
// hand (see maximizeToWorkArea) so it lands exactly on the work area instead
// of eight pixels past it.
let winMaximized = false;
let winRestoreBounds = null;

/**
 * Grow the window to the display's work area, keeping the size to restore to.
 * @returns true - the window is now maximised.
 */
function maximizeToWorkArea() {
  if (!window) return false;
  const from = window.getBounds();
  // Only remember a normal size: maximising twice must not make the restore
  // target the maximised bounds.
  if (!winMaximized) winRestoreBounds = from;
  const display = screen.getDisplayMatching(from);
  window.setBounds(display.workArea);
  winMaximized = true;
  return true;
}

/** Put the window back where it was before the last maximise. */
function restoreFromMaximize() {
  if (!window) return false;
  if (winRestoreBounds) window.setBounds(winRestoreBounds);
  winMaximized = false;
  return false;
}

handleIpc("lane:window-action", async (_event, action) => {
  if (!window) return { ok: false };
  if (action === "minimize") window.minimize();
  else if (action === "toggle-maximize") {
    if (winMaximized) restoreFromMaximize();
    else maximizeToWorkArea();
  } else if (action === "close") window.close();
  else return { ok: false, error: `unknown action: ${action}` };
  return { ok: true, maximized: winMaximized };
});

handleIpc("lane:window-state", async () => ({ maximized: winMaximized }));

handleIpc("lane:quit", async () => {
  quitting = true;
  // A locked file during shutdown must not leave a windowless process
  // behind; the quit proceeds either way.
  await stopGateway().catch(() => {});
  app.quit();
});

app.whenReady().then(async () => {
  createWindow();
  // The OS switching light/dark while the page follows "system" changes the
  // native chrome too; keep the window's own base colour in step.
  nativeTheme.on("updated", () => {
    if (!window) return;
    // The titlebar is page CSS and follows the theme attribute; only the
    // window's own backdrop needs telling, so the resize flash matches.
    window.setBackgroundColor(chromeColors().color);
  });
  // The tray exists before the gateway starts: a start that fails leaves a
  // window whose close button hides it, and without a tray the process
  // could only be killed from the task manager.
  createTray();
  try {
    await startGateway();
  } catch (error) {
    if (!isSmokeTest) {
      dialog.showErrorBox("Lane 无法启动", error?.stack || error?.message || String(error));
    }
  }
  if (isSmokeTest) {
    const runSmokeTest = async () => {
      await new Promise((resolve) => setTimeout(resolve, 1800));
      try {
        await window.webContents.executeJavaScript(
          `document.querySelector('#test-route')?.click()`
        );
        await new Promise((resolve) => setTimeout(resolve, 4500));
        if (window.isMinimized() || !window.isVisible()) window.show();
        window.focus();
        const previewDir = app.isPackaged
          ? path.join(dataDir(), "preview")
          : path.join(DESKTOP_DIR, "..", "dist");
        await fs.mkdir(previewDir, { recursive: true });
        // The previews are a side effect, not the assertion: a headless or
        // occluded desktop cannot capture a surface, and that must not take
        // the smoke run's own result down with it.
        const capture = async (name) => {
          try {
            // An occluded window or a sleeping display leaves the compositor
            // without a frame and capturePage answers "display surface not
            // available". Forcing a repaint with throttling off makes the
            // preview work in exactly those runs it exists for.
            window.webContents.setBackgroundThrottling(false);
            window.webContents.invalidate();
            await new Promise((resolve) => setTimeout(resolve, 150));
            const shot = await window.webContents.capturePage();
            await fs.writeFile(path.join(previewDir, name), shot.toPNG());
          } catch (error) {
            console.error(`preview ${name} skipped: ${error.message}`);
          }
        };
        await capture("desktop-preview.png");
        for (const view of ["agents", "accounts", "models", "settings", "activity"]) {
          await window.webContents.executeJavaScript(
            `document.querySelector('.nav[data-view="${view}"]')?.click()`
          );
          await new Promise((resolve) => setTimeout(resolve, 250));
          // The usage view's charts need a beat more, and its 15-day range
          // exercises the widest bar layout the page ever renders.
          if (view === "activity") {
            // The usage fetch and the bar grow-in both need a beat before
            // the widest layout is on screen.
            await new Promise((resolve) => setTimeout(resolve, 900));
            await window.webContents.executeJavaScript(
              `document.querySelector('#usage-range button[data-range="15d"]')?.click()`
            );
            await new Promise((resolve) => setTimeout(resolve, 1200));
          }
          await capture(`desktop-${view}.png`);
        }
        const status = await control.status();
        console.log(JSON.stringify({
          ok: Boolean(status),
          title: window.getTitle(),
          signedIn: status.signedIn,
          models: status.models.length
        }));
        quitting = true;
        await stopGateway();
        app.exit(0);
      } catch (error) {
        console.error(error);
        quitting = true;
        await stopGateway();
        app.exit(1);
      }
    };
    // startGateway above can outlive the page load: a listener attached
    // after did-finish-load has already fired would never run and hang the
    // test with a visible window, so load state decides how it is attached.
    if (window.webContents.isLoading()) {
      window.webContents.once("did-finish-load", runSmokeTest);
    } else {
      runSmokeTest();
    }
  }
});

app.on("window-all-closed", () => {});
app.on("before-quit", async (event) => {
  quitting = true;
  // Quits that do not go through the tray or lane:quit — Windows session
  // end, a quit asked from elsewhere — would skip the gateway stop and lose
  // the debounced journal tail. Quitting is held until the stop lands, then
  // re-issued; a stop that already ran (control gone) lets it through.
  if (!control) return;
  event.preventDefault();
  await stopGateway().catch(() => {});
  app.quit();
});
