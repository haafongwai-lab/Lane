const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("lane", {
  status: () => ipcRenderer.invoke("lane:status"),
  command: (command, options = {}) => ipcRenderer.invoke("lane:command", { command, ...options }),
  signIn: () => ipcRenderer.invoke("lane:signin"),
  account: (action, id, options = {}) => ipcRenderer.invoke("lane:account", { action, id, ...options }),
  checkin: (id) => ipcRenderer.invoke("lane:checkin", { id }),
  checkinSettings: (patch) => ipcRenderer.invoke("lane:checkin-settings", patch),
  test: () => ipcRenderer.invoke("lane:test"),
  open: (target) => ipcRenderer.invoke("lane:open", target),
  openURL: (url) => ipcRenderer.invoke("lane:open-url", url),
  quit: () => ipcRenderer.invoke("lane:quit"),
  onSignIn: (callback) => {
    ipcRenderer.on("lane:signin", (_event, value) => callback(value));
  }
});
