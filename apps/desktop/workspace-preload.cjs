const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('rivetDesktop', Object.freeze({
  openModelSettings: () => ipcRenderer.invoke('rivet:show-model-settings'),
}));
