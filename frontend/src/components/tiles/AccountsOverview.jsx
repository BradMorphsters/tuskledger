import { useEffect, useState } from 'react'
import { Landmark } from 'lucide-react'
import { getAccounts, getManualAssets } from '../../api/client'
import { SkeletonCard } from '../Skeleton'
import { fmtMoney, tileCardStyle } from './shared'

// ─────────────────────── Accounts Overview ───────────────────────
//
// All connected accounts in one tile, grouped by Plaid type into the
// four buckets that map to the user's mental model:
//
//   Cash        — depository (checking, savings, money market, CD)
//   Investment  — investment (brokerage, retirement, IRA, 401k)
//   Credit      — credit card
//   Loans       — loan / mortgage / student / auto
//
// Why this exists alongside CashBalances and PortfolioSnapshot: those
// answer specific questions ("am I about to bounce a bill?" / "how
// is my portfolio doing?"). This one answers the much more common
// dashboard question — "what's the balance on each of my accounts
// right now?" — which previously required clicking into the Accounts
// page. Most consumer finance apps lead with this; we were the
// outlier.
//
// Each row shows the custom_name (or name) + last-4 mask + current
// balance. Liability balances (credit / loans) render as negative for
// quick visual subtraction; the per-group subtotal and the bottom
// "Net worth" line use the same convention so the math reads
// straight down.
//
// Stale indicator: a small clock badge appears next to the balance
// when an account hasn't been refreshed in > 7 days. Plaid usually
// refreshes hourly to daily, so a week stale is a real signal —
// most often a relink-required state. The badge links to the
// Accounts page so the user can act on it.

const ACCOUNT_GROUPS = [
  { key: 'depository', label: 'Cash',       side: 'asset',     color: 'var(--accent-blue)' },
  { key: 'investment', label: 'Investment', side: 'asset',     color: 'var(--accent-purple)' },
  { key: 'credit',     label: 'Credit',     side: 'liability', color: 'var(--accent-orange)' },
  { key: 'loan',       label: 'Loans',      side: 'liability', color: 'var(--accent-red)' },
]

function StaleBadge({ updatedAt }) {
  if (!updatedAt) return null
  const ageMs = Date.now() - new Date(updatedAt).getTime()
  if (!Number.isFinite(ageMs) || ageMs < 7 * 24 * 60 * 60 * 1000) return null
  const days = Math.floor(ageMs / (24 * 60 * 60 * 1000))
  return (
    <span
      title={`Last synced ${days} days ago — may need a re-link`}
      style={{
        display: 'inline-flex', alignItems: 'center',
        marginLeft: 6, padding: '1px 5px',
        fontSize: 9, fontWeight: 600, letterSpacing: 0.4,
        color: 'var(--accent-orange)',
        background: 'rgba(239, 159, 39, 0.10)',
        border: '1px solid rgba(239, 159, 39, 0.35)',
        borderRadius: 3,
      }}
    >
      {days}d
    </span>
  )
}

export function AccountsOverview() {
  const [accounts, setAccounts] = useState(null)
  const [manualAssets, setManualAssets] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    // Fetch Plaid accounts and manual entries in parallel. Manual
    // assets are optional; failure (e.g. brand-new install with the
    // table empty) shouldn't take the whole tile down.
    Promise.all([
      getAccounts().catch(() => []),
      getManualAssets().catch(() => []),
    ])
      .then(([acc, manual]) => {
        setAccounts(acc)
        setManualAssets(Array.isArray(manual) ? manual : [])
      })
      .finally(() => setLoading(false))
  }, [])

  if (loading) return <SkeletonCard titleWidth="40%" rows={6} />
  if (!accounts || accounts.length === 0) return null

  // Bucket Plaid accounts into the four groups, dropping anything we
  // don't know how to classify (rare — Plaid's type vocabulary is small).
  const grouped = ACCOUNT_GROUPS.map((g) => {
    const items = accounts
      .filter((a) => (a.type || '').toLowerCase() === g.key)
      .sort((a, b) => Math.abs(b.current_balance || 0) - Math.abs(a.current_balance || 0))
    const subtotal = items.reduce((s, a) => s + (a.current_balance || 0), 0)
    return { ...g, items, subtotal }
  }).filter((g) => g.items.length > 0)

  // Manual entries: split by side. These cover things Plaid can't
  // see — homes, vehicles, held-away 401(k)s (Fidelity NetBenefits,
  // Voya, PlanMember, etc.), private auto loans, etc.
  const manualAssetItems = manualAssets.filter(
    (m) => (m.side || 'asset') === 'asset'
  )
  const manualLiabilityItems = manualAssets.filter(
    (m) => (m.side || 'asset') === 'liability'
  )
  const manualAssetSubtotal = manualAssetItems.reduce(
    (s, m) => s + (m.current_value || 0), 0
  )
  const manualLiabilitySubtotal = manualLiabilityItems.reduce(
    (s, m) => s + (m.current_value || 0), 0
  )

  // Build the manual rows the same shape as `grouped` so the renderer
  // is uniform. Hidden when empty — new users without any manual
  // entries see a clean 4-row tile, not empty placeholder rows.
  const manualRows = []
  if (manualAssetItems.length > 0) {
    manualRows.push({
      key: 'manual-assets',
      label: 'Manual assets',
      side: 'asset',
      color: 'var(--accent-green)',
      items: manualAssetItems,
      subtotal: manualAssetSubtotal,
    })
  }
  if (manualLiabilityItems.length > 0) {
    manualRows.push({
      key: 'manual-liabilities',
      label: 'Manual liabilities',
      side: 'liability',
      color: 'var(--accent-red)',
      items: manualLiabilityItems,
      subtotal: manualLiabilitySubtotal,
    })
  }
  const allRows = [...grouped, ...manualRows]

  // Net worth = sum of asset-side − sum of liability-side, across both
  // Plaid accounts and manual entries. This now matches the Net Worth
  // page exactly — one number, one truth.
  const totalAssets = allRows
    .filter((g) => g.side === 'asset')
    .reduce((s, g) => s + g.subtotal, 0)
  const totalLiabilities = allRows
    .filter((g) => g.side === 'liability')
    .reduce((s, g) => s + g.subtotal, 0)
  const net = totalAssets - totalLiabilities

  return (
    <div className="card" style={tileCardStyle}>
      <div className="card-header">
        <span className="card-title" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <Landmark size={14} style={{ color: 'var(--accent-blue)' }} /> Accounts
        </span>
        <a href="/connect" style={{ fontSize: 11, color: 'var(--accent-blue)' }}>
          Manage →
        </a>
      </div>

      {/* Body: four-row balance-sheet summary + Net footer.
          Per-account inventory deliberately lives on /connect, not
          here. The dashboard tile answers "what does my balance
          sheet look like" at a glance; drilling into individual
          accounts is one click away via "Manage →". This shape also
          eliminates redundancy with the Cash Balances tile (which
          owns the per-checking-account view) and Portfolio (which
          owns the investments roll-up). */}
      <div style={{
        marginTop: 8, flex: 1,
        display: 'flex', flexDirection: 'column',
      }}>
        <div style={{ flex: 1 }}>
          {allRows.map((g) => (
            <div
              key={g.key}
              style={{
                display: 'flex', justifyContent: 'space-between',
                alignItems: 'baseline',
                padding: '12px 0',
                borderBottom: '1px solid var(--border-soft)',
              }}
            >
              {/* Group label + count. Color comes from the group
                  config (CASH=green, INVESTMENT=purple, etc.). */}
              <span style={{
                fontSize: 12, fontWeight: 600,
                color: g.color,
                letterSpacing: 0.4, textTransform: 'uppercase',
              }}>
                {g.label}
                <span style={{
                  marginLeft: 8,
                  color: 'var(--text-dim)',
                  fontWeight: 400, letterSpacing: 0,
                  textTransform: 'none',
                }}>
                  {/* "accounts" reads right for the four Plaid groups
                      (which really are accounts); manual rows use
                      "entries" since a manual asset is a hand-entered
                      record, not a synced account. */}
                  · {g.items.length} {g.key.startsWith('manual-')
                    ? (g.items.length === 1 ? 'entry' : 'entries')
                    : (g.items.length === 1 ? 'account' : 'accounts')}
                </span>
              </span>
              {/* Signed subtotal. Liabilities render with a leading
                  minus so the balance-sheet math reads top-to-bottom. */}
              <span style={{
                fontVariantNumeric: 'tabular-nums',
                fontWeight: 600, fontSize: 14,
                color: 'var(--text-primary)',
              }}>
                {g.side === 'liability' ? '−' : ''}
                {fmtMoney(g.subtotal)}
              </span>
            </div>
          ))}
        </div>

        {/* Net worth footer — sum of every row above (Plaid groups +
            manual assets + manual liabilities). Matches the Net Worth
            page's headline number exactly so the dashboard and the
            detail view tell one consistent story. */}
        <div style={{
          display: 'flex', justifyContent: 'space-between',
          alignItems: 'baseline',
          marginTop: 12, paddingTop: 12,
          borderTop: '2px solid var(--border)',
        }}>
          <span style={{
            fontSize: 11, fontWeight: 700,
            color: 'var(--text-secondary)',
            letterSpacing: 0.4, textTransform: 'uppercase',
          }}>
            Net Worth
          </span>
          <span style={{
            fontSize: 16, fontWeight: 700,
            fontVariantNumeric: 'tabular-nums',
            color: net >= 0 ? 'var(--text-primary)' : 'var(--accent-red)',
          }}>
            {fmtMoney(net)}
          </span>
        </div>
      </div>
    </div>
  )
}
