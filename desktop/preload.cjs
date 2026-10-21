const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("lane", {
  status: () => ipcRenderer.invoke("lane:status"),
  command: (command, options = {}) => ipcRenderer.invoke("lane:command", { command, ...options }),
  signIn: () => ipcRenderer.invoke("lane:signin"),
  signOut: () => ipcRenderer.invoke("lane:signout"),
  test: () => ipcRenderer.invoke("lane:test"),
  open: (target) => ipcRenderer.invoke("lane:open", target),
  openURL: (url) => ipcRenderer.invoke("lane:open-url", url),
  quit: () => ipcRenderer.invoke("lane:quit"),
  onSignIn: (callback) => {
    ipcRenderer.on("lane:signin", (_event, value) => callback(value));
  }
});
