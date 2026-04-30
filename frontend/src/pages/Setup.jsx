import { useState } from 'react'
import { ShieldCheck, QrCode, Copy, Check } from 'lucide-react'
import { setupStart, setupVerify } from '../api/client'

export default function Setup({ onAuthenticated }) {
  const [step, setStep] = useState('credentials') // credentials | enroll | verify
  const [username, setUsername] = useState('operator')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [qr, setQr] = useState(null)
  const [secret, setSecret] = useState(null)
  const [code, setCode] = useState('')
  const [error, setError] = useState(null)
  const [submitting, setSubmitting] = useState(false)
  const [copied, setCopied] = useState(false)

  const startEnrollment = async (e) => {
    e.preventDefault()
    setError(null)
    if (password.length < 8) {
      setError('Password must be at least 8 characters.')
      return
    }
    if (password !== confirm) {
      setError('Passwords do not match.')
      return
    }
    setSubmitting(true)
    try {
      const res = await setupStart(username, password)
      setQr(res.qr_code)
      setSecret(res.secret)
      setStep('enroll')
    } catch (err) {
      setError(err.message || 'Setup failed')
    } finally {
      setSubmitting(false)
    }
  }

  const verifyCode = async (e) => {
    e.preventDefault()
    setError(null)
    setSubmitting(true)
    try {
      await setupVerify(code)
      onAuthenticated()
    } catch (err) {
      setError(err.message || 'Verification failed')
    } finally {
      setSubmitting(false)
    }
  }

  const copySecret = async () => {
    try {
      await navigator.clipboard.writeText(secret)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch (_) {}
  }

  return (
    <div className="auth-screen">
      <div className="auth-card auth-card-wide">
        <div className="auth-header">
          <ShieldCheck size={32} className="auth-icon" />
          <h1>Welcome to Tusk Ledger</h1>
          <p className="auth-subtitle">
            Let&apos;s secure your dashboard with a password and two-factor authentication.
          </p>
        </div>

        {step === 'credentials' && (
          <form onSubmit={startEnrollment} className="auth-form">
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
              <span>Password (8+ characters)</span>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                minLength={8}
                autoComplete="new-password"
                required
              />
            </label>

            <label className="auth-label">
              <span>Confirm password</span>
              <input
                type="password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                autoComplete="new-password"
                required
              />
            </label>

            {error && <div className="auth-error">{error}</div>}

            <button
              type="submit"
              className="auth-submit"
              disabled={submitting}
            >
              {submitting ? 'Creating…' : 'Continue'}
            </button>
          </form>
        )}

        {step === 'enroll' && (
          <div className="enroll-step">
            <h3 className="enroll-title">
              <QrCode size={18} style={{ verticalAlign: 'middle', marginRight: 8 }} />
              Scan with your authenticator app
            </h3>
            <p className="enroll-hint">
              Use Google Authenticator, Authy, 1Password, or any TOTP app.
              Scan the QR code, then enter the 6-digit code the app shows.
            </p>

            <div className="qr-container">
              <img src={qr} alt="TOTP QR code" className="qr-image" />
            </div>

            <details className="manual-secret">
              <summary>Can&apos;t scan? Enter manually.</summary>
              <div className="secret-row">
                <code>{secret}</code>
                <button type="button" onClick={copySecret} className="secret-copy">
                  {copied ? <Check size={14} /> : <Copy size={14} />}
                  {copied ? 'Copied' : 'Copy'}
                </button>
              </div>
            </details>

            <button
              type="button"
              className="auth-submit"
              onClick={() => setStep('verify')}
            >
              I&apos;ve added Tusk Ledger to my authenticator
            </button>
          </div>
        )}

        {step === 'verify' && (
          <form onSubmit={verifyCode} className="auth-form">
            <label className="auth-label">
              <span>Enter the 6-digit code from your authenticator</span>
              <input
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                maxLength={6}
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                autoComplete="one-time-code"
                required
                autoFocus
              />
            </label>

            {error && <div className="auth-error">{error}</div>}

            <button
              type="submit"
              className="auth-submit"
              disabled={submitting || code.length !== 6}
            >
              {submitting ? 'Verifying…' : 'Complete setup'}
            </button>

            <button
              type="button"
              className="auth-link"
              onClick={() => setStep('enroll')}
            >
              ← Back
            </button>
          </form>
        )}

        <div className="auth-footer">
          Credentials are stored locally on this machine only.
        </div>
      </div>
    </div>
  )
}
