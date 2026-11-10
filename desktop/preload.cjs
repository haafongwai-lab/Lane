const { contextBridge, ipcRenderer } = require("electron");

// At most one sign-in listener per renderer: onSignIn used to stack a new
// ipcRenderer.on on every call, so one "lane:signin" event fired every
// registered callback (duplicate toasts and duplicate status refreshes).
let signInListener = null;

contextBridge.exposeInMainWorld("lane", {
  status: () => ipcRenderer.invoke("lane:status"),
  clearHistory: (ids) => ipcRenderer.invoke("lane:clear-history", { ids }),
  clearModel: (model, range) => ipcRenderer.invoke("lane:clear-model", { model, range }),
  command: (command, options = {}) => ipcRenderer.invoke("lane:command", { command, ...options }),
  signIn: (options) => ipcRenderer.invoke("lane:signin", options),
  account: (action, id, options = {}) => ipcRenderer.invoke("lane:account", { action, id, ...options }),
  checkin: (id) => ipcRenderer.invoke("lane:checkin", { id }),
  usage: (range) => ipcRenderer.invoke("lane:usage", { range }),
  checkinSettings: (patch) => ipcRenderer.invoke("lane:checkin-settings", patch),
  mcpList: () => ipcRenderer.invoke("lane:mcp"),
  mcpUpsert: (server) => ipcRenderer.invoke("lane:mcp", { server }),
  mcpRemove: (name) => ipcRenderer.invoke("lane:mcp-remove", { name }),
  mcpToggle: (name, off) => ipcRenderer.invoke("lane:mcp-toggle", { name, off }),
  mcpSetAgents: (name, agents) => ipcRenderer.invoke("lane:mcp-agents", { name, agents }),
  mcpTest: (name) => ipcRenderer.invoke("lane:mcp-test", { name }),
  skillsList: () => ipcRenderer.invoke("lane:skills"),
  skillsImport: (dir) => ipcRenderer.invoke("lane:skills-import", { dir }),
  skillsPickFolder: () => ipcRenderer.invoke("lane:skills-pick-folder"),
  skillsRemove: (name) => ipcRenderer.invoke("lane:skills-remove", { name }),
  skillsInstall: (name, agent) => ipcRenderer.invoke("lane:skills-install", { name, agent }),
  skillsUninstall: (name, agent) => ipcRenderer.invoke("lane:skills-uninstall", { name, agent }),
  setModel: (id, enabled, provider) => ipcRenderer.invoke("lane:set-model", { id, enabled, provider }),
  plugins: () => ipcRenderer.invoke("lane:plugins"),
  pluginCheck: () => ipcRenderer.invoke("lane:plugin-check"),
  pluginStage: (key) => ipcRenderer.invoke("lane:plugin-stage", { key }),
  pluginApply: (key) => ipcRenderer.invoke("lane:plugin-apply", { key }),
  pluginRollback: (key) => ipcRenderer.invoke("lane:plugin-rollback", { key }),
  gatewaySettings: () => ipcRenderer.invoke("lane:gateway-settings"),
  hideDsh: (hideDsh) => ipcRenderer.invoke("lane:hide-dsh", { hideDsh }),
  redactSettings: (patch) => ipcRenderer.invoke("lane:redact-settings", patch),
  saveGatewaySettings: (patch) => ipcRenderer.invoke("lane:save-gateway-settings", patch),
  setTheme: (mode) => ipcRenderer.invoke("lane:set-theme", { mode }),
  test: () => ipcRenderer.invoke("lane:test"),
  open: (target) => ipcRenderer.invoke("lane:open", target),
  openURL: (url) => ipcRenderer.invoke("lane:open-url", url),
  quit: () => ipcRenderer.invoke("lane:quit"),
  onSignIn: (callback) => {
    if (signInListener) ipcRenderer.removeListener("lane:signin", signInListener);
    signInListener = (_event, value) => callback(value);
    ipcRenderer.on("lane:signin", signInListener);
  },
  offSignIn: () => {
    if (!signInListener) return;
    ipcRenderer.removeListener("lane:signin", signInListener);
    signInListener = null;
  }
});
