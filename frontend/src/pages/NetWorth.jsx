import { useState, useEffect, useMemo } from 'react'
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  ReferenceDot, Line,
} from 'recharts'
import { Plus, Pencil, Trash2, ExternalLink, Home, Car, Gem, Package, GraduationCap, Banknote, Receipt, CreditCard, AlertTriangle, CheckCircle } from 'lucide-react'
import { useSearchParams } from 'react-router-dom'
import {
  getNetWorthHistory, getManualAssets,
  createManualAsset, updateManualAsset, deleteManualAsset,
  getDebtPayoff, getNetWorthProjection, getNetWorthYoy,
} from '../api/client'
import AccountFreshness from '../components/AccountFreshness'
import Stat from '../components/Stat'
import Pill from '../components/Pill'
import { useIsMobile } from '../hooks/useIsMobile'
import { formatCurrencyZero as formatCurrency } from '../lib/format'
import { useAccounts } from '../hooks/useAccounts'
import { useLatestRequest } from '../hooks/useLatestRequest'

function daysSince(isoDate) {
  if (!isoDate) return null
  const then = new Date(isoDate + 'T00:00:00')
  const now = new Date()
  return Math.floor((now - then) / (1000 * 60 * 60 * 24))
}

// Type options are split by side so the dropdown shows relevant options only.
// Mixed into one map to keep iconFor() simple.
const ASSET_TYPE_OPTIONS = [
  { value: 'real_estate', label: 'Real estate', Icon: Home },
  { value: 'vehicle', label: 'Vehicle', Icon: Car },
  { value: 'collectible', label: 'Collectible', Icon: Gem },
  { value: 'other', label: 'Other', Icon: Package },
]

const LIABILITY_TYPE_OPTIONS = [
  { value: 'student_loan', label: 'Student loan', Icon: GraduationCap },
  { value: 'auto_loan', label: 'Auto loan', Icon: Car },
  { value: 'personal_loan', label: 'Personal loan', Icon: Banknote },
  { value: 'tax_bill', label: 'Tax bill', Icon: Receipt },
  { value: 'other', label: 'Other', Icon: Package },
]

function optionsFor(side) {
  return side === 'liability' ? LIABILITY_TYPE_OPTIONS : ASSET_TYPE_OPTIONS
}

function iconFor(type) {
  const all = [...ASSET_TYPE_OPTIONS, ...LIABILITY_TYPE_OPTIONS]
  const opt = all.find(o => o.value === type)
  return opt ? opt.Icon : Package
}

export default function NetWorth() {
  const isMobile = useIsMobile()
  const [history, setHistory] = useState([])
  const { accounts, refresh: refreshAccounts } = useAccounts()
  const [manualAssets, setManualAssets] = useState([])
  const [days, setDays] = useState(90)
  const [editingAsset, setEditingAsset] = useState(null) // null | "new" | asset object | { prefillMortgageId }
  const [searchParams, setSearchParams] = useSearchParams()
  const [projectionData, setProjectionData] = useState(null)
  const [showProjection, setShowProjection] = useState(false)
  const [yoyData, setYoyData] = useState(null)
  const [showYoy, setShowYoy] = useState(false)

  const reload = () => {
    getNetWorthHistory(days).then(setHistory).catch(() => [])
    refreshAccounts()
    getManualAssets().then(setManualAssets).catch(() => [])
  }

  const runHistory = useLatestRequest()
  useEffect(() => {
    // Guard against a slow response for a previously-selected range
    // (e.g. rapid 30d→1y→90d clicks) rendering under the new range.
    runHistory(token => {
      getNetWorthHistory(days).then(d => { if (token.live) setHistory(d) }).catch(() => [])
      getManualAssets().then(d => { if (token.live) setManualAssets(d) }).catch(() => [])
    })
  }, [days])

  useEffect(() => {
    if (showProjection) {
      getNetWorthProjection(12).then(setProjectionData).catch(() => setProjectionData(null))
    }
  }, [showProjection])

  // Year-over-year overlay — fetched on demand. Each row pairs today's
  // date with the net worth value from ~365 days earlier so the chart
  // can render two stacked area/line trajectories without time-shifting.
  useEffect(() => {
    if (showYoy && !yoyData) {
      getNetWorthYoy().then(setYoyData).catch(() => setYoyData(null))
    }
  }, [showYoy])

  // Merge YoY data into the history array on the matching date so
  // Recharts renders both series with the same x-axis. The new field
  // `prior_year` will be undefined on dates where no prior-year
  // snapshot exists; Recharts handles gaps naturally.
  const chartHistory = useMemo(() => {
    if (!showYoy || !yoyData?.prior_year?.length) return history
    const priorMap = new Map(yoyData.prior_year.map(r => [r.date, r.value]))
    return history.map(h => ({ ...h, prior_year: priorMap.get(h.date) }))
  }, [history, yoyData, showYoy])

  // Cross-page deep-link: /net-worth?pair=<mortgage account id> opens the
  // modal pre-bound to that mortgage. Clears the param after handling so
  // refreshing the page doesn't re-open the modal.
  useEffect(() => {
    const pairId = searchParams.get('pair')
    if (!pairId) return
    const acctId = parseInt(pairId)
    if (!acctId) return
    // If a manual asset is already paired with this mortgage, edit it.
    // Otherwise open a fresh-create with the mortgage pre-selected so the
    // address auto-fills.
    const existing = manualAssets.find(a => a.plaid_mortgage_account_id === acctId)
    setEditingAsset(existing ? existing : { prefillMortgageId: acctId })
    searchParams.delete('pair')
    setSearchParams(searchParams, { replace: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams, manualAssets])

  const bankAssets = accounts.filter(a => a.type !== 'credit' && a.type !== 'loan')
  const bankLiabilities = accounts.filter(a => a.type === 'credit' || a.type === 'loan')
  const manualAssetRows = manualAssets.filter(a => (a.side || 'asset') === 'asset')
  const manualLiabilityRows = manualAssets.filter(a => a.side === 'liability')

  // Compute current totals from live data, including manual assets and liabilities.
  const totalBankAssets = bankAssets.reduce((sum, a) => sum + (a.current_balance || 0), 0)
  const totalManualAssets = manualAssetRows.reduce((sum, a) => sum + (a.current_value || 0), 0)
  const totalBankLiabilities = bankLiabilities.reduce((sum, a) => sum + Math.abs(a.current_balance || 0), 0)
  const totalManualLiabilities = manualLiabilityRows.reduce((sum, a) => sum + Math.abs(a.current_value || 0), 0)
  const totalAssets = totalBankAssets + totalManualAssets
  const totalLiabilities = totalBankLiabilities + totalManualLiabilities
  const netWorth = totalAssets - totalLiabilities

  const latest = history[history.length - 1]
  const first = history[0]
  const change = latest && first ? latest.net_worth - first.net_worth : 0

  // Mortgage accounts the user might want to pair with a home asset.
  const mortgageAccounts = useMemo(() =>
    accounts.filter(a => a.type === 'loan' && (a.subtype || '').toLowerCase().includes('mortgage')),
    [accounts]
  )

  // Manual liabilities (auto loans, personal loans) a vehicle/other asset
  // could be paired with via the new paired_manual_liability_id FK.
  const manualLiabilities = useMemo(() =>
    manualAssets.filter(a => a.side === 'liability'),
    [manualAssets]
  )

  const handleSave = async (form) => {
    try {
      if (form.id) {
        await updateManualAsset(form.id, {
          name: form.name,
          side: form.side,
          type: form.type,
          current_value: parseFloat(form.current_value),
          value_as_of: form.value_as_of || null,
          notes: form.notes || null,
          address_street: form.address_street || null,
          address_city: form.address_city || null,
          address_region: form.address_region || null,
          address_postal_code: form.address_postal_code || null,
          plaid_mortgage_account_id: form.plaid_mortgage_account_id || null,
          paired_manual_liability_id: form.paired_manual_liability_id || null,
        })
      } else {
        await createManualAsset({
          name: form.name,
          side: form.side,
          type: form.type,
          current_value: parseFloat(form.current_value),
          value_as_of: form.value_as_of || undefined,
          notes: form.notes || undefined,
          address_street: form.address_street || undefined,
          address_city: form.address_city || undefined,
          address_region: form.address_region || undefined,
          address_postal_code: form.address_postal_code || undefined,
          plaid_mortgage_account_id: form.plaid_mortgage_account_id || undefined,
          paired_manual_liability_id: form.paired_manual_liability_id || undefined,
        })
      }
      setEditingAsset(null)
      reload()
    } catch (e) {
      alert(`Save failed: ${e.message || 'unknown error'}`)
    }
  }

  const handleDelete = async (id) => {
    if (!confirm('Delete this asset? This cannot be undone.')) return
    await deleteManualAsset(id)
    reload()
  }

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">Net Worth</h1>
        <div style={{ display: 'flex', gap: 8 }}>
          {[30, 90, 365, 1095].map(d => (
            <button
              key={d}
              className={`btn ${days === d ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => setDays(d)}
              style={{ padding: '6px 14px', fontSize: 13 }}
            >
              {d <= 90 ? `${d}D` : `${Math.round(d / 365)}Y`}
            </button>
          ))}
        </div>
      </div>

      <div className="stats-grid">
        <Stat
          label="Net Worth"
          value={formatCurrency(netWorth)}
          tone={netWorth >= 0 ? 'positive' : 'negative'}
        />
        <Stat
          label="Assets"
          value={formatCurrency(totalAssets)}
          tone="positive"
        />
        <Stat
          label="Liabilities"
          value={formatCurrency(totalLiabilities)}
          tone="negative"
        />
        <Stat
          label={`Change (${days}d)`}
          value={`${change >= 0 ? '+' : ''}${formatCurrency(change)}`}
          tone={change >= 0 ? 'positive' : 'negative'}
        />
      </div>

      {/* Recent movement callouts — independent of the selected `days`
          range so the user always sees week / month / quarter / year
          context at a glance. Falls back gracefully when the snapshot
          history doesn't go back that far. */}
      <RecentMovementStrip history={history} latestNetWorth={latest?.net_worth ?? netWorth} />

      {/* Chart */}
      <div className="card" style={{ marginBottom: 24 }}>
        <div className="card-header">
          <span className="card-title">Net Worth Over Time</span>
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 14 }}>
            <label style={{ fontSize: 'var(--text-xs)', color: 'var(--text-secondary)', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <input type="checkbox" checked={showYoy} onChange={e => setShowYoy(e.target.checked)} />
              YoY overlay
            </label>
            <label style={{ fontSize: 'var(--text-xs)', color: 'var(--text-secondary)', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <input type="checkbox" checked={showProjection} onChange={e => setShowProjection(e.target.checked)} />
              show projection
            </label>
          </div>
        </div>

        {/* Empty-state banners — when the toggle is on but the underlying
            response had no usable data (no snapshots from a year ago for
            YoY, not enough history for projection), tell the user instead
            of silently doing nothing. The toggle previously looked broken. */}
        {showYoy && yoyData && (!yoyData.prior_year || yoyData.prior_year.length === 0) && (
          <div style={{
            padding: '8px 12px', marginBottom: 12,
            background: 'rgba(96,165,250,0.08)',
            border: '1px solid rgba(96,165,250,0.25)',
            borderRadius: 6, fontSize: 12, color: 'var(--text-secondary)',
          }}>
            No net-worth snapshots from a year ago — YoY overlay needs ~365 days of history.
            Snapshots accumulate as your accounts sync over time.
          </div>
        )}
        {showProjection && projectionData && (!projectionData.projected || projectionData.projected.length === 0) && (
          <div style={{
            padding: '8px 12px', marginBottom: 12,
            background: 'rgba(96,165,250,0.08)',
            border: '1px solid rgba(96,165,250,0.25)',
            borderRadius: 6, fontSize: 12, color: 'var(--text-secondary)',
          }}>
            {projectionData.reason || 'Not enough net-worth history to project. Need at least 2 snapshots.'}
          </div>
        )}
        {history.length > 1 ? (
          <>
            <ResponsiveContainer width="100%" height={isMobile ? 240 : 350}>
              <AreaChart
                data={showProjection && projectionData ? [...chartHistory, ...projectionData.projected] : chartHistory}
                margin={isMobile
                  ? { top: 8, right: 4, left: -8, bottom: 0 }
                  : { top: 8, right: 12, left: 0, bottom: 0 }}
              >
              <defs>
                <linearGradient id="nwGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#34d399" stopOpacity={0.3} />
                  <stop offset="95%" stopColor="#34d399" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
              <XAxis
                dataKey="date"
                stroke="var(--text-muted)"
                fontSize={isMobile ? 10 : 12}
                interval={isMobile ? 'preserveStartEnd' : 'preserveEnd'}
                minTickGap={isMobile ? 30 : 5}
              />
              <YAxis
                stroke="var(--text-muted)"
                fontSize={isMobile ? 10 : 12}
                tickFormatter={v => `$${(v / 1000).toFixed(0)}k`}
                width={isMobile ? 40 : 60}
              />
              <Tooltip
                formatter={(val) => formatCurrency(val)}
                contentStyle={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 8 }}
              />
              <Area type="monotone" dataKey="net_worth" stroke="#34d399" fill="url(#nwGrad)" strokeWidth={2} name="Net Worth" />
              {/* YoY overlay — anchored to today's dates so the user sees
                  "where you were a year ago" at every point. Solid muted
                  line, no fill, so it doesn't compete visually with the
                  primary series. */}
              {showYoy && (
                <Line
                  type="monotone"
                  dataKey="prior_year"
                  stroke="var(--text-secondary)"
                  strokeWidth={1.5}
                  strokeDasharray="4 4"
                  dot={false}
                  name="1 year ago"
                  connectNulls
                />
              )}
              {/* Milestone markers — first time net worth crossed each
                  round-dollar threshold ($100k, $250k, $500k, $1M, etc.).
                  Computed in-place from the history array; rendered as
                  small green dots with a label. Highlights the journey. */}
              {(() => {
                const thresholds = [50000, 100000, 250000, 500000, 1000000, 2000000, 5000000, 10000000]
                const milestones = []
                let prev = history[0]?.net_worth ?? 0
                for (let i = 1; i < history.length; i++) {
                  const cur = history[i].net_worth
                  for (const t of thresholds) {
                    if (prev < t && cur >= t) {
                      milestones.push({ date: history[i].date, value: cur, threshold: t })
                    }
                  }
                  prev = cur
                }
                return milestones.map((m, i) => (
                  <ReferenceDot key={`ms-${i}`}
                    x={m.date} y={m.value}
                    r={5} fill="#34d399" stroke="#0f1117" strokeWidth={2}
                    label={{
                      value: m.threshold >= 1_000_000
                        ? `$${m.threshold / 1_000_000}M`
                        : `$${m.threshold / 1000}k`,
                      position: 'top', fill: '#34d399',
                      fontSize: 10, fontWeight: 600,
                    }}
                  />
                ))
              })()}
            </AreaChart>
            </ResponsiveContainer>
            {showProjection && projectionData && projectionData.monthly_pace !== null && (
              <div style={{
                padding: '12px 16px',
                borderTop: '1px solid var(--border)',
                fontSize: 'var(--text-xs)',
                color: 'var(--text-secondary)',
              }}>
                Projected at {formatCurrency(projectionData.monthly_pace)}/mo pace · {projectionData.confidence} confidence
              </div>
            )}
          </>
        ) : (
          <p style={{ textAlign: 'center', color: 'var(--text-muted)', padding: 60 }}>
            Net worth history will build over time as your accounts sync.
          </p>
        )}
      </div>

      {/* The long-horizon retirement projection used to live here. It
          grew into a substantial feature (per-bucket withdrawal sim,
          staged income, RMDs, healthcare bridge, dual real/nominal
          chart, etc.) and now has its own dedicated tab — see
          /retirement / pages/Retirement.jsx. */}

      {/* Account breakdown */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        <div className="card">
          <div className="card-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span className="card-title">Assets</span>
            <button
              className="btn btn-secondary"
              onClick={() => setEditingAsset({ newSide: 'asset' })}
              style={{ padding: '4px 10px', fontSize: 12 }}
            >
              <Plus size={12} /> Manual asset
            </button>
          </div>
          <table style={{ width: '100%' }}>
            <tbody>
              {bankAssets.map(a => (
                <tr key={`bank-${a.id}`}>
                  <td>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span>{a.custom_name || a.name}</span>
                      {a.is_manual && <Pill title="User-tracked, not synced from a bank">Manual</Pill>}
                    </div>
                    <div style={{ fontSize: 12, color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
                      {a.institution_name && <span>{a.institution_name}</span>}
                      <AccountFreshness account={a} />
                    </div>
                  </td>
                  <td style={{ textAlign: 'right' }}><span className="amount-positive">{formatCurrency(a.current_balance)}</span></td>
                </tr>
              ))}
              {manualAssetRows.map(ma => {
                const Icon = iconFor(ma.type)
                const stale = daysSince(ma.value_as_of)
                const stalePill = stale === null ? null : (
                  <span style={{
                    fontSize: 10, padding: '2px 6px', borderRadius: 4,
                    color: stale > 180 ? '#fb923c' : 'var(--text-muted)',
                    background: stale > 180 ? 'rgba(251,146,60,0.1)' : 'transparent',
                    border: stale > 180 ? '1px solid rgba(251,146,60,0.3)' : 'none',
                    marginLeft: 6,
                  }}>
                    valued {stale === 0 ? 'today' : `${stale}d ago`}
                  </span>
                )
                // If this asset is paired with a manual liability (e.g.,
                // a vehicle paired with its auto loan), look up the
                // liability so we can render the equity inline.
                const pairedLiability = ma.paired_manual_liability_id
                  ? manualAssets.find(a => a.id === ma.paired_manual_liability_id && a.side === 'liability')
                  : null
                const equity = pairedLiability
                  ? (ma.current_value || 0) - (pairedLiability.current_value || 0)
                  : null
                return (
                  <tr key={`manual-${ma.id}`}>
                    <td>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <Icon size={14} style={{ color: 'var(--text-muted)' }} />
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ display: 'flex', alignItems: 'center' }}>
                            {ma.name}
                            {stalePill}
                          </div>
                          <div style={{ fontSize: 12, color: 'var(--text-muted)', display: 'flex', gap: 8, alignItems: 'center' }}>
                            <span>Manual · {ma.type.replace('_', ' ')}</span>
                            <button onClick={() => setEditingAsset(ma)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', padding: 0 }} title="Edit"><Pencil size={11} /></button>
                            <button onClick={() => handleDelete(ma.id)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', padding: 0 }} title="Delete"><Trash2 size={11} /></button>
                          </div>
                          {pairedLiability && (
                            <div style={{
                              fontSize: 11, marginTop: 2,
                              display: 'flex', gap: 6, alignItems: 'center',
                              color: 'var(--text-secondary)',
                            }}>
                              <span>↔ Loan: {formatCurrency(pairedLiability.current_value)} owed</span>
                              <span style={{ color: 'var(--text-muted)' }}>·</span>
                              <span style={{
                                color: equity >= 0 ? 'var(--accent-green)' : 'var(--accent-red)',
                                fontWeight: 500,
                              }}>
                                Equity {formatCurrency(equity)}
                              </span>
                            </div>
                          )}
                        </div>
                      </div>
                    </td>
                    <td style={{ textAlign: 'right' }}><span className="amount-positive">{formatCurrency(ma.current_value)}</span></td>
                  </tr>
                )
              })}
              {bankAssets.length === 0 && manualAssets.length === 0 && (
                <tr><td colSpan={2} style={{ textAlign: 'center', color: 'var(--text-muted)' }}>No assets yet</td></tr>
              )}
            </tbody>
          </table>
        </div>
        <div className="card">
          <div className="card-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span className="card-title">Liabilities</span>
            <button
              className="btn btn-secondary"
              onClick={() => setEditingAsset({ newSide: 'liability' })}
              style={{ padding: '4px 10px', fontSize: 12 }}
            >
              <Plus size={12} /> Manual liability
            </button>
          </div>
          <table style={{ width: '100%' }}>
            <tbody>
              {bankLiabilities.map(a => (
                <tr key={`bank-${a.id}`}>
                  <td>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span>{a.custom_name || a.name}</span>
                      {a.is_manual && <Pill title="User-tracked, not synced from a bank">Manual</Pill>}
                    </div>
                    <div style={{ fontSize: 12, color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
                      {a.institution_name && <span>{a.institution_name}</span>}
                      <AccountFreshness account={a} />
                    </div>
                  </td>
                  <td style={{ textAlign: 'right' }}><span className="amount-negative">{formatCurrency(Math.abs(a.current_balance))}</span></td>
                </tr>
              ))}
              {manualLiabilityRows.map(ml => {
                const Icon = iconFor(ml.type)
                const stale = daysSince(ml.value_as_of)
                const stalePill = stale === null ? null : (
                  <span style={{
                    fontSize: 10, padding: '2px 6px', borderRadius: 4,
                    color: stale > 180 ? '#fb923c' : 'var(--text-muted)',
                    background: stale > 180 ? 'rgba(251,146,60,0.1)' : 'transparent',
                    border: stale > 180 ? '1px solid rgba(251,146,60,0.3)' : 'none',
                    marginLeft: 6,
                  }}>
                    valued {stale === 0 ? 'today' : `${stale}d ago`}
                  </span>
                )
                return (
                  <tr key={`manual-liab-${ml.id}`}>
                    <td>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <Icon size={14} style={{ color: 'var(--text-muted)' }} />
                        <div>
                          <div style={{ display: 'flex', alignItems: 'center' }}>
                            {ml.name}
                            {stalePill}
                          </div>
                          <div style={{ fontSize: 12, color: 'var(--text-muted)', display: 'flex', gap: 8, alignItems: 'center' }}>
                            <span>Manual · {ml.type.replace('_', ' ')}</span>
                            <button onClick={() => setEditingAsset(ml)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', padding: 0 }} title="Edit"><Pencil size={11} /></button>
                            <button onClick={() => handleDelete(ml.id)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', padding: 0 }} title="Delete"><Trash2 size={11} /></button>
                          </div>
                        </div>
                      </div>
                    </td>
                    <td style={{ textAlign: 'right' }}><span className="amount-negative">{formatCurrency(Math.abs(ml.current_value))}</span></td>
                  </tr>
                )
              })}
              {bankLiabilities.length === 0 && manualLiabilityRows.length === 0 && (
                <tr><td colSpan={2} style={{ textAlign: 'center', color: 'var(--text-muted)' }}>No liabilities</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Debt payoff section */}
      <DebtPayoffSection />

      {editingAsset !== null && (
        <ManualAssetModal
          initial={
            editingAsset === 'new'
              || (editingAsset && (editingAsset.prefillMortgageId || editingAsset.newSide))
              ? null
              : editingAsset
          }
          prefillMortgageId={editingAsset && editingAsset.prefillMortgageId}
          initialSide={editingAsset && editingAsset.newSide}
          mortgageAccounts={mortgageAccounts}
          manualLiabilities={manualLiabilities}
          onClose={() => setEditingAsset(null)}
          onSave={handleSave}
        />
      )}
    </div>
  )
}


/**
 * RecentMovementStrip — at-a-glance "where am I vs last week / month /
 * quarter / year" deltas.
 *
 * Common-account math (load-bearing): the raw `net_worth` field on
 * each snapshot is the sum of WHATEVER accounts existed on that day.
 * If the user onboarded a $200k 401(k) on day 5, comparing day-7 to
 * day-1 would double-count that $200k as "growth" — but it isn't
 * growth, it's just an account that's now visible. Tusk Ledger's
 * first week of use is exactly when this happens (lots of accounts
 * being connected), so the bug surfaces immediately for new users.
 *
 * Fix: compute the delta on the INTERSECTION of accounts present in
 * BOTH snapshots. NetWorthSnapshot.account_balances stores
 * `{account_id: balance}` per day, so the math is just:
 *
 *     common_ids = keys(latest) ∩ keys(baseline)
 *     delta = sum(latest[id] for id in common_ids)
 *           - sum(baseline[id] for id in common_ids)
 *
 * When the account set differs we surface "+N new accounts since" so
 * the user can see both the honest market/balance change AND that
 * more accounts are now being tracked. Old snapshots from before the
 * account_balances column existed fall back to the raw net_worth diff
 * with a small "noisy baseline" tag.
 *
 * Lookups use the latest snapshot on or before the target date so
 * weekends/holidays don't produce false misses.
 */
function RecentMovementStrip({ history, latestNetWorth }) {
  if (!history || history.length === 0) return null

  const sorted = [...history].sort((a, b) => a.date.localeCompare(b.date))
  const latest = sorted[sorted.length - 1]
  const today = new Date()

  const findSnapshotOnOrBefore = (daysAgo) => {
    const cutoff = new Date(today)
    cutoff.setDate(cutoff.getDate() - daysAgo)
    const cutoffStr = cutoff.toISOString().slice(0, 10)
    let candidate = null
    for (const s of sorted) {
      if (s.date <= cutoffStr) candidate = s
      else break
    }
    return candidate
  }

  const computeWindow = (baseline) => {
    if (!baseline) return null
    const lb = latest.account_balances
    const bb = baseline.account_balances
    if (!lb || !bb) {
      // Old snapshot lacks the per-account JSON — best we can do is
      // the raw diff, but tag it so the UI can warn the user.
      const delta = latest.net_worth - baseline.net_worth
      const pct = baseline.net_worth ? (delta / Math.abs(baseline.net_worth)) * 100 : null
      return {
        delta, pct,
        accounts_added: 0,
        missing_balances: true,
        baseline_date: baseline.date,
      }
    }
    const baselineIds = new Set(Object.keys(bb))
    const latestIds = new Set(Object.keys(lb))
    let common_baseline_total = 0
    let common_latest_total = 0
    for (const id of baselineIds) {
      if (latestIds.has(id)) {
        common_baseline_total += Number(bb[id]) || 0
        common_latest_total += Number(lb[id]) || 0
      }
    }
    // Accounts that DISAPPEARED from latest (closed/disconnected) are
    // implicitly excluded from the delta by the common-set math, which
    // is what we want — a closed account shouldn't count as a loss.
    const added = [...latestIds].filter(id => !baselineIds.has(id)).length
    const delta = common_latest_total - common_baseline_total
    const pct = common_baseline_total
      ? (delta / Math.abs(common_baseline_total)) * 100
      : null
    return {
      delta, pct,
      accounts_added: added,
      missing_balances: false,
      baseline_date: baseline.date,
    }
  }

  const windows = [
    { label: '7 days', daysAgo: 7 },
    { label: '30 days', daysAgo: 30 },
    { label: '90 days', daysAgo: 90 },
    { label: '1 year', daysAgo: 365 },
  ]

  const computed = windows.map(w => ({
    ...w,
    result: computeWindow(findSnapshotOnOrBefore(w.daysAgo)),
  }))
  const anyAvailable = computed.some(w => w.result !== null)
  if (!anyAvailable) return null

  return (
    <div className="card" style={{
      marginBottom: 24, padding: 14,
    }}>
      <div style={{
        fontSize: 11, color: 'var(--text-muted)',
        textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 10,
        display: 'flex', alignItems: 'baseline', flexWrap: 'wrap', gap: 8,
      }}>
        <span>Recent movement</span>
        <span style={{
          textTransform: 'none', letterSpacing: 0,
          fontSize: 11, fontWeight: 400, color: 'var(--text-dim)',
        }}>
          deltas use accounts present in both snapshots, so newly
          onboarded accounts don't inflate the change
        </span>
      </div>
      <div style={{
        display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12,
      }}>
        {computed.map(w => {
          const r = w.result
          const delta = r ? r.delta : null
          const pct = r ? r.pct : null
          const tone = delta === null ? 'neutral' : delta >= 0 ? 'positive' : 'negative'
          const accent = tone === 'positive' ? 'var(--accent-green)'
            : tone === 'negative' ? 'var(--accent-red)'
            : 'var(--text-muted)'
          return (
            <div key={w.label} style={{
              borderLeft: `3px solid ${accent}`,
              paddingLeft: 12, paddingTop: 2, paddingBottom: 2,
            }}>
              <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>vs {w.label} ago</div>
              <div style={{
                fontSize: 18, fontWeight: 600, color: accent,
                fontVariantNumeric: 'tabular-nums', marginTop: 2,
                whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
              }}>
                {delta === null
                  ? '—'
                  : (delta >= 0 ? '+' : '') + formatCurrency(delta)}
              </div>
              {pct !== null && Math.abs(pct) > 0.01 && (
                <div style={{
                  fontSize: 11, color: 'var(--text-secondary)',
                  fontVariantNumeric: 'tabular-nums', marginTop: 1,
                }}>
                  {pct >= 0 ? '+' : ''}{pct.toFixed(1)}%
                </div>
              )}
              {r && r.accounts_added > 0 && (
                <div
                  title={`${r.accounts_added} account(s) added since ${r.baseline_date}. Their balances aren't included in this delta — that prevents onboarding from looking like growth.`}
                  style={{
                    fontSize: 10, color: 'var(--text-dim)', marginTop: 2,
                    fontStyle: 'italic',
                  }}>
                  +{r.accounts_added} new acct{r.accounts_added > 1 ? 's' : ''} since
                </div>
              )}
              {r && r.missing_balances && (
                <div
                  title="The baseline snapshot doesn't have a per-account breakdown — the delta may include accounts that didn't exist in the baseline."
                  style={{
                    fontSize: 10, color: 'var(--accent-orange, #fb923c)', marginTop: 2,
                    fontStyle: 'italic',
                  }}>
                  noisy baseline
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function DebtPayoffSection() {
  const [data, setData] = useState(null)
  useEffect(() => { getDebtPayoff().then(setData).catch(() => setData({ debts: [] })) }, [])

  if (!data) return <p style={{ color: 'var(--text-muted)', padding: 40, textAlign: 'center' }}>Loading…</p>

  const debts = data.debts ?? []
  const debtsWithProjection = debts.filter(d => d.months_remaining)
  const longestMonths = debtsWithProjection.length
    ? Math.max(...debtsWithProjection.map(d => d.months_remaining))
    : 0

  return (
    <div>
      <h2 style={{ fontSize: 18, fontWeight: 600, margin: '32px 0 16px' }}>Debt payoff</h2>

      <div className="stats-grid" style={{ marginBottom: 20 }}>
        <div className="stat-card">
          <div className="stat-label">Total balance</div>
          <div className="stat-value negative">{formatCurrency(data.total_balance)}</div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>
            across {data.count} liabilit{data.count === 1 ? 'y' : 'ies'}
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Monthly payments</div>
          <div className="stat-value">{formatCurrency(data.total_monthly_payments)}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Total interest remaining</div>
          <div className="stat-value negative">{formatCurrency(data.total_interest_remaining)}</div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>
            if you stay at minimums
          </div>
        </div>
      </div>

      {debts.length === 0 ? (
        <div className="card" style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)' }}>
          <CheckCircle size={28} style={{ color: 'var(--accent-green)', marginBottom: 12 }} />
          <h3 style={{ color: 'var(--text-primary)' }}>Debt-free</h3>
          <p>No active liabilities tracked.</p>
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(420px, 1fr))', gap: 16 }}>
          {debts.map(d => <DebtCard key={`${d.source}-${d.id}`} debt={d} longest={longestMonths} />)}
        </div>
      )}
    </div>
  )
}

function DebtCard({ debt, longest }) {
  const projected = !!debt.months_remaining
  const ratioOfLongest = projected && longest > 0 ? debt.months_remaining / longest : 0
  const kindLabel = ({
    mortgage: 'Mortgage',
    credit_card: 'Credit Card',
    auto_loan: 'Auto Loan',
    student_loan: 'Student Loan',
    loan: 'Loan',
    credit: 'Credit',
  }[debt.kind] || debt.kind || 'Liability')

  return (
    <div className="card">
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 10 }}>
        <div>
          <div style={{ fontWeight: 600, fontSize: 15 }}>{debt.name}</div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.4, marginTop: 2 }}>
            {kindLabel}{debt.institution ? ` · ${debt.institution}` : ''}{debt.mask ? ` · ••${debt.mask}` : ''}
            {debt.source === 'manual' && <span style={{ marginLeft: 6, color: 'var(--accent-orange)' }}>· Manual</span>}
          </div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div style={{ fontWeight: 700, color: 'var(--accent-red)', fontSize: 18 }}>
            {formatCurrency(debt.balance)}
          </div>
          {debt.annual_rate_pct !== null && debt.annual_rate_pct !== undefined && (
            <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
              {debt.annual_rate_pct.toFixed(2)}% APR
            </div>
          )}
        </div>
      </div>

      {/* Negative amortization warning */}
      {debt.negative_amortization && (
        <div style={{
          padding: '8px 10px', borderRadius: 6, marginBottom: 10,
          background: 'rgba(239,68,68,0.1)', color: 'var(--accent-red)',
          fontSize: 12, display: 'flex', alignItems: 'center', gap: 6,
        }}>
          <AlertTriangle size={12} />
          Minimum payment doesn't cover interest — balance is growing.
        </div>
      )}

      {/* Stat row */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 12, marginBottom: 12, fontSize: 13 }}>
        <div>
          <div style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.4 }}>
            Monthly payment
          </div>
          <div style={{ fontWeight: 600 }}>
            {debt.monthly_payment ? formatCurrency(debt.monthly_payment) : '—'}
          </div>
        </div>
        <div>
          <div style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.4 }}>
            Months remaining
          </div>
          <div style={{ fontWeight: 600 }}>
            {projected
              ? `${debt.months_remaining} mo (${(debt.months_remaining / 12).toFixed(1)} yrs)`
              : 'Need monthly payment'}
          </div>
        </div>
        <div>
          <div style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.4 }}>
            Payoff date
          </div>
          <div style={{ fontWeight: 600 }}>
            {debt.payoff_date || '—'}
          </div>
        </div>
        <div>
          <div style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.4 }}>
            Total interest
          </div>
          <div style={{ fontWeight: 600, color: debt.total_interest_remaining ? 'var(--accent-red)' : 'var(--text-primary)' }}>
            {debt.total_interest_remaining !== null && debt.total_interest_remaining !== undefined
              ? formatCurrency(debt.total_interest_remaining)
              : '—'}
          </div>
        </div>
      </div>

      {/* Time-to-payoff bar — relative to the longest debt */}
      {projected && (
        <div title="Bar length is relative to the longest-projected debt">
          <div style={{ height: 6, background: 'var(--bg-hover)', borderRadius: 3, overflow: 'hidden' }}>
            <div style={{
              width: `${Math.max(ratioOfLongest * 100, 2)}%`, height: '100%',
              background: debt.kind === 'mortgage' ? 'var(--accent-blue)'
                : debt.kind === 'credit_card' ? 'var(--accent-red)'
                : 'var(--accent-orange)',
              borderRadius: 3,
            }} />
          </div>
        </div>
      )}

      {debt.notes && (
        <div style={{ marginTop: 10, fontSize: 11, color: 'var(--text-muted)', borderTop: '1px solid var(--border)', paddingTop: 8 }}>
          {debt.notes}
        </div>
      )}
    </div>
  )
}


function ManualAssetModal({ initial, prefillMortgageId, initialSide, mortgageAccounts, manualLiabilities = [], onClose, onSave }) {
  const effectiveSide = (initial && initial.side) || initialSide || 'asset'
  const defaultType = effectiveSide === 'liability' ? 'student_loan' : 'real_estate'

  const [form, setForm] = useState(() => initial ? {
    id: initial.id,
    name: initial.name || '',
    side: initial.side || 'asset',
    type: initial.type || defaultType,
    current_value: initial.current_value ?? '',
    value_as_of: initial.value_as_of || '',
    notes: initial.notes || '',
    address_street: initial.address_street || '',
    address_city: initial.address_city || '',
    address_region: initial.address_region || '',
    address_postal_code: initial.address_postal_code || '',
    plaid_mortgage_account_id: initial.plaid_mortgage_account_id || '',
    paired_manual_liability_id: initial.paired_manual_liability_id || '',
  } : {
    id: null,
    name: '',
    side: effectiveSide,
    type: defaultType,
    current_value: '',
    value_as_of: new Date().toISOString().slice(0, 10),
    notes: '',
    address_street: '',
    address_city: '',
    address_region: '',
    address_postal_code: '',
    // Pre-bind to a mortgage when arriving via the deep-link from the
    // Accounts page; address auto-fill will then fire on first render.
    plaid_mortgage_account_id: prefillMortgageId || '',
    paired_manual_liability_id: '',
  })

  const typeOptions = optionsFor(form.side)

  // When the user picks a mortgage to pair with, auto-fill the address from that mortgage's
  // property fields (loaded lazily when the dropdown changes).
  useEffect(() => {
    if (!form.plaid_mortgage_account_id) return
    if (form.address_street) return // don't clobber what they already typed
    const apt = parseInt(form.plaid_mortgage_account_id)
    fetch(`/api/accounts/${apt}/mortgage`, { credentials: 'include' })
      .then(r => r.ok ? r.json() : null)
      .then(d => {
        if (!d) return
        setForm(f => ({
          ...f,
          address_street: f.address_street || d.property_street || '',
          address_city: f.address_city || d.property_city || '',
          address_region: f.address_region || d.property_region || '',
          address_postal_code: f.address_postal_code || d.property_postal_code || '',
          name: f.name || (d.property_street ? `Home — ${d.property_street}` : f.name),
        }))
      })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.plaid_mortgage_account_id])

  const addressForLookup = [form.address_street, form.address_city, form.address_region, form.address_postal_code]
    .filter(Boolean).join(', ')
  const zillowUrl = addressForLookup ? `https://www.zillow.com/homes/${encodeURIComponent(addressForLookup)}_rb/` : null
  const redfinUrl = addressForLookup ? `https://www.redfin.com/stingray/do/location-autocomplete?location=${encodeURIComponent(addressForLookup)}` : null

  const submit = (e) => {
    e.preventDefault()
    if (!form.name.trim() || !form.current_value) return
    onSave({
      ...form,
      plaid_mortgage_account_id: form.plaid_mortgage_account_id ? parseInt(form.plaid_mortgage_account_id) : null,
    })
  }

  return (
    <div
      onClick={onClose}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 900, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
    >
      <form
        onClick={e => e.stopPropagation()}
        onSubmit={submit}
        style={{
          background: 'var(--bg-card, #1e2130)',
          border: '1px solid var(--border, #2a2d3a)',
          borderRadius: 12,
          padding: 24,
          width: 'min(560px, 95vw)',
          maxHeight: '90vh',
          overflow: 'auto',
        }}
      >
        <h3 style={{ marginTop: 0 }}>
          {initial
            ? `Edit ${form.side === 'liability' ? 'liability' : 'asset'}`
            : `Add manual ${form.side === 'liability' ? 'liability' : 'asset'}`}
        </h3>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
          <Field label="Name" required>
            <input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })}
              placeholder={form.side === 'liability' ? 'e.g. Federal Student Loans' : 'e.g. Primary residence'}
              autoFocus style={FORM_INPUT_STYLE} />
          </Field>
          <Field label="Type">
            <select
              value={form.type}
              onChange={e => setForm({ ...form, type: e.target.value })}
              style={FORM_INPUT_STYLE}
            >
              {typeOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </Field>
          <Field label={form.side === 'liability' ? 'Current balance owed' : 'Current value'} required>
            <input type="number" step="0.01" value={form.current_value}
              onChange={e => setForm({ ...form, current_value: e.target.value })}
              placeholder={form.side === 'liability' ? '0.00' : '0.00'}
              style={FORM_INPUT_STYLE} />
          </Field>
          <Field label="Value as of">
            <input type="date" value={form.value_as_of}
              onChange={e => setForm({ ...form, value_as_of: e.target.value })} style={FORM_INPUT_STYLE} />
          </Field>
          {/* Mortgage pairing — only meaningful for real estate assets. */}
          {mortgageAccounts.length > 0 && form.side === 'asset' && form.type === 'real_estate' && (
            <Field label="Pair with mortgage" full>
              <select value={form.plaid_mortgage_account_id}
                onChange={e => setForm({ ...form, plaid_mortgage_account_id: e.target.value })}
                style={FORM_INPUT_STYLE}>
                <option value="">— None —</option>
                {mortgageAccounts.map(a => (
                  <option key={a.id} value={a.id}>
                    {a.custom_name || a.name} · {a.institution_name}
                  </option>
                ))}
              </select>
            </Field>
          )}

          {/* Manual liability pairing — for vehicles or "other" assets that
              have a corresponding loan tracked as a manual liability (auto
              loans usually live there because Plaid auto-loan integrations
              are flaky). Excludes the asset itself if it happens to be a
              liability being edited (can't pair to itself). */}
          {form.side === 'asset' && form.type !== 'real_estate' && manualLiabilities.length > 0 && (
            <Field label={`Pair with ${form.type === 'vehicle' ? 'auto loan' : 'loan'}`} full>
              <select value={form.paired_manual_liability_id}
                onChange={e => setForm({ ...form, paired_manual_liability_id: e.target.value })}
                style={FORM_INPUT_STYLE}>
                <option value="">— None —</option>
                {manualLiabilities
                  .filter(L => L.id !== form.id)  // can't pair to self
                  .map(L => (
                    <option key={L.id} value={L.id}>
                      {L.name} · ${(L.current_value || 0).toLocaleString()} owed
                    </option>
                  ))}
              </select>
            </Field>
          )}
          <Field label="Address (street)" full>
            <input value={form.address_street} onChange={e => setForm({ ...form, address_street: e.target.value })} style={FORM_INPUT_STYLE} />
          </Field>
          <Field label="City">
            <input value={form.address_city} onChange={e => setForm({ ...form, address_city: e.target.value })} style={FORM_INPUT_STYLE} />
          </Field>
          <Field label="State / Postal">
            <div style={{ display: 'flex', gap: 6 }}>
              <input value={form.address_region} onChange={e => setForm({ ...form, address_region: e.target.value })} placeholder="State" style={{ ...FORM_INPUT_STYLE, width: 60 }} />
              <input value={form.address_postal_code} onChange={e => setForm({ ...form, address_postal_code: e.target.value })} style={FORM_INPUT_STYLE} placeholder="ZIP" />
            </div>
          </Field>
          <Field label="Notes" full>
            <input value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })} style={FORM_INPUT_STYLE} />
          </Field>
        </div>

        {addressForLookup && form.type === 'real_estate' && (
          <div style={{ display: 'flex', gap: 8, marginBottom: 16, fontSize: 12, color: 'var(--text-secondary)', alignItems: 'center' }}>
            <span>Look up current value:</span>
            {zillowUrl && (
              <a href={zillowUrl} target="_blank" rel="noreferrer" style={{ display: 'inline-flex', alignItems: 'center', gap: 3, color: 'var(--accent-blue)' }}>
                Zillow <ExternalLink size={11} />
              </a>
            )}
            {redfinUrl && (
              <a href={redfinUrl} target="_blank" rel="noreferrer" style={{ display: 'inline-flex', alignItems: 'center', gap: 3, color: 'var(--accent-blue)' }}>
                Redfin <ExternalLink size={11} />
              </a>
            )}
          </div>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button type="button" onClick={onClose} className="btn btn-secondary">Cancel</button>
          <button type="submit" className="btn btn-primary">{initial ? 'Save' : 'Add asset'}</button>
        </div>
      </form>
    </div>
  )
}


function Field({ label, children, required, full }) {
  return (
    <label style={{
      gridColumn: full ? '1 / -1' : 'auto',
      display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: 'var(--text-secondary)',
    }}>
      <span>{label}{required && <span style={{ color: 'var(--accent-red)' }}> *</span>}</span>
      {children}
    </label>
  )
}

// Inline style for the modal form fields. Inlined per-element rather than
// using a className to keep this self-contained — saves touching index.css
// for a one-page feature.
const FORM_INPUT_STYLE = {
  background: 'var(--bg-primary, #15171f)',
  color: 'var(--text-primary, white)',
  border: '1px solid var(--border, #2a2d3a)',
  borderRadius: 6,
  padding: '6px 10px',
  fontSize: 13,
  width: '100%',
  boxSizing: 'border-box',
}

// Apply the style by replacing the className references at runtime via a
// tiny ref pattern would be overkill — instead, the JSX uses style={...}
// directly. Keep this constant exported to the file so the modal markup
// reads cleanly.

