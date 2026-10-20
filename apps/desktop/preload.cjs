const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('rivetSetup', Object.freeze({
  config: () => ipcRenderer.invoke('rivet:config'),
  checkModel: value => ipcRenderer.invoke('rivet:check-model', value),
  open: value => ipcRenderer.invoke('rivet:open', value),
}));
