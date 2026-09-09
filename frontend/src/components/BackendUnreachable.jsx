import { PlugZap, RefreshCw } from 'lucide-react'

/**
 * Shown when the frontend can't reach the Tusk Ledger backend.
 *
 * Why this screen exists: /api/auth/status answers 200 on a healthy backend
 * — it reports setup_required / authenticated in the BODY and never throws to
 * say "you're logged out". So any error from that call means the request
 * didn't reach our backend at all: the API isn't running, another app has
 * taken its port, or the Vite proxy points somewhere else.
 *
 * Before this screen, every one of those failures rendered the Login page.
 * That's a lie with a cost: it tells the operator their session expired,
 * sends them hunting for a password they may never have set (DEV_BYPASS_AUTH
 * users don't have one), and hides the actual cause — which is usually a
 * thirty-second port fix.
 */
export default function BackendUnreachable({ detail, onRetry }) {
  return (
    <div className="auth-screen">
      <div className="auth-card">
        <div className="auth-header">
          <PlugZap size={32} className="auth-icon" />
          <h1 className="auth-title">Can't reach the backend</h1>
          <p className="auth-subtitle">
            You are not logged out — the Tusk Ledger API just isn't answering.
          </p>
        </div>

        <div style={{ fontSize: 14, lineHeight: 1.6, marginTop: 8 }}>
          <p style={{ marginBottom: 12 }}>Most likely one of these:</p>
          <ul style={{ paddingLeft: 20, marginBottom: 16 }}>
            <li>The backend isn't running.</li>
            <li>
              Another app has taken its port, so <code>/api</code> requests are
              landing on a different server.
            </li>
          </ul>
          <p style={{ marginBottom: 8 }}>Check what's holding the port:</p>
          <pre
            style={{
              background: 'rgba(127,127,127,0.12)', padding: '10px 12px',
              borderRadius: 6, overflowX: 'auto', fontSize: 13, margin: 0,
            }}
          >lsof -nP -iTCP:8000 -sTCP:LISTEN</pre>
          <p style={{ marginTop: 12, marginBottom: 0 }}>
            Stop whatever that shows, then relaunch Tusk Ledger. To run both
            apps at once, start Tusk Ledger on another port with{' '}
            <code>TUSKLEDGER_PORT=8010</code> — the Vite proxy, Bonjour and the
            iOS pairing page all follow that variable.
          </p>
        </div>

        {detail && (
          <p style={{ marginTop: 16, fontSize: 12, opacity: 0.7 }}>
            Backend said: {detail}
          </p>
        )}

        <button
          className="btn btn-primary"
          style={{ marginTop: 20, display: 'inline-flex', alignItems: 'center', gap: 8 }}
          onClick={onRetry}
        >
          <RefreshCw size={16} /> Try again
        </button>
      </div>
    </div>
  )
}
