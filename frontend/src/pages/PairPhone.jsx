/**
 * PairPhone — laptop-side QR generator + paired-device list.
 *
 * The mobile app's first-run flow scans the QR shown on this page
 * (or types the 8-char code manually). The QR encodes a
 * tuskledger://pair?host=…&port=…&code=… deep link that the mobile
 * app's PairingScreen parses in one step.
 *
 * Paired devices are listed below so the user can revoke any token
 * that belongs to a phone they no longer trust (lost, sold,
 * "I don't remember pairing that one").
 *
 * Why this is a standalone page rather than a Settings tab: there
 * isn't a Settings page yet, and overloading another existing page
 * (Connect Accounts is closest in spirit) would mix two unrelated
 * concerns. Add it here, link from the sidebar, fold into a real
 * Settings page when one exists.
 */
import { useEffect, useState } from 'react'
import { Smartphone, RefreshCw, Trash2, Wifi, AlertTriangle } from 'lucide-react'

const API = '/api/mobile'

export default function PairPhone() {
  const [pair, setPair] = useState(null)
  const [pairing, setPairing] = useState(false)
  const [pairError, setPairError] = useState(null)
  const [devices, setDevices] = useState([])
  const [loadingDevices, setLoadingDevices] = useState(true)

  async function loadDevices() {
    setLoadingDevices(true)
    try {
      const res = await fetch(`${API}/devices`, { credentials: 'include' })
      if (res.ok) setDevices(await res.json())
    } finally {
      setLoadingDevices(false)
    }
  }

  useEffect(() => { loadDevices() }, [])

  async function startPair() {
    setPairing(true)
    setPairError(null)
    try {
      const res = await fetch(`${API}/pair/start`, {
        method: 'POST',
        credentials: 'include',
      })
      if (!res.ok) throw new Error(`pair/start failed: ${res.status}`)
      const body = await res.json()
      setPair(body)
    } catch (e) {
      setPairError(e.message || String(e))
    } finally {
      setPairing(false)
    }
  }

  async function revoke(id) {
    if (!window.confirm('Revoke this device? Its app will be signed out and prompted to re-pair.')) return
    const res = await fetch(`${API}/devices/${id}/revoke`, {
      method: 'POST',
      credentials: 'include',
    })
    if (res.ok) loadDevices()
  }

  // Auto-clear an expired code so the screen doesn't keep showing a
  // stale QR after the 5-minute window. Doesn't free the row server-
  // side — that happens lazily on the next claim attempt.
  useEffect(() => {
    if (!pair?.expires_at) return
    const ms = new Date(pair.expires_at).getTime() - Date.now()
    if (ms <= 0) { setPair(null); return }
    const t = setTimeout(() => setPair(null), ms)
    return () => clearTimeout(t)
  }, [pair?.expires_at])

  return (
    <div className="page">
      <div className="page-header">
        <h1><Smartphone size={22} style={{ verticalAlign: '-3px', marginRight: 8 }} />Pair phone</h1>
        <p style={{ color: 'var(--text-secondary)', maxWidth: 640 }}>
          Run Tusk Ledger on your iPhone over your home Wi-Fi. Generate a
          one-time code below, then scan it with the Tusk Ledger app on
          your phone. The phone keeps a fast local copy and refreshes from
          your laptop every few minutes.
        </p>
      </div>

      <LanWarning />

      <section className="card" style={{ padding: 24, maxWidth: 720, marginTop: 16 }}>
        <h2 style={{ marginTop: 0 }}>1. Generate a pairing code</h2>
        {!pair ? (
          <button
            className="primary-btn"
            onClick={startPair}
            disabled={pairing}
            style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
            <RefreshCw size={14} className={pairing ? 'spinning' : ''} />
            {pairing ? 'Generating…' : 'Generate code'}
          </button>
        ) : (
          <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', alignItems: 'center' }}>
            <img
              src={pair.qr_data_url}
              alt="Pairing QR"
              style={{
                width: 220, height: 220,
                background: '#fff',
                padding: 8,
                borderRadius: 8,
                imageRendering: 'pixelated',
              }}
            />
            <div style={{ flex: 1, minWidth: 220 }}>
              <div style={{ color: 'var(--text-secondary)', fontSize: 12, letterSpacing: 0.6 }}>
                CODE (manual entry fallback)
              </div>
              <div style={{
                fontFamily: 'ui-monospace, SFMono-Regular, monospace',
                fontSize: 28, letterSpacing: 4, marginTop: 4,
              }}>
                {pair.code}
              </div>
              <div style={{ marginTop: 12, color: 'var(--text-secondary)', fontSize: 13 }}>
                {pair.host
                  ? <>Host: <strong>{pair.host}:{pair.port}</strong></>
                  : <span style={{ color: 'var(--accent-orange, #fb923c)' }}>
                      Couldn't auto-detect a LAN IP — you'll need to type the
                      laptop address into the phone manually.
                    </span>
                }
              </div>
              <div style={{ marginTop: 6, color: 'var(--text-muted)', fontSize: 12 }}>
                Expires {new Date(pair.expires_at).toLocaleTimeString()} (in 5 min)
              </div>
              <button
                onClick={startPair}
                style={{ marginTop: 12 }}
                className="ghost-btn">
                Regenerate
              </button>
            </div>
          </div>
        )}
        {pairError && (
          <div style={{
            marginTop: 12,
            padding: '8px 12px',
            background: 'rgba(239,111,108,0.10)',
            border: '1px solid rgba(239,111,108,0.4)',
            borderRadius: 6,
            color: 'var(--text-primary)',
            fontSize: 13,
          }}>
            {pairError}
          </div>
        )}
      </section>

      <section className="card" style={{ padding: 24, maxWidth: 720, marginTop: 16 }}>
        <h2 style={{ marginTop: 0 }}>2. Scan from the phone</h2>
        <ol style={{ color: 'var(--text-secondary)', lineHeight: 1.7 }}>
          <li>Open the Tusk Ledger app on your iPhone (TestFlight or
            Expo Go).</li>
          <li>Allow camera + local network access on first launch.</li>
          <li>Point the camera at the QR. The phone takes care of the rest.</li>
        </ol>
        <p style={{ color: 'var(--text-muted)', fontSize: 13, marginTop: 12 }}>
          Camera not cooperating? Tap "Enter code manually" on the phone
          and type the 8-char code + the host (<code>{pair?.host || 'IP'}:{pair?.port || 8000}</code>).
        </p>
      </section>

      <section className="card" style={{ padding: 24, maxWidth: 720, marginTop: 16 }}>
        <h2 style={{ marginTop: 0 }}>Paired devices</h2>
        {loadingDevices ? (
          <p style={{ color: 'var(--text-muted)' }}>Loading…</p>
        ) : devices.length === 0 ? (
          <p style={{ color: 'var(--text-muted)' }}>
            No phones paired yet. Generate a code above to get started.
          </p>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
            <thead>
              <tr style={{ textAlign: 'left', color: 'var(--text-muted)', fontSize: 12, letterSpacing: 0.6 }}>
                <th style={th}>LABEL</th>
                <th style={th}>PAIRED</th>
                <th style={th}>LAST SEEN</th>
                <th style={th}>STATUS</th>
                <th style={th}></th>
              </tr>
            </thead>
            <tbody>
              {devices.map(d => (
                <tr key={d.id} style={{ borderTop: '1px solid var(--border)' }}>
                  <td style={td}>{d.label || `Device ${d.id}`}</td>
                  <td style={td}>{d.created_at ? new Date(d.created_at).toLocaleDateString() : '—'}</td>
                  <td style={td}>{d.last_seen_at ? new Date(d.last_seen_at).toLocaleString() : 'never'}</td>
                  <td style={td}>
                    {d.revoked
                      ? <span style={{ color: 'var(--text-muted)' }}>revoked</span>
                      : <span style={{ color: 'var(--accent-green, #5cd6a4)' }}>active</span>}
                  </td>
                  <td style={td}>
                    {!d.revoked && (
                      <button
                        onClick={() => revoke(d.id)}
                        title="Revoke this device's token"
                        className="ghost-btn"
                        style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                        <Trash2 size={12} /> Revoke
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  )
}

const th = { padding: '8px 6px', fontWeight: 600 }
const td = { padding: '10px 6px', verticalAlign: 'middle' }

/**
 * Hint shown above the pairing UI when LAN_SYNC_ENABLED isn't on
 * (heuristic: the page is being served from 127.0.0.1, so a phone
 * couldn't reach this address). Doesn't query the backend — just
 * checks where the browser thinks it's connected to.
 */
function LanWarning() {
  const isLocalhost =
    typeof window !== 'undefined' &&
    /^(localhost|127\.0\.0\.1|\[::1\])$/.test(window.location.hostname)

  if (!isLocalhost) return null

  return (
    <div style={{
      display: 'flex',
      gap: 12,
      alignItems: 'flex-start',
      padding: 12,
      borderRadius: 8,
      background: 'rgba(255,180,84,0.10)',
      border: '1px solid rgba(255,180,84,0.4)',
      maxWidth: 720,
      marginTop: 8,
    }}>
      <AlertTriangle size={18} style={{ color: 'var(--accent-orange, #ffb454)', flexShrink: 0, marginTop: 2 }} />
      <div style={{ fontSize: 13, lineHeight: 1.5 }}>
        <strong>You're viewing this page on localhost.</strong> Your phone
        can't reach <code>127.0.0.1</code> on your laptop. To make pairing
        work, restart Tusk Ledger with{' '}
        <code>LAN_SYNC_ENABLED=true</code> and bind to <code>0.0.0.0</code>{' '}
        (e.g. <code>uvicorn app.main:app --host 0.0.0.0 --port 8000</code>).
        Then visit this page from your laptop's LAN IP — see the README in{' '}
        <code>tuskledger/mobile</code> for the full walkthrough.{' '}
        <Wifi size={12} style={{ verticalAlign: '-1px' }} />
      </div>
    </div>
  )
}
