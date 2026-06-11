/**
 * Trading Tax — top-level page (sidebar nav between Investments and
 * Insights). Mounts the TradingTax component with an account-filter
 * dropdown sourced from /api/accounts so the user can scope to one
 * account or view the taxpayer-wide picture (the default).
 *
 * The underlying calculation always considers ALL accounts for wash-
 * sale detection (IRC §1091 applies per taxpayer); the filter only
 * scopes which matches and open positions are shown.
 */
import { useMemo, useState } from 'react'
import { Receipt } from 'lucide-react'
import TradingTax from '../components/TradingTax'
import TradingDataFreshness from '../components/TradingDataFreshness'
import { useAccounts } from '../hooks/useAccounts'

export default function TradingTaxPage() {
  const { accounts } = useAccounts()
  const [accountFilter, setAccountFilter] = useState('')

  const investmentAccounts = useMemo(
    () => accounts.filter(a => a.type === 'investment'),
    [accounts]
  )

  return (
    <div style={{ padding: 16 }}>
      <div style={{
        display: 'flex', alignItems: 'flex-start',
        justifyContent: 'space-between', gap: 16, marginBottom: 16,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <Receipt size={28} style={{ color: 'var(--accent-blue)' }} />
          <div>
            <h1 style={{ margin: 0, fontSize: 24, fontWeight: 600 }}>Trading Tax</h1>
            <p style={{ margin: '4px 0 0', fontSize: 13, color: 'var(--text-secondary)' }}>
              Realized capital gains, wash-sale detection, and hold-to-long-term
              opportunities across all your investment accounts.
            </p>
          </div>
        </div>
        {investmentAccounts.length > 1 && (
          <select
            value={accountFilter}
            onChange={e => setAccountFilter(e.target.value)}
            style={{
              background: 'var(--bg-input, var(--bg-card))',
              color: 'var(--text-primary)',
              border: '1px solid var(--border-color, rgba(255,255,255,0.1))',
              borderRadius: 8, padding: '8px 12px', fontSize: 13,
            }}
            title="Scope the displayed matches and positions to one account. Wash-sale detection still considers all accounts (IRS rule)."
          >
            <option value="">All investment accounts</option>
            {investmentAccounts.map(a => (
              <option key={a.id} value={a.id}>
                {a.custom_name || a.name}
              </option>
            ))}
          </select>
        )}
      </div>
      <TradingDataFreshness />
      <TradingTax accountFilter={accountFilter} />
    </div>
  )
}
