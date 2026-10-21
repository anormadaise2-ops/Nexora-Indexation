const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("nexora", {
  getState: () => ipcRenderer.invoke("browser:get-state"),
  newTab: url => ipcRenderer.invoke("browser:new-tab", url),
  switchTab: id => ipcRenderer.invoke("browser:switch-tab", id),
  closeTab: id => ipcRenderer.invoke("browser:close-tab", id),
  navigate: input => ipcRenderer.invoke("browser:navigate", input),
  action: action => ipcRenderer.invoke("browser:action", action),
  addBookmark: () => ipcRenderer.invoke("browser:add-bookmark"),
  setEngine: engine => ipcRenderer.invoke("browser:set-engine", engine),

  showBookmarks: () => ipcRenderer.send("browser:show-bookmarks"),
  showHistory: () => ipcRenderer.send("browser:show-history"),
  showSettings: () => ipcRenderer.send("browser:show-settings"),
  openDownloads: () => ipcRenderer.send("browser:open-downloads"),

  onState: callback => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on("browser:state", listener);
    return () => ipcRenderer.removeListener("browser:state", listener);
  },

  onNotice: callback => {
    const listener = (_event, message) => callback(message);
    ipcRenderer.on("browser:notice", listener);
    return () => ipcRenderer.removeListener("browser:notice", listener);
  },

  onFocusAddress: callback => {
    const listener = () => callback();
    ipcRenderer.on("browser:focus-address", listener);
    return () => ipcRenderer.removeListener("browser:focus-address", listener);
  }
});