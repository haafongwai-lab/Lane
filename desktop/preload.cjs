const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("lane", {
  status: () => ipcRenderer.invoke("lane:status"),
  clearHistory: (ids) => ipcRenderer.invoke("lane:clear-history", { ids }),
  command: (command, options = {}) => ipcRenderer.invoke("lane:command", { command, ...options }),
  signIn: (options) => ipcRenderer.invoke("lane:signin", options),
  account: (action, id, options = {}) => ipcRenderer.invoke("lane:account", { action, id, ...options }),
  checkin: (id) => ipcRenderer.invoke("lane:checkin", { id }),
  usage: (range) => ipcRenderer.invoke("lane:usage", { range }),
  checkinSettings: (patch) => ipcRenderer.invoke("lane:checkin-settings", patch),
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
