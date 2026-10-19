const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('asistiaSetup', Object.freeze({
  save: (settings) => ipcRenderer.invoke('asistia:setup', {
    companyName: String(settings && settings.companyName || ''),
    email: String(settings && settings.email || ''),
    password: String(settings && settings.password || '')
  })
}));
