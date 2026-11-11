'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('asistiaDesktop', Object.freeze({
  health: () => ipcRenderer.invoke('asistia:health'),
  openDataFolder: () => ipcRenderer.invoke('asistia:open-data-folder'),
  version: () => ipcRenderer.invoke('asistia:version'),
  installUpdate: (rawPackage) => ipcRenderer.invoke('asistia:install-update', rawPackage)
}));
