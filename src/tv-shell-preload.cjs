// What the TV home screen may ask of the TV shell: open YouTube, tune live TV.
const { contextBridge, ipcRenderer } = require('electron');

const config = ipcRenderer.sendSync('shell:config') || { live: [] };
contextBridge.exposeInMainWorld('ontoShell', {
  youtube: true,
  live: config.live,
  open: what => ipcRenderer.send('shell:open', String(what)),
  watchLive: lcn => ipcRenderer.send('shell:live', String(lcn)),
});
