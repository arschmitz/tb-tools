const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("commandsBrowser", {
  action(action, tabId) {
    if (["back", "forward", "reload", "open-browser", "close", "select",
      "window-close", "window-minimize", "window-maximize"].includes(action)) {
      ipcRenderer.send("commands-browser-action", { action, tabId });
    }
  },
  onState(callback) {
    ipcRenderer.on("commands-browser-state", (_event, state) => callback(state));
  },
});
