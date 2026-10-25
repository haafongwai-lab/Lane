const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("lane", {
  status: () => ipcRenderer.invoke("lane:status"),
  clearHistory: (ids) => ipcRenderer.invoke("lane:clear-history", { ids }),
  clearProject: (project) => ipcRenderer.invoke("lane:clear-project", { project }),
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
  skillsList: () => ipcRenderer.invoke("lane:skills"),
  skillsImport: (dir) => ipcRenderer.invoke("lane:skills-import", { dir }),
  skillsPickFolder: () => ipcRenderer.invoke("lane:skills-pick-folder"),
  skillsRemove: (name) => ipcRenderer.invoke("lane:skills-remove", { name }),
  skillsInstall: (name, agent) => ipcRenderer.invoke("lane:skills-install", { name, agent }),
  skillsUninstall: (name, agent) => ipcRenderer.invoke("lane:skills-uninstall", { name, agent }),
  gatewaySettings: () => ipcRenderer.invoke("lane:gateway-settings"),
  saveGatewaySettings: (patch) => ipcRenderer.invoke("lane:save-gateway-settings", patch),
  test: () => ipcRenderer.invoke("lane:test"),
  open: (target) => ipcRenderer.invoke("lane:open", target),
  openURL: (url) => ipcRenderer.invoke("lane:open-url", url),
  quit: () => ipcRenderer.invoke("lane:quit"),
  onSignIn: (callback) => {
    ipcRenderer.on("lane:signin", (_event, value) => callback(value));
  }
});
