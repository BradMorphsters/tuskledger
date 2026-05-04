import { Fragment, useEffect, useMemo, useState } from 'react'
import { TrendingUp, TrendingDown, CircleDollarSign, ChevronRight, ChevronDown, ArrowUp, ArrowDown } from 'lucide-react'
import {
  getHoldings,
  getInvestmentTransactions,
  getInvestmentsSummary,
  getAccounts,
} from '../api/client'
import { BarChart, Bar, Cell, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, PieChart, Pie } from 'recharts'
import AccountFreshness from '../components/AccountFreshness'
import Stat from '../components/Stat'
import Pill from '../components/Pill'
import CapitalLossTracker from '../components/CapitalLossTracker'

function formatCurrency(n, currency = 'USD') {
  if (n === null || n === undefined) return '—'
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(n)
}

function formatNumber(n, digits = 4) {
  if (n === null || n === undefined) return '—'
  return Number(n).toLocaleString('en-US', { maximumFractionDigits: digits })
}

export default function Investments() {
  const [summary, setSummary] = useState(null)
  const [holdings, setHoldings] = useState([])
  const [txns, setTxns] = useState([])
  const [accounts, setAccounts] = useState([])
  const [accountFilter, setAccountFilter] = useState('')
  const [tab, setTab] = useState('holdings')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    refresh()
  }, [])

  const refresh = async () => {
    setLoading(true)
    try {
      const [s, h, t, a] = await Promise.all([
        getInvestmentsSummary().catch(() => null),
        getHoldings().catch(() => []),
        getInvestmentTransactions({ limit: 500 }).catch(() => []),
        getAccounts().catch(() => []),
      ])
      setSummary(s)
      setHoldings(h)
      setTxns(t)
      setAccounts(a)
    } finally {
      setLoading(false)
    }
  }

  const investmentAccounts = useMemo(
    () => accounts.filter(a => a.type === 'investment'),
    [accounts]
  )

  const filteredHoldings = useMemo(
    () => (accountFilter ? holdings.filter(h => String(h.account_id) === accountFilter) : holdings),
    [holdings, accountFilter]
  )
  const filteredTxns = useMemo(
    () => (accountFilter ? txns.filter(t => String(t.account_id) === accountFilter) : txns),
    [txns, accountFilter]
  )

  const hasData = investmentAccounts.length > 0 || holdings.length > 0

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">Investments</h1>
      </div>

      {/* Summary cards — uses the same Stat component the Dashboard uses
          for consistent type scale and accent stripes. */}
      {summary && (
        <div className="stats-grid" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
          <Stat
            label={<><CircleDollarSign size={14} /> Total market value</>}
            value={formatCurrency(summary.total_value)}
          />
          <Stat
            label={`Cost basis${summary.total_cost_basis === null ? ' (partial)' : ''}`}
            value={formatCurrency(summary.total_cost_basis)}
            tone="neutral"
          />
          <Stat
            label={
              <>
                {summary.total_gain_loss !== null && summary.total_gain_loss >= 0
                  ? <TrendingUp size={14} />
                  : <TrendingDown size={14} />}
                Unrealized gain / loss
                {summary.total_cost_basis && summary.total_gain_loss !== null && (
                  <span style={{
                    fontSize: 11, marginLeft: 6, color: 'var(--text-muted)',
                  }}>
                    ({(summary.total_gain_loss >= 0 ? '+' : '') +
                      ((summary.total_gain_loss / summary.total_cost_basis) * 100).toFixed(1)}%)
                  </span>
                )}
              </>
            }
            value={summary.total_gain_loss === null ? '—' : formatCurrency(summary.total_gain_loss)}
            tone={
              summary.total_gain_loss === null
                ? 'neutral'
                : summary.total_gain_loss >= 0 ? 'positive' : 'negative'
            }
          />
        </div>
      )}

      {/* Capital loss carryover — surfaces the pre-paid loss credit
          from prior tax-year filings, contextualized against current
          unrealized gains. Self-hides when no carryover configured AND
          no unrealized gains to show. The unrealizedGain prop drives
          the contextual "you have $X unrealized — sell freely" hint. */}
      <CapitalLossTracker unrealizedGain={summary?.total_gain_loss > 0 ? summary.total_gain_loss : 0} />

      {/* Top Movers — best 3 winners + worst 3 losers by % gain. Helps the
          user quickly spot which positions are driving portfolio movement
          without scrolling through 50+ holdings. */}
      {holdings.length > 0 && <TopMoversCard holdings={holdings} />}

      {/* Asset Allocation and Top Holdings */}
      {summary && (summary.allocation && summary.allocation.length > 0) && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 24 }}>
          {/* Asset Allocation Chart */}
          <div className="card">
            <div className="card-header">
              <span className="card-title">Asset Allocation</span>
            </div>
            <ResponsiveContainer width="100%" height={250}>
              <PieChart>
                <Pie
                  data={summary.allocation}
                  cx="50%"
                  cy="50%"
                  innerRadius={50}
                  outerRadius={90}
                  paddingAngle={2}
                  dataKey="value"
                  nameKey="label"
                >
                  {summary.allocation.map((_, i) => {
                    const colors = ['#34d399', '#60a5fa', '#a78bfa', '#fbbf24', '#f87171', '#fb923c', '#38bdf8', '#e879f9', '#4ade80', '#f472b6']
                    return <Cell key={`cell-${i}`} fill={colors[i % colors.length]} />
                  })}
                </Pie>
                <Tooltip
                  // The Pie's dataKey is "value" (dollar amount), so the
                  // formatter's first arg is dollars — slapping "%" on it
                  // displayed dollar amounts as percentages. The real
                  // percentage lives on payload.pct, computed server-side
                  // in /investments/summary. Render label, dollars, AND %
                  // so the tooltip is more useful than just one number.
                  content={({ active, payload }) => {
                    if (!active || !payload || !payload.length) return null
                    const row = payload[0].payload
                    const dollars = (row.value || 0).toLocaleString('en-US', {
                      style: 'currency', currency: 'USD', maximumFractionDigits: 0,
                    })
                    return (
                      <div style={{
                        background: '#1e2130',
                        border: '1px solid #2a2d3a',
                        borderRadius: 8,
                        padding: '8px 12px',
                        fontSize: 12,
                      }}>
                        <div style={{ fontWeight: 600, color: '#e8eaed', marginBottom: 2 }}>
                          {row.label}
                        </div>
                        <div style={{ color: '#9aa0a6' }}>
                          {dollars} · {(row.pct ?? 0).toFixed(1)}%
                        </div>
                      </div>
                    )
                  }}
                />
              </PieChart>
            </ResponsiveContainer>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, marginTop: 12 }}>
              {summary.allocation.map((item, i) => {
                const colors = ['#34d399', '#60a5fa', '#a78bfa', '#fbbf24', '#f87171', '#fb923c', '#38bdf8', '#e879f9', '#4ade80', '#f472b6']
                return (
                  <div key={item.type} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
                    <span style={{ width: 10, height: 10, borderRadius: '50%', background: colors[i % colors.length], flexShrink: 0 }} />
                    <span style={{ color: 'var(--text-secondary)' }}>{item.label} {item.pct.toFixed(1)}%</span>
                  </div>
                )
              })}
            </div>
          </div>

          {/* Top Holdings */}
          <div className="card">
            <div className="card-header">
              <span className="card-title">Top Holdings</span>
            </div>
            {summary.top_holdings && summary.top_holdings.length > 0 ? (
              <div className="table-wrapper">
                <table style={{ fontSize: 13 }}>
                  <thead>
                    <tr>
                      <th>Ticker</th>
                      <th style={{ textAlign: 'right' }}>Value</th>
                      <th style={{ textAlign: 'right' }}>% Port</th>
                      <th style={{ textAlign: 'right' }}>Gain/Loss</th>
                    </tr>
                  </thead>
                  <tbody>
                    {summary.top_holdings.slice(0, 5).map(h => (
                      <tr key={h.ticker || h.security_name}>
                        <td>
                          <div style={{ fontWeight: 500 }}>{h.ticker || h.security_name}</div>
                          {h.ticker && h.security_name && (
                            <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{h.security_name}</div>
                          )}
                        </td>
                        <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                          {formatCurrency(h.value)}
                        </td>
                        <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: 'var(--text-secondary)' }}>
                          {h.pct_of_portfolio.toFixed(1)}%
                        </td>
                        <td style={{
                          textAlign: 'right', fontVariantNumeric: 'tabular-nums',
                          color: h.gain_loss_pct === null || h.gain_loss_pct === undefined
                            ? 'var(--text-secondary)'
                            : h.gain_loss_pct >= 0 ? 'var(--accent-green)' : 'var(--accent-red)',
                        }}>
                          {h.gain_loss_pct === null || h.gain_loss_pct === undefined
                            ? '—'
                            : (h.gain_loss_pct >= 0 ? '+' : '') + h.gain_loss_pct.toFixed(1) + '%'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p style={{ color: 'var(--text-muted)', fontSize: 13, padding: '16px 0' }}>No holdings yet.</p>
            )}
          </div>
        </div>
      )}

      {/* Empty state */}
      {!loading && !hasData && (
        <div className="card" style={{ padding: 24, textAlign: 'center', color: 'var(--text-secondary)' }}>
          No investment accounts linked yet. Go to the <strong>Accounts</strong> page and connect a brokerage, 401(k), IRA, or Roth account.
          Make sure you link with the updated app — older links without the Investments scope need to be reconnected.
        </div>
      )}

      {/* Account breakdown */}
      {summary && summary.accounts && summary.accounts.length > 0 && (
        <ValueByAccountCard
          accounts={summary.accounts}
          holdings={holdings}
          totals={{
            total: summary.total_value,
            cash: summary.total_cash,
            invested: summary.total_invested,
            cost: summary.total_cost_basis,
            gainLoss: summary.total_gain_loss,
          }}
          activeFilter={accountFilter}
          onFilter={(id) => setAccountFilter(id ? String(id) : '')}
        />
      )}

      {/* Filter + tabs */}
      {hasData && (
        <>
          <div style={{ display: 'flex', gap: 12, marginBottom: 16, alignItems: 'center' }}>
            <div style={{ display: 'flex', gap: 4 }}>
              <button
                className={`btn ${tab === 'holdings' ? 'btn-primary' : ''}`}
                onClick={() => setTab('holdings')}
              >
                Holdings ({filteredHoldings.length})
              </button>
              <button
                className={`btn ${tab === 'transactions' ? 'btn-primary' : ''}`}
                onClick={() => setTab('transactions')}
              >
                Transactions ({filteredTxns.length})
              </button>
            </div>
            <div style={{ marginLeft: 'auto' }}>
              <select
                value={accountFilter}
                onChange={e => setAccountFilter(e.target.value)}
                style={{
                  background: 'var(--bg-input, var(--card-bg))',
                  color: 'inherit',
                  border: '1px solid var(--border-color, #ccc)',
                  borderRadius: 8, padding: '8px 12px', fontSize: 13,
                }}
              >
                <option value="">All investment accounts</option>
                {investmentAccounts.map(a => (
                  <option key={a.id} value={a.id}>{a.custom_name || a.name}</option>
                ))}
              </select>
            </div>
          </div>

          {tab === 'holdings' && (
            <div className="card">
              <div className="table-wrapper">
                <table className="holdings-table">
                  <thead>
                    <tr>
                      <th>Security</th>
                      <th>Account</th>
                      <th style={{ textAlign: 'right' }}>Quantity</th>
                      <th style={{ textAlign: 'right' }}>Price</th>
                      <th style={{ textAlign: 'right' }}>Market value</th>
                      <th style={{ textAlign: 'right' }}>Cost basis</th>
                      <th style={{ textAlign: 'right' }}>Gain / loss</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredHoldings.map(h => (
                      <tr key={h.id}>
                        <td>
                          <div style={{ fontWeight: 500 }}>{h.security?.ticker_symbol || h.security?.name || '—'}</div>
                          {h.security?.ticker_symbol && h.security?.name && (
                            <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{h.security.name}</div>
                          )}
                        </td>
                        <td style={{ fontSize: 13, color: 'var(--text-secondary)' }}>{h.account_name}</td>
                        <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{formatNumber(h.quantity)}</td>
                        <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{formatCurrency(h.institution_price)}</td>
                        <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums', fontWeight: 500 }}>
                          {formatCurrency(h.institution_value)}
                        </td>
                        <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: 'var(--text-secondary)' }}>
                          {formatCurrency(h.cost_basis)}
                        </td>
                        <td style={{
                          textAlign: 'right',
                          fontVariantNumeric: 'tabular-nums',
                          color: h.gain_loss === null
                            ? 'var(--text-secondary)'
                            : h.gain_loss >= 0 ? 'var(--accent-green)' : 'var(--accent-red)',
                        }}>
                          {h.gain_loss === null ? '—' : formatCurrency(h.gain_loss)}
                        </td>
                      </tr>
                    ))}
                    {filteredHoldings.length === 0 && (
                      <tr><td colSpan={7} style={{ textAlign: 'center', color: 'var(--text-muted)' }}>No holdings yet.</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {tab === 'transactions' && (
            <div className="card">
              <div className="table-wrapper">
                <table>
                  <thead>
                    <tr>
                      <th>Date</th>
                      <th>Description</th>
                      <th>Type</th>
                      <th>Account</th>
                      <th style={{ textAlign: 'right' }}>Qty</th>
                      <th style={{ textAlign: 'right' }}>Price</th>
                      <th style={{ textAlign: 'right' }}>Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredTxns.map(t => (
                      <tr key={t.id}>
                        <td style={{ whiteSpace: 'nowrap' }}>{t.date}</td>
                        <td>
                          <div style={{ fontWeight: 500 }}>{t.name || '—'}</div>
                          {t.ticker_symbol && (
                            <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{t.ticker_symbol}</div>
                          )}
                        </td>
                        <td>
                          <span className="category-badge">{t.type}{t.subtype ? ' · ' + t.subtype : ''}</span>
                        </td>
                        <td style={{ fontSize: 13, color: 'var(--text-secondary)' }}>{t.account_name}</td>
                        <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{formatNumber(t.quantity)}</td>
                        <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{formatCurrency(t.price)}</td>
                        <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums', fontWeight: 500 }}>
                          {formatCurrency(t.amount)}
                        </td>
                      </tr>
                    ))}
                    {filteredTxns.length === 0 && (
                      <tr><td colSpan={7} style={{ textAlign: 'center', color: 'var(--text-muted)' }}>No investment transactions in range.</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}

        </>
      )}
    </div>
  )
}


/**
 * Per-account portfolio breakdown table.
 *
 * Features:
 *   - Color-coded allocation bar at the top, each segment proportional
 *     to one account's share of the portfolio. Click to filter.
 *   - Sortable column headers (click toggles asc/desc).
 *   - "% Gain" column alongside dollar gain/loss for relative perspective.
 *   - Click anywhere on a row → filters the Holdings/Transactions tabs
 *     below to that account (existing behavior).
 *   - Click the chevron at the start of a row → inline-expands a
 *     compact holdings list for that account, no scrolling required.
 *   - Cash and invested are always shown separately so cash sitting
 *     post-sale (e.g. settled COPX proceeds) doesn't get treated as a
 *     zero-gain "investment" and dilute portfolio performance numbers.
 */
function ValueByAccountCard({ accounts, holdings, totals, activeFilter, onFilter }) {
  // Visual allocation bar: each account a colored segment proportional to its value.
  const palette = ['#34d399', '#60a5fa', '#a78bfa', '#fbbf24', '#fb7185', '#fb923c', '#38bdf8', '#e879f9', '#4ade80', '#f472b6']

  // Sort + expand state. Default sort: total_value desc (matches the
  // backend ordering, so first render is unchanged).
  const [sortKey, setSortKey] = useState('total_value')
  const [sortDir, setSortDir] = useState('desc')
  const [expandedId, setExpandedId] = useState(null)

  const formatPctCompact = (v) => {
    if (v === null || v === undefined || isNaN(v)) return '—'
    return v < 0.05 ? '<0.1%' : v.toFixed(1) + '%'
  }
  const formatGainLoss = (gl) => {
    if (gl === null || gl === undefined) return '—'
    const sign = gl >= 0 ? '+' : ''
    return sign + new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(gl)
  }
  const pctGain = (a) => {
    if (a.gain_loss === null || a.gain_loss === undefined) return null
    if (!a.cost_basis || a.cost_basis === 0) return null
    return (a.gain_loss / a.cost_basis) * 100
  }
  const formatPctGain = (v) => {
    if (v === null || v === undefined || isNaN(v)) return '—'
    const sign = v >= 0 ? '+' : ''
    return sign + v.toFixed(1) + '%'
  }

  // Derive sortable rows. We compute pct_gain client-side because the
  // backend doesn't ship that column; everything else is straight from
  // the AccountValueOut payload.
  const rows = useMemo(() => {
    const augmented = accounts.map((a, i) => ({
      ...a,
      paletteColor: palette[i % palette.length], // assigned by ORIGINAL backend order
      pct_gain: pctGain(a),
    }))
    // Null-aware sort: nulls always sort to the bottom regardless of direction.
    const dir = sortDir === 'asc' ? 1 : -1
    const cmp = (a, b) => {
      const av = a[sortKey], bv = b[sortKey]
      if (av === null || av === undefined) return 1
      if (bv === null || bv === undefined) return -1
      if (typeof av === 'string') return av.localeCompare(bv) * dir
      return (av - bv) * dir
    }
    return [...augmented].sort(cmp)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accounts, sortKey, sortDir])

  // Toggle sort direction on repeat-click of the same column; otherwise
  // switch to the new column with a sensible default direction (desc for
  // numbers, asc for the account-name column).
  const onHeaderClick = (key, defaultDir = 'desc') => {
    if (sortKey === key) {
      setSortDir(d => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortKey(key)
      setSortDir(defaultDir)
    }
  }

  const SortableTh = ({ k, label, defaultDir = 'desc', align = 'left' }) => {
    const active = sortKey === k
    return (
      <th
        onClick={() => onHeaderClick(k, defaultDir)}
        style={{
          textAlign: align, cursor: 'pointer',
          userSelect: 'none', whiteSpace: 'nowrap',
          color: active ? 'var(--text-primary)' : undefined,
        }}
        title="Click to sort"
      >
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, justifyContent: align === 'right' ? 'flex-end' : 'flex-start' }}>
          {label}
          {active && (sortDir === 'asc' ? <ArrowUp size={11} /> : <ArrowDown size={11} />)}
        </span>
      </th>
    )
  }

  return (
    <div className="card" style={{ marginBottom: 24 }}>
      <div className="card-header">
        <span className="card-title">Value by account</span>
        {activeFilter && (
          <button
            onClick={() => onFilter(null)}
            style={{ fontSize: 12, background: 'none', border: 'none', color: 'var(--accent-blue)', cursor: 'pointer' }}
          >
            Clear filter ✕
          </button>
        )}
      </div>

      {/* Allocation bar — uses ORIGINAL order so colors stay stable when sorted. */}
      <div style={{
        display: 'flex', height: 10, borderRadius: 6, overflow: 'hidden',
        margin: '0 0 16px', background: 'var(--bg-hover, rgba(255,255,255,0.04))',
      }}>
        {accounts.map((a, i) => (
          <div
            key={a.account_id}
            title={`${a.name}: ${formatPctCompact(a.pct_of_portfolio)}`}
            onClick={() => onFilter(a.account_id)}
            style={{
              width: `${a.pct_of_portfolio}%`,
              background: palette[i % palette.length],
              cursor: 'pointer',
              opacity: !activeFilter || activeFilter === String(a.account_id) ? 1 : 0.35,
              transition: 'opacity 120ms',
            }}
          />
        ))}
      </div>

      <div className="table-wrapper">
        <table style={{ width: '100%' }}>
          <thead>
            <tr>
              <th style={{ width: 24 }}></th>
              <SortableTh k="name" label="Account" defaultDir="asc" />
              <SortableTh k="subtype" label="Type" defaultDir="asc" />
              <SortableTh k="cash_value" label="Cash" align="right" />
              <SortableTh k="invested_value" label="Invested" align="right" />
              <SortableTh k="total_value" label="Total" align="right" />
              <SortableTh k="gain_loss" label="Gain / Loss" align="right" />
              <SortableTh k="pct_gain" label="% Gain" align="right" />
              <SortableTh k="pct_of_portfolio" label="% of Total" align="right" />
            </tr>
          </thead>
          <tbody>
            {rows.map((a) => {
              const isActive = activeFilter === String(a.account_id)
              const isExpanded = expandedId === a.account_id
              const acctHoldings = (holdings || []).filter(h => h.account_id === a.account_id)
              return (
                <Fragment key={a.account_id}>
                  <tr
                    onClick={() => onFilter(isActive ? null : a.account_id)}
                    style={{
                      cursor: 'pointer',
                      background: isActive ? 'rgba(96,165,250,0.12)' : 'transparent',
                    }}
                  >
                    <td onClick={(e) => { e.stopPropagation(); setExpandedId(isExpanded ? null : a.account_id) }}
                      style={{ cursor: 'pointer', color: 'var(--text-secondary)', textAlign: 'center', padding: '0 4px' }}
                      title={isExpanded ? 'Collapse holdings' : 'Show holdings'}
                    >
                      {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                    </td>
                    <td>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span style={{
                          width: 8, height: 8, borderRadius: 4,
                          background: a.paletteColor, flexShrink: 0,
                        }} />
                        <div>
                          <div style={{ fontWeight: 500, display: 'flex', alignItems: 'center', gap: 6 }}>
                            <span>{a.name}</span>
                            {a.is_manual && <Pill title="User-tracked, not synced from a bank">Manual</Pill>}
                          </div>
                          <div style={{ fontSize: 11, color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
                            {a.institution && <span>{a.institution}</span>}
                            <AccountFreshness account={a} />
                          </div>
                        </div>
                      </div>
                    </td>
                    <td style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                      {a.subtype || '—'}
                      <span style={{ color: 'var(--text-muted)', marginLeft: 6 }}>· {a.holding_count} hold{a.holding_count === 1 ? 'ing' : 'ings'}</span>
                    </td>
                    <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: 'var(--text-secondary)' }}>
                      {a.cash_value > 0 ? formatCurrency(a.cash_value) : '—'}
                    </td>
                    <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: 'var(--text-secondary)' }}>
                      {a.invested_value > 0 ? formatCurrency(a.invested_value) : '—'}
                    </td>
                    <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums', fontWeight: 500 }}>
                      {formatCurrency(a.total_value)}
                    </td>
                    <td style={{
                      textAlign: 'right', fontVariantNumeric: 'tabular-nums',
                      color: a.gain_loss === null
                        ? 'var(--text-muted)'
                        : a.gain_loss >= 0 ? 'var(--accent-green)' : 'var(--accent-red)',
                    }}>
                      {formatGainLoss(a.gain_loss)}
                    </td>
                    <td style={{
                      textAlign: 'right', fontVariantNumeric: 'tabular-nums', fontSize: 12,
                      color: a.pct_gain === null
                        ? 'var(--text-muted)'
                        : a.pct_gain >= 0 ? 'var(--accent-green)' : 'var(--accent-red)',
                    }}>
                      {formatPctGain(a.pct_gain)}
                    </td>
                    <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: 'var(--text-secondary)' }}>
                      {formatPctCompact(a.pct_of_portfolio)}
                    </td>
                  </tr>
                  {isExpanded && (
                    <tr>
                      <td colSpan={9} style={{ padding: 0, background: 'rgba(255,255,255,0.02)' }}>
                        <AccountHoldingsInline
                          holdings={acctHoldings}
                          accountTotal={a.total_value}
                        />
                      </td>
                    </tr>
                  )}
                </Fragment>
              )
            })}
          </tbody>
          <tfoot>
            <tr style={{ borderTop: '2px solid var(--border, #2a2d3a)', fontWeight: 600 }}>
              <td></td>
              <td>Total</td>
              <td style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                {accounts.length} account{accounts.length === 1 ? '' : 's'}
              </td>
              <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                {formatCurrency(totals.cash)}
              </td>
              <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                {formatCurrency(totals.invested)}
              </td>
              <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                {formatCurrency(totals.total)}
              </td>
              <td style={{
                textAlign: 'right', fontVariantNumeric: 'tabular-nums',
                color: totals.gainLoss === null || totals.gainLoss === undefined
                  ? 'var(--text-muted)'
                  : totals.gainLoss >= 0 ? 'var(--accent-green)' : 'var(--accent-red)',
              }}>
                {formatGainLoss(totals.gainLoss)}
              </td>
              <td style={{
                textAlign: 'right', fontVariantNumeric: 'tabular-nums', fontSize: 12,
                color: (totals.cost && totals.gainLoss !== null && totals.gainLoss !== undefined)
                  ? (totals.gainLoss >= 0 ? 'var(--accent-green)' : 'var(--accent-red)')
                  : 'var(--text-muted)',
              }}>
                {totals.cost && totals.gainLoss !== null && totals.gainLoss !== undefined
                  ? formatPctGain((totals.gainLoss / totals.cost) * 100)
                  : '—'}
              </td>
              <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>100%</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  )
}


/**
 * TopMoversCard — at-a-glance "what's working / what's hurting" panel.
 *
 * Shows up to 3 best and 3 worst positions by unrealized % gain. Cash
 * positions and holdings without cost basis (where % gain is undefined)
 * are skipped because they'd otherwise bunch up at 0% and crowd out
 * meaningful winners/losers.
 *
 * Useful for getting an answer to "which positions did the work" without
 * scanning a 30-row holdings table.
 */
function TopMoversCard({ holdings }) {
  // Filter to positions with cost basis AND non-cash AND meaningful size.
  // Tiny dust positions ($1 of fractional shares from a DRIP) get filtered
  // because their % swings are extreme and not actionable.
  const eligible = (holdings || []).filter(h => {
    if (!h.cost_basis || h.cost_basis <= 0) return false
    if (h.security?.is_cash_equivalent) return false
    if ((h.institution_value || 0) < 50) return false
    if (h.gain_loss === null || h.gain_loss === undefined) return false
    return true
  }).map(h => ({
    ...h,
    pct_gain: (h.gain_loss / h.cost_basis) * 100,
    label: h.security?.ticker_symbol || h.security?.name || '?',
    name: h.security?.name || '',
  }))

  if (eligible.length === 0) return null

  const sorted = [...eligible].sort((a, b) => b.pct_gain - a.pct_gain)
  const winners = sorted.slice(0, 3).filter(h => h.pct_gain > 0)
  const losers = [...sorted].reverse().slice(0, 3).filter(h => h.pct_gain < 0)

  // Don't render the card if there's literally nothing positive or negative.
  if (winners.length === 0 && losers.length === 0) return null

  return (
    <div className="card" style={{ marginBottom: 24 }}>
      <div className="card-header">
        <span className="card-title">Top movers</span>
        <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
          by unrealized % · positions ≥ $50
        </span>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        <MoversColumn
          title="Winners"
          icon={<TrendingUp size={14} />}
          rows={winners}
          tone="positive"
          emptyMsg="No positions in the green right now."
        />
        <MoversColumn
          title="Losers"
          icon={<TrendingDown size={14} />}
          rows={losers}
          tone="negative"
          emptyMsg="No positions in the red — nice."
        />
      </div>
    </div>
  )
}

function MoversColumn({ title, icon, rows, tone, emptyMsg }) {
  const accent = tone === 'positive' ? 'var(--accent-green)' : 'var(--accent-red)'
  return (
    <div>
      <div style={{
        fontSize: 12, color: 'var(--text-muted)', textTransform: 'uppercase',
        letterSpacing: 0.4, marginBottom: 8,
        display: 'flex', alignItems: 'center', gap: 6,
      }}>
        <span style={{ color: accent }}>{icon}</span> {title}
      </div>
      {rows.length === 0 ? (
        <div style={{ color: 'var(--text-muted)', fontSize: 12, padding: '12px 0' }}>
          {emptyMsg}
        </div>
      ) : (
        rows.map(h => (
          <div key={h.id} style={{
            display: 'flex', alignItems: 'center', gap: 10,
            padding: '8px 0', borderBottom: '1px solid var(--border)',
          }}>
            <div style={{ flex: 1, minWidth: 0, overflow: 'hidden' }}>
              <div style={{ fontWeight: 500, fontSize: 13, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {h.label}
              </div>
              {h.name && h.label !== h.name && (
                <div style={{ fontSize: 11, color: 'var(--text-muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {h.name}
                </div>
              )}
            </div>
            <div style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}>
              <div style={{ fontWeight: 600, fontSize: 13, color: accent }}>
                {h.pct_gain >= 0 ? '+' : ''}{h.pct_gain.toFixed(1)}%
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                {h.gain_loss >= 0 ? '+' : ''}{formatCurrency(h.gain_loss)}
              </div>
            </div>
          </div>
        ))
      )}
    </div>
  )
}


/**
 * Compact holdings list rendered inside a row's expanded drawer.
 * Sorted by market value desc. Cash positions get folded into a single
 * "Cash" line so the user doesn't see four separate "CUR:USD" rows.
 */
function AccountHoldingsInline({ holdings, accountTotal }) {
  if (!holdings || holdings.length === 0) {
    return (
      <div style={{ padding: '12px 16px', fontSize: 12, color: 'var(--text-muted)' }}>
        No holdings reported.
      </div>
    )
  }
  const sorted = [...holdings].sort((a, b) => (b.institution_value || 0) - (a.institution_value || 0))
  return (
    <div style={{ padding: '8px 16px 12px' }}>
      <table style={{ width: '100%', fontSize: 12 }}>
        <thead>
          <tr style={{ color: 'var(--text-muted)' }}>
            <th style={{ textAlign: 'left', padding: '4px 8px 4px 0', fontWeight: 500 }}>Security</th>
            <th style={{ textAlign: 'right', padding: '4px 8px', fontWeight: 500 }}>Quantity</th>
            <th style={{ textAlign: 'right', padding: '4px 8px', fontWeight: 500 }}>Price</th>
            <th style={{ textAlign: 'right', padding: '4px 8px', fontWeight: 500 }}>Value</th>
            <th style={{ textAlign: 'right', padding: '4px 8px', fontWeight: 500 }}>Cost</th>
            <th style={{ textAlign: 'right', padding: '4px 0 4px 8px', fontWeight: 500 }}>Gain/Loss</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map(h => {
            const ticker = h.security?.ticker_symbol
            const name = h.security?.name
            const isCash = h.security?.is_cash_equivalent
            return (
              <tr key={h.id} style={{ borderTop: '1px solid var(--border, rgba(255,255,255,0.05))' }}>
                <td style={{ padding: '6px 8px 6px 0' }}>
                  <span style={{ fontWeight: 500 }}>{isCash ? 'Cash' : (ticker || name || '?')}</span>
                  {!isCash && ticker && name && (
                    <span style={{ color: 'var(--text-muted)', marginLeft: 6 }}>{name}</span>
                  )}
                </td>
                <td style={{ textAlign: 'right', padding: '6px 8px', fontVariantNumeric: 'tabular-nums', color: 'var(--text-secondary)' }}>
                  {isCash ? '—' : formatNumber(h.quantity)}
                </td>
                <td style={{ textAlign: 'right', padding: '6px 8px', fontVariantNumeric: 'tabular-nums', color: 'var(--text-secondary)' }}>
                  {isCash ? '—' : formatCurrency(h.institution_price)}
                </td>
                <td style={{ textAlign: 'right', padding: '6px 8px', fontVariantNumeric: 'tabular-nums', fontWeight: 500 }}>
                  {formatCurrency(h.institution_value)}
                </td>
                <td style={{ textAlign: 'right', padding: '6px 8px', fontVariantNumeric: 'tabular-nums', color: 'var(--text-secondary)' }}>
                  {formatCurrency(h.cost_basis)}
                </td>
                <td style={{
                  textAlign: 'right', padding: '6px 0 6px 8px', fontVariantNumeric: 'tabular-nums',
                  color: h.gain_loss === null || h.gain_loss === undefined
                    ? 'var(--text-muted)'
                    : h.gain_loss >= 0 ? 'var(--accent-green)' : 'var(--accent-red)',
                }}>
                  {h.gain_loss === null || h.gain_loss === undefined
                    ? '—'
                    : (h.gain_loss >= 0 ? '+' : '') + formatCurrency(h.gain_loss)}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
