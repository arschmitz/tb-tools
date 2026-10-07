const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("commandsBrowser", {
  action(action, tabId) {
    if (["back", "forward", "reload", "close", "select", "tab-menu"].includes(action)) {
      ipcRenderer.send("commands-browser-action", { action, tabId });
    }
  },
  onState(callback) {
    ipcRenderer.on("commands-browser-state", (_event, state) => callback(state));
  },
});
