/**
 * Spending & Income — the analytics command center for personal cash flow.
 *
 * Layout (top to bottom):
 *   1. Stat cards: Spending, Income, Net, Savings Rate, Forecast
 *   2. Income vs Spending bar chart (3/6/12 month toggle)
 *   3. Month/year selector + Spending/Income toggle + YoY toggle
 *   4. Pie chart + Category Details (with sparklines, MoM/YoY deltas)
 *      Both are click-to-drill into TransactionDrawer
 *   5. Top Merchants + Recurring/Subscriptions (rolling 6mo)
 *   6. Cash Flow Waterfall + Day-of-Week heatmap
 *   7. Income Sources panel (only in Income view)
 *
 * Backend endpoints used:
 *   - GET /transactions/income-vs-spending?months=N
 *   - GET /transactions/category-breakdown?month=&year=
 *   - GET /analytics/category-trends?month=&year=&months_back=6
 *   - GET /analytics/spending-patterns?month=&year=
 *   - GET /analytics/merchants?months=6
 *   - GET /analytics/recurring
 *   - GET /analytics/export?start_date=&end_date=  (download)
 */
import { useState, useEffect, useMemo } from 'react'
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
  PieChart, Pie, Cell,
} from 'recharts'
import {
  TrendingUp, TrendingDown, DollarSign, Percent, Download, Calendar,
  Receipt, Repeat, ArrowUp, ArrowDown, AlertTriangle, BarChart3,
} from 'lucide-react'
import {
  getIncomeVsSpending, getCategoryBreakdown, getCategoryTrends,
  getSpendingPatterns, getMerchantInsights, getRecurring, getExportUrl,
  getSubscriptionRules, createSubscriptionRule, deleteSubscriptionRule,
  getYearOverYear,
} from '../api/client'
import TransactionDrawer from '../components/TransactionDrawer'
import MerchantDrawer from '../components/MerchantDrawer'
import Stat from '../components/Stat'
import Pill from '../components/Pill'
import EmptyState from '../components/EmptyState'
import TrendStat from '../components/TrendStat'
import { SpendingHeatmap } from '../components/SpendingExtras'

const COLORS = ['#34d399', '#60a5fa', '#a78bfa', '#fbbf24', '#f87171', '#fb923c', '#38bdf8', '#e879f9', '#4ade80', '#f472b6', '#22d3ee', '#c084fc']

function fmt(val) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(val || 0)
}

function fmtCompact(val) {
  const n = val || 0
  if (Math.abs(n) >= 1000) return `$${(n / 1000).toFixed(1)}k`
  return `$${Math.round(n)}`
}

// Strip noisy ACH/transfer prefixes from raw transaction descriptions so
// the page reads cleanly. We get strings like
//   "DEPOSIT EMPLOYER NAME TYPE: PAYROLL ID: *0391 DATA: 04/03/26 ..."
// and want just "Employer Name".
function cleanMerchantName(raw) {
  if (!raw) return raw
  let s = String(raw)
  // Drop everything after the first "TYPE:", "ID:", "DATA:", "CO:" sentinel
  s = s.replace(/\s+(TYPE:|ID:|DATA:|CO:|PPD|ACH ECC|ACH Trace).*/i, '')
  // Drop leading verbs we don't need to see
  s = s.replace(/^(DEPOSIT|WITHDRAWAL|TRANSFER|PAYMENT|PURCHASE)\s+/i, '')
  // Collapse whitespace
  s = s.replace(/\s+/g, ' ').trim()
  // Title-case ALL CAPS strings (but leave mixed-case alone — it's already pretty)
  if (s === s.toUpperCase() && s.length > 3) {
    s = s.toLowerCase().replace(/\b\w/g, c => c.toUpperCase())
  }
  return s || raw
}

// ─── Sparkline ────────────────────────────────────────────────
// Tiny inline trend line for the Category Details rows. Last point dotted.
function Sparkline({ data = [], color = '#60a5fa', width = 70, height = 22 }) {
  if (!data || data.length < 2) return <span style={{ display: 'inline-block', width, height }} />
  const max = Math.max(...data, 1)
  const min = Math.min(...data, 0)
  const range = (max - min) || 1
  const points = data.map((v, i) => {
    const x = (i / (data.length - 1)) * width
    const y = height - ((v - min) / range) * (height - 4) - 2
    return `${x},${y}`
  }).join(' ')
  const lastX = width
  const lastY = height - ((data[data.length - 1] - min) / range) * (height - 4) - 2
  return (
    <svg width={width} height={height} style={{ overflow: 'visible' }}>
      <polyline points={points} stroke={color} strokeWidth="1.5" fill="none"
        strokeLinejoin="round" strokeLinecap="round" opacity={0.85} />
      <circle cx={lastX} cy={lastY} r="2" fill={color} />
    </svg>
  )
}

// ─── Custom recharts Tooltip with proper text colors ─────────
const ChartTooltip = ({ active, payload, label }) => {
  if (!active || !payload || !payload.length) return null
  return (
    <div style={{
      background: 'var(--bg-card)',
      border: '1px solid var(--border)',
      borderRadius: 'var(--radius-sm)',
      padding: '10px 14px',
      fontSize: 'var(--text-sm)',
      color: 'var(--text-primary)',
    }}>
      {label !== undefined && (
        <div style={{ fontWeight: 600, marginBottom: 6 }}>{label}</div>
      )}
      {payload.map((p, i) => (
        <div key={i} style={{ color: p.color || 'var(--text-primary)' }}>
          {p.name}: {fmt(p.value)}
        </div>
      ))}
    </div>
  )
}

// Delta arrow + percentage badge
function DeltaBadge({ pct, inverse = false }) {
  if (pct === null || pct === undefined) return <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>—</span>
  const up = pct > 0
  // For spending, "up" is negative (more spending = bad). inverse=true flips that.
  const isBad = inverse ? !up : up
  const color = Math.abs(pct) < 1
    ? 'var(--text-muted)'
    : isBad ? 'var(--accent-red)' : 'var(--accent-green)'
  return (
    <span style={{
      color, fontSize: 11, fontWeight: 500,
      display: 'inline-flex', alignItems: 'center', gap: 2,
    }}>
      {up ? <ArrowUp size={10} /> : <ArrowDown size={10} />}
      {Math.abs(pct).toFixed(1)}%
    </span>
  )
}

// ─── Top Merchants Card ──────────────────────────────────────
function TopMerchantsCard({ merchants, onMerchantClick }) {
  return (
    <div className="card">
      <div className="card-header">
        <span className="card-title" style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          <Receipt size={16} style={{ color: 'var(--text-muted)' }} />
          Top Merchants
        </span>
        <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
          last 6 months
        </span>
      </div>
      {merchants.length === 0 ? (
        <EmptyState compact icon={<Receipt size={20} />} title="No merchant data yet" />
      ) : (
        <div style={{ maxHeight: 360, overflowY: 'auto' }}>
          {merchants.slice(0, 10).map((m, i) => (
            <div
              key={m.merchant}
              onClick={() => onMerchantClick && onMerchantClick(m)}
              style={{
                display: 'flex', alignItems: 'center', gap: 10,
                padding: '10px 0',
                borderBottom: i < Math.min(9, merchants.length - 1) ? '1px solid var(--border)' : 'none',
                cursor: onMerchantClick ? 'pointer' : 'default',
                minWidth: 0,
              }}
            >
              <span style={{ fontSize: 18, flexShrink: 0 }}>{m.icon}</span>
              <div style={{ flex: 1, minWidth: 0, overflow: 'hidden' }}>
                <div
                  title={m.merchant}
                  style={{
                    fontWeight: 500, fontSize: 'var(--text-sm)',
                    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                  }}
                >
                  {cleanMerchantName(m.merchant)}
                </div>
                <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', marginTop: 2 }}>
                  {m.count}× · avg {fmt(m.avg_transaction)}
                </div>
              </div>
              <div className="tabular" style={{ fontWeight: 600, fontSize: 'var(--text-sm)', flexShrink: 0 }}>
                {fmt(m.total)}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ─── Recurring / Subscriptions Card ──────────────────────────
//
// Subscription status tracker — each merchant row gets a per-user status
// (active / watch / cancel) persisted to localStorage. "cancel" rolls up
// into a "potential annual savings" pill in the header so the user can
// see the financial reward of trimming once they've made a decision.
//
const SUB_STATUS_KEY = 'tuskledger.subscriptionStatus.v1'
const SUB_STATUSES = [
  { id: 'active', label: 'Keep', tone: 'success', emoji: '✓' },
  { id: 'watch', label: 'Watch', tone: 'warning', emoji: '👀' },
  { id: 'cancel', label: 'Cancel', tone: 'danger', emoji: '✂️' },
]
function loadSubStatusMap() {
  try {
    const raw = localStorage.getItem(SUB_STATUS_KEY)
    return raw ? JSON.parse(raw) : {}
  } catch {
    return {}
  }
}
function saveSubStatusMap(map) {
  try { localStorage.setItem(SUB_STATUS_KEY, JSON.stringify(map)) } catch {}
}

function RecurringCard({ data, onRulesChanged }) {
  const [statusMap, setStatusMap] = useState(loadSubStatusMap)
  const [openMenu, setOpenMenu] = useState(null) // merchant key whose menu is open
  // Subscription override rules — used to render the right toggle
  // (mark vs unmark) on each merchant row and to remove rules when
  // the user reverses the decision. Loaded once and kept in sync.
  const [subRules, setSubRules] = useState([])
  const [pending, setPending] = useState(null)  // merchant currently being toggled

  useEffect(() => {
    getSubscriptionRules().then(setSubRules).catch(() => {})
  }, [])

  // Find the override rule (if any) that matches this merchant and
  // kind. Used both to render "remove" actions (when an override is
  // already in place) and to avoid creating duplicates on quick clicks.
  const ruleForMerchant = (merchant, kind) => {
    const m = (merchant || '').toLowerCase()
    return subRules.find(r => r.kind === kind && m.includes(r.pattern.toLowerCase()))
  }

  const toggleSubscription = async (r) => {
    if (pending === r.merchant) return
    setPending(r.merchant)
    try {
      // Decide based on whether this row is currently flagged sub.
      const isCurrentlySub = r.kind === 'subscription'
      // If the user wants to FLIP the auto-detection, we add the
      // appropriate override rule. If an opposite-direction rule
      // already exists from a prior toggle, remove it first.
      if (isCurrentlySub) {
        // Was sub → user wants 'not sub'.
        const oldOverride = ruleForMerchant(r.merchant, 'force_subscription')
        if (oldOverride) await deleteSubscriptionRule(oldOverride.id)
        await createSubscriptionRule({
          pattern: r.merchant,
          kind: 'force_not_subscription',
          notes: `User unmarked ${r.merchant} on ${new Date().toISOString().split('T')[0]}`,
        })
      } else {
        // Was not sub → user wants 'sub'.
        const oldOverride = ruleForMerchant(r.merchant, 'force_not_subscription')
        if (oldOverride) await deleteSubscriptionRule(oldOverride.id)
        await createSubscriptionRule({
          pattern: r.merchant,
          kind: 'force_subscription',
          notes: `User marked ${r.merchant} on ${new Date().toISOString().split('T')[0]}`,
        })
      }
      // Refresh rules locally + ask parent to refetch the recurring data.
      const fresh = await getSubscriptionRules()
      setSubRules(fresh)
      if (onRulesChanged) onRulesChanged()
    } catch (e) {
      console.error('Failed to toggle subscription rule:', e)
    } finally {
      setPending(null)
    }
  }

  // Close the dropdown when clicking outside.
  useEffect(() => {
    if (!openMenu) return
    const handler = (e) => {
      // Don't close if the click was on the menu trigger itself (handled by toggle)
      if (e.target.closest?.('[data-substatus-menu]')) return
      setOpenMenu(null)
    }
    document.addEventListener('click', handler)
    return () => document.removeEventListener('click', handler)
  }, [openMenu])

  const setStatus = (merchant, status) => {
    setStatusMap(prev => {
      const next = { ...prev }
      if (status === 'active' || !status) {
        delete next[merchant] // 'active' is the default; don't bloat storage
      } else {
        next[merchant] = status
      }
      saveSubStatusMap(next)
      return next
    })
    setOpenMenu(null)
  }

  if (!data) {
    return (
      <div className="card">
        <div className="card-header">
          <span className="card-title" style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
            <Repeat size={16} style={{ color: 'var(--text-muted)' }} />
            Recurring & Subscriptions
          </span>
        </div>
        <div style={{ color: 'var(--text-muted)', fontSize: 'var(--text-sm)' }}>Loading…</div>
      </div>
    )
  }
  const items = data.recurring || []

  // Roll up annual savings from anything tagged "cancel".
  const cancelAnnual = items.reduce((sum, r) => {
    return statusMap[r.merchant] === 'cancel' ? sum + (r.annual_cost || 0) : sum
  }, 0)
  const watchAnnual = items.reduce((sum, r) => {
    return statusMap[r.merchant] === 'watch' ? sum + (r.annual_cost || 0) : sum
  }, 0)

  return (
    <div className="card">
      <div className="card-header">
        <span className="card-title" style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          <Repeat size={16} style={{ color: 'var(--text-muted)' }} />
          Recurring & Subscriptions
        </span>
        <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
          {fmt(data.total_monthly_cost)}/mo · {fmt(data.total_annual_cost)}/yr
        </span>
      </div>

      {/* Status rollup — only shows when the user has actually tagged things */}
      {(cancelAnnual > 0 || watchAnnual > 0) && (
        <div style={{
          display: 'flex', flexWrap: 'wrap', gap: 8,
          padding: '8px 10px', marginBottom: 8,
          background: 'rgba(96,165,250,0.06)',
          border: '1px solid rgba(96,165,250,0.2)',
          borderRadius: 6, fontSize: 'var(--text-xs)',
        }}>
          {cancelAnnual > 0 && (
            <span title="Annual cost of subscriptions you've tagged 'Cancel'">
              <strong style={{ color: 'var(--accent-green)' }}>{fmt(cancelAnnual)}/yr</strong>
              {' '}potential savings if cancelled
            </span>
          )}
          {watchAnnual > 0 && (
            <span title="Annual cost of subscriptions you're keeping an eye on">
              <strong style={{ color: 'var(--accent-yellow)' }}>{fmt(watchAnnual)}/yr</strong>
              {' '}under review
            </span>
          )}
        </div>
      )}

      {items.length === 0 ? (
        <EmptyState compact icon={<Repeat size={20} />} title="No recurring charges detected" />
      ) : (
        <div style={{ maxHeight: 360, overflowY: 'auto' }}>
          {items.slice(0, 12).map((r, i) => {
            const isLast = i === Math.min(11, items.length - 1)
            const status = statusMap[r.merchant] || 'active'
            const statusDef = SUB_STATUSES.find(s => s.id === status) || SUB_STATUSES[0]
            return (
              <div
                key={r.merchant}
                style={{
                  display: 'flex', alignItems: 'center', gap: 10,
                  padding: '10px 0',
                  borderBottom: isLast ? 'none' : '1px solid var(--border)',
                  minWidth: 0,
                  opacity: status === 'cancel' ? 0.55 : 1,
                  textDecoration: status === 'cancel' ? 'line-through' : 'none',
                }}
              >
                <span style={{ fontSize: 18, flexShrink: 0 }}>{r.icon}</span>
                <div style={{ flex: 1, minWidth: 0, overflow: 'hidden' }}>
                  <div style={{
                    fontWeight: 500, fontSize: 'var(--text-sm)',
                    display: 'flex', alignItems: 'center', gap: 6,
                    whiteSpace: 'nowrap', overflow: 'hidden',
                  }}>
                    <span title={r.merchant} style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {cleanMerchantName(r.merchant)}
                    </span>
                    {r.kind === 'subscription' && <Pill tone="info">SUB</Pill>}
                    {r.forced_subscription && (
                      <Pill tone="info" title="You marked this as a subscription">FORCED</Pill>
                    )}
                    {r.forced_not_subscription && (
                      <Pill tone="warning" title="You marked this as NOT a subscription — auto-detection overridden">UNFLAGGED</Pill>
                    )}
                    <button
                      onClick={(e) => { e.stopPropagation(); toggleSubscription(r) }}
                      disabled={pending === r.merchant}
                      title={r.kind === 'subscription'
                        ? 'Mark this merchant as NOT a subscription (creates a force_not_subscription rule)'
                        : 'Mark this merchant AS a subscription (creates a force_subscription rule)'}
                      style={{
                        background: 'transparent',
                        border: '1px dashed var(--border)',
                        color: 'var(--text-muted)',
                        fontSize: 9, padding: '1px 6px',
                        borderRadius: 3, cursor: pending === r.merchant ? 'wait' : 'pointer',
                        textTransform: 'uppercase', letterSpacing: 0.4,
                      }}
                    >
                      {pending === r.merchant
                        ? '…'
                        : r.kind === 'subscription' ? 'Not a sub' : 'Mark sub'}
                    </button>
                    {r.is_anomalous && (
                      <Pill tone="warning" title={`Latest charge ${r.latest_vs_median_pct}% above median`}>
                        <AlertTriangle size={9} /> +{r.latest_vs_median_pct}%
                      </Pill>
                    )}
                    {r.is_overdue && <Pill tone="warning" title="Hasn't charged on its usual schedule">overdue</Pill>}
                  </div>
                  <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', marginTop: 2 }}>
                    {r.frequency} · next {r.next_expected}
                  </div>
                </div>

                {/* Status menu — click the badge to change it. Default 'active'
                    shows a faint outline so it doesn't fight for attention; the
                    other states use the standard tone palette. */}
                <div style={{ position: 'relative', flexShrink: 0 }} data-substatus-menu>
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      setOpenMenu(openMenu === r.merchant ? null : r.merchant)
                    }}
                    title="Change status"
                    style={{
                      background: 'none', border: 'none', cursor: 'pointer',
                      padding: 0, display: 'inline-flex', textDecoration: 'none',
                    }}
                  >
                    {status === 'active' ? (
                      <span style={{
                        fontSize: 10, padding: '2px 6px', borderRadius: 3,
                        border: '1px dashed var(--border)',
                        color: 'var(--text-muted)',
                        textDecoration: 'none',
                      }}>
                        + tag
                      </span>
                    ) : (
                      <Pill tone={statusDef.tone}>
                        {statusDef.emoji} {statusDef.label}
                      </Pill>
                    )}
                  </button>
                  {openMenu === r.merchant && (
                    <div
                      onClick={(e) => e.stopPropagation()}
                      style={{
                        position: 'absolute', right: 0, top: '100%', marginTop: 4,
                        background: 'var(--bg-card)', border: '1px solid var(--border)',
                        borderRadius: 6, boxShadow: 'var(--shadow-lg, 0 4px 12px rgba(0,0,0,0.3))',
                        zIndex: 10, minWidth: 120, padding: 4,
                      }}
                    >
                      {SUB_STATUSES.map(s => (
                        <button
                          key={s.id}
                          onClick={() => setStatus(r.merchant, s.id)}
                          style={{
                            display: 'flex', width: '100%', alignItems: 'center', gap: 6,
                            padding: '6px 8px', fontSize: 12,
                            background: status === s.id ? 'var(--bg-hover, rgba(255,255,255,0.05))' : 'transparent',
                            border: 'none', cursor: 'pointer',
                            color: 'var(--text-primary)', textAlign: 'left',
                            borderRadius: 4,
                          }}
                        >
                          <span>{s.emoji}</span>
                          <span>{s.label}</span>
                          {status === s.id && <span style={{ marginLeft: 'auto', color: 'var(--accent-blue)' }}>✓</span>}
                        </button>
                      ))}
                    </div>
                  )}
                </div>

                <div className="tabular" style={{ textAlign: 'right', minWidth: 80 }}>
                  <div style={{ fontWeight: 600, fontSize: 'var(--text-sm)' }}>{fmt(r.avg_amount)}</div>
                  <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
                    {fmt(r.annual_cost)}/yr
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ─── Day-of-Week Heatmap ──────────────────────────────────────
function DayOfWeekCard({ data = [] }) {
  const max = Math.max(...data.map(d => d.total), 1)
  return (
    <div className="card">
      <div className="card-header">
        <span className="card-title" style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          <Calendar size={16} style={{ color: 'var(--text-muted)' }} />
          Spending by Day of Week
        </span>
      </div>
      {data.length === 0 || data.every(d => d.total === 0) ? (
        <EmptyState compact icon={<Calendar size={20} />} title="No spending data" />
      ) : (
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8, padding: '12px 4px' }}>
          {data.map((d, i) => {
            // Pixel heights: max 110px so the column has visual range
            const barPx = Math.max(Math.round((d.total / max) * 110), 4)
            return (
              <div key={d.day} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
                <div className="tabular" style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
                  {fmtCompact(d.total)}
                </div>
                <div style={{
                  width: '100%', height: barPx,
                  background: i === 5 || i === 6 ? 'var(--accent-purple)' : 'var(--accent-blue)',
                  borderRadius: 'var(--radius-xs) var(--radius-xs) 0 0',
                  opacity: 0.85,
                }} />
                <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-secondary)' }}>{d.day}</div>
                <div style={{ fontSize: 'var(--text-2xs)', color: 'var(--text-muted)' }}>{d.count} txn</div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ─── Cash Flow Waterfall ──────────────────────────────────────
function WaterfallCard({ data = [] }) {
  if (!data || data.length === 0) {
    return (
      <div className="card">
        <div className="card-header">
          <span className="card-title" style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
            <BarChart3 size={16} style={{ color: 'var(--text-muted)' }} />
            Cash Flow
          </span>
        </div>
        <EmptyState compact icon={<BarChart3 size={20} />} title="No data" />
      </div>
    )
  }
  // Income / Fixed / Variable / Net
  const income = data.find(d => d.label === 'Income')?.value || 0
  const fixed = data.find(d => d.label === 'Fixed')?.value || 0
  const variable = data.find(d => d.label === 'Variable')?.value || 0
  const net = data.find(d => d.label === 'Net')?.value || 0
  const max = Math.max(income, fixed + variable, Math.abs(net), 1)

  const bars = [
    { label: 'Income', value: income, color: 'var(--accent-green)', help: 'Total money in' },
    { label: 'Fixed', value: fixed, color: 'var(--accent-orange)', help: 'Bills, loans, taxes, subscriptions' },
    { label: 'Variable', value: variable, color: 'var(--accent-purple)', help: 'Discretionary categories' },
    { label: 'Net', value: net, color: net >= 0 ? 'var(--accent-green)' : 'var(--accent-red)', help: 'Income − total spending' },
  ]

  return (
    <div className="card">
      <div className="card-header">
        <span className="card-title" style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          <BarChart3 size={16} style={{ color: 'var(--text-muted)' }} />
          Cash Flow
        </span>
        <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
          income → fixed → variable → net
        </span>
      </div>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 14, padding: '10px 4px' }}>
        {bars.map((b) => {
          const barPx = Math.max(Math.round((Math.abs(b.value) / max) * 150), 4)
          return (
            <div key={b.label} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
              <div style={{ fontSize: 'var(--text-xs)', fontWeight: 600 }} title={b.help}>
                {fmt(b.value)}
              </div>
              <div style={{
                width: '100%',
                height: barPx,
                background: b.color,
                borderRadius: 'var(--radius-xs) var(--radius-xs) 0 0',
                opacity: 0.85,
              }} />
              <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-secondary)' }}>{b.label}</div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ─── Income Sources Card ──────────────────────────────────────
function IncomeSourcesCard({ sources = [] }) {
  // Backend groups by raw description, but ACH IDs make each payroll entry
  // unique. After cleaning, we need to merge entries that resolve to the
  // same human-readable name (e.g. multiple paychecks from same employer).
  const merged = (() => {
    const m = new Map()
    for (const s of sources) {
      const cleaned = cleanMerchantName(s.source)
      const cur = m.get(cleaned) || { source: cleaned, raw: s.source, amount: 0, count: 0 }
      cur.amount += s.amount
      cur.count += 1
      m.set(cleaned, cur)
    }
    return [...m.values()].sort((a, b) => b.amount - a.amount)
  })()
  const total = merged.reduce((s, x) => s + x.amount, 0)
  return (
    <div className="card">
      <div className="card-header">
        <span className="card-title">Income Sources</span>
        <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>{fmt(total)} total</span>
      </div>
      {merged.length === 0 ? (
        <EmptyState compact icon={<TrendingUp size={20} />} title="No income recorded" />
      ) : (
        <table style={{ width: '100%' }}>
          <tbody>
            {merged.map((s, i) => {
              const pct = total > 0 ? (s.amount / total) * 100 : 0
              return (
                <tr key={s.source}>
                  <td style={{ width: 24, paddingLeft: 0 }}>
                    <span style={{
                      display: 'inline-block', width: 10, height: 10,
                      borderRadius: '50%', background: COLORS[i % COLORS.length],
                    }} />
                  </td>
                  <td title={s.raw}>
                    {s.source}
                    {s.count > 1 && (
                      <span style={{ color: 'var(--text-muted)', fontSize: 'var(--text-xs)', marginLeft: 6 }}>
                        ({s.count}×)
                      </span>
                    )}
                  </td>
                  <td style={{ width: 60, color: 'var(--text-muted)', fontSize: 'var(--text-xs)' }}>
                    {pct.toFixed(1)}%
                  </td>
                  <td style={{ textAlign: 'right' }} className="tabular amount-positive">
                    {fmt(s.amount)}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════
//  Main page
// ═══════════════════════════════════════════════════════════════
export default function SpendingIncome() {
  const today = new Date()
  const [monthlyData, setMonthlyData] = useState([])
  const [breakdown, setBreakdown] = useState(null)
  const [trends, setTrends] = useState(null)
  const [patterns, setPatterns] = useState(null)
  const [merchants, setMerchants] = useState([])
  const [recurring, setRecurring] = useState(null)
  // Range driving the trend chart + the new aggregate stats below it.
  // Stored as a string preset so 'ytd' can be a first-class option;
  // resolves to a number for the API call.
  const [trendPreset, setTrendPreset] = useState('6')
  const timeRange = trendPreset === 'ytd'
    ? Math.max(1, new Date().getMonth() + 1)
    : parseInt(trendPreset, 10)
  const [selectedMonth, setSelectedMonth] = useState(today.getMonth() + 1)
  const [selectedYear, setSelectedYear] = useState(today.getFullYear())
  const [view, setView] = useState('spending')
  const [showYoY, setShowYoY] = useState(false)
  const [yoyData, setYoyData] = useState(null)
  const [drawer, setDrawer] = useState({ open: false, title: '', subtitle: '', filters: {} })
  const [merchantDrawerName, setMerchantDrawerName] = useState(null)

  useEffect(() => {
    getIncomeVsSpending(timeRange).then(setMonthlyData).catch(() => {})
  }, [timeRange])

  useEffect(() => {
    getCategoryBreakdown(selectedMonth, selectedYear).then(setBreakdown).catch(() => setBreakdown(null))
    getCategoryTrends(selectedMonth, selectedYear, 6).then(setTrends).catch(() => setTrends(null))
    getSpendingPatterns(selectedMonth, selectedYear).then(setPatterns).catch(() => setPatterns(null))
    if (showYoY) {
      getYearOverYear(selectedMonth, selectedYear).then(setYoyData).catch(() => setYoyData(null))
    }
  }, [selectedMonth, selectedYear, showYoY])

  useEffect(() => {
    getMerchantInsights(6).then(d => setMerchants(d.merchants || [])).catch(() => {})
    getRecurring().then(setRecurring).catch(() => {})
  }, [])

  // Derived numbers
  const totalSpending = breakdown?.total_spending || 0
  const totalIncome = breakdown?.total_income || 0
  const netSavings = breakdown?.net || 0
  const savingsRate = patterns?.savings_rate
  const forecast = patterns?.forecast
  const isCurrentMonth = forecast?.is_current_month
  const monthChanges = (() => {
    // Compute month-over-month from trends data — sum the deltas
    if (!trends?.categories) return null
    const cur = trends.categories.reduce((s, c) => s + c.amount, 0)
    const prev = trends.categories.reduce((s, c) => s + c.prev_month_amount, 0)
    if (prev === 0) return null
    return ((cur - prev) / prev) * 100
  })()

  const pieData = (view === 'spending' ? breakdown?.spending_categories : breakdown?.income_categories) || []

  // Trends are spending-only — pick the right list to render
  const trendsByCategory = useMemo(() => {
    const map = {}
    ;(trends?.categories || []).forEach(t => { map[t.category] = t })
    return map
  }, [trends])

  // ISO date range that corresponds to the selected month — used as drawer filters
  const monthRange = useMemo(() => {
    const start = `${selectedYear}-${String(selectedMonth).padStart(2, '0')}-01`
    const lastDay = new Date(selectedYear, selectedMonth, 0).getDate()
    const end = `${selectedYear}-${String(selectedMonth).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`
    return { start_date: start, end_date: end }
  }, [selectedMonth, selectedYear])

  const monthLabel = useMemo(() => (
    new Date(selectedYear, selectedMonth - 1, 1)
      .toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
  ), [selectedMonth, selectedYear])

  // Drill-down handler
  const openCategory = (category, isIncome = false) => {
    setDrawer({
      open: true,
      title: `${isIncome ? '💰 ' : ''}${category}`,
      subtitle: monthLabel,
      filters: { category, ...monthRange },
    })
  }

  const handleExport = () => {
    const url = getExportUrl(monthRange.start_date, monthRange.end_date)
    window.open(url, '_blank')
  }

  // Forecast comparison: are we on track to beat / overshoot last month?
  const forecastVsLast = useMemo(() => {
    if (!forecast?.is_current_month) return null
    const last = monthlyData.length >= 2 ? monthlyData[monthlyData.length - 2]?.spending : null
    if (!last) return null
    const diff = forecast.projected_total - last
    return { last, diff, pct: last > 0 ? (diff / last) * 100 : null }
  }, [forecast, monthlyData])

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">Spending & Income</h1>
        <button
          className="btn btn-secondary"
          onClick={handleExport}
          title="Download CSV of transactions for the selected month"
        >
          <Download size={14} /> Export CSV
        </button>
      </div>

      {/* ─── Stat cards (5-up) ──────────────────────────────── */}
      <div className="stats-grid" style={{ gridTemplateColumns: 'repeat(5, 1fr)' }}>
        <Stat
          label="Spending"
          icon={<TrendingDown size={14} color="var(--accent-red)" />}
          value={fmt(totalSpending)}
          tone="negative"
          sub={monthChanges !== null ? (
            <span>
              <DeltaBadge pct={monthChanges} inverse /> vs last month
            </span>
          ) : null}
        />
        <Stat
          label="Income"
          icon={<TrendingUp size={14} color="var(--accent-green)" />}
          value={fmt(totalIncome)}
          tone="positive"
        />
        <Stat
          label="Net"
          icon={<DollarSign size={14} color="var(--accent-blue)" />}
          value={fmt(netSavings)}
          tone={netSavings >= 0 ? 'positive' : 'negative'}
        />
        <Stat
          label="Savings Rate"
          icon={<Percent size={14} color="var(--accent-purple)" />}
          value={savingsRate !== null && savingsRate !== undefined ? `${savingsRate}%` : '—'}
          tone={savingsRate >= 20 ? 'positive' : savingsRate < 0 ? 'negative' : undefined}
          sub={savingsRate >= 20 ? 'healthy' : savingsRate >= 0 ? 'building' : 'overspending'}
        />
        <Stat
          label={isCurrentMonth ? 'Projected Spend' : 'Avg / Day'}
          icon={<Calendar size={14} color="var(--accent-orange)" />}
          value={
            isCurrentMonth
              ? fmt(forecast?.projected_total || 0)
              : fmt(forecast?.daily_avg || 0)
          }
          sub={
            isCurrentMonth && forecast
              ? `${forecast.days_elapsed}/${forecast.days_in_month} days · ${fmt(forecast.daily_avg)}/day`
              : forecast ? `${forecast.days_in_month} days` : null
          }
        />
      </div>

      {forecastVsLast && (
        <div style={{
          padding: 'var(--space-3) var(--space-4)',
          marginBottom: 'var(--space-6)',
          background: 'var(--bg-card)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius-sm)',
          fontSize: 'var(--text-sm)',
          color: 'var(--text-secondary)',
        }}>
          <span style={{ marginRight: 8 }}>📈</span>
          At your current pace, you'll spend {fmt(forecast.projected_total)} by month-end —
          {' '}
          <span style={{
            color: forecastVsLast.diff > 0 ? 'var(--accent-red)' : 'var(--accent-green)',
            fontWeight: 600,
          }}>
            {forecastVsLast.diff > 0 ? 'over' : 'under'} last month by {fmt(Math.abs(forecastVsLast.diff))}
          </span>.
        </div>
      )}

      {/* ─── Income vs Spending trend ──────────────────────── */}
      {/* Aggregates from the same monthlyData that feeds the chart, so the
          stats and the bars can never disagree. Months-with-data is used
          as the avg denominator (not raw range) so a partial current
          month / partial YTD doesn't artificially deflate the per-month
          numbers. */}
      {(() => {
        const totalIncome = monthlyData.reduce((s, m) => s + (m.income || 0), 0)
        const totalSpending = monthlyData.reduce((s, m) => s + (m.spending || 0), 0)
        const net = totalIncome - totalSpending
        const monthsWithData = monthlyData.filter(
          m => (m.income || 0) > 0 || (m.spending || 0) > 0
        ).length
        const avgIncome = monthsWithData > 0 ? totalIncome / monthsWithData : 0
        const avgSpending = monthsWithData > 0 ? totalSpending / monthsWithData : 0
        const avgNet = monthsWithData > 0 ? net / monthsWithData : 0
        const trendLabel = trendPreset === 'ytd'
          ? `Year-to-date · ${monthsWithData} mo`
          : `Last ${timeRange} mo`

        return (
          <div className="card" style={{ marginBottom: 'var(--space-6)' }}>
            <div className="card-header">
              <span className="card-title">Income vs Spending Trend · {trendLabel}</span>
              <div style={{ display: 'flex', gap: 6 }}>
                {[
                  { key: '2',  label: '2mo'  },
                  { key: '3',  label: '3mo'  },
                  { key: '6',  label: '6mo'  },
                  { key: '12', label: '12mo' },
                  { key: 'ytd', label: 'YTD' },
                ].map(({ key, label }) => {
                  const active = trendPreset === key
                  return (
                    <button
                      key={key}
                      onClick={() => setTrendPreset(key)}
                      className={active ? 'btn btn-primary' : 'btn btn-secondary'}
                      style={{ padding: '6px 14px', fontSize: 12 }}
                    >
                      {label}
                    </button>
                  )
                })}
              </div>
            </div>

            {/* Aggregate tiles — same shape as the Dashboard's Trend snapshot
                so jumping between the two pages is visually consistent. */}
            {monthsWithData > 0 && (
              <div style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(4, 1fr)',
                gap: 12,
                marginBottom: 16,
              }}>
                <TrendStat
                  label="Income"
                  total={totalIncome}
                  avg={avgIncome}
                  color="var(--accent-green)"
                />
                <TrendStat
                  label="Spending"
                  total={totalSpending}
                  avg={avgSpending}
                  color="var(--accent-red)"
                />
                <TrendStat
                  label="Net"
                  total={net}
                  avg={avgNet}
                  color={net >= 0 ? 'var(--accent-green)' : 'var(--accent-red)'}
                />
                <TrendStat
                  label="Months counted"
                  total={`${monthsWithData} of ${monthlyData.length}`}
                  avg={monthsWithData < monthlyData.length ? 'partial month included' : 'all complete'}
                  color="var(--text-secondary)"
                  isText
                />
              </div>
            )}

            {monthlyData.length > 0 ? (
              <ResponsiveContainer width="100%" height={300}>
                <BarChart data={monthlyData} barGap={4}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                  <XAxis dataKey="month" tick={{ fill: 'var(--text-muted)', fontSize: 12 }} />
                  <YAxis tick={{ fill: 'var(--text-muted)', fontSize: 12 }} tickFormatter={v => `$${(v / 1000).toFixed(0)}k`} />
                  <Tooltip content={<ChartTooltip />} />
                  <Legend wrapperStyle={{ fontSize: 13 }} />
                  <Bar dataKey="income" name="Income" fill="#34d399" radius={[4, 4, 0, 0]} />
                  <Bar dataKey="spending" name="Spending" fill="#f87171" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <EmptyState compact icon={<BarChart3 size={20} />} title="No trend data yet" />
            )}
          </div>
        )
      })()}

      {/* ─── Month + view picker ───────────────────────────── */}
      <div style={{ display: 'flex', gap: 12, marginBottom: 16, alignItems: 'center', flexWrap: 'wrap' }}>
        <select
          value={selectedMonth}
          onChange={e => setSelectedMonth(Number(e.target.value))}
          style={SELECT_STYLE}
        >
          {['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'].map((m, i) => (
            <option key={i} value={i + 1}>{m}</option>
          ))}
        </select>
        <select
          value={selectedYear}
          onChange={e => setSelectedYear(Number(e.target.value))}
          style={SELECT_STYLE}
        >
          {[2024, 2025, 2026, 2027].map(y => <option key={y} value={y}>{y}</option>)}
        </select>
        <label style={{ fontSize: 'var(--text-xs)', color: 'var(--text-secondary)', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <input type="checkbox" checked={showYoY} onChange={e => setShowYoY(e.target.checked)} />
          show year-over-year
        </label>
        <div style={{ display: 'flex', gap: 4, marginLeft: 'auto' }}>
          <button
            onClick={() => setView('spending')}
            className={view === 'spending' ? 'btn btn-primary' : 'btn btn-secondary'}
            style={{ padding: '6px 16px', fontSize: 13 }}
          >Spending</button>
          <button
            onClick={() => setView('income')}
            className={view === 'income' ? 'btn btn-primary' : 'btn btn-secondary'}
            style={{ padding: '6px 16px', fontSize: 13 }}
          >Income</button>
        </div>
      </div>

      {/* ─── Pie chart + Category Details ──────────────────── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: 16, marginBottom: 'var(--space-6)' }}>
        <div className="card">
          <div className="card-header">
            <span className="card-title">{view === 'spending' ? 'Spending' : 'Income'} by Category</span>
            <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>{monthLabel}</span>
          </div>
          {pieData.length > 0 ? (
            <ResponsiveContainer width="100%" height={280}>
              <PieChart>
                <Pie
                  data={pieData}
                  cx="50%"
                  cy="50%"
                  innerRadius={65}
                  outerRadius={110}
                  paddingAngle={2}
                  dataKey="amount"
                  nameKey="category"
                  onClick={(slice) => openCategory(slice.category, view === 'income')}
                  style={{ cursor: 'pointer' }}
                >
                  {pieData.map((_, i) => (
                    <Cell key={i} fill={COLORS[i % COLORS.length]} />
                  ))}
                </Pie>
                <Tooltip content={<ChartTooltip />} />
              </PieChart>
            </ResponsiveContainer>
          ) : (
            <EmptyState compact title={`No ${view} data for ${monthLabel}`} />
          )}
          <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', textAlign: 'center', marginTop: 4 }}>
            click a slice to see transactions
          </div>
        </div>

        <div className="card">
          <div className="card-header">
            <span className="card-title">Category Details</span>
            <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
              {pieData.length} categor{pieData.length === 1 ? 'y' : 'ies'}
            </span>
          </div>
          <div style={{ maxHeight: 380, overflowY: 'auto' }}>
            {pieData.map((cat, i) => {
              const trend = view === 'spending' ? trendsByCategory[cat.category] : null
              return (
                <div
                  key={cat.category}
                  onClick={() => openCategory(cat.category, view === 'income')}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 10, padding: '10px 6px',
                    borderBottom: i < pieData.length - 1 ? '1px solid var(--border)' : 'none',
                    cursor: 'pointer', borderRadius: 'var(--radius-xs)',
                    transition: 'background 0.15s',
                  }}
                  onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-hover)'}
                  onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                >
                  <span style={{ fontSize: 18 }}>{cat.icon}</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 500, fontSize: 'var(--text-sm)' }}>{cat.category}</div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}>
                      <div style={{
                        flex: 1, height: 5, background: 'var(--bg-hover)',
                        borderRadius: 3, overflow: 'hidden',
                      }}>
                        <div style={{
                          width: `${cat.percentage}%`, height: '100%', borderRadius: 3,
                          background: COLORS[i % COLORS.length],
                        }} />
                      </div>
                      <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', minWidth: 36 }}>
                        {cat.percentage}%
                      </span>
                    </div>
                  </div>
                  {trend && (
                    <Sparkline
                      data={trend.history}
                      color={COLORS[i % COLORS.length]}
                    />
                  )}
                  <div style={{ minWidth: 110, textAlign: 'right' }}>
                    <div className="tabular" style={{
                      fontWeight: 600, fontSize: 'var(--text-sm)',
                      color: view === 'spending' ? 'var(--accent-red)' : 'var(--accent-green)',
                    }}>
                      {fmt(cat.amount)}
                    </div>
                    {trend && (
                      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6, marginTop: 2 }}>
                        <DeltaBadge pct={trend.mom_pct} inverse={view === 'spending'} />
                        {showYoY && trend.yoy_pct !== null && (
                          <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
                            <span style={{ marginRight: 2 }}>YoY</span>
                            <DeltaBadge pct={trend.yoy_pct} inverse={view === 'spending'} />
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              )
            })}
            {pieData.length === 0 && (
              <EmptyState compact title="No data" />
            )}
          </div>
        </div>
      </div>

      {/* ─── Year-over-Year Comparison ─────────────────────── */}
      {showYoY && yoyData && (
        <div className="card" style={{ marginBottom: 'var(--space-6)' }}>
          <div className="card-header">
            <span className="card-title">Year-over-Year Comparison</span>
            <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
              {new Date(selectedYear - 1, selectedMonth - 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' })} vs {new Date(selectedYear, selectedMonth - 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}
            </span>
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table style={{
              width: '100%',
              borderCollapse: 'collapse',
              fontSize: 'var(--text-sm)',
            }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--border)' }}>
                  <th style={{ textAlign: 'left', padding: '8px', fontWeight: 600, color: 'var(--text-secondary)' }}>Category</th>
                  <th style={{ textAlign: 'right', padding: '8px', fontWeight: 600, color: 'var(--text-secondary)', width: 100 }}>
                    {new Date(selectedYear, selectedMonth - 1).toLocaleDateString('en-US', { month: 'short', year: '2-digit' })}
                  </th>
                  <th style={{ textAlign: 'right', padding: '8px', fontWeight: 600, color: 'var(--text-secondary)', width: 100 }}>
                    {new Date(selectedYear - 1, selectedMonth - 1).toLocaleDateString('en-US', { month: 'short', year: '2-digit' })}
                  </th>
                  <th style={{ textAlign: 'right', padding: '8px', fontWeight: 600, color: 'var(--text-secondary)', width: 80 }}>Delta %</th>
                </tr>
              </thead>
              <tbody>
                {yoyData.deltas.by_category.map((cat, i) => (
                  <tr key={cat.category} style={{ borderBottom: i < yoyData.deltas.by_category.length - 1 ? '1px solid var(--border)' : 'none' }}>
                    <td style={{ padding: '8px', fontWeight: 500 }}>{cat.category}</td>
                    <td style={{ padding: '8px', textAlign: 'right', color: view === 'spending' ? 'var(--accent-red)' : 'var(--accent-green)' }}>
                      {fmt(cat.current)}
                    </td>
                    <td style={{ padding: '8px', textAlign: 'right', color: 'var(--text-secondary)' }}>
                      {fmt(cat.prior)}
                    </td>
                    <td style={{
                      padding: '8px',
                      textAlign: 'right',
                      color: view === 'spending'
                        ? (cat.delta_pct < 0 ? '#28a745' : '#dc3545')
                        : (cat.delta_pct > 0 ? '#28a745' : '#dc3545'),
                      fontWeight: 600,
                    }}>
                      {cat.delta_pct > 0 ? '+' : ''}{cat.delta_pct.toFixed(1)}%
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={{
            padding: 'var(--space-3)',
            borderTop: '1px solid var(--border)',
            display: 'grid',
            gridTemplateColumns: 'repeat(3, 1fr)',
            gap: 'var(--space-3)',
            fontSize: 'var(--text-xs)',
          }}>
            <div>
              <div style={{ color: 'var(--text-secondary)', marginBottom: 4 }}>Spending Change</div>
              <div style={{
                fontWeight: 600,
                fontSize: 'var(--text-base)',
                color: view === 'spending'
                  ? (yoyData.deltas.spending_pct < 0 ? '#28a745' : '#dc3545')
                  : (yoyData.deltas.spending_pct > 0 ? '#28a745' : '#dc3545'),
              }}>
                {yoyData.deltas.spending_pct > 0 ? '+' : ''}{yoyData.deltas.spending_pct.toFixed(1)}%
              </div>
            </div>
            <div>
              <div style={{ color: 'var(--text-secondary)', marginBottom: 4 }}>Income Change</div>
              <div style={{
                fontWeight: 600,
                fontSize: 'var(--text-base)',
                color: yoyData.deltas.income_pct > 0 ? '#28a745' : '#dc3545',
              }}>
                {yoyData.deltas.income_pct > 0 ? '+' : ''}{yoyData.deltas.income_pct.toFixed(1)}%
              </div>
            </div>
            <div>
              <div style={{ color: 'var(--text-secondary)', marginBottom: 4 }}>Net Change</div>
              <div style={{
                fontWeight: 600,
                fontSize: 'var(--text-base)',
                color: yoyData.deltas.net_pct > 0 ? '#28a745' : '#dc3545',
              }}>
                {yoyData.deltas.net_pct > 0 ? '+' : ''}{yoyData.deltas.net_pct.toFixed(1)}%
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ─── Top Merchants + Recurring ─────────────────────── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: 16, marginBottom: 'var(--space-6)' }}>
        <TopMerchantsCard
          merchants={merchants}
          onMerchantClick={(m) => setMerchantDrawerName(m.merchant)}
        />
        <RecurringCard data={recurring} onRulesChanged={() => getRecurring().then(setRecurring).catch(() => {})} />
      </div>

      {/* ─── Cash Flow Waterfall + DOW heatmap ─────────────── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: 16, marginBottom: 'var(--space-6)' }}>
        <WaterfallCard data={patterns?.waterfall} />
        <DayOfWeekCard data={patterns?.dow_heatmap || []} />
      </div>

      {/* ─── Income Sources (income view only) ─────────────── */}
      {view === 'income' && (
        <div style={{ marginBottom: 'var(--space-6)' }}>
          <IncomeSourcesCard sources={patterns?.income_sources || []} />
        </div>
      )}

      {/* ─── 365-day spending heatmap (spending view only) ─────────── */}
      {view === 'spending' && (
        <div style={{ marginBottom: 'var(--space-6)' }}>
          <SpendingHeatmap />
        </div>
      )}

      <TransactionDrawer
        open={drawer.open}
        onClose={() => setDrawer({ ...drawer, open: false })}
        title={drawer.title}
        subtitle={drawer.subtitle}
        filters={drawer.filters}
      />
      <MerchantDrawer
        merchantName={merchantDrawerName}
        onClose={() => setMerchantDrawerName(null)}
      />
    </div>
  )
}

const SELECT_STYLE = {
  background: 'var(--bg-card)',
  color: 'var(--text-primary)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius-sm)',
  padding: '8px 12px',
  fontSize: 14,
}
