import { useEffect, useState } from 'react'
import { AlertTriangle, Wallet } from 'lucide-react'
import { SkeletonCard } from '../Skeleton'
import { formatCurrencyZero as fmtFull } from '../../lib/format'
import { fmtMoney, tileCardStyle } from './shared'
import { useAccounts } from '../../hooks/useAccounts'

/**
 * CashBalances — at-a-glance "is any checking account running low?"
 *
 * Scope: checking accounts only (depository / checking). Savings is
 * intentionally excluded — those accounts often sit at the institution's
 * minimum-to-stay-open ($5–$10) by design and would generate noise; the
 * problem we're trying to surface is "did a bill autopay just empty out
 * a checking account that's about to bounce the next one?"
 *
 * Sort: descending by current_balance so the largest balance is on
 * top. Low-balance accounts are still surfaced via the headline
 * "N account(s) below $X" summary and the red/yellow row tinting.
 *
 * Color rules:
 *   < LOW_BALANCE_RED    → red row + warning icon ("act on this")
 *   < LOW_BALANCE_YELLOW → yellow row ("watching this")
 *   otherwise            → normal
 *
 * The thresholds are intentionally simple constants for v1. If different
 * accounts need different thresholds (e.g. a high-volume primary
 * checking should alert at a higher floor than a rarely-used secondary)
 * we'll move them onto the Account model — but a single global default
 * covers the catch-the-low-balance use case for now.
 */
const LOW_BALANCE_RED = 100      // Below this: bill bounce risk
const LOW_BALANCE_YELLOW = 500   // Below this: getting tight, worth knowing

export function CashBalances() {
  const { accounts: allAccounts, loading } = useAccounts()
  // Normalise: hook returns [] while loading, tile previously used null-sentinel.
  const accounts = loading ? null : allAccounts

  if (loading) return <SkeletonCard titleWidth="35%" rows={4} />
  if (!accounts) return null

  // Filter to checking accounts only. Skip Plaid's depository "subtype:
  // money market" / "cd" / "savings" — only true checking. Some
  // institutions report subtype as null; in that case fall back to
  // the type field and assume any depository without a subtype is a
  // checking account (rare in practice with Plaid's classifier).
  const checking = accounts
    .filter(a => {
      if (a.type !== 'depository') return false
      const sub = (a.subtype || '').toLowerCase()
      // Accept "checking" or null/empty subtype on a depository account.
      // Reject savings, money market, CD, prepaid, etc.
      return sub === 'checking' || sub === ''
    })
    .sort((a, b) => (b.current_balance || 0) - (a.current_balance || 0))

  if (checking.length === 0) return null

  const total = checking.reduce((s, a) => s + (a.current_balance || 0), 0)
  const lowCount = checking.filter(a => (a.current_balance || 0) < LOW_BALANCE_RED).length
  const watchCount = checking.filter(a => {
    const b = a.current_balance || 0
    return b >= LOW_BALANCE_RED && b < LOW_BALANCE_YELLOW
  }).length

  const headerColor = lowCount > 0
    ? 'var(--accent-red)'
    : watchCount > 0
      ? 'var(--accent-orange)'
      : 'var(--accent-blue)'

  return (
    <div className="card" style={tileCardStyle}>
      <div className="card-header">
        <span className="card-title" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <Wallet size={14} style={{ color: headerColor }} /> Cash balances
        </span>
        <a href="/connect" style={{ fontSize: 11, color: 'var(--accent-blue)' }}>
          Detail →
        </a>
      </div>

      {/* Headline: total cash across checking + low-balance summary */}
      <div style={{ marginTop: 4 }}>
        <div style={{
          fontSize: 10, color: 'var(--text-muted)',
          textTransform: 'uppercase', letterSpacing: 0.4,
        }}>
          Checking total
        </div>
        <div style={{
          fontSize: 24, fontWeight: 700, color: 'var(--text-primary)',
          fontVariantNumeric: 'tabular-nums', marginTop: 2,
        }}>
          {fmtMoney(total)}
        </div>
        {lowCount > 0 ? (
          <div style={{
            fontSize: 12, color: 'var(--accent-red)', marginTop: 4,
            fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 4,
          }}>
            <AlertTriangle size={12} />
            {lowCount} account{lowCount !== 1 ? 's' : ''} below {fmtMoney(LOW_BALANCE_RED)}
          </div>
        ) : watchCount > 0 ? (
          <div style={{
            fontSize: 12, color: 'var(--accent-orange)', marginTop: 4,
            fontWeight: 600,
          }}>
            {watchCount} account{watchCount !== 1 ? 's' : ''} below {fmtMoney(LOW_BALANCE_YELLOW)}
          </div>
        ) : (
          <div style={{
            fontSize: 12, color: 'var(--text-muted)', marginTop: 4,
          }}>
            All checking accounts above {fmtMoney(LOW_BALANCE_YELLOW)}
          </div>
        )}
      </div>

      {/* Per-account list, largest balance first. flex: 1 lets the
          list stretch when the tile shares a row with a taller
          sibling. */}
      <div style={{
        display: 'flex', flexDirection: 'column',
        gap: 8, paddingTop: 12, marginTop: 8, flex: 1,
        borderTop: '1px solid var(--border-color, rgba(255,255,255,0.05))',
      }}>
        {checking.map((acct, idx) => {
          const balance = acct.current_balance || 0
          const isLow = balance < LOW_BALANCE_RED
          const isWatch = !isLow && balance < LOW_BALANCE_YELLOW
          const balanceColor = isLow
            ? 'var(--accent-red)'
            : isWatch
              ? 'var(--accent-orange)'
              : 'var(--text-primary)'
          const rowBg = isLow
            ? 'rgba(248,113,113,0.06)'
            : isWatch
              ? 'rgba(251,146,60,0.04)'
              : 'transparent'
          const displayName = acct.custom_name || acct.name
          return (
            <div
              key={acct.id}
              style={{
                display: 'flex', alignItems: 'center',
                justifyContent: 'space-between', gap: 12,
                padding: '6px 8px', borderRadius: 6,
                background: rowBg,
                marginLeft: -8, marginRight: -8,
              }}
              title={
                isLow
                  ? `Below ${fmtMoney(LOW_BALANCE_RED)} — risk of bouncing autopays`
                  : isWatch
                    ? `Below ${fmtMoney(LOW_BALANCE_YELLOW)} — keep an eye on it`
                    : undefined
              }
            >
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{
                  fontSize: 13, fontWeight: 500, color: 'var(--text-primary)',
                  display: 'flex', alignItems: 'center', gap: 6,
                  whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                }}>
                  {isLow && <AlertTriangle size={12} style={{ color: 'var(--accent-red)', flexShrink: 0 }} />}
                  {displayName}
                </div>
                <div style={{
                  fontSize: 11, color: 'var(--text-muted)',
                  whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                }}>
                  {acct.institution_name || '—'}
                  {acct.mask && ` · ⋯${acct.mask}`}
                </div>
              </div>
              <div style={{
                fontSize: 14, fontWeight: 700, color: balanceColor,
                fontVariantNumeric: 'tabular-nums', flexShrink: 0,
                textAlign: 'right',
              }}>
                {fmtFull(balance)}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
