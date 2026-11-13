'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('asistiaDesktop', Object.freeze({
  trialStatus: () => ipcRenderer.invoke('asistia:trial-status'),
  health: () => ipcRenderer.invoke('asistia:health'),
  openDataFolder: () => ipcRenderer.invoke('asistia:open-data-folder'),
  version: () => ipcRenderer.invoke('asistia:version'),
  installUpdate: (rawPackage, legacyStorageData) => ipcRenderer.invoke('asistia:install-update', rawPackage, legacyStorageData),
  getLegacyStorage: () => ipcRenderer.invoke('asistia:legacy-storage')
}));
