"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("nexora", Object.freeze({
  getState: () => ipcRenderer.invoke("browser:get-state"),
  newTab: url => ipcRenderer.invoke("browser:new-tab", url),
  switchTab: id => ipcRenderer.invoke("browser:switch-tab", id),
  closeTab: id => ipcRenderer.invoke("browser:close-tab", id),
  navigate: input => ipcRenderer.invoke("browser:navigate", input),
  action: action => ipcRenderer.invoke("browser:action", action),
  addBookmark: () => ipcRenderer.invoke("browser:add-bookmark"),
  setEngine: engine => ipcRenderer.invoke("browser:set-engine", engine),

  openIndexer: () => ipcRenderer.invoke("indexer:open-window"),
  indexerStatus: base => ipcRenderer.invoke("indexer:status", base),
  indexerAddURL: (base, url) => ipcRenderer.invoke("indexer:add-url", base, url),
  indexerList: base => ipcRenderer.invoke("indexer:list", base),
  indexerSearch: (base, query) => ipcRenderer.invoke("indexer:search", base, query),
  indexerOpenURL: url => ipcRenderer.invoke("indexer:open-url", url),

  toggleShields: enabled => ipcRenderer.invoke("browser:toggle-shields", enabled),
  manageExtensions: () => ipcRenderer.invoke("browser:manage-extensions"),

  getDownloads: () => ipcRenderer.invoke("browser:get-downloads"),
  openDownloadFile: id => ipcRenderer.invoke("browser:open-download-file", id),
  cancelDownload: id => ipcRenderer.invoke("browser:cancel-download", id),
  openDownloadsFolder: () => ipcRenderer.send("browser:open-downloads-folder"),

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

  onDownloads: callback => {
    const listener = (_event, items) => callback(items);
    ipcRenderer.on("browser:downloads", listener);
    return () => ipcRenderer.removeListener("browser:downloads", listener);
  },

  onFocusAddress: callback => {
    const listener = () => callback();
    ipcRenderer.on("browser:focus-address", listener);
    return () => ipcRenderer.removeListener("browser:focus-address", listener);
  }
}));