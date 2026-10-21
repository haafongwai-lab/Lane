import { app, BrowserWindow, Menu, Tray, dialog, ipcMain, shell } from "electron";
import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createControlCenter } from "../src/control-center.js";
import { createServer } from "../src/server.js";
import { WorkBuddyProvider } from "../src/workbuddy.js";
import { dataDir } from "../src/config.js";

const PORT = 3426;
const HOST = "127.0.0.1";
const GATEWAY = `http://${HOST}:${PORT}`;
const isSmokeTest = process.argv.includes("--smoke-test");
const startHidden = process.argv.includes("--hidden");
const DESKTOP_DIR = path.dirname(fileURLToPath(import.meta.url));

let window;
let tray;
let server;
let control;
let quitting = false;
let starting;
let ownsGateway = false;
let logStream;

app.setAppUserModelId("local.lane.control");
if (!isSmokeTest) {
  if (!app.requestSingleInstanceLock()) app.exit(0);
  app.on("second-instance", () => showWindow());
}

async function startGateway() {
  if (server?.listening) return;
  if (starting) return starting;
  starting = (async () => {
    let alreadyRunning = false;
    try {
      alreadyRunning = await healthy();
    } catch {}
    if (alreadyRunning) {
      control = createControlCenter({
        port: PORT,
        host: HOST,
        onSignIn: (result, error) => {
          window?.webContents.send("lane:signin", { result, error: error?.message || "" });
        }
      });
      return;
    }
    const provider = await new WorkBuddyProvider().init();
    await fs.mkdir(dataDir(), { recursive: true });
    logStream = await fs.open(path.join(dataDir(), "desktop.log"), "a");
    if (logStream) {
      const originalLog = console.log;
      const originalError = console.error;
      console.log = (...args) => {
        logStream.write(`${new Date().toISOString()} ${args.join(" ")}\n`).catch(() => {});
        originalLog(...args);
      };
      console.error = (...args) => {
        logStream.write(`${new Date().toISOString()} ERROR ${args.join(" ")}\n`).catch(() => {});
        originalError(...args);
      };
    }
    control = createControlCenter({
      port: PORT,
      host: HOST,
      onSignIn: (result, error) => {
        window?.webContents.send("lane:signin", { result, error: error?.message || "" });
      }
    });
    server = createServer({ provider, control });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(PORT, HOST, resolve);
    });
    await writePid();
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
  if (!server) return;
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(path.join(dataDir(), "lane.pid"), { force: true });
  server = null;
  control = null;
  ownsGateway = false;
}

async function healthy() {
  try {
    const response = await fetch(`${GATEWAY}/healthz`, { signal: AbortSignal.timeout(1200) });
    return response.ok;
  } catch {
    return false;
  }
}

async function writePid() {
  await fs.mkdir(dataDir(), { recursive: true });
  await fs.writeFile(path.join(dataDir(), "lane.pid"), String(process.pid));
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
          await stopGateway();
          app.quit();
        }
      }
    ]));
    tray.on("double-click", showWindow);
  } catch {}
}

ipcMain.handle("lane:status", async () => {
  if (!control) await startGateway();
  if (ownsGateway) {
    return {
      ...await control.status(),
      ownsGateway: true,
      executable: app.isPackaged ? process.execPath : ""
    };
  }
  return fetchExternalStatus();
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
ipcMain.handle("lane:signin", async () => {
  await startGateway();
  return control.signIn();
});
ipcMain.handle("lane:signout", async () => {
  await startGateway();
  return control.signOut();
});
ipcMain.handle("lane:open", async (_event, target) => {
  if (target === "data") return shell.openPath(dataDir());
  if (target === "log") {
    const file = ownsGateway ? path.join(dataDir(), "desktop.log") : path.join(dataDir(), "lane.log");
    return shell.openPath(file);
  }
  if (target === "models") return shell.openExternal(`${GATEWAY}/v1/models`);
  if (target === "error-log") return shell.openPath(path.join(dataDir(), "lane-error.log"));
  return "";
});
ipcMain.handle("lane:open-url", async (_event, url) => {
  if (/^https:\/\//.test(url)) await shell.openExternal(url);
});
ipcMain.handle("lane:test", async () => {
  await startGateway();
  const started = Date.now();
  try {
    const response = await fetch(`${GATEWAY}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "hy3",
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
  await stopGateway();
  app.quit();
});

app.whenReady().then(async () => {
  createWindow();
  try {
    await startGateway();
    createTray();
  } catch (error) {
    if (!isSmokeTest) {
      dialog.showErrorBox("Lane 无法启动", error?.stack || error?.message || String(error));
    }
  }
  if (isSmokeTest) {
    window.webContents.once("did-finish-load", async () => {
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
        for (const view of ["agents", "models", "settings"]) {
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
    });
  }
});

app.on("window-all-closed", () => {});
app.on("before-quit", () => { quitting = true; });
