// Painel da chamada na barra de menu. JS puro: só redesenha quando o estado muda.

// Ícones do lucide (os mesmos do app), como marcação fixa.
const ICONS = {
  mic: '<path d="M12 19v3"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><rect x="9" y="2" width="6" height="13" rx="3"/>',
  micOff:
    '<path d="M12 19v3"/><path d="M15 9.34V5a3 3 0 0 0-5.68-1.33"/><path d="M16.95 16.95A7 7 0 0 1 5 12v-2"/><path d="M18.89 13.23A7 7 0 0 0 19 12v-2"/><path d="m2 2 20 20"/><path d="M9 9v3a3 3 0 0 0 5.12 2.12"/>',
  headphones: '<path d="M3 14h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7a9 9 0 0 1 18 0v7a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3"/>',
  headphoneOff:
    '<path d="M21 14h-1.343"/><path d="M9.128 3.47A9 9 0 0 1 21 12v3.343"/><path d="m2 2 20 20"/><path d="M20.414 20.414A2 2 0 0 1 19 21h-1a2 2 0 0 1-2-2v-3"/><path d="M3 14h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7a9 9 0 0 1 2.636-6.364"/>',
  video: '<path d="m16 13 5.223 3.482a.5.5 0 0 0 .777-.416V7.87a.5.5 0 0 0-.752-.432L16 10.5"/><rect x="2" y="6" width="14" height="12" rx="2"/>',
  videoOff:
    '<path d="M10.66 6H14a2 2 0 0 1 2 2v2.5l5.248-3.062A.5.5 0 0 1 22 7.87v8.196"/><path d="M16 16a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h2"/><path d="m2 2 20 20"/>',
  screen:
    '<path d="M13 3H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-3"/><path d="M8 21h8"/><path d="M12 17v4"/><path d="m17 8 5-5"/><path d="M17 3h5v5"/>',
  screenOff:
    '<path d="M13 3H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-3"/><path d="M8 21h8"/><path d="M12 17v4"/><path d="m22 3-5 5"/><path d="m17 3 5 5"/>',
  leave:
    '<path d="M10.1 13.9a14 14 0 0 0 3.732 2.668 1 1 0 0 0 1.213-.303l.355-.465A2 2 0 0 1 17 15h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2 18 18 0 0 1-12.728-5.272"/><path d="M22 2 2 22"/><path d="M4.76 13.582A18 18 0 0 1 2 4a2 2 0 0 1 2-2h3a2 2 0 0 1 2 2v3a2 2 0 0 1-.8 1.6l-.468.351a1 1 0 0 0-.292 1.233 14 14 0 0 0 .244.473"/>',
  app: '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="M10 4v4"/><path d="M2 8h20"/><path d="M6 4v4"/>',
}
const svg = (name) => `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[name]}</svg>`

// Mesma cor de avatar do app.
const HUES = [250, 200, 160, 30, 340, 280, 15, 190]

const $ = (id) => document.getElementById(id)
const send = (cmd) => window.tray.command(cmd)

function button(label, icon, cmd, cls = '', disabled = false) {
  const b = document.createElement('button')
  b.type = 'button'
  b.title = label
  b.setAttribute('aria-label', label)
  b.className = cls
  b.disabled = disabled
  b.innerHTML = svg(icon)
  b.onclick = () => send(cmd)
  return b
}

function render(c) {
  if (!c) return
  $('channel').textContent = c.channel
  $('group').textContent = c.group
  $('group').hidden = !c.group

  // Desmutar o microfone estando sem som também volta o som, como no app.
  $('controls').replaceChildren(
    button(c.muted ? 'Ativar microfone' : 'Desativar microfone', c.muted ? 'micOff' : 'mic', 'mute', c.muted ? 'off' : '', !c.hasMic),
    button(c.deafened ? 'Ativar som' : 'Desativar som', c.deafened ? 'headphoneOff' : 'headphones', 'deafen', c.deafened ? 'off' : ''),
    button(c.camera ? 'Desligar câmera' : 'Ligar câmera', c.camera ? 'video' : 'videoOff', 'camera', c.camera ? 'on' : ''),
    button(c.screen ? 'Parar de compartilhar' : 'Compartilhar tela', c.screen ? 'screenOff' : 'screen', 'screen', c.screen ? 'on' : ''),
    button('Sair da chamada', 'leave', 'leave', 'leave'),
  )

  $('people').replaceChildren(
    ...c.people.map((p) => {
      const li = document.createElement('li')
      const avatar = document.createElement('span')
      avatar.className = 'avatar'
      avatar.style.background = `hsl(${HUES[p.id % HUES.length]} 45% 52%)`
      avatar.textContent = p.name.slice(0, 1).toUpperCase()
      const name = document.createElement('span')
      name.className = 'name'
      name.textContent = p.name
      if (p.self) {
        const you = document.createElement('small')
        you.textContent = ' (você)'
        name.append(you)
      }
      const flags = document.createElement('span')
      flags.className = 'flags'
      const flag = (icon, title, off) => `<span title="${title}"${off ? ' class="off"' : ''}>${svg(icon)}</span>`
      flags.innerHTML = [
        p.screen && flag('screen', 'Compartilhando a tela'),
        p.camera && flag('video', 'Câmera ligada'),
        p.deafened ? flag('headphoneOff', 'Sem som', true) : p.muted && flag('micOff', 'Microfone desligado', true),
      ]
        .filter(Boolean)
        .join('')
      li.append(avatar, name, flags)
      return li
    }),
  )

  $('panel').hidden = false
  // A altura do conteúdo, não a da janela (que começa maior e nunca encolheria).
  window.tray.height($('panel').offsetHeight)
}

$('open').innerHTML = `${svg('app')}<span>Abrir o Discordia</span>`
$('open').onclick = () => send('open')
addEventListener('keydown', (e) => e.key === 'Escape' && send('close'))

window.tray.onState(render)
window.tray.ready().then(render)
