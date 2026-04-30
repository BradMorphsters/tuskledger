import { useState, useEffect } from 'react'
import { ChevronDown, ChevronUp, AlertTriangle, X } from 'lucide-react'
import { getStaleAccounts } from '../api/client'

/**
 * Pick the right top-line headline based on what's actually in the list.
 * Two cadences come back from the backend now (`plaid` and `manual`),
 * each with its own meaning of "stale" — surface whichever applies.
 */
function summaryHeadline(accounts, count, daysThreshold) {
  const noun = `account${count !== 1 ? 's' : ''}`
  const hasManual = accounts.some(a => a.cadence === 'manual')
  const hasPlaid = accounts.some(a => a.cadence === 'plaid' || !a.cadence)
  if (hasManual && hasPlaid) {
    return `${count} ${noun} overdue (sync gaps + missing statements)`
  }
  if (hasManual) {
    return `${count} ${noun} missing last month's statement`
  }
  return `${count} ${noun} haven't synced in ${daysThreshold}+ days`
}

export default function StaleBalanceAlert() {
  const [data, setData] = useState(null)
  const [expanded, setExpanded] = useState(false)
  const [dismissed, setDismissed] = useState(false)
  const DAYS_THRESHOLD = 7

  useEffect(() => {
    // Check if dismissed today
    const today = new Date().toISOString().split('T')[0]
    const dismissalKey = `stale-alert-dismissed-${today}`
    if (localStorage.getItem(dismissalKey)) {
      setDismissed(true)
      return
    }

    // Fetch stale accounts
    getStaleAccounts(DAYS_THRESHOLD)
      .then(result => setData(result))
      .catch(() => {})
  }, [])

  if (dismissed || !data || data.stale_count === 0) {
    return null
  }

  const handleDismiss = () => {
    const today = new Date().toISOString().split('T')[0]
    localStorage.setItem(`stale-alert-dismissed-${today}`, '1')
    setDismissed(true)
  }

  const accounts = data.accounts || []

  return (
    <div style={{
      background: 'rgba(251, 146, 60, 0.1)',
      border: '1px solid rgba(251, 146, 60, 0.3)',
      borderRadius: 8,
      padding: 12,
      marginBottom: 24,
      display: 'flex',
      alignItems: 'flex-start',
      gap: 12,
    }}>
      <AlertTriangle size={18} style={{ color: 'var(--accent-orange)', flexShrink: 0, marginTop: 2 }} />
      
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
          <span style={{ color: 'var(--accent-orange)', fontWeight: 500, fontSize: 14 }}>
            {summaryHeadline(accounts, data.stale_count, DAYS_THRESHOLD)}
          </span>
          <button
            onClick={() => setExpanded(!expanded)}
            style={{
              background: 'none',
              border: 'none',
              padding: 0,
              cursor: 'pointer',
              color: 'var(--text-secondary)',
              display: 'inline-flex',
              alignItems: 'center',
            }}
            title={expanded ? 'Hide accounts' : 'Show accounts'}
          >
            {expanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
          </button>
        </div>

        {expanded && accounts.length > 0 && (
          <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px solid rgba(251, 146, 60, 0.2)' }}>
            {accounts.map(account => (
              <div key={account.id} style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                paddingBottom: 6,
                marginBottom: 6,
                fontSize: 13,
                color: 'var(--text-secondary)',
              }}>
                <div>
                  {account.name && <span style={{ fontWeight: 500, color: 'var(--text-primary)' }}>{account.name}</span>}
                  {account.institution_name && <span style={{ marginLeft: 8, fontSize: 12 }}>({account.institution_name})</span>}
                  {account.cadence === 'manual' && (
                    <span style={{
                      marginLeft: 8, fontSize: 10, padding: '1px 6px', borderRadius: 8,
                      background: 'rgba(255,255,255,0.06)', color: 'var(--text-muted)',
                      verticalAlign: 'middle', textTransform: 'uppercase', letterSpacing: 0.4,
                    }}>
                      manual
                    </span>
                  )}
                </div>
                <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>
                  {/* Backend-provided reason: "March statement overdue" for manual,
                      "12 days since last sync" for Plaid. Falls back to days-ago
                      if an older backend hasn't been deployed yet. */}
                  {account.reason || `${account.days_stale} day${account.days_stale !== 1 ? 's' : ''} ago`}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      <button
        onClick={handleDismiss}
        style={{
          background: 'none',
          border: 'none',
          padding: 0,
          cursor: 'pointer',
          color: 'var(--text-secondary)',
          flexShrink: 0,
        }}
        title="Dismiss until tomorrow"
      >
        <X size={16} />
      </button>
    </div>
  )
}
