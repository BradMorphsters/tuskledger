/**
 * Data-freshness panel for the Trading Tax page.
 *
 * The trading-tax math is only as good as the underlying transaction
 * sync. If Plaid hasn't pulled recent activity from Robinhood (or any
 * investment account), the YTD numbers + open positions + wash-sale
 * detection will all be stale — and worse, the user won't necessarily
 * notice unless we surface it explicitly.
 *
 * This panel sits at the top of the page and shows:
 *   - Per-investment-account: balance_as_of date + last transaction
 *     date + days-since-last-sync, color-coded by staleness.
 *   - A one-click Sync Now button that triggers /api/plaid/sync and
 *     re-fetches when complete.
 *   - A pre-flight prompt if any account is >3 days stale.
 *
 * Pure-function helpers exported for unit tests.
 */
import { useEffect, useState } from 'react'
import { Clock, RefreshCw, CheckCircle, AlertTriangle, Loader2, Info } from 'lucide-react'
import { getAccounts, triggerSync, getInvestmentTransactions, getAuthStatus } from '../api/client'
import { formatDate } from '../lib/format'

// Pure helpers — exported for unit tests.

export function classifyFreshness(daysStale) {
  // Trading data freshness tiers. Tighter than the global stale-balance
  // alert because intraday trading activity rotates fast — even a
  // 3-day-old picture can be misleading for swing-trade reasoning.
  if (daysStale === null || daysStale === undefined) return 'unknown'
  if (daysStale <= 1) return 'fresh'
  if (daysStale <= 3) return 'recent'
  if (daysStale <= 7) return 'stale'
  return 'very_stale'
}

export function freshnessColor(tier) {
  switch (tier) {
    case 'fresh': return 'var(--accent-green)'
    case 'recent': return 'var(--accent-blue)'
    case 'stale': return 'var(--accent-orange)'
    case 'very_stale': return 'var(--accent-red)'
    default: return 'var(--text-muted)'
  }
}

export function freshnessLabel(tier, daysStale) {
  if (tier === 'unknown') return 'Never synced'
  if (tier === 'fresh') return daysStale === 0 ? 'Today' : 'Yesterday'
  return `${daysStale} days ago`
}

export default function TradingDataFreshness() {
  const [investmentAccounts, setInvestmentAccounts] = useState([])
  const [lastTxnByAccount, setLastTxnByAccount] = useState({})
  const [loading, setLoading] = useState(true)
  const [syncing, setSyncing] = useState(false)
  const [syncJustCompleted, setSyncJustCompleted] = useState(false)
  // Last sync's per-item results — populated after a Sync Now click.
  // Lets us surface specific per-item errors instead of swallowing them
  // (the backend's sync_all_items catches per-item exceptions and
  // continues; without surfacing the error array, a Plaid auth failure
  // on Robinhood looked indistinguishable from success in the UI).
  const [lastSyncResult, setLastSyncResult] = useState(null)
  // Demo mode short-circuits sync to a no-op. Detecting and surfacing
  // this prevents the user from clicking Sync Now repeatedly wondering
  // why nothing happens.
  const [isDemo, setIsDemo] = useState(false)

  const refresh = async () => {
    setLoading(true)
    try {
      const [accounts, txns, auth] = await Promise.all([
        getAccounts().catch(() => []),
        getInvestmentTransactions({ limit: 1000 }).catch(() => []),
        getAuthStatus().catch(() => ({})),
      ])
      setIsDemo(!!auth.demo_mode)
      setInvestmentAccounts(accounts.filter(a => a.type === 'investment'))
      // Derive most-recent transaction date per account so we can
      // surface "data through Apr 12" rather than just "synced today"
      // (Plaid sync timestamp can be fresh while transaction data lags).
      const lastTxn = {}
      for (const t of txns) {
        const d = t.date
        if (!lastTxn[t.account_id] || lastTxn[t.account_id] < d) {
          lastTxn[t.account_id] = d
        }
      }
      setLastTxnByAccount(lastTxn)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { refresh() }, [])

  const handleSync = async () => {
    setSyncing(true)
    setSyncJustCompleted(false)
    setLastSyncResult(null)
    try {
      const result = await triggerSync()
      // Capture the response so we can surface per-item errors. The
      // backend returns either:
      //   {status: 'ok', results: [{item_id, status, ...}]}        — real
      //   {status: 'ok', results: [], note: 'demo mode...'}         — demo no-op
      //   {status: 'ok', results: [{status: 'error', error: '...'}]} — partial fail
      setLastSyncResult(result)
      setSyncJustCompleted(true)
      await refresh()
      setTimeout(() => setSyncJustCompleted(false), 4000)
    } catch (e) {
      console.error('Sync failed:', e)
      setLastSyncResult({ status: 'error', error: e.message || 'Sync request failed' })
    } finally {
      setSyncing(false)
    }
  }

  // Build a friendly diagnostic from the sync response.
  const syncDiagnostic = (() => {
    if (!lastSyncResult) return null
    if (lastSyncResult.note && /demo/i.test(lastSyncResult.note)) {
      return {
        kind: 'demo',
        message: "You're in Demo mode — Sync Now is a no-op against the synthetic dataset. Switch to Real mode (sidebar) to pull live data from Plaid.",
      }
    }
    if (lastSyncResult.status === 'error') {
      return { kind: 'error', message: lastSyncResult.error || 'Sync failed.' }
    }
    const failed = (lastSyncResult.results || []).filter(r => r.status === 'error')
    if (failed.length > 0) {
      return {
        kind: 'partial',
        message: `${failed.length} item${failed.length === 1 ? '' : 's'} failed to sync. Most common cause: the Plaid auth token expired and the institution needs reconnecting on the Connect Accounts page.`,
        details: failed.map(f => `${f.item_id || 'item'}: ${f.error}`),
      }
    }
    if ((lastSyncResult.results || []).length === 0) {
      return {
        kind: 'empty',
        message: "No Plaid items connected. Connect your accounts on the Connect Accounts page first.",
      }
    }
    return {
      kind: 'ok',
      message: `Synced ${lastSyncResult.results.length} item${lastSyncResult.results.length === 1 ? '' : 's'}.`,
    }
  })()

  if (loading && investmentAccounts.length === 0) {
    return (
      <div style={{ padding: 14, color: 'var(--text-muted)', fontSize: 12 }}>
        <Loader2 size={12} style={{ animation: 'spin 1s linear infinite' }} /> Checking sync state…
      </div>
    )
  }

  if (investmentAccounts.length === 0) return null

  const today = new Date()
  // Use the most-recent-transaction date per account as the "data through"
  // marker — that's the actual freshness of the trading-tax computation,
  // separate from the more general balance-snapshot timestamp.
  const rows = investmentAccounts.map(a => {
    const lastTxnStr = lastTxnByAccount[a.id]
    const balanceStr = a.balance_as_of
    // Use whichever is fresher — the balance-snapshot date or the
    // last-transaction date. Plaid updates balances on every sync but
    // transactions only when there's actual activity, so the txn date
    // can lag for a sleepy account.
    const candidates = [lastTxnStr, balanceStr].filter(Boolean)
    const mostRecent = candidates.length
      ? candidates.reduce((a, b) => (a > b ? a : b))
      : null
    const daysStale = mostRecent
      ? Math.floor((today - new Date(mostRecent + 'T12:00:00')) / (1000 * 60 * 60 * 24))
      : null
    const tier = classifyFreshness(daysStale)
    return {
      account: a,
      lastTxn: lastTxnStr,
      balanceAsOf: balanceStr,
      mostRecent,
      daysStale,
      tier,
    }
  })
  // Sort stalest first so the user's eye lands on the problem account.
  rows.sort((a, b) => (b.daysStale || 0) - (a.daysStale || 0))

  const hasStale = rows.some(r => r.tier === 'stale' || r.tier === 'very_stale')

  return (
    <div style={{
      padding: 14,
      background: hasStale ? 'var(--accent-orange-bg)' : 'var(--bg-card)',
      border: `1px solid ${hasStale ? 'var(--accent-orange-border)' : 'var(--border-color, rgba(255,255,255,0.08))'}`,
      borderLeft: `3px solid ${hasStale ? 'var(--accent-orange)' : 'var(--accent-blue)'}`,
      borderRadius: 8,
      marginBottom: 16,
    }}>
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start',
        gap: 12, marginBottom: 10,
      }}>
        <div>
          <div style={{
            fontSize: 12, fontWeight: 700, letterSpacing: 0.4,
            textTransform: 'uppercase',
            color: hasStale ? 'var(--accent-orange)' : 'var(--accent-blue)',
            display: 'flex', alignItems: 'center', gap: 6,
          }}>
            <Clock size={12} /> Data freshness
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 4, lineHeight: 1.4 }}>
            {hasStale
              ? "One or more investment accounts are stale. Wash-sale detection and YTD numbers won't reflect recent trades until you sync."
              : "Investment account data is recent. Trading-tax numbers reflect what's been pulled from your brokers."}
          </div>
        </div>
        <button
          onClick={handleSync}
          disabled={syncing}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 6,
            padding: '6px 12px', fontSize: 12, fontWeight: 600,
            background: hasStale ? 'var(--accent-orange)' : 'var(--accent-blue)',
            color: '#0d0e14',
            border: 'none', borderRadius: 4,
            cursor: syncing ? 'wait' : 'pointer',
            whiteSpace: 'nowrap',
          }}
        >
          {syncing ? (
            <><Loader2 size={12} style={{ animation: 'spin 1s linear infinite' }} /> Syncing…</>
          ) : syncJustCompleted ? (
            <><CheckCircle size={12} /> Synced</>
          ) : (
            <><RefreshCw size={12} /> Sync now</>
          )}
        </button>
      </div>
      {/* Persistent demo-mode notice (independent of sync clicks). */}
      {isDemo && (
        <div style={{
          padding: '8px 10px', marginBottom: 8, fontSize: 11,
          background: 'rgba(251,146,60,0.12)',
          border: '1px solid rgba(251,146,60,0.4)',
          borderRadius: 4, color: 'var(--text-primary)',
          display: 'flex', alignItems: 'flex-start', gap: 6,
        }}>
          <Info size={11} style={{ color: 'var(--accent-orange)', flexShrink: 0, marginTop: 2 }} />
          <span>
            <strong style={{ color: 'var(--accent-orange)' }}>Demo mode:</strong>{' '}
            Sync Now is a no-op against synthetic data. Switch to Real mode in the sidebar to pull live data from Plaid.
          </span>
        </div>
      )}

      {/* Per-sync diagnostic — surfaces the result of the most recent
          Sync Now click so silent failures (token expired, demo no-op,
          partial item errors) are visible. */}
      {syncDiagnostic && (
        <div style={{
          padding: '8px 10px', marginBottom: 8, fontSize: 11,
          background: syncDiagnostic.kind === 'ok' ? 'var(--accent-green-bg)'
            : syncDiagnostic.kind === 'demo' ? 'var(--accent-orange-bg)'
            : syncDiagnostic.kind === 'empty' ? 'var(--accent-blue-bg)'
            : 'var(--accent-red-bg, rgba(248,113,113,0.12))',
          border: `1px solid ${syncDiagnostic.kind === 'ok' ? 'var(--accent-green-border)'
            : syncDiagnostic.kind === 'demo' ? 'var(--accent-orange-border)'
            : syncDiagnostic.kind === 'empty' ? 'var(--accent-blue-border)'
            : 'rgba(248,113,113,0.4)'}`,
          borderRadius: 4, color: 'var(--text-primary)',
          display: 'flex', alignItems: 'flex-start', gap: 6,
        }}>
          {syncDiagnostic.kind === 'ok'
            ? <CheckCircle size={11} style={{ color: 'var(--accent-green)', flexShrink: 0, marginTop: 2 }} />
            : <AlertTriangle size={11} style={{ color: 'var(--accent-orange)', flexShrink: 0, marginTop: 2 }} />}
          <div>
            {syncDiagnostic.message}
            {syncDiagnostic.details && (
              <ul style={{
                margin: '4px 0 0 16px', padding: 0,
                color: 'var(--text-muted)', fontSize: 10,
              }}>
                {syncDiagnostic.details.map((d, i) => <li key={i}>{d}</li>)}
              </ul>
            )}
          </div>
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8 }}>
        {rows.map(r => (
          <div key={r.account.id} style={{
            display: 'grid',
            gridTemplateColumns: '1fr auto auto',
            gap: 12, alignItems: 'center',
            padding: '6px 10px',
            background: 'var(--bg-input)',
            borderRadius: 4,
            fontSize: 12,
          }}>
            <div>
              <span style={{ fontWeight: 500, color: 'var(--text-primary)' }}>
                {r.account.custom_name || r.account.name}
              </span>
              <span style={{ color: 'var(--text-muted)', marginLeft: 8, fontSize: 11 }}>
                {r.account.institution_name}
                {r.account.plaid_item_id ? '' : ' · manual'}
              </span>
            </div>
            <div style={{ color: 'var(--text-muted)', fontSize: 11 }}>
              {r.mostRecent ? `data through ${formatDate(r.mostRecent)}` : 'no data'}
            </div>
            <div style={{
              display: 'flex', alignItems: 'center', gap: 4,
              color: freshnessColor(r.tier),
              fontWeight: 600, fontSize: 11,
            }}>
              {(r.tier === 'stale' || r.tier === 'very_stale') && <AlertTriangle size={11} />}
              {r.tier === 'fresh' && <CheckCircle size={11} />}
              {freshnessLabel(r.tier, r.daysStale)}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
