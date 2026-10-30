// Ponte mínima entre a página e o app. A página do servidor recebe só o seletor
// de tela; a tela local de escolha do servidor recebe só current/connect.
const { contextBridge, ipcRenderer } = require('electron')

const info = ipcRenderer.sendSync('desktop:info')

if (location.protocol === 'file:') {
  contextBridge.exposeInMainWorld('setup', {
    current: () => ipcRenderer.invoke('server:current'),
    connect: (url) => ipcRenderer.invoke('server:connect', url),
  })
} else {
  contextBridge.exposeInMainWorld('discordia', {
    platform: info.platform,
    systemAudio: info.systemAudio,
    getSources: () => ipcRenderer.invoke('screen:sources'),
    selectSource: (id, audio) => ipcRenderer.invoke('screen:select', id, audio),
  })
}
