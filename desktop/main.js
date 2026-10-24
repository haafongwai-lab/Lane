import { app, BrowserWindow, Menu, Tray, dialog, ipcMain, shell } from "electron";
import net from "node:net";
import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createControlCenter } from "../src/control-center.js";
import { createServer } from "../src/server.js";
import { WorkBuddyProvider } from "../src/workbuddy.js";
import { dataDir } from "../src/config.js";
import { claimOwnership, releaseOwnership } from "../src/owner.js";
import { readSettings, writeSettings } from "../src/settings.js";
import { readState } from "../src/agents/store.js";

const HOST = "127.0.0.1";
const isSmokeTest = process.argv.includes("--smoke-test");
const startHidden = process.argv.includes("--hidden");
const DESKTOP_DIR = path.dirname(fileURLToPath(import.meta.url));

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
    let alreadyRunning = false;
    try {
      alreadyRunning = await healthy();
    } catch {}
    if (alreadyRunning) {
      // Another Lane owns the gateway, so it also owns the daily check-in and
      // the journal; this window follows the journal's file as it changes.
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
      return;
    }
    // The health probe only sees a gateway on this address; a `lane serve`
    // on another port would be invisible to it and race this window for the
    // journal. The pid seat refuses that before anything is built.
    const seat = await claimOwnership();
    if (!seat.claimed) {
      throw new Error(
        `另一个 Lane 进程（pid ${seat.owner}）已拥有数据目录，请先退出它再启动`
      );
    }
    const provider = await new WorkBuddyProvider().init();
    await fs.mkdir(dataDir(), { recursive: true });
    if (!logStream) {
      logStream = await fs.open(path.join(dataDir(), "desktop.log"), "a");
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
      console.log = (...args) => {
        writeLine(`${new Date().toISOString()} ${args.join(" ")}\n`);
        originalLog(...args);
      };
      console.error = (...args) => {
        writeLine(`${new Date().toISOString()} ERROR ${args.join(" ")}\n`);
        originalError(...args);
      };
    }
    control = createControlCenter({
      port: PORT,
      host: HOST,
      checkins: true,
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
    const response = await fetch(`${GATEWAY}/lane/status`, { signal: AbortSignal.timeout(4000) });
    if (response.ok) return { ...await response.json(), ownsGateway: false };
  } catch {}
  // startGateway may still be bringing the server up; answer with a
  // neutral status rather than throwing "网关连接失败" at the UI.
  if (!control) {
    return {
      signedIn: false,
      account: "",
      domain: "",
      models: [],
      agents: {},
      recent: [],
      usage: null,
      starting: true,
      ownsGateway: false
    };
  }
  return { ...await control.status(), ownsGateway: false };
}

function showWindow() {
  if (!window) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

function createWindow() {
  window = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1040,
    minHeight: 680,
    backgroundColor: "#f4f3ef",
    title: "Lane",
    icon: path.join(DESKTOP_DIR, "assets", "lane.ico"),
    webPreferences: {
      preload: path.join(DESKTOP_DIR, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  Menu.setApplicationMenu(null);
  window.loadFile(path.join(DESKTOP_DIR, "index.html"));
  window.on("close", (event) => {
    if (!quitting) {
      event.preventDefault();
      window.hide();
    }
  });
  window.once("ready-to-show", () => {
    if (!startHidden) window.show();
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://")) shell.openExternal(url);
    return { action: "deny" };
  });
}

function createTray() {
  try {
    tray = new Tray(path.join(DESKTOP_DIR, "assets", "tray.ico"));
    tray.setToolTip("Lane · WorkBuddy 本地网关");
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
  } catch {}
}

ipcMain.handle("lane:status", async () => {
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
ipcMain.handle("lane:usage", async (_event, { range } = {}) => {
  await startGateway();
  return control.usage(range || "today");
});
ipcMain.handle("lane:clear-history", async () => {
  await startGateway();
  return control.clearHistory();
});
ipcMain.handle("lane:command", async (_event, { command, agent, enabled }) => {
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
ipcMain.handle("lane:signin", async (_event, options) => {
  await startGateway();
  return control.signIn({ site: options?.site });
});
// Account actions run against whichever Lane owns the gateway, so the list
// stays the same whether this window started it or joined one.
ipcMain.handle("lane:account", async (_event, { action, id, enabled }) => {
  await startGateway();
  if (action === "activate") return control.activate(id);
  if (action === "enabled") return control.setEnabled(id, Boolean(enabled));
  if (action === "remove") return control.removeAccount(id);
  throw new Error(`unknown account action: ${action}`);
});
ipcMain.handle("lane:checkin", async (_event, { id }) => {
  await startGateway();
  return control.checkin(id || "");
});
ipcMain.handle("lane:checkin-settings", async (_event, patch) => {
  await startGateway();
  return control.checkinSettings(patch || {});
});
ipcMain.handle("lane:gateway-settings", async () => {
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

ipcMain.handle("lane:save-gateway-settings", async (_event, patch) => {
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
  for (const agent of ["codex", "claude-desktop", "zcode"]) {
    try {
      // Only rewrite wirings that are on: an agent the user disconnected
      // must not be silently reconnected by a port save.
      if (!state[stateKey[agent]]?.connected) continue;
      const result = await control.connect(agent, { gateway: nextGateway });
      if (result?.connected !== false) rewritten.push(agent);
    } catch {}
  }
  // The autostart runner carries the old port in the node branch's --addr;
  // an installed autostart is rewritten with the new one so the next logon
  // starts the gateway where the settings say it will be.
  let autostartUpdated = false;
  if (await autostartOn().catch(() => false)) {
    try {
      await control.autostart(true, {
        ...(app.isPackaged ? { desktopExe: process.execPath } : {}),
        port: effectivePort
      });
      autostartUpdated = true;
    } catch {}
  }
  return {
    changed: true,
    port: effectivePort,
    host: HOST,
    rewritten,
    autostartUpdated,
    restartNeeded: ownsGateway
  };
});
ipcMain.handle("lane:open", async (_event, target) => {
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
ipcMain.handle("lane:open-url", async (_event, url) => {
  if (/^https:\/\//.test(url)) await shell.openExternal(url);
});
ipcMain.handle("lane:test", async () => {
  await startGateway();
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
ipcMain.handle("lane:view", async (_event, view) => {
  if (isSmokeTest && /^[a-z]+$/.test(view)) {
    await window.webContents.executeJavaScript(
      `document.querySelector('.nav[data-view="${view}"]')?.click()`
    );
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
});
ipcMain.handle("lane:quit", async () => {
  quitting = true;
  // A locked file during shutdown must not leave a windowless process
  // behind; the quit proceeds either way.
  await stopGateway().catch(() => {});
  app.quit();
});

app.whenReady().then(async () => {
  createWindow();
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
        const image = await window.webContents.capturePage();
        const previewDir = app.isPackaged
          ? path.join(dataDir(), "preview")
          : path.join(DESKTOP_DIR, "..", "dist");
        await fs.mkdir(previewDir, { recursive: true });
        await fs.writeFile(
          path.join(previewDir, "desktop-preview.png"),
          image.toPNG()
        );
        for (const view of ["agents", "accounts", "models", "settings"]) {
          await window.webContents.executeJavaScript(
            `document.querySelector('.nav[data-view="${view}"]')?.click()`
          );
          await new Promise((resolve) => setTimeout(resolve, 250));
          const viewImage = await window.webContents.capturePage();
          await fs.writeFile(
            path.join(previewDir, `desktop-${view}.png`),
            viewImage.toPNG()
          );
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
