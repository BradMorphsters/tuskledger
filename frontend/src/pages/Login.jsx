import { useState } from 'react'
import { ShieldCheck, KeyRound, Smartphone } from 'lucide-react'
import { login } from '../api/client'

export default function Login({ onAuthenticated }) {
  const [username, setUsername] = useState('operator')
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const [error, setError] = useState(null)
  const [submitting, setSubmitting] = useState(false)

  const handleSubmit = async (e) => {
    e.preventDefault()
    setError(null)
    setSubmitting(true)
    try {
      await login(username, password, code)
      onAuthenticated()
    } catch (err) {
      setError(err.message || 'Login failed')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="auth-screen">
      <div className="auth-card">
        <div className="auth-header">
          <ShieldCheck size={32} className="auth-icon" />
          <h1>Tusk Ledger</h1>
          <p className="auth-subtitle">
            Multi-factor authentication required
          </p>
        </div>

        <form onSubmit={handleSubmit} className="auth-form">
          <label className="auth-label">
            <span>Username</span>
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              required
            />
          </label>

          <label className="auth-label">
            <span>
              <KeyRound size={12} style={{ verticalAlign: 'middle', marginRight: 4 }} />
              Password
            </span>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              required
            />
          </label>

          <label className="auth-label">
            <span>
              <Smartphone size={12} style={{ verticalAlign: 'middle', marginRight: 4 }} />
              6-digit code from authenticator
            </span>
            <input
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              maxLength={6}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
              autoComplete="one-time-code"
              required
            />
          </label>

          {error && <div className="auth-error">{error}</div>}

          <button
            type="submit"
            className="auth-submit"
            disabled={submitting || !password || code.length !== 6}
          >
            {submitting ? 'Verifying…' : 'Sign in'}
          </button>
        </form>

        <div className="auth-footer">
          Protected by password and TOTP two-factor authentication.
        </div>
      </div>
    </div>
  )
}
