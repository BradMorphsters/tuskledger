/**
 * Tiny presentation helper: renders "as of <date> · through <date>" beneath
 * an account name, with stale-coloring thresholds.
 *
 * Logic:
 *   - Manual account: shows "as of <balance_as_of>" plus, if different
 *     from balance_as_of, "· through <transactions_through>".
 *   - Plaid account: shows nothing if transactions are recent (<14d). If
 *     transactions_through is older than 14 days, shows "transactions
 *     through <date>" so you can spot a stuck/disabled sync.
 *   - Color thresholds (manual only): muted up to 35d, orange 35-60d,
 *     red beyond 60d. Tracks the typical monthly statement cadence.
 */

function daysSince(isoDate) {
  if (!isoDate) return null
  const d = new Date(isoDate + 'T00:00:00')
  return Math.floor((Date.now() - d.getTime()) / 86400000)
}

function colorForAge(days) {
  if (days === null) return 'var(--text-muted)'
  if (days > 60) return '#fb7185' // red
  if (days > 35) return '#fb923c' // orange
  return 'var(--text-muted)'
}

function fmt(iso) {
  if (!iso) return null
  const d = new Date(iso + 'T00:00:00')
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

export default function AccountFreshness({ account, compact = false }) {
  if (!account) return null
  const isManual = !!account.is_manual
  const asOf = account.balance_as_of
  const through = account.transactions_through
  const txnsAge = daysSince(through)

  // Plaid accounts: only flag when transactions look stuck.
  if (!isManual) {
    if (!through || txnsAge === null || txnsAge < 14) return null
    return (
      <span style={{ fontSize: 11, color: colorForAge(txnsAge), marginLeft: 6 }}>
        · txns through {fmt(through)}
      </span>
    )
  }

  // Manual accounts: always show the snapshot date.
  const balanceAge = daysSince(asOf)
  const balanceColor = colorForAge(balanceAge)
  const showThrough = through && through !== asOf

  return (
    <span style={{ fontSize: 11, color: balanceColor, fontWeight: 400 }}>
      as of {fmt(asOf) || '—'}
      {showThrough && (
        <>
          {' · '}
          <span style={{ color: colorForAge(txnsAge) }}>
            txns through {fmt(through)}
          </span>
        </>
      )}
    </span>
  )
}
