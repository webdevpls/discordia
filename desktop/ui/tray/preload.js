// Ponte do painel da barra de menu: recebe o estado da chamada e manda comandos.
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('tray', {
  ready: () => ipcRenderer.invoke('tray:ready'),
  onState: (cb) => ipcRenderer.on('tray:state', (_e, state) => cb(state)),
  command: (cmd) => ipcRenderer.send('tray:command', cmd),
  height: (px) => ipcRenderer.send('tray:height', px),
})
