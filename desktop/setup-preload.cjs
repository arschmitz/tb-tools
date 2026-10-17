const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("commandsSetup", {
  request(action, value) {
    if (!["prepare", "new", "status", "prerequisites", "existing", "folder", "start", "retry", "finish",
      "check-tools", "install-tools", "submission", "open-dashboard", "save-credentials", "skip-credentials", "phabricator-settings", "bugzilla-settings"].includes(action)) {
      return Promise.reject(new Error("Unknown setup action."));
    }
    return ipcRenderer.invoke("commands-setup", action, value);
  },
});
