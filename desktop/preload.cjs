'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('asistiaDesktop', Object.freeze({
  trialStatus: () => ipcRenderer.invoke('asistia:trial-status'),
  openActivationWhatsApp: () => ipcRenderer.invoke('asistia:open-activation-whatsapp'),
  health: () => ipcRenderer.invoke('asistia:health'),
  openDataFolder: () => ipcRenderer.invoke('asistia:open-data-folder'),
  version: () => ipcRenderer.invoke('asistia:version'),
  installUpdate: (rawPackage, legacyStorageData) => ipcRenderer.invoke('asistia:install-update', rawPackage, legacyStorageData),
  getLegacyStorage: () => ipcRenderer.invoke('asistia:legacy-storage'),
  provisionMobileAccess: employee => ipcRenderer.invoke('asistia:provision-mobile-access', employee),
  getMobileRecent: () => ipcRenderer.invoke('asistia:mobile-recent'),
  syncEmployees: employees => ipcRenderer.invoke('asistia:sync-employees', employees),
  getMobileSettings: branch => ipcRenderer.invoke('asistia:get-mobile-settings', branch),
  saveMobileSettings: settings => ipcRenderer.invoke('asistia:save-mobile-settings', settings),
  getMobileNetworkInfo: () => ipcRenderer.invoke('asistia:get-mobile-network-info'),
  getMobileConnectionInfo: () => ipcRenderer.invoke('asistia:get-mobile-connection-info'),
  openMobileCertificateFolder: () => ipcRenderer.invoke('asistia:open-mobile-certificate-folder')
}));
