const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('kaytvUpdater', {
  download: (payload) => ipcRenderer.invoke('updater:download', payload),
  install: () => ipcRenderer.invoke('updater:install'),
  onProgress: (callback) => {
    const listener = (_event, data) => callback(data)
    ipcRenderer.on('updater:progress', listener)
    return () => ipcRenderer.removeListener('updater:progress', listener)
  }
})
