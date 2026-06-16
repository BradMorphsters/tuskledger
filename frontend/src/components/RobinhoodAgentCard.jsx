/**
 * RobinhoodAgentCard — connect Tusk Ledger as the bound agent on the Robinhood agentic account.
 *
 * Clicking Connect runs the OAuth consent in your browser (password-free); the backend stores the
 * token encrypted and resolves the agentic account. It comes up READ-ONLY — connecting does NOT
 * arm live trading (that's a separate, deliberate env step). Use "Test read-only" to confirm the
 * connection reads your sleeve before you go further. Disconnect forgets the token.
 */
import { useEffect, useState, useCallback } from 'react'
import { Bot, CheckCircle, AlertCircle, Plug, PlugZap } from 'lucide-react'
import {
  getRobinhoodAgentStatus,
  connectRobinhoodAgent,
  pingRobinhoodAgent,
  disconnectRobinhoodAgent,
} from '../api/client'

const GREEN = 'var(--accent-green, #10b981)'
const RED = 'var(--accent-red, #ef4444)'
const BLUE = 'var(--accent-blue, #3b82f6)'

export default function RobinhoodAgentCard() {
  const [status, setStatus] = useState(null)
  const [busy, setBusy] = useState(null)     // 'connect' | 'ping' | 'disconnect'
  const [msg, setMsg] = useState(null)        // { tone, text }

  const load = useCallback(() => {
    getRobinhoodAgentStatus().then(setStatus).catch(() => setStatus({ connected: false }))
  }, [])
  useEffect(() => { load() }, [load])

  const run = async (fn, key, onOk) => {
    setBusy(key); setMsg(null)
    try { const r = await fn(); onOk?.(r) }
    catch (e) { setMsg({ tone: 'err', text: e.message || 'Failed' }) }
    finally { setBusy(null); load() }
  }

  const connected = status?.connected
  const armed = status?.armed

  return (
    <div className="card" style={{ marginBottom: 24, padding: 24 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
        <Bot size={22} style={{ color: BLUE }} />
        <h3 style={{ margin: 0 }}>Robinhood Agent (Tusk Ledger)</h3>
        <span style={{ marginLeft: 'auto', fontSize: 12.5, fontWeight: 600,
                       color: connected ? GREEN : 'var(--text-secondary)' }}>
          {connected ? `Connected · ${status.account || 'agentic'} · ${armed ? 'LIVE' : 'read-only'}` : 'Not connected'}
        </span>
      </div>

      <p style={{ color: 'var(--text-secondary)', fontSize: 13.5, margin: '0 0 16px', maxWidth: 620 }}>
        Authorize Tusk Ledger as the agent on your Robinhood Agentic account so it can read the
        sleeve and place orders <strong>you approve</strong>. Connect opens Robinhood's consent in
        your browser (password-free) and comes up <strong>read-only</strong> — it does not arm live
        trading. First disconnect Robinhood from Claude (one agent per account).
      </p>

      {!connected ? (
        <button className="btn btn-primary" disabled={busy === 'connect'}
          onClick={() => run(connectRobinhoodAgent, 'connect',
            (r) => setMsg(r?.connected ? { tone: 'ok', text: 'Connected.' } : { tone: 'err', text: 'Consent not completed.' }))}>
          <Plug size={16} /> {busy === 'connect' ? 'Opening Robinhood…' : 'Connect Robinhood Agent'}
        </button>
      ) : (
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <button className="btn" disabled={busy === 'ping'}
            onClick={() => run(pingRobinhoodAgent, 'ping',
              (r) => setMsg({ tone: 'ok', text: `Read-only OK — sleeve $${(r.sleeve_cash ?? 0).toLocaleString()} cash, ${r.sleeve_positions ?? 0} positions (agentic ${r.agentic_account_found ? 'found' : 'not found'}).` }))}>
            <PlugZap size={16} /> {busy === 'ping' ? 'Testing…' : 'Test read-only connection'}
          </button>
          <button className="btn" style={{ color: RED }} disabled={busy === 'disconnect'}
            onClick={() => run(disconnectRobinhoodAgent, 'disconnect', () => setMsg({ tone: 'ok', text: 'Disconnected.' }))}>
            Disconnect
          </button>
        </div>
      )}

      {busy === 'connect' && (
        <p style={{ marginTop: 12, color: BLUE, fontSize: 13 }}>
          A Robinhood window should have opened — approve there, then return here.
        </p>
      )}
      {msg && (
        <p style={{ marginTop: 12, fontSize: 13, display: 'flex', alignItems: 'center', gap: 6,
                    color: msg.tone === 'ok' ? GREEN : RED }}>
          {msg.tone === 'ok' ? <CheckCircle size={15} /> : <AlertCircle size={15} />}{msg.text}
        </p>
      )}
    </div>
  )
}
