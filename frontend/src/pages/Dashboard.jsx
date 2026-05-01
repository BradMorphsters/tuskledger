import { useState, useEffect } from 'react'
import {
  PieChart, Pie, Cell, ResponsiveContainer, Tooltip,
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Legend,
} from 'recharts'
import { getAccounts, getCategoryBreakdown, getLatestNetWorth, getTransactions, getIncomeVsSpending, getBusinesses, getManualAssets, getSpendingPatterns } from '../api/client'
import BusinessBadge from '../components/BusinessBadge'
import TransactionDrawer from '../components/TransactionDrawer'
import AccountFreshness from '../components/AccountFreshness'
import Stat from '../components/Stat'
import Pill from '../components/Pill'
import Skeleton from '../components/Skeleton'
import EmptyState from '../components/EmptyState'
import UpcomingBills from '../components/UpcomingBills'
import StaleBalanceAlert from '../components/StaleBalanceAlert'
import AINarrative from '../components/AINarrative'
import InsightsBar from '../components/InsightsBar'
import TrendStat from '../components/TrendStat'
import { FinancialPulse, CashFlowForecast, DailySnapshot, HsaTracker, DcfsaTracker, LoanPayoffCountdown, PortfolioSnapshot } from '../components/DashboardTiles'
import { Wallet, ChevronDown, ChevronUp, ChevronRight } from 'lucide-react'

// Strip noisy ACH prefixes from raw transaction descriptions for inline
// display. Mirrors the helper on the Spending & Income page.
function cleanMerchantName(raw) {
  if (!raw) return raw
  let s = String(raw)
  s = s.replace(/\s+(TYPE:|ID:|DATA:|CO:|PPD|ACH ECC|ACH Trace).*/i, '')
  s = s.replace(/^(DEPOSIT|WITHDRAWAL|TRANSFER|PAYMENT|PURCHASE)\s+/i, '')
  s = s.replace(/\s+/g, ' ').trim()
  if (s === s.toUpperCase() && s.length > 3) {
    s = s.toLowerCase().replace(/\b\w/g, c => c.toUpperCase())
  }
  return s || raw
}

/** First/last day of a month as ISO yyyy-mm-dd. `month` is 1-12. */
function monthRange(year, month) {
  const pad = n => String(n).padStart(2, '0')
  const first = `${year}-${pad(month)}-01`
  const lastDay = new Date(year, month, 0).getDate()
  const last = `${year}-${pad(month)}-${pad(lastDay)}`
  return { start_date: first, end_date: last }
}

const COLORS = ['#34d399', '#60a5fa', '#a78bfa', '#fbbf24', '#f87171', '#fb923c', '#38bdf8', '#e879f9', '#4ade80', '#f472b6']

function formatCurrency(val) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(val)
}

const CustomTooltip = ({ active, payload }) => {
  if (!active || !payload || !payload.length) return null
  const d = payload[0].payload
  return (
    <div style={{ background: '#1e2130', border: '1px solid #2a2d3a', borderRadius: 8, padding: '10px 14px' }}>
      <div style={{ fontWeight: 600, color: '#e8eaed', marginBottom: 4 }}>{d.icon} {d.category}</div>
      <div style={{ color: '#9aa0a6', fontSize: 13 }}>{formatCurrency(d.amount)} · {d.percentage}%</div>
    </div>
  )
}

/**
 * HealthTilesRow — the at-a-glance widget row at the top of Dashboard.
 * Order is user-customizable; defaults to pulse → forecast → snapshot.
 * Persists to localStorage so each user can prioritize their most-
 * glanced-at metric (e.g., put DailySnapshot first if you check that
 * every morning). Up/down arrows on each tile move it in the row.
 */
// Bumped to v9. Reordered row 2 so DCFSA sits directly to the right
// of Cash flow forecast (matches user's preference for grouping the
// recurring/scheduled-money tiles together). With snapshot returning
// null, the visible 6 tiles render row-by-row across 3 columns:
//   Row 1: Pulse | HSA | Portfolio
//   Row 2: Forecast | DCFSA | Loans
const TILE_ORDER_KEY = 'tuskledger-health-tile-order.v9'
const DEFAULT_TILE_ORDER = ['pulse', 'hsa', 'portfolio', 'forecast', 'dcfsa', 'loans', 'snapshot']
const TILE_LABELS = {
  pulse: 'Pulse', forecast: 'Forecast', snapshot: 'Snapshot',
  hsa: 'HSA', dcfsa: 'DCFSA', loans: 'Loans', portfolio: 'Portfolio',
}

function HealthTilesRow() {
  const [order, setOrder] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(TILE_ORDER_KEY) || 'null')
      // Validate: must contain all default tile keys, no extras
      if (Array.isArray(saved) && saved.length === DEFAULT_TILE_ORDER.length
          && DEFAULT_TILE_ORDER.every(k => saved.includes(k))) {
        return saved
      }
    } catch {}
    return DEFAULT_TILE_ORDER
  })

  const move = (idx, direction) => {
    const newIdx = idx + direction
    if (newIdx < 0 || newIdx >= order.length) return
    const next = [...order]
    ;[next[idx], next[newIdx]] = [next[newIdx], next[idx]]
    setOrder(next)
    try { localStorage.setItem(TILE_ORDER_KEY, JSON.stringify(next)) } catch {}
  }

  const tileFor = (key) => {
    if (key === 'pulse') return <FinancialPulse />
    if (key === 'forecast') return <CashFlowForecast />
    if (key === 'snapshot') return <DailySnapshot />
    if (key === 'hsa') return <HsaTracker />
    if (key === 'dcfsa') return <DcfsaTracker />
    if (key === 'loans') return <LoanPayoffCountdown />
    if (key === 'portfolio') return <PortfolioSnapshot />
    return null
  }

  return (
    <div style={{
      display: 'grid',
      // Column sizing math, no media queries:
      //   minmax(max(320px, calc((100% - 32px) / 3)), 1fr)
      // The min picks whichever is BIGGER between:
      //   - 320px (a hard floor — narrower and tile content gets cramped)
      //   - one-third of the available width minus the two 16px gaps
      // On wide screens the calc wins, forcing exactly 3 columns. As
      // the viewport narrows past ~992px the 320px floor takes over
      // and auto-fit drops to 2 columns (~640px), then 1 column.
      gridTemplateColumns: 'repeat(auto-fit, minmax(max(320px, calc((100% - 32px) / 3)), 1fr))',
      // align-items: stretch (the default) — every tile in a row
      // grows to the tallest tile's height. Combined with each tile
      // using tileCardStyle height: 100% + flex: 1 on its body
      // section, content fills the cell instead of leaving a gap
      // below it. Tile components that have less natural content
      // (Portfolio, DCFSA empty state, Loans single row) carry
      // extra secondary content so they fill rather than look
      // hollow when stretched. The full layout: 2 rows of 3 tiles
      // each, every cell visually weighted.
      alignItems: 'stretch',
      gap: 16, marginBottom: 24,
      position: 'relative',
    }}>
      {order.map((key, idx) => {
        const tile = tileFor(key)
        // HsaTracker (and any future conditional tile) returns null
        // when it has nothing to show — e.g. user has no HSA accounts.
        // Skip the wrapper entirely so the grid doesn't reserve an
        // empty cell with phantom hover controls.
        if (tile === null) return null
        return (
          <div key={key} style={{
            position: 'relative',
            // Tile wrapper hugs its content. Tile components own
            // their own internal layout; if a tile wants to be tall
            // it just renders tall content.
          }}>
            {tile}
            {/* Floating reorder controls — top-right of each tile.
                Hidden until hover so they don't add clutter. */}
            <div className="tile-reorder" style={{
              position: 'absolute', top: 8, right: 8,
              display: 'flex', gap: 2, opacity: 0,
              transition: 'opacity 0.15s',
            }}>
              <button
                onClick={() => move(idx, -1)}
                disabled={idx === 0}
                title="Move left"
                style={reorderBtnStyle(idx === 0)}
              >‹</button>
              <button
                onClick={() => move(idx, 1)}
                disabled={idx === order.length - 1}
                title="Move right"
                style={reorderBtnStyle(idx === order.length - 1)}
              >›</button>
            </div>
          </div>
        )
      })}
      <style>{`
        .tile-reorder { opacity: 0; }
        div:hover > .tile-reorder { opacity: 1; }
      `}</style>
    </div>
  )
}

function reorderBtnStyle(disabled) {
  return {
    width: 22, height: 22, padding: 0,
    background: 'var(--bg-elevated)', color: 'var(--text-secondary)',
    border: '1px solid var(--border)', borderRadius: 4,
    cursor: disabled ? 'not-allowed' : 'pointer',
    fontSize: 14, fontWeight: 600, lineHeight: 1,
    opacity: disabled ? 0.3 : 1,
  }
}


export default function Dashboard() {
  const [accounts, setAccounts] = useState([])
  const [manualAssets, setManualAssets] = useState([])
  const [breakdown, setBreakdown] = useState(null)
  const [patterns, setPatterns] = useState(null)
  const [netWorth, setNetWorth] = useState(null)
  const [recentTxns, setRecentTxns] = useState([])
  const [monthlyTrend, setMonthlyTrend] = useState([])
  const [businesses, setBusinesses] = useState([])
  const [loading, setLoading] = useState(true)

  // Range driving the trend section + the Income vs Spending chart.
  // 'ytd' is computed to current-month-of-year so backend (which expects
  // a number) gets an integer. `trendRange` derives from `trendPreset`
  // so the active pill stays highlighted independent of the resolved value.
  const [trendPreset, setTrendPreset] = useState('6')
  const trendRange = trendPreset === 'ytd'
    ? Math.max(1, new Date().getMonth() + 1)
    : parseInt(trendPreset, 10)

  // Drawer drill-down state. `drillCategory` null => closed.
  const now = new Date()
  const thisMonth = now.getMonth() + 1
  const thisYear = now.getFullYear()
  const [drillCategory, setDrillCategory] = useState(null)
  // Which side of the This Month card is currently expanded inline.
  // null = collapsed, 'spending' or 'income' = open.
  const [expandedThisMonth, setExpandedThisMonth] = useState(null)

  const loadDashboard = () => {
    Promise.all([
      getAccounts().catch(() => []),
      getCategoryBreakdown(thisMonth, thisYear).catch(() => null),
      getLatestNetWorth().catch(() => null),
      getTransactions({ limit: 8 }).catch(() => []),
      getIncomeVsSpending(trendRange).catch(() => []),
      getBusinesses().catch(() => []),
      getManualAssets().catch(() => []),
      // Income sources (cleaned + deduped) live on this endpoint, alongside
      // forecast / waterfall / DOW. We only need income_sources here.
      getSpendingPatterns(thisMonth, thisYear).catch(() => null),
    ]).then(([accs, bd, nw, txns, trend, bizs, manual, pat]) => {
      setAccounts(accs)
      setBreakdown(bd)
      setNetWorth(nw)
      setRecentTxns(txns)
      setMonthlyTrend(trend)
      setBusinesses(bizs || [])
      setManualAssets(manual || [])
      setPatterns(pat)
      setLoading(false)
    })
  }

  useEffect(() => {
    loadDashboard()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Re-fetch ONLY the trend when the range pill changes — avoids re-running
  // the whole Promise.all and re-rendering the rest of the dashboard.
  // Skipped on first mount (initial fetch is part of loadDashboard).
  const [trendInitialized, setTrendInitialized] = useState(false)
  useEffect(() => {
    if (!trendInitialized) { setTrendInitialized(true); return }
    getIncomeVsSpending(trendRange).then(setMonthlyTrend).catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trendRange])

  // Aggregates derived from monthlyTrend. Avg uses months-WITH-data so a
  // partial-current-month YTD doesn't divide by 1 and look misleading.
  const trendTotalIncome = monthlyTrend.reduce((s, m) => s + (m.income || 0), 0)
  const trendTotalSpending = monthlyTrend.reduce((s, m) => s + (m.spending || 0), 0)
  const trendNet = trendTotalIncome - trendTotalSpending
  const monthsWithData = monthlyTrend.filter(
    m => (m.income || 0) > 0 || (m.spending || 0) > 0
  ).length
  const trendAvgIncome = monthsWithData > 0 ? trendTotalIncome / monthsWithData : 0
  const trendAvgSpending = monthsWithData > 0 ? trendTotalSpending / monthsWithData : 0
  const trendAvgNet = monthsWithData > 0 ? trendNet / monthsWithData : 0
  const trendLabel = trendPreset === 'ytd'
    ? `Year-to-date · ${monthsWithData} mo`
    : `Last ${trendRange} mo`

  // Stat-card totals: prefer the server-side Net Worth snapshot when
  // available — it's the single source of truth and already accounts for
  // manual assets (homes, vehicles) on top of Plaid balances. Fall back
  // to a local compute over Plaid accounts only when no snapshot exists
  // yet (fresh install before the first sync).
  const accountAssets = accounts
    .filter(a => a.type !== 'credit' && a.type !== 'loan')
    .reduce((s, a) => s + a.current_balance, 0)
  const accountDebt = accounts
    .filter(a => a.type === 'credit' || a.type === 'loan')
    .reduce((s, a) => s + Math.abs(a.current_balance), 0)

  const totalAssets = (netWorth && netWorth.total_assets !== undefined)
    ? netWorth.total_assets
    : accountAssets
  const totalDebt = (netWorth && netWorth.total_liabilities !== undefined)
    ? netWorth.total_liabilities
    : accountDebt
  const totalBalance = (netWorth && netWorth.net_worth !== undefined)
    ? netWorth.net_worth
    : (accountAssets - accountDebt)

  if (loading) {
    // Skeleton placeholder mirrors the real layout so the page doesn't
    // flash from "loading" to "data" with an awkward height jump.
    return (
      <div>
        <StaleBalanceAlert />
        <div className="page-header">
          <h1 className="page-title">Dashboard</h1>
        </div>
        <div className="stats-grid">
          {[0, 1, 2, 3].map(i => (
            <div key={i} className="stat-card tone-neutral">
              <Skeleton width="50%" height={12} style={{ marginBottom: 12 }} />
              <Skeleton width="80%" height={28} />
            </div>
          ))}
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 24 }}>
          <div className="card" style={{ minHeight: 280 }}><Skeleton width="40%" height={16} style={{ marginBottom: 16 }} /><Skeleton width="100%" height={220} /></div>
          <div className="card" style={{ minHeight: 280 }}><Skeleton width="40%" height={16} style={{ marginBottom: 16 }} /><Skeleton width="100%" height={220} /></div>
        </div>
      </div>
    )
  }

  if (accounts.length === 0) {
    return (
      <div>
        <StaleBalanceAlert />
        <div className="page-header">
          <h1 className="page-title">Dashboard</h1>
        </div>
        <div className="card">
          <EmptyState
            icon={<Wallet size={24} />}
            title="Welcome to Tusk Ledger"
            description="Connect your bank accounts and credit cards to start tracking your spending, budgets, investments, and net worth in one place."
            action={
              <a href="/connect" className="btn btn-primary" style={{ display: 'inline-flex' }}>
                Connect Accounts
              </a>
            }
          />
        </div>
      </div>
    )
  }

  const pieData = breakdown?.spending_categories?.slice(0, 8) || []
  const totalSpending = breakdown?.total_spending || 0
  const totalIncome = breakdown?.total_income || 0

  return (
      <div>
        <StaleBalanceAlert />
        <div className="page-header">
        <h1 className="page-title">Dashboard</h1>
      </div>

      {/* Stat cards — top-line numbers from the Net Worth snapshot, plus a
          monthly cash-flow split. The Stat component handles the accent
          stripe based on tone. */}
      <div className="stats-grid">
        <Stat
          label="Net Worth"
          value={formatCurrency(totalBalance)}
          tone={totalBalance >= 0 ? 'positive' : 'negative'}
        />
        <Stat
          label="Total Assets"
          value={formatCurrency(totalAssets)}
          tone="positive"
        />
        <Stat
          label="Total Debt"
          value={formatCurrency(totalDebt)}
          tone="negative"
        />
        <div className="stat-card tone-neutral">
          <div className="stat-label">This Month</div>
          <div style={{ display: 'flex', gap: 'var(--space-5)', marginTop: 'var(--space-2)', alignItems: 'baseline' }}>
            {/* Both halves are buttons that toggle the inline breakdown panel
                below the stats grid. Active half gets a brighter label. */}
            {[
              { key: 'spending', label: 'Spending', color: 'var(--accent-red)', value: totalSpending },
              { key: 'income',   label: 'Income',   color: 'var(--accent-green)', value: totalIncome },
            ].map(({ key, label, color, value }) => {
              const active = expandedThisMonth === key
              return (
                <button
                  key={key}
                  onClick={() => setExpandedThisMonth(active ? null : key)}
                  title={active ? 'Hide breakdown' : `Show ${label.toLowerCase()} breakdown`}
                  style={{
                    background: 'transparent',
                    border: 'none',
                    padding: 0,
                    margin: 0,
                    textAlign: 'left',
                    cursor: 'pointer',
                    color: 'inherit',
                  }}
                >
                  <div style={{
                    fontSize: 'var(--text-2xs)',
                    color: active ? color : 'var(--text-muted)',
                    textTransform: 'uppercase',
                    letterSpacing: 0.4,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 4,
                  }}>
                    {label}
                    {active ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
                  </div>
                  <div style={{
                    fontSize: 'var(--text-lg)',
                    fontWeight: 700,
                    color,
                    fontVariantNumeric: 'tabular-nums',
                    textDecoration: active ? 'underline' : 'none',
                    textDecorationThickness: 2,
                    textUnderlineOffset: 4,
                  }}>
                    {formatCurrency(value)}
                  </div>
                </button>
              )
            })}
          </div>
        </div>
      </div>

      {/* AI narrative + rule-based anomaly cards. Promoted high on the
          page so they sit directly under the user's headline numbers
          (Net Worth, This Month) instead of buried below the trend
          snapshot. The narrative card frames the specific anomaly
          cards underneath; both feed off the same MTD-vs-trailing-
          baseline math. AINarrative renders an empty placeholder when
          LLM_ENABLED=false so the layout doesn't bounce as it loads. */}
      <AINarrative />
      <InsightsBar />

      {/* Health-at-a-glance — pulse score, cash flow forecast, daily
          snapshot. Order is user-customizable via localStorage so each
          person can put their most-glanced-at tile first. */}
      <HealthTilesRow />


      {/* Trend snapshot — same shape as the "This Month" stats above but
          aggregated across the user-selected range. The pill row drives
          BOTH this section and the Income vs Spending chart below, so
          they always show the same window of data. */}
      <div className="card" style={{ marginBottom: 24 }}>
        <div className="card-header" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span className="card-title">Trend snapshot · {trendLabel}</span>
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
                  style={{
                    padding: '4px 10px',
                    fontSize: 12,
                    fontWeight: active ? 600 : 500,
                    borderRadius: 14,
                    background: active ? 'var(--accent-blue)' : 'rgba(255,255,255,0.04)',
                    border: `1px solid ${active ? 'var(--accent-blue)' : 'rgba(255,255,255,0.08)'}`,
                    color: active ? '#fff' : 'var(--text-secondary)',
                    cursor: 'pointer',
                  }}
                >
                  {label}
                </button>
              )
            })}
          </div>
        </div>

        {monthsWithData === 0 ? (
          <p style={{ color: 'var(--text-muted)', textAlign: 'center', padding: 20, margin: 0 }}>
            No data in this range yet
          </p>
        ) : (
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(4, 1fr)',
            gap: 12,
          }}>
            <TrendStat
              label="Income"
              total={trendTotalIncome}
              avg={trendAvgIncome}
              color="var(--accent-green)"
            />
            <TrendStat
              label="Spending"
              total={trendTotalSpending}
              avg={trendAvgSpending}
              color="var(--accent-red)"
            />
            <TrendStat
              label="Net"
              total={trendNet}
              avg={trendAvgNet}
              color={trendNet >= 0 ? 'var(--accent-green)' : 'var(--accent-red)'}
            />
            <TrendStat
              label="Months counted"
              // Repurposed: this fourth slot shows the data-coverage breakdown
              // alongside the three monetary totals. Keeps the grid balanced
              // and makes the avg denominator transparent.
              total={`${monthsWithData} of ${monthlyTrend.length}`}
              avg={monthsWithData < monthlyTrend.length ? 'partial month included' : 'all complete'}
              color="var(--text-secondary)"
              isText
            />
          </div>
        )}
      </div>

      {/* (AI narrative + InsightsBar moved up to sit directly under the
          stat cards — see above HealthTilesRow.) */}

      {/* Inline This Month breakdown — appears between the stat cards and
          the charts row when the user clicks Spending or Income above. */}
      {expandedThisMonth && (
        <ThisMonthBreakdown
          side={expandedThisMonth}
          breakdown={breakdown}
          patterns={patterns}
          totalSpending={totalSpending}
          totalIncome={totalIncome}
          month={thisMonth}
          year={thisYear}
          onClose={() => setExpandedThisMonth(null)}
        />
      )}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 24 }}>
        {/* Spending breakdown with friendly categories */}
        <div className="card">
          <div className="card-header">
            <span className="card-title">Spending by Category</span>
            <a href="/spending" style={{ fontSize: 13 }}>Details →</a>
          </div>
          {pieData.length > 0 ? (
            <>
              <ResponsiveContainer width="100%" height={240}>
                <PieChart>
                  <Pie
                    data={pieData}
                    cx="50%"
                    cy="50%"
                    innerRadius={55}
                    outerRadius={95}
                    paddingAngle={2}
                    dataKey="amount"
                    nameKey="category"
                    onClick={(d) => d && d.category && setDrillCategory(d.category)}
                    style={{ cursor: 'pointer' }}
                  >
                    {pieData.map((_, i) => (
                      <Cell key={i} fill={COLORS[i % COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip content={<CustomTooltip />} />
                </PieChart>
              </ResponsiveContainer>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 8 }}>
                {pieData.map((d, i) => (
                  <button
                    key={d.category}
                    onClick={() => setDrillCategory(d.category)}
                    title={`View ${d.category} transactions this month`}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 6,
                      fontSize: 12, color: 'var(--text-secondary)',
                      background: 'none', border: 'none', padding: 0, cursor: 'pointer',
                    }}
                  >
                    <span style={{ width: 10, height: 10, borderRadius: '50%', background: COLORS[i % COLORS.length] }} />
                    {d.icon} {d.category}
                  </button>
                ))}
              </div>
            </>
          ) : (
            <p style={{ color: 'var(--text-muted)', textAlign: 'center', padding: 40 }}>No spending data yet</p>
          )}
        </div>

        {/* Income vs Spending mini trend — shares trendRange with the
            Trend snapshot above so they always reflect the same window. */}
        <div className="card">
          <div className="card-header">
            <span className="card-title">Income vs Spending · {trendLabel}</span>
            <a href="/spending" style={{ fontSize: 13 }}>Full View →</a>
          </div>
          {monthlyTrend.length > 0 ? (
            <ResponsiveContainer width="100%" height={280}>
              <BarChart data={monthlyTrend} barGap={4}>
                <CartesianGrid strokeDasharray="3 3" stroke="#2a2d3a" />
                <XAxis dataKey="month" tick={{ fill: '#9aa0a6', fontSize: 11 }} />
                <YAxis tick={{ fill: '#9aa0a6', fontSize: 11 }} tickFormatter={v => `$${(v / 1000).toFixed(0)}k`} />
                <Tooltip
                  formatter={(val) => formatCurrency(val)}
                  contentStyle={{ background: '#1e2130', border: '1px solid #2a2d3a', borderRadius: 8 }}
                />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Bar dataKey="income" name="Income" fill="#34d399" radius={[3, 3, 0, 0]} />
                <Bar dataKey="spending" name="Spending" fill="#f87171" radius={[3, 3, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <p style={{ color: 'var(--text-muted)', textAlign: 'center', padding: 40 }}>Not enough data yet</p>
          )}
        </div>
      </div>

      {/* Upcoming bills — chronological view of due payments. Mirrors
          the chart row's visual rhythm (one card, full width). Positioned
          between charts and Accounts because it's the most action-driving
          piece of info on the page after the top-line stats. */}
      <UpcomingBills daysAhead={45} />

      {/* Accounts */}
      <div className="card" style={{ marginBottom: 24 }}>
        <div className="card-header">
          <span className="card-title">Accounts</span>
          <a href="/connect" style={{ fontSize: 13 }}>Manage →</a>
        </div>
        <div className="table-wrapper">
          <table>
            <thead>
              <tr><th>Account</th><th>Type</th><th style={{ textAlign: 'right' }}>Balance</th></tr>
            </thead>
            <tbody>
              {accounts.map(a => (
                <tr key={`plaid-${a.id}`}>
                  <td>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 500 }}>
                      <span>{a.custom_name || a.name}</span>
                      {a.is_manual && <Pill title="User-tracked, not synced from a bank">Manual</Pill>}
                    </div>
                    <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap', marginTop: 2 }}>
                      {a.institution_name && <span>{a.institution_name}</span>}
                      <AccountFreshness account={a} />
                    </div>
                  </td>
                  <td><span className="category-badge">{a.subtype || a.type}</span></td>
                  <td style={{ textAlign: 'right' }} className="tabular">
                    <span className={a.type === 'credit' || a.type === 'loan' ? 'amount-negative' : 'amount-positive'}>
                      {formatCurrency(a.current_balance)}
                    </span>
                  </td>
                </tr>
              ))}
              {/* Manual assets/liabilities. Distinguished by a "Manual" badge in
                  the institution-subtitle slot, since they have no Plaid item.
                  Liability values render in red and assets in green so the
                  glance-totals match the column color conventions. */}
              {manualAssets.map(m => {
                const isLiability = m.side === 'liability'
                return (
                  <tr key={`manual-${m.id}`}>
                    <td>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span style={{ fontWeight: 500 }}>{m.name}</span>
                        <Pill title="User-tracked, not synced from a bank">Manual</Pill>
                      </div>
                      <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', marginTop: 2 }}>
                        {(m.type || '').replace('_', ' ')}
                      </div>
                    </td>
                    <td>
                      <span className="category-badge">{(m.type || '').replace('_', ' ')}</span>
                    </td>
                    <td style={{ textAlign: 'right' }} className="tabular">
                      <span className={isLiability ? 'amount-negative' : 'amount-positive'}>
                        {formatCurrency(m.current_value)}
                      </span>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Recent transactions */}
      <div className="card">
        <div className="card-header">
          <span className="card-title">Recent Transactions</span>
          <a href="/transactions" style={{ fontSize: 13 }}>View all →</a>
        </div>
        <div className="table-wrapper">
          <table>
            <thead>
              <tr><th>Date</th><th>Description</th><th>Category</th><th style={{ textAlign: 'right' }}>Amount</th></tr>
            </thead>
            <tbody>
              {recentTxns.map(t => {
                const biz = businesses.find(b => b.id === t.business_id)
                return (
                <tr key={t.id}>
                  <td>{t.date}</td>
                  <td>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      {t.display_name || t.merchant_name || t.name}
                      {biz && <BusinessBadge business={biz} />}
                      {t.is_transfer && (
                        <Pill tone="info" title="Account-to-account transfer or bill payment (not counted as spending)">
                          ↔ Transfer
                        </Pill>
                      )}
                    </div>
                  </td>
                  <td><span className="category-badge">{t.custom_category || t.category || 'Uncategorized'}</span></td>
                  <td style={{ textAlign: 'right' }}>
                    <span className={t.amount > 0 ? 'amount-negative' : 'amount-positive'}>
                      {t.amount > 0 ? '-' : '+'}{formatCurrency(Math.abs(t.amount))}
                    </span>
                  </td>
                </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Drill-down: click a category slice/legend → see the transactions. */}
      <TransactionDrawer
        open={!!drillCategory}
        onClose={() => setDrillCategory(null)}
        title={drillCategory || ''}
        subtitle={`${now.toLocaleString('en-US', { month: 'long' })} ${thisYear}`}
        filters={drillCategory ? { category: drillCategory, ...monthRange(thisYear, thisMonth) } : {}}
        onDataChanged={loadDashboard}
      />
    </div>
  )
}


// ─── This Month inline breakdown ─────────────────────────────────────
// Renders an expandable card under the stats grid showing the line items
// that make up this month's Spending or Income total.
//
//   side='spending' → top categories from the existing breakdown payload,
//                     same data the donut uses, just as a clean text list.
//   side='income'   → cleaned + deduped income sources from the
//                     /api/analytics/spending-patterns endpoint.
//
// Each row is itself expandable: click a row to drill in and see the
// individual transactions that make up its total. We fetch the month's
// transactions once on first open and reuse the same payload for both
// spending- and income-side row expansions.
function ThisMonthBreakdown({
  side, breakdown, patterns, totalSpending, totalIncome,
  month, year, onClose,
}) {
  const isIncome = side === 'income'
  const total = isIncome ? totalIncome : totalSpending
  const accent = isIncome ? 'var(--accent-green)' : 'var(--accent-red)'
  const title = isIncome ? 'Income this month' : 'Spending this month'
  const subtitle = isIncome ? 'by source' : 'by category'

  // Per-row expansion: a Set of row keys currently showing their
  // individual transactions.
  const [openRows, setOpenRows] = useState(() => new Set())
  const [monthTxns, setMonthTxns] = useState(null)
  const [txnsLoading, setTxnsLoading] = useState(false)

  // Reset the per-row expansion state when the user flips Spending↔Income
  // so we don't keep a stale "Shopping" expansion while viewing income.
  useEffect(() => { setOpenRows(new Set()) }, [side])

  // Fetch the month's transactions once. Reuse for both sides.
  useEffect(() => {
    if (monthTxns !== null) return
    const pad = n => String(n).padStart(2, '0')
    const lastDay = new Date(year, month, 0).getDate()
    const start_date = `${year}-${pad(month)}-01`
    const end_date = `${year}-${pad(month)}-${pad(lastDay)}`
    setTxnsLoading(true)
    // /api/transactions caps limit at 500. A single household-month rarely
    // hits that, but if it ever does we'd silently miss the tail; the
    // existing TransactionDrawer already paginates so the workaround is
    // there if/when the cap matters.
    getTransactions({ start_date, end_date, limit: 500 })
      .then(txns => setMonthTxns(txns || []))
      .catch(() => setMonthTxns([]))
      .finally(() => setTxnsLoading(false))
  }, [monthTxns, month, year])

  // Build the row list specific to each side.
  let rows = []
  if (isIncome) {
    // income_sources is already sorted by amount desc on the backend, but
    // each ACH variation comes through as a separate entry — dedupe by the
    // cleaned name so multiple paychecks from the same employer collapse.
    const merged = new Map()
    for (const s of (patterns?.income_sources || [])) {
      const cleaned = cleanMerchantName(s.source)
      const cur = merged.get(cleaned) || { name: cleaned, raw: s.source, amount: 0, count: 0 }
      cur.amount += s.amount
      cur.count += 1
      merged.set(cleaned, cur)
    }
    rows = [...merged.values()]
      .sort((a, b) => b.amount - a.amount)
      .map(r => ({
        key: r.name,
        title: r.name,
        meta: r.count > 1 ? `${r.count} payments` : null,
        rawTitle: r.raw,
        amount: r.amount,
      }))
  } else {
    rows = (breakdown?.spending_categories || []).map(c => ({
      key: c.category,
      title: `${c.icon || ''} ${c.category}`.trim(),
      meta: c.transaction_count
        ? `${c.transaction_count} transaction${c.transaction_count === 1 ? '' : 's'}`
        : null,
      amount: c.amount,
    }))
  }

  // Match a transaction to a row's key. For income, by cleaned merchant
  // name; for spending, by category (custom takes precedence over Plaid's).
  const matchesRow = (txn, rowKey) => {
    if (isIncome) {
      if (txn.amount >= 0 || txn.is_transfer) return false
      const cleaned = cleanMerchantName(txn.merchant_name || txn.name || '')
      return cleaned === rowKey
    } else {
      if (txn.amount <= 0 || txn.is_transfer) return false
      const cat = txn.custom_category || txn.category || 'Uncategorized'
      return cat === rowKey
    }
  }

  // Inline progress bar widths are scaled to the LARGEST row, not the
  // total — that gives a useful visual ranking even when one category
  // dominates the total.
  const maxAmt = Math.max(...rows.map(r => r.amount), 1)

  const fmt = (n) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n || 0)
  const fmtDate = (iso) => {
    const d = new Date(iso + 'T00:00:00')
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  }

  const toggleRow = (key) => {
    setOpenRows(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  return (
    <div className="card" style={{ marginBottom: 24, animation: 'fadeIn 0.2s ease' }}>
      <div className="card-header">
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          <span className="card-title" style={{ color: accent }}>{title}</span>
          <span style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>
            {subtitle} · {rows.length} {rows.length === 1 ? 'item' : 'items'}
            {' · click a row to see individual transactions'}
          </span>
        </div>
        <button
          onClick={onClose}
          className="btn btn-secondary"
          style={{ padding: '4px 12px', fontSize: 12 }}
        >
          Close
        </button>
      </div>

      {rows.length === 0 ? (
        <div style={{ color: 'var(--text-muted)', fontSize: 13, padding: '16px 0' }}>
          No {isIncome ? 'income' : 'spending'} recorded this month yet.
        </div>
      ) : (
        <div>
          {rows.map(row => {
            const pct = (row.amount / maxAmt) * 100
            const totalPct = total > 0 ? (row.amount / total) * 100 : 0
            const isOpen = openRows.has(row.key)
            const subTxns = isOpen && monthTxns
              ? monthTxns.filter(t => matchesRow(t, row.key))
                  .sort((a, b) => (b.date || '').localeCompare(a.date || ''))
              : []
            return (
              <div key={row.key} style={{ borderBottom: '1px solid var(--border)' }}>
                <div
                  onClick={() => toggleRow(row.key)}
                  title={isOpen ? 'Hide individual transactions' : 'Show individual transactions'}
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '20px 1.6fr 3fr auto',
                    gap: 12,
                    alignItems: 'center',
                    padding: '8px 0',
                    cursor: 'pointer',
                    transition: 'background 0.15s',
                  }}
                  onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-hover)'}
                  onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                >
                  {/* Chevron */}
                  <span style={{ color: 'var(--text-muted)', display: 'flex', justifyContent: 'center' }}>
                    {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                  </span>

                  {/* Name + sub-label */}
                  <div style={{ minWidth: 0, overflow: 'hidden' }}>
                    <div title={row.rawTitle} style={{
                      fontWeight: 500, fontSize: 14,
                      whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                    }}>
                      {row.title}
                    </div>
                    {row.meta && (
                      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
                        {row.meta}
                      </div>
                    )}
                  </div>

                  {/* Bar + percentage of total */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <div style={{
                      flex: 1, height: 6, background: 'var(--bg-hover)',
                      borderRadius: 3, overflow: 'hidden',
                    }}>
                      <div style={{
                        width: `${pct}%`, height: '100%', borderRadius: 3, background: accent,
                      }} />
                    </div>
                    <span style={{ fontSize: 11, color: 'var(--text-muted)', minWidth: 44, textAlign: 'right' }}>
                      {totalPct.toFixed(1)}%
                    </span>
                  </div>

                  {/* Amount */}
                  <div className="tabular" style={{ fontWeight: 600, fontSize: 14, color: accent, minWidth: 100, textAlign: 'right' }}>
                    {fmt(row.amount)}
                  </div>
                </div>

                {/* Per-row drill-down */}
                {isOpen && (
                  <div style={{ paddingLeft: 32, paddingBottom: 10, paddingTop: 2 }}>
                    {txnsLoading ? (
                      <div style={{ fontSize: 12, color: 'var(--text-muted)', padding: '6px 0' }}>
                        Loading transactions…
                      </div>
                    ) : subTxns.length === 0 ? (
                      <div style={{ fontSize: 12, color: 'var(--text-muted)', padding: '6px 0' }}>
                        No matching transactions found in this month.
                      </div>
                    ) : (
                      <table style={{ width: '100%', fontSize: 12 }}>
                        <tbody>
                          {subTxns.map(t => {
                            // For income, prefer merchant_name (already clean) over the
                            // backend's concatenated display_name which can read
                            // "Oliver Healthcar Oliver Healthcar". Then run through the
                            // cleaner to strip ACH gunk if it slipped through, and
                            // collapse "Foo Foo" → "Foo".
                            let displayName
                            if (isIncome) {
                              displayName = cleanMerchantName(t.merchant_name || t.name || '')
                              const half = Math.floor(displayName.length / 2)
                              const a = displayName.slice(0, half).trim()
                              const b = displayName.slice(half).trim()
                              if (a && a === b) displayName = a
                            } else {
                              displayName = t.display_name || t.merchant_name || t.name || ''
                            }
                            return (
                              <tr key={t.id} style={{ borderBottom: '1px dotted var(--border)' }}>
                                <td style={{
                                  width: 60, padding: '4px 8px 4px 0',
                                  color: 'var(--text-muted)', whiteSpace: 'nowrap',
                                }}>
                                  {fmtDate(t.date)}
                                </td>
                                <td style={{ padding: '4px 8px 4px 0', minWidth: 0 }}>
                                  <div title={t.name} style={{
                                    color: 'var(--text-primary)',
                                    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                                    maxWidth: 320,
                                  }}>
                                    {displayName}
                                  </div>
                                </td>
                                <td style={{
                                  textAlign: 'right', whiteSpace: 'nowrap',
                                  fontVariantNumeric: 'tabular-nums', fontWeight: 500,
                                  color: accent,
                                  paddingLeft: 8,
                                }}>
                                  {fmt(Math.abs(t.amount))}
                                </td>
                              </tr>
                            )
                          })}
                        </tbody>
                      </table>
                    )}
                  </div>
                )}
              </div>
            )
          })}

          {/* Total footer */}
          <div style={{
            display: 'grid',
            gridTemplateColumns: '20px 1.6fr 3fr auto',
            gap: 12,
            alignItems: 'center',
            padding: '12px 0 4px',
            fontSize: 13,
          }}>
            <div />
            <div style={{ fontWeight: 700, color: 'var(--text-primary)' }}>Total</div>
            <div />
            <div className="tabular" style={{
              fontWeight: 700, fontSize: 14, color: accent, minWidth: 100, textAlign: 'right',
            }}>
              {fmt(total)}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}


