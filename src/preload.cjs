const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('tv', {
  get: () => ipcRenderer.invoke('app:get'),
  addFiles: paths => ipcRenderer.invoke('drop:add', paths),
  pause: () => ipcRenderer.invoke('drop:pause'),
  resume: () => ipcRenderer.invoke('drop:resume'),
  stop: () => ipcRenderer.invoke('drop:stop'),
  choose: () => ipcRenderer.invoke('drop:choose'),
  saveTv: input => ipcRenderer.invoke('settings:tv', input),
  openShuffler: () => ipcRenderer.invoke('shuffler:open'),
  chooseShuffler: kind => ipcRenderer.invoke('shuffler:choose', kind),
  buildShuffler: () => ipcRenderer.invoke('shuffler:build'),
  pathFor(file) { try { return webUtils.getPathForFile(file); } catch { return ''; } },
  onState: listener => ipcRenderer.on('drop:state', (_event, state) => listener(state)),
  onMode: listener => ipcRenderer.on('app:mode', (_event, mode) => listener(mode)),
  onError: listener => ipcRenderer.on('app:error', (_event, message) => listener(message)),
});
