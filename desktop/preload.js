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
    version: info.version,
    getSources: () => ipcRenderer.invoke('screen:sources'),
    selectSource: (id, audio) => ipcRenderer.invoke('screen:select', id, audio),
    // Ícone da chamada na barra de menu: a página manda o estado (null = fora da
    // chamada) e recebe os comandos clicados no menu.
    setCallState: (state) => ipcRenderer.send('call:state', state),
    onCallCommand: (cb) => {
      ipcRenderer.removeAllListeners('call:command')
      ipcRenderer.on('call:command', (_e, cmd) => cb(cmd))
    },
  })
}
