import { useState, type FormEvent } from 'react'
import { authenticate } from '../store'

export function Auth() {
  const [mode, setMode] = useState<'login' | 'register'>('login')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError('')
    try {
      await authenticate(mode, username.trim(), password)
    } catch (err) {
      setError((err as Error).message)
      setBusy(false)
    }
  }

  const login = mode === 'login'
  return (
    <div className="auth">
      <form onSubmit={submit}>
        <div>
          <h1>{login ? 'Bem-vindo de volta' : 'Criar conta'}</h1>
          <p>{login ? 'Entre para ver seus grupos.' : 'Leva dez segundos.'}</p>
        </div>
        <input className="input" placeholder="Usuário" autoComplete="username" autoFocus value={username} onChange={(e) => setUsername(e.target.value)} />
        <input
          className="input"
          type="password"
          placeholder="Senha"
          autoComplete={login ? 'current-password' : 'new-password'}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        {error && <div className="error">{error}</div>}
        <button className="btn" disabled={busy || !username || !password}>
          {login ? 'Entrar' : 'Criar conta'}
        </button>
        <div className="switch">
          {login ? 'Não tem conta? ' : 'Já tem conta? '}
          <button type="button" onClick={() => (setMode(login ? 'register' : 'login'), setError(''))}>
            {login ? 'Cadastre-se' : 'Entrar'}
          </button>
        </div>
      </form>
    </div>
  )
}
