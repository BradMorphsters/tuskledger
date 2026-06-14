/**
 * IntegrationsCard — one consistent place that shows every external service is
 * bring-your-own-key: which keys are set, the .env variable for each, and where
 * to get one. Status only (no key values); nothing hosted or shared.
 */
import { useEffect, useState } from 'react'
import { KeyRound, CheckCircle, AlertCircle } from 'lucide-react'
import Pill from './Pill'
import { getIntegrationsStatus } from '../api/client'

export default function IntegrationsCard() {
  const [items, setItems] = useState(null)
  useEffect(() => {
    getIntegrationsStatus().then(d => setItems(d.integrations || [])).catch(() => setItems([]))
  }, [])
  if (!items) return null

  return (
    <div className="card" style={{ marginBottom: 24 }}>
      <div className="card-header">
        <div className="card-title" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <KeyRound size={16} /> API keys — bring your own
        </div>
      </div>
      <p style={{ fontSize: 12.5, color: 'var(--text-secondary)', margin: '0 0 14px' }}>
        Every external service is bring-your-own-key — set in <code>backend/.env</code> and read at
        startup. Nothing is hosted or shared: each person who runs Tusk Ledger uses their own keys.
      </p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {items.map(it => (
          <div key={it.key} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
            <div>
              <div style={{ fontWeight: 600, fontSize: 13 }}>{it.label}</div>
              <code style={{ fontSize: 11, color: 'var(--text-muted)' }}>{it.env}</code>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              {it.configured
                ? <Pill tone="success" soft><CheckCircle size={11} /> Connected</Pill>
                : <Pill tone="neutral" soft><AlertCircle size={11} /> Not set</Pill>}
              {it.url && <a href={it.url} target="_blank" rel="noreferrer" style={{ fontSize: 12, color: 'var(--accent-blue)' }}>get a key →</a>}
            </div>
          </div>
        ))}
      </div>
      <p style={{ fontSize: 11, color: 'var(--text-muted)', margin: '14px 0 0' }}>
        To add or change one: edit <code>backend/.env</code> (e.g. <code>QUIVER_API_KEY=…</code>) and restart the backend.
      </p>
    </div>
  )
}
