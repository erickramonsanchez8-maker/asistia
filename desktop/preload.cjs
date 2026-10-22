const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('asistiaSetup', Object.freeze({
  save: (settings) => ipcRenderer.invoke('asistia:setup', {
    companyName: String(settings && settings.companyName || ''),
    email: String(settings && settings.email || ''),
    password: String(settings && settings.password || '')
  })
}));

contextBridge.exposeInMainWorld('asistiaRecovery', Object.freeze({
  reset: (input) => ipcRenderer.invoke('asistia:recovery-reset', {
    email: String(input && input.email || ''),
    code: String(input && input.code || ''),
    password: String(input && input.password || '')
  }),
  back: () => ipcRenderer.invoke('asistia:recovery-back')
}));
