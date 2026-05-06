/**
 * DashboardTiles — composite "at a glance" widgets for the Dashboard page.
 *
 *   FinancialPulse       — single 0-100 health score with component breakdown
 *   CashFlowForecast     — 90-day forward projection (small line chart)
 *   HsaTracker           — HSA contribution headroom + tax savings + deadline
 *   PortfolioSnapshot    — total portfolio value + allocation + top holdings
 *
 * Each fetches its own data; parent doesn't need to wire anything.
 */
import { useEffect, useState } from 'react'
import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip, ReferenceLine } from 'recharts'
import { Activity, TrendingDown, TrendingUp, Calendar, Heart, Settings, PieChart, Wallet, AlertTriangle } from 'lucide-react'
import { getFinancialPulse, getCashFlowForecast, getTransactions, getHsaStatus, getInvestmentsSummary, getAccounts } from '../api/client'
import { SkeletonCard } from './Skeleton'
import { useStoredState } from '../lib/storage'
import { formatCurrencyZero as fmtFull } from '../lib/format'
// CashFlowForecast uses the existing /analytics/cash-flow-forecast
// endpoint (recurring detector + variable-spend baseline) — not our
// own naive version. The import is at the top of the file already.

function fmtMoney(n) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n || 0)
}

/* ─────────────────────── Financial Pulse ─────────────────────── */

function pulseColor(score) {
  if (score >= 80) return 'var(--accent-green)'
  if (score >= 60) return 'var(--accent-blue)'
  if (score >= 40) return 'var(--accent-orange)'
  return 'var(--accent-red)'
}
function pulseLabel(score) {
  if (score >= 80) return 'Strong'
  if (score >= 60) return 'Healthy'
  if (score >= 40) return 'Watch'
  return 'Action needed'
}

const PAYROLL_DEFERRAL_KEY = 'tuskledger-payroll-deferral'

export function FinancialPulse() {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  // Persist 401k deferral to localStorage so the user only sets it once.
  const [payrollDeferral, setPayrollDeferral] = useState(() => {
    try {
      return Number(localStorage.getItem(PAYROLL_DEFERRAL_KEY)) || 0
    } catch { return 0 }
  })
  const [editingDeferral, setEditingDeferral] = useState(false)

  // Re-fetch whenever the deferral changes (debounced via the input
  // field's onChange that only writes to state).
  useEffect(() => {
    setLoading(true)
    getFinancialPulse(payrollDeferral)
      .then(d => { setData(d); setLoading(false) })
      .catch(() => setLoading(false))
  }, [payrollDeferral])

  // Persist deferral changes to localStorage.
  useEffect(() => {
    try { localStorage.setItem(PAYROLL_DEFERRAL_KEY, String(payrollDeferral)) } catch {}
  }, [payrollDeferral])

  if (loading) return <SkeletonCard titleWidth="35%" rows={5} />

  if (!data) return null
  const score = data.score
  const color = pulseColor(score)
  return (
    <div className="card" style={tileCardStyle}>
      <div className="card-header">
        <span className="card-title" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <Activity size={14} style={{ color }} /> Financial pulse
        </span>
        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>composite 0–100</span>
      </div>
      {/* Big number + label */}
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 8 }}>
        <div style={{ fontSize: 44, fontWeight: 700, color, lineHeight: 1, fontVariantNumeric: 'tabular-nums' }}>
          {Math.round(score)}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <span style={{
            display: 'inline-block', padding: '3px 8px',
            background: `${color}22`, color, borderRadius: 4,
            fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5,
            alignSelf: 'flex-start',
          }}>
            {pulseLabel(score)}
          </span>
          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
            {data.components.liquidity.value}mo runway · {data.components.savings.value}% saving
          </span>
        </div>
      </div>
      {/* Runway composition — shown when taxable brokerage is meaningful
          (>0) so the user understands how the runway number is built. */}
      {data.components.liquidity.taxable_brokerage > 0 && (
        <div style={{
          marginBottom: 14, padding: '6px 10px',
          background: 'var(--bg-elevated)', borderRadius: 6,
          fontSize: 11, color: 'var(--text-secondary)',
        }}>
          Runway = {fmtMoney(data.components.liquidity.pure_cash)} cash
          + {fmtMoney(data.components.liquidity.taxable_brokerage)} taxable brokerage
          (penalty-free, 2-day liquid)
        </div>
      )}
      {/* Component bars */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {Object.entries(data.components).map(([key, c]) => (
          <ComponentBar key={key} label={c.label || key} score={c.score} color={pulseColor(c.score)} />
        ))}
      </div>
      {/* Savings rate detail — shown under the component bars when
          payroll deferral is set OR when the user is editing the value.
          Lets the user see "20% visible / 33% true" so the systematic
          understatement from Plaid (no payroll-deduction visibility) is
          transparent rather than hidden. */}
      <div style={{
        marginTop: 12, paddingTop: 10,
        borderTop: '1px dashed var(--border)',
        fontSize: 11, color: 'var(--text-secondary)',
      }}>
        {data.components.savings.uses_true_rate ? (
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
            <span>
              Savings rate: <strong style={{ color: 'var(--text-primary)' }}>
                {data.components.savings.true_rate_pct}% true
              </strong>
              <span style={{ color: 'var(--text-muted)' }}>
                {' '}({data.components.savings.visible_rate_pct}% visible
                + ${data.components.savings.monthly_payroll_deferral}/mo 401k)
              </span>
            </span>
            <button onClick={() => setEditingDeferral(e => !e)} style={editBtnStyle}>
              {editingDeferral ? 'done' : 'edit'}
            </button>
          </div>
        ) : (
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
            <span>
              Savings rate based on bank only. Add 401k contributions for true rate.
            </span>
            <button onClick={() => setEditingDeferral(e => !e)} style={editBtnStyle}>
              {editingDeferral ? 'done' : '+ 401k'}
            </button>
          </div>
        )}
        {editingDeferral && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
              Monthly 401k / Roth / 403(b) deferral $:
            </span>
            <input
              type="number" min={0} step={50}
              value={payrollDeferral}
              onChange={e => setPayrollDeferral(Number(e.target.value) || 0)}
              autoFocus
              style={{
                width: 100, padding: '3px 8px', fontSize: 12,
                background: 'var(--bg-input)', color: 'inherit',
                border: '1px solid var(--border)', borderRadius: 4,
              }}
            />
          </div>
        )}
      </div>
    </div>
  )
}

const editBtnStyle = {
  fontSize: 10, padding: '2px 8px',
  background: 'transparent', color: 'var(--accent-blue)',
  border: '1px solid var(--border)', borderRadius: 3, cursor: 'pointer',
}

function ComponentBar({ label, score, color }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <div style={{ flex: '0 0 130px', fontSize: 11, color: 'var(--text-muted)', textTransform: 'capitalize' }}>
        {label}
      </div>
      <div style={{
        flex: 1, height: 6, background: 'var(--bg-elevated)',
        borderRadius: 3, overflow: 'hidden', position: 'relative',
      }}>
        <div style={{
          width: `${Math.min(100, score)}%`, height: '100%',
          background: color, transition: 'width 0.3s',
        }} />
      </div>
      <div style={{
        flex: '0 0 36px', textAlign: 'right',
        fontSize: 11, color: 'var(--text-secondary)',
        fontVariantNumeric: 'tabular-nums',
      }}>
        {Math.round(score)}
      </div>
    </div>
  )
}

/* ─────────────────────── Cash Flow Forecast ─────────────────────── */

export function CashFlowForecast() {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  useEffect(() => {
    getCashFlowForecast(90).then(d => { setData(d); setLoading(false) }).catch(() => setLoading(false))
  }, [])

  if (loading) return <SkeletonCard titleWidth="40%" rows={5} />
  if (!data || !data.series || !data.series.length) return null

  // Adapt to the existing endpoint's data shape:
  // series rows have { date, balance, ... }, plus low_point + per-day rates
  const startBal = data.series[0]?.balance || 0
  const endBal = data.series[data.series.length - 1]?.balance || 0
  const netChange = endBal - startBal
  const trending = netChange >= 0
  const Icon = trending ? TrendingUp : TrendingDown
  const trendColor = trending ? 'var(--accent-green)' : 'var(--accent-red)'

  // Min/max from the series for "lowest point" footer summary. The endpoint
  // ships its own low_point (worst balance) but we also want a max for
  // quick range context, so derive both from the series.
  const balances = data.series.map(s => s.balance)
  const seriesMin = Math.min(...balances)
  const seriesMax = Math.max(...balances)
  const minPoint = data.low_point || data.series.find(s => s.balance === seriesMin)
  const lowIsNegative = minPoint && minPoint.balance < 0

  return (
    <div className="card" style={tileCardStyle}>
      {/* Compact title bar — drops the technical "recurring + variable spend"
          subtitle (it took space and meant nothing to a casual viewer). */}
      <div className="card-header" style={{ marginBottom: 4 }}>
        <span className="card-title" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <Icon size={14} style={{ color: trendColor }} /> Cash flow forecast
        </span>
        <span style={{
          fontSize: 10, color: 'var(--text-muted)',
          padding: '2px 6px', border: '1px solid var(--border)', borderRadius: 10,
        }}>
          90 days
        </span>
      </div>

      {/* Negative-balance warning ribbon — promoted to the TOP so it's the
          first thing the user sees if their cash dips below zero. */}
      {lowIsNegative && (
        <div style={{
          padding: '6px 10px', marginBottom: 8,
          background: 'rgba(248,113,113,0.08)',
          border: '1px solid rgba(248,113,113,0.3)',
          borderRadius: 6, fontSize: 11, color: 'var(--accent-red)',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
        }}>
          <span>⚠ Cash dips to <strong>{fmtMoney(minPoint.balance)}</strong></span>
          <span style={{ color: 'var(--text-muted)' }}>{minPoint.date?.slice(5)}</span>
        </div>
      )}

      {/* Hero: today → projected, with arrow and delta in between. Replaces
          the old cramped 3-column grid where "Net change +" / "Net change −"
          used two unnecessary slots. Now it reads naturally L-to-R. */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '6px 0 10px',
      }}>
        <div style={{ flex: '1 1 auto', minWidth: 0 }}>
          <div style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.4 }}>
            Today
          </div>
          <div style={{
            fontSize: 18, fontWeight: 600, color: 'var(--text-primary)',
            fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap',
            overflow: 'hidden', textOverflow: 'ellipsis',
          }}>
            {fmtMoney(startBal)}
          </div>
        </div>

        {/* Center delta block — colored pill with arrow + amount */}
        <div style={{
          display: 'flex', flexDirection: 'column', alignItems: 'center',
          padding: '0 4px', flexShrink: 0,
        }}>
          <div style={{
            display: 'inline-flex', alignItems: 'center', gap: 3,
            padding: '2px 8px', borderRadius: 10,
            background: trending ? 'rgba(52,211,153,0.12)' : 'rgba(248,113,113,0.12)',
            color: trendColor, fontSize: 11, fontWeight: 600,
            fontVariantNumeric: 'tabular-nums',
          }}>
            {trending ? '+' : '−'}{fmtMoney(Math.abs(netChange))}
          </div>
          <div style={{ fontSize: 16, color: 'var(--text-muted)', marginTop: -2 }}>→</div>
        </div>

        <div style={{ flex: '1 1 auto', minWidth: 0, textAlign: 'right' }}>
          <div style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.4 }}>
            In 90 days
          </div>
          <div style={{
            fontSize: 18, fontWeight: 600, color: trendColor,
            fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap',
            overflow: 'hidden', textOverflow: 'ellipsis',
          }}>
            {fmtMoney(endBal)}
          </div>
        </div>
      </div>

      {/* Chart fills remaining vertical space so the tile sizes match its
          siblings whatever the row height ends up being. The narrower
          left-axis tick formatter saves horizontal real estate so the
          line itself gets the room it needs. */}
      <div style={{ flex: '1 1 0', minHeight: 110 }}>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data.series} margin={{ top: 4, right: 4, left: -8, bottom: 0 }}>
            <XAxis
              dataKey="date"
              tick={{ fill: 'var(--text-muted)', fontSize: 10 }}
              tickFormatter={d => d?.slice(5)}
              minTickGap={32}
            />
            <YAxis
              tick={{ fill: 'var(--text-muted)', fontSize: 10 }}
              tickFormatter={v => fmtCompactMoney(v)}
              width={42}
            />
            <Tooltip
              contentStyle={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 6, fontSize: 11 }}
              formatter={v => fmtMoney(v)}
              labelFormatter={d => d}
            />
            {/* Reference lines: zero gets dashed red as before; today's
                balance gets a faint horizontal so the chart self-explains
                "you're heading up/down from here". */}
            <ReferenceLine y={0} stroke="var(--accent-red)" strokeDasharray="3 3" />
            <ReferenceLine y={startBal} stroke="var(--text-muted)" strokeDasharray="2 4" strokeOpacity={0.5} />
            <Line type="monotone" dataKey="balance" stroke={trendColor} strokeWidth={2} dot={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>

      {/* Footer summary — min/max range as a compact strip, replaces the
          standalone low-point alert (which still appears at the TOP if
          the dip is actually negative). Always visible, gives spatial
          range context for the chart. */}
      <div style={{
        marginTop: 6, paddingTop: 6,
        borderTop: '1px solid var(--border)',
        display: 'flex', justifyContent: 'space-between',
        fontSize: 10, color: 'var(--text-muted)',
      }}>
        <span>
          Low: <span style={{
            color: lowIsNegative ? 'var(--accent-red)' : 'var(--text-secondary)',
            fontVariantNumeric: 'tabular-nums',
          }}>{fmtMoney(seriesMin)}</span>
        </span>
        <span>
          High: <span style={{ color: 'var(--text-secondary)', fontVariantNumeric: 'tabular-nums' }}>
            {fmtMoney(seriesMax)}
          </span>
        </span>
      </div>
    </div>
  )
}

// Compact dollar formatter for chart tick labels — keeps the y-axis
// width small so the line drawing area gets maximum width.
function fmtCompactMoney(v) {
  const abs = Math.abs(v)
  if (abs >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`
  if (abs >= 1_000) return `$${Math.round(v / 1_000)}k`
  return `$${Math.round(v)}`
}

// Small label/value pair, used by the Daily Snapshot tile and
// previously by the old Cash Flow Forecast 3-col grid.
function ForecastStat({ label, value, color }) {
  return (
    <div>
      <div style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.4 }}>
        {label}
      </div>
      <div style={{ fontSize: 16, fontWeight: 600, color, fontVariantNumeric: 'tabular-nums' }}>
        {value}
      </div>
    </div>
  )
}

/* ─────────────────────── Daily Snapshot ─────────────────────── */

/**
 * DailySnapshot — at-a-glance "how am I doing today/this week" tile.
 * Pulls last 90 days of transactions and computes:
 *   - Today's outflow
 *   - This week's outflow (Mon-Sun)
 *   - Same-day-of-week average from prior weeks (anomaly comparison)
 * Useful for "is today normal?" quick checks.
 */
export function DailySnapshot() {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  useEffect(() => {
    const today = new Date()
    const cutoff = new Date(today)
    cutoff.setDate(cutoff.getDate() - 90)
    getTransactions({
      start_date: cutoff.toISOString().slice(0, 10),
      end_date: today.toISOString().slice(0, 10),
      limit: 5000,
    })
      .then(txns => { setData(processTxns(txns || [])); setLoading(false) })
      .catch(() => setLoading(false))
  }, [])

  if (loading) return <SkeletonCard titleWidth="35%" rows={3} />
  if (!data) return null

  const todayVsAvg = data.todayOutflow - data.dowAverage
  const todayColor = todayVsAvg > data.dowAverage * 0.5
    ? 'var(--accent-orange)'
    : todayVsAvg < -data.dowAverage * 0.3
      ? 'var(--accent-green)'
      : 'var(--text-primary)'

  return (
    <div className="card" style={tileCardStyle}>
      <div className="card-header">
        <span className="card-title" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <Calendar size={14} style={{ color: 'var(--accent-blue)' }} /> Daily snapshot
        </span>
        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>vs typical {data.dowName}</span>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
        <ForecastStat label="Today" value={fmtMoney(data.todayOutflow)} color={todayColor} />
        <ForecastStat label="This week" value={fmtMoney(data.weekOutflow)} color="var(--text-primary)" />
        <ForecastStat
          label={`Avg ${data.dowName}`}
          value={fmtMoney(data.dowAverage)}
          color="var(--text-secondary)"
        />
      </div>
      <div style={{
        marginTop: 10, fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.5,
      }}>
        {todayVsAvg > 0
          ? `Today is ${fmtMoney(todayVsAvg)} above your typical ${data.dowName}.`
          : todayVsAvg < 0
            ? `Today is ${fmtMoney(-todayVsAvg)} below your typical ${data.dowName}. 👍`
            : 'On pace with a typical day.'}
        {' '}{data.weekTxnCount} txns this week.
      </div>
    </div>
  )
}

function processTxns(txns) {
  const today = new Date()
  const todayStr = today.toISOString().slice(0, 10)
  const dowNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  const todayDow = today.getDay()
  // Week start (Monday)
  const weekStart = new Date(today)
  const dayOffset = (today.getDay() + 6) % 7
  weekStart.setDate(weekStart.getDate() - dayOffset)
  const weekStartStr = weekStart.toISOString().slice(0, 10)

  let todayOutflow = 0
  let weekOutflow = 0
  let weekTxnCount = 0
  const dowOutflows = [] // outflows on same DoW as today, prior weeks

  txns.forEach(t => {
    if (!t.amount || t.amount <= 0 || t.is_transfer) return
    const tDate = new Date(t.date + 'T12:00:00')
    if (t.date === todayStr) todayOutflow += t.amount
    if (t.date >= weekStartStr && t.date <= todayStr) {
      weekOutflow += t.amount
      weekTxnCount++
    }
    // Prior same-DoW outflows for averaging (skip today itself)
    if (tDate.getDay() === todayDow && t.date !== todayStr) {
      dowOutflows.push({ date: t.date, amount: t.amount })
    }
  })

  // Average outflow per same-DoW (group by date first to handle multi-txn days)
  const byDate = {}
  dowOutflows.forEach(d => { byDate[d.date] = (byDate[d.date] || 0) + d.amount })
  const dailyTotals = Object.values(byDate)
  const dowAverage = dailyTotals.length
    ? dailyTotals.reduce((a, b) => a + b, 0) / dailyTotals.length
    : 0

  return {
    todayOutflow,
    weekOutflow,
    weekTxnCount,
    dowAverage,
    dowName: dowNames[todayDow],
  }
}

// Shared style for all three Dashboard tiles. Makes the card fill its
// Cards fill the height of their grid cell (the row's tallest tile).
// Combined with `flex: 1` on each tile's body section, content
// stretches to fill instead of leaving white space. Tiles whose
// natural content is short carry secondary content (preview lists,
// allocation bars, account counts) so the stretched space is used
// for information, not padding.
const tileCardStyle = {
  width: '100%',
  height: '100%',
  display: 'flex',
  flexDirection: 'column',
}

/* ─────────────────────── HSA Tracker ─────────────────────── */

/**
 * HsaTracker — surfaces remaining HSA contribution headroom for the
 * current tax year, with dollarized tax savings and an April-15
 * deadline countdown.
 *
 * A common miss for households on a family HDHP: the employer
 * contributes only a portion of the limit and the personal-side gap
 * sits unfunded all year — leaving real federal + state tax savings
 * unclaimed. This tile makes that gap visible year-round instead of
 * surfacing it only at April-14.
 *
 * Two tracking modes:
 *   1. 'manual'  — user enters YTD personal contribution as a number.
 *                  Snapshot value, must be updated whenever they want
 *                  to see fresh numbers.
 *   2. 'payroll' — user enters per-paycheck amount + frequency + start
 *                  date; tile computes YTD live and projects end-of-year.
 *                  Best for the common case where contributions are a
 *                  fixed payroll deduction. Surfaces a "to max, bump
 *                  per-paycheck to $X or add $Y lump sum" recommendation
 *                  when projected EOY falls short of the cap.
 *
 * Data model: backend returns IRS limits + the list of HSA accounts.
 * Per-account YTD contributions (employer + personal) and coverage
 * type live in localStorage — they don't change often enough to merit
 * a DB table, and not all HSA balance growth is contribution (there's
 * investment return too).
 *
 * Storage key: tuskledger.hsaConfig.v1 = {
 *   [accountId]: {
 *     coverage, holder_age, marginal_tax_rate, employer_ytd,
 *     tracking_mode,           // 'manual' (default) | 'payroll'
 *     personal_ytd,            // manual mode only
 *     per_paycheck_amount,     // payroll mode
 *     pay_frequency,           // payroll mode: weekly | biweekly | semimonthly | monthly
 *     payroll_start_date,      // payroll mode: ISO date of first paycheck of the year
 *   }
 * }
 */
const HSA_CONFIG_KEY = 'tuskledger.hsaConfig.v1'
// Default combined federal + state marginal rate. Set to a moderate
// midpoint that's typical for many households (e.g. ~22% federal plus
// a low single-digit state rate). User can override per-account.
const DEFAULT_MARGINAL_RATE = 0.2625

// Paychecks-per-year by frequency. Used for proportion-based YTD
// computation in payroll mode (accurate within ±1 paycheck for any
// reasonable date range — exact daily arithmetic isn't worth the
// complexity for a personal-use tracker).
const PAYCHECKS_PER_YEAR = { weekly: 52, biweekly: 26, semimonthly: 24, monthly: 12 }

function computePayrollYtd(cfg, today = new Date()) {
  const ppy = PAYCHECKS_PER_YEAR[cfg.pay_frequency] || 26
  const perCheck = Number(cfg.per_paycheck_amount) || 0
  if (!perCheck) return { elapsedPaychecks: 0, remainingPaychecks: 0, ytd: 0, projectedEoy: 0 }
  const yearStart = new Date(today.getFullYear(), 0, 1, 12)
  const yearEnd = new Date(today.getFullYear(), 11, 31, 12)
  const start = cfg.payroll_start_date
    ? new Date(cfg.payroll_start_date + 'T12:00:00')
    : yearStart
  const day = (a, b) => Math.max(0, Math.floor((b - a) / (1000 * 60 * 60 * 24)))
  // Proportion of year elapsed since payroll started.
  const elapsedDays = day(start, today)
  const totalEligibleDays = Math.max(1, day(start, yearEnd))
  const elapsedFrac = Math.min(1, elapsedDays / 365)
  const remainingFrac = Math.max(0, day(today, yearEnd) / 365)
  const elapsedPaychecks = Math.floor(elapsedFrac * ppy)
  const remainingPaychecks = Math.ceil(remainingFrac * ppy)
  return {
    elapsedPaychecks,
    remainingPaychecks,
    ytd: elapsedPaychecks * perCheck,
    projectedEoy: (elapsedPaychecks + remainingPaychecks) * perCheck,
  }
}

export function HsaTracker() {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [config, setConfig] = useStoredState(HSA_CONFIG_KEY, {})
  const [editingId, setEditingId] = useState(null)

  useEffect(() => {
    getHsaStatus().then(d => { setData(d); setLoading(false) }).catch(() => setLoading(false))
  }, [])

  if (loading) return <SkeletonCard titleWidth="40%" rows={4} />
  if (!data || !data.accounts || data.accounts.length === 0) {
    // No HSAs detected — silently hide rather than nag. Tile only
    // appears for users who actually have an HSA configured.
    return null
  }

  // Per-account derived values. The personal-YTD value depends on
  // tracking_mode: in 'manual' it's whatever the user typed; in
  // 'payroll' it's computed from the per-paycheck amount × elapsed
  // paychecks. Projected EOY only meaningful in payroll mode.
  const accounts = data.accounts.map(a => {
    const cfg = config[a.id] || {}
    const coverage = cfg.coverage || 'family'
    const limitKey = `${coverage}${cfg.holder_age >= 55 ? '_55_plus' : ''}`
    const limit = data.limits[limitKey] || data.limits[coverage]
    const employer = Number(cfg.employer_ytd) || 0
    const trackingMode = cfg.tracking_mode || 'manual'

    let personal = 0
    let projection = null
    if (trackingMode === 'payroll') {
      projection = computePayrollYtd(cfg)
      personal = projection.ytd
    } else {
      personal = Number(cfg.personal_ytd) || 0
    }

    const contributed = employer + personal
    const remaining = Math.max(0, limit - contributed)
    const rate = Number(cfg.marginal_tax_rate) || DEFAULT_MARGINAL_RATE
    const taxSavingsIfMaxed = remaining * rate

    // "To max" recommendation — only meaningful in payroll mode where
    // we can project EOY. Compute the gap between projected total and
    // the cap, then express it as both a per-paycheck bump and a one-
    // time lump-sum option. Pre-deadline contributions can be either.
    let recommendation = null
    if (projection && projection.remainingPaychecks > 0) {
      const projectedTotal = employer + projection.projectedEoy
      const gap = limit - projectedTotal
      if (gap > 1) {
        recommendation = {
          gap,
          perPaycheckBump: gap / projection.remainingPaychecks,
          newPerPaycheck: (Number(cfg.per_paycheck_amount) || 0) + (gap / projection.remainingPaychecks),
          lumpSum: gap,
        }
      } else if (gap < -1) {
        recommendation = { overshoot: -gap }
      }
    }

    return {
      ...a, coverage, limit, employer, personal, contributed, remaining,
      taxSavingsIfMaxed, rate, trackingMode, projection, recommendation,
    }
  })

  // Roll up across all HSAs in the household.
  const totalRemaining = accounts.reduce((s, a) => s + a.remaining, 0)
  const totalSavings = accounts.reduce((s, a) => s + a.taxSavingsIfMaxed, 0)

  const updateConfig = (accountId, patch) => {
    setConfig(prev => ({ ...prev, [accountId]: { ...(prev[accountId] || {}), ...patch } }))
  }

  return (
    <div className="card" style={tileCardStyle}>
      <div className="card-header">
        <span className="card-title" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <Heart size={14} style={{ color: 'var(--accent-green)' }} /> HSA headroom
        </span>
        <span style={{
          fontSize: 10, color: 'var(--text-muted)',
          padding: '2px 6px', border: '1px solid var(--border)', borderRadius: 10,
        }}>
          {data.year} · {data.days_remaining}d to file
        </span>
      </div>

      {/* Hero rollup — always visible, summarizes across all HSAs */}
      {totalRemaining > 0 ? (
        <div style={{
          padding: '10px 12px', marginBottom: 10,
          background: 'rgba(52,211,153,0.08)',
          border: '1px solid rgba(52,211,153,0.25)',
          borderRadius: 6,
        }}>
          <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
            Tax savings if maxed by {new Date(data.deadline + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
          </div>
          <div style={{
            fontSize: 22, fontWeight: 700, color: 'var(--accent-green)',
            fontVariantNumeric: 'tabular-nums', marginTop: 2,
          }}>
            ~{fmtFull(totalSavings)}
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 2 }}>
            Contribute {fmtFull(totalRemaining)} more across {accounts.length} HSA{accounts.length === 1 ? '' : 's'}
          </div>
        </div>
      ) : (
        <div style={{
          padding: '10px 12px', marginBottom: 10,
          background: 'rgba(96,165,250,0.08)',
          border: '1px solid rgba(96,165,250,0.25)',
          borderRadius: 6,
          fontSize: 12, color: 'var(--text-secondary)',
        }}>
          ✓ All HSAs maxed for {data.year}.
        </div>
      )}

      {/* Per-account progress bars + edit-in-place */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, flex: 1 }}>
        {accounts.map(a => {
          const pct = Math.min(100, (a.contributed / a.limit) * 100)
          const isEditing = editingId === a.id
          return (
            <div key={a.id}>
              <div style={{
                display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
                fontSize: 12, marginBottom: 4,
              }}>
                <span style={{ fontWeight: 500, color: 'var(--text-primary)' }}>
                  {a.name}
                  <span style={{ color: 'var(--text-muted)', fontWeight: 400, marginLeft: 6 }}>
                    · {a.coverage}
                  </span>
                </span>
                <button
                  onClick={() => setEditingId(isEditing ? null : a.id)}
                  title="Edit HSA configuration"
                  style={{
                    background: 'none', border: 'none', cursor: 'pointer',
                    color: 'var(--text-muted)', padding: 2, display: 'inline-flex',
                  }}
                >
                  <Settings size={12} />
                </button>
              </div>

              {/* Progress bar — segmented to show employer vs personal */}
              <div style={{
                height: 8, background: 'var(--bg-elevated, rgba(255,255,255,0.06))',
                borderRadius: 4, overflow: 'hidden', display: 'flex',
              }}>
                {a.employer > 0 && (
                  <div
                    title={`Employer: ${fmtFull(a.employer)}`}
                    style={{
                      width: `${(a.employer / a.limit) * 100}%`,
                      background: 'var(--accent-blue)',
                      transition: 'width 200ms',
                    }}
                  />
                )}
                {a.personal > 0 && (
                  <div
                    title={`Personal: ${fmtFull(a.personal)}`}
                    style={{
                      width: `${(a.personal / a.limit) * 100}%`,
                      background: 'var(--accent-green)',
                      transition: 'width 200ms',
                    }}
                  />
                )}
              </div>

              <div style={{
                fontSize: 11, color: 'var(--text-muted)', marginTop: 3,
                display: 'flex', justifyContent: 'space-between',
              }}>
                <span>
                  {fmtFull(a.contributed)} of {fmtFull(a.limit)}
                </span>
                <span style={{
                  color: a.remaining > 0 ? 'var(--accent-yellow)' : 'var(--accent-green)',
                }}>
                  {a.remaining > 0
                    ? `${fmtFull(a.remaining)} left`
                    : '✓ maxed'}
                </span>
              </div>

              {/* Payroll-mode projection + recommendation. Only renders
                  when tracking_mode='payroll' and the user is on pace
                  to either fall short or overshoot. The actionable
                  recommendation is the value-add of payroll mode. */}
              {a.projection && a.recommendation?.gap > 1 && (
                <div style={{
                  marginTop: 6, padding: '6px 8px',
                  background: 'rgba(251,191,36,0.08)',
                  border: '1px solid rgba(251,191,36,0.25)',
                  borderRadius: 4, fontSize: 11,
                  color: 'var(--text-secondary)',
                }}>
                  <div style={{ marginBottom: 2 }}>
                    On pace for <strong>{fmtFull(a.employer + a.projection.projectedEoy)}</strong>
                    {' '}by year-end ({a.projection.remainingPaychecks} paychecks left).
                    Short by <strong style={{ color: 'var(--accent-yellow)' }}>{fmtFull(a.recommendation.gap)}</strong>.
                  </div>
                  <div>
                    To max: bump per-paycheck to{' '}
                    <strong style={{ color: 'var(--accent-green)' }}>
                      {fmtFull(a.recommendation.newPerPaycheck)}
                    </strong>{' '}
                    (+{fmtFull(a.recommendation.perPaycheckBump)}), or add a one-time{' '}
                    <strong style={{ color: 'var(--accent-green)' }}>
                      {fmtFull(a.recommendation.lumpSum)}
                    </strong>{' '}
                    by Apr 15.
                  </div>
                </div>
              )}
              {a.projection && a.recommendation?.overshoot > 1 && (
                <div style={{
                  marginTop: 6, padding: '6px 8px',
                  background: 'rgba(248,113,113,0.08)',
                  border: '1px solid rgba(248,113,113,0.25)',
                  borderRadius: 4, fontSize: 11,
                  color: 'var(--text-secondary)',
                }}>
                  ⚠ On pace to overshoot the cap by <strong style={{ color: 'var(--accent-red)' }}>
                  {fmtFull(a.recommendation.overshoot)}</strong>.
                  Lower per-paycheck or excess will be taxed + 6% excise penalty.
                </div>
              )}

              {/* Inline editor — fields adapt to tracking_mode. Manual
                  mode collects a single YTD number; payroll mode collects
                  per-paycheck amount + frequency + start date and
                  computes YTD live. */}
              {isEditing && (
                <div style={{
                  marginTop: 8, padding: 8,
                  background: 'rgba(255,255,255,0.03)',
                  border: '1px solid var(--border)',
                  borderRadius: 4,
                  display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6,
                  fontSize: 11,
                }}>
                  <HsaField label="Coverage">
                    <select
                      value={a.coverage}
                      onChange={e => updateConfig(a.id, { coverage: e.target.value })}
                      style={hsaInputStyle}
                    >
                      <option value="family">Family</option>
                      <option value="self">Self only</option>
                    </select>
                  </HsaField>
                  <HsaField label="Holder age (for 55+ catch-up)">
                    <input
                      type="number"
                      value={config[a.id]?.holder_age || ''}
                      onChange={e => updateConfig(a.id, { holder_age: Number(e.target.value) || 0 })}
                      placeholder="e.g. 38"
                      style={hsaInputStyle}
                    />
                  </HsaField>
                  <HsaField label="Employer YTD contribution">
                    <input
                      type="number"
                      value={config[a.id]?.employer_ytd || ''}
                      onChange={e => updateConfig(a.id, { employer_ytd: Number(e.target.value) || 0 })}
                      placeholder="from W-2 box 12 code W"
                      style={hsaInputStyle}
                    />
                  </HsaField>
                  <HsaField label="Marginal tax rate" >
                    <input
                      type="number"
                      step="0.01"
                      value={config[a.id]?.marginal_tax_rate || ''}
                      onChange={e => updateConfig(a.id, { marginal_tax_rate: Number(e.target.value) || 0 })}
                      placeholder="0.2625 = 22% fed + ~4% state"
                      style={hsaInputStyle}
                    />
                  </HsaField>

                  {/* Tracking mode toggle — spans full width */}
                  <HsaField label="Personal contribution tracking" full>
                    <select
                      value={a.trackingMode}
                      onChange={e => updateConfig(a.id, { tracking_mode: e.target.value })}
                      style={hsaInputStyle}
                    >
                      <option value="manual">Manual snapshot (enter YTD)</option>
                      <option value="payroll">Payroll deduction (auto-track)</option>
                    </select>
                  </HsaField>

                  {a.trackingMode === 'payroll' ? (
                    <>
                      <HsaField label="Per-paycheck amount">
                        <input
                          type="number"
                          step="0.01"
                          value={config[a.id]?.per_paycheck_amount || ''}
                          onChange={e => updateConfig(a.id, { per_paycheck_amount: Number(e.target.value) || 0 })}
                          placeholder="e.g. 171.66"
                          style={hsaInputStyle}
                        />
                      </HsaField>
                      <HsaField label="Pay frequency">
                        <select
                          value={config[a.id]?.pay_frequency || 'biweekly'}
                          onChange={e => updateConfig(a.id, { pay_frequency: e.target.value })}
                          style={hsaInputStyle}
                        >
                          <option value="weekly">Weekly (52/yr)</option>
                          <option value="biweekly">Bi-weekly (26/yr)</option>
                          <option value="semimonthly">Semi-monthly (24/yr)</option>
                          <option value="monthly">Monthly (12/yr)</option>
                        </select>
                      </HsaField>
                      <HsaField label="First paycheck of year (date)" full>
                        <input
                          type="date"
                          value={config[a.id]?.payroll_start_date || ''}
                          onChange={e => updateConfig(a.id, { payroll_start_date: e.target.value })}
                          style={hsaInputStyle}
                        />
                      </HsaField>
                      {a.projection && (
                        <div style={{
                          gridColumn: '1 / -1', padding: 6,
                          background: 'rgba(96,165,250,0.06)',
                          border: '1px dashed rgba(96,165,250,0.3)',
                          borderRadius: 3, fontSize: 10,
                          color: 'var(--text-muted)',
                        }}>
                          Computed YTD: <strong style={{ color: 'var(--text-primary)' }}>
                          {fmtFull(a.projection.ytd)}</strong>
                          {' '}({a.projection.elapsedPaychecks} paychecks elapsed,{' '}
                          {a.projection.remainingPaychecks} remaining → projected EOY{' '}
                          <strong style={{ color: 'var(--text-primary)' }}>
                          {fmtFull(a.projection.projectedEoy)}</strong>)
                        </div>
                      )}
                    </>
                  ) : (
                    <HsaField label="Personal YTD contribution" full>
                      <input
                        type="number"
                        value={config[a.id]?.personal_ytd || ''}
                        onChange={e => updateConfig(a.id, { personal_ytd: Number(e.target.value) || 0 })}
                        placeholder="0"
                        style={hsaInputStyle}
                      />
                    </HsaField>
                  )}

                  <button
                    onClick={() => setEditingId(null)}
                    style={{
                      gridColumn: '1 / -1',
                      padding: '4px', fontSize: 11,
                      background: 'var(--accent-blue)', color: '#0d0e14',
                      border: 'none', borderRadius: 3, cursor: 'pointer',
                    }}
                  >
                    Done
                  </button>
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function HsaField({ label, children, full }) {
  return (
    <label style={{
      display: 'flex', flexDirection: 'column', gap: 2,
      gridColumn: full ? '1 / -1' : undefined,
    }}>
      <span style={{
        fontSize: 9, color: 'var(--text-muted)',
        textTransform: 'uppercase', letterSpacing: 0.4,
      }}>{label}</span>
      {children}
    </label>
  )
}

const hsaInputStyle = {
  width: '100%', padding: '4px 6px', fontSize: 11,
  border: '1px solid var(--border)', borderRadius: 3,
  background: 'var(--bg-input)', color: 'var(--text-primary)',
  fontFamily: 'inherit', boxSizing: 'border-box',
}


/**
 * DcfsaTracker — dependent-care FSA tracker.
 *
 * DCFSAs differ from HSAs in three important ways that this tile
 * encodes:
 *   1. Use-it-or-lose-it deadline (typically Dec 31 of plan year, or
 *      Mar 15 with grace period). HSA money rolls forward forever.
 *   2. No bank account to sync — DCFSA is payroll-deducted and
 *      reimbursed via claim. Tile is purely localStorage-driven.
 *   3. Single annual limit (2025: $5,000 MFJ / $2,500 MFS), no
 *      coverage-type or age catch-up branching.
 *
 * Drives a "use it or lose it $X by [deadline]" warning when funded
 * but not spent — the most common DCFSA failure mode.
 *
 * Storage: tuskledger.dcfsaConfig.v1 = {
 *   annual_election,    // user's elected $ amount for the year
 *   per_paycheck,       // payroll deduction per check
 *   pay_frequency,      // weekly | biweekly | semimonthly | monthly
 *   payroll_start_date, // ISO date of first paycheck of the year
 *   spent_ytd,          // user-entered, what's been claimed/used
 *   plan_year_end,      // ISO date of plan-year deadline (default 12/31)
 *   marginal_tax_rate,  // for tax-savings display
 * }
 */
const DCFSA_CONFIG_KEY = 'tuskledger.dcfsaConfig.v1'
const DCFSA_LIMIT_2025 = 5000  // MFJ; MFS is half but rare for households
const DEFAULT_DCFSA_MARGINAL_RATE = 0.2625

export function DcfsaTracker() {
  const [config, setConfig] = useStoredState(DCFSA_CONFIG_KEY, {})
  const [editing, setEditing] = useState(false)

  // Empty state — fills a standard-size tile (~330px tall) without
  // looking hollow. Layout: header pinned to top, value-prop content
  // centered vertically in the remaining space, "Configure tracker"
  // button pinned to bottom. The "what you'd see if configured"
  // preview list teaches the user what the tracker tracks before
  // they invest in setting it up — turns dead space into onboarding.
  if (!config.annual_election && !editing) {
    return (
      <div className="card" style={tileCardStyle}>
        <div className="card-header">
          <span className="card-title" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <Calendar size={14} style={{ color: 'var(--accent-blue)' }} /> Dependent-care FSA
          </span>
        </div>

        {/* Value-prop block. flex: 1 absorbs the slack between the
            header and the bottom-pinned configure button when the
            card is stretched to match a tall row neighbor. Content
            stays vertically centered in the available space. */}
        <div style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          gap: 10,
          padding: '6px 0 10px',
        }}>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.5 }}>
            Tax-advantaged account for daycare, after-school, summer camp.{' '}
            <strong style={{ color: 'var(--text-primary)' }}>Use-it-or-lose-it</strong> by Dec 31. Up to $5,000/yr MFJ.
          </div>
          <div style={{
            fontSize: 11, color: 'var(--text-dim)',
            textTransform: 'uppercase', letterSpacing: 0.4, fontWeight: 600,
            marginTop: 4,
          }}>
            What you&apos;ll see here
          </div>
          <ul style={{
            margin: 0, padding: 0, listStyle: 'none',
            display: 'flex', flexDirection: 'column', gap: 6,
            fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.4,
          }}>
            <li style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
              <span style={{ color: 'var(--accent-blue)', flexShrink: 0 }}>•</span>
              <span>YTD funded vs election, with paycheck pacing</span>
            </li>
            <li style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
              <span style={{ color: 'var(--accent-blue)', flexShrink: 0 }}>•</span>
              <span>At-risk dollars and days-to-deadline countdown</span>
            </li>
            <li style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
              <span style={{ color: 'var(--accent-blue)', flexShrink: 0 }}>•</span>
              <span>Tax savings projected at your marginal rate</span>
            </li>
          </ul>
        </div>

        <button
          type="button"
          onClick={() => setEditing(true)}
          style={{
            width: '100%', padding: '8px 12px',
            background: 'var(--accent-blue-bg)',
            border: '1px solid var(--accent-blue-border)',
            borderRadius: 6, color: 'var(--accent-blue)',
            fontSize: 12, fontWeight: 600, cursor: 'pointer',
          }}
        >
          + Configure tracker
        </button>
      </div>
    )
  }

  const today = new Date()
  const election = Number(config.annual_election) || 0
  const perCheck = Number(config.per_paycheck) || 0
  const ppy = PAYCHECKS_PER_YEAR[config.pay_frequency] || 26

  // Compute YTD payroll-funded amount the same way the HSA tracker
  // does — proportion of year elapsed × paychecks/yr.
  const yearStart = new Date(today.getFullYear(), 0, 1, 12)
  const yearEnd = new Date(today.getFullYear(), 11, 31, 12)
  const start = config.payroll_start_date
    ? new Date(config.payroll_start_date + 'T12:00:00')
    : yearStart
  const day = (a, b) => Math.max(0, Math.floor((b - a) / (1000 * 60 * 60 * 24)))
  const elapsedFrac = Math.min(1, day(start, today) / 365)
  const elapsedPaychecks = Math.floor(elapsedFrac * ppy)
  const funded_ytd = elapsedPaychecks * perCheck

  const planEnd = config.plan_year_end
    ? new Date(config.plan_year_end + 'T12:00:00')
    : yearEnd
  const daysToDeadline = day(today, planEnd)

  const spent = Number(config.spent_ytd) || 0
  const remaining_to_spend = Math.max(0, funded_ytd - spent)
  const remaining_to_fund = Math.max(0, election - funded_ytd)

  const marginalRate = config.marginal_tax_rate
    || DEFAULT_DCFSA_MARGINAL_RATE
  const tax_savings_at_election = election * marginalRate

  // Risk: amount that's been deducted from your paycheck but won't
  // get used by the deadline. This is the actual money you'd lose.
  const at_risk = remaining_to_spend  // worst-case if no more spending

  return (
    <div className="card" style={tileCardStyle}>
      <div className="card-header">
        <span className="card-title" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <Calendar size={14} style={{ color: 'var(--accent-blue)' }} /> Dependent-care FSA
        </span>
        <button
          type="button"
          onClick={() => setEditing(!editing)}
          style={{
            background: 'transparent', border: 'none',
            color: 'var(--text-muted)', cursor: 'pointer', fontSize: 11,
          }}
        >
          {editing ? '✓ Done' : '⚙ Edit'}
        </button>
      </div>

      {/* Hero: at-risk dollars + deadline countdown */}
      {!editing && election > 0 && (
        <>
          <div style={{
            display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)',
            gap: 12, marginBottom: 10,
          }}>
            <div>
              <div style={{ fontSize: 10, color: 'var(--text-muted)',
                textTransform: 'uppercase', letterSpacing: 0.4 }}>
                At risk
              </div>
              <div style={{
                fontSize: 18, fontWeight: 700,
                color: at_risk > 0 ? 'var(--accent-orange)' : 'var(--accent-green)',
              }}>
                {fmtMoney(at_risk)}
              </div>
              <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>
                funded but unspent
              </div>
            </div>
            <div>
              <div style={{ fontSize: 10, color: 'var(--text-muted)',
                textTransform: 'uppercase', letterSpacing: 0.4 }}>
                Days to deadline
              </div>
              <div style={{
                fontSize: 18, fontWeight: 700,
                color: daysToDeadline < 30 ? 'var(--accent-orange)'
                  : daysToDeadline < 90 ? 'var(--accent-yellow)'
                  : 'var(--text-primary)',
              }}>
                {daysToDeadline}
              </div>
              <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>
                {planEnd.toLocaleDateString()}
              </div>
            </div>
            <div>
              <div style={{ fontSize: 10, color: 'var(--text-muted)',
                textTransform: 'uppercase', letterSpacing: 0.4 }}>
                Tax savings
              </div>
              <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--accent-green)' }}>
                {fmtMoney(tax_savings_at_election)}
              </div>
              <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>
                @ {Math.round(marginalRate * 100)}% marginal
              </div>
            </div>
          </div>

          {/* Progress bar — funded vs election */}
          <div style={{ marginBottom: 6 }}>
            <div style={{
              fontSize: 11, color: 'var(--text-muted)', marginBottom: 3,
              display: 'flex', justifyContent: 'space-between',
            }}>
              <span>Funded YTD</span>
              <span>{fmtMoney(funded_ytd)} of {fmtMoney(election)}</span>
            </div>
            <div style={{
              height: 6, background: 'var(--bg-input)', borderRadius: 3,
              overflow: 'hidden',
            }}>
              <div style={{
                height: '100%',
                width: `${Math.min(100, (funded_ytd / Math.max(1, election)) * 100)}%`,
                background: 'var(--accent-blue)',
              }} />
            </div>
          </div>

          {/* Spent bar */}
          <div>
            <div style={{
              fontSize: 11, color: 'var(--text-muted)', marginBottom: 3,
              display: 'flex', justifyContent: 'space-between',
            }}>
              <span>Spent / claimed YTD</span>
              <span>{fmtMoney(spent)} of {fmtMoney(funded_ytd)} funded</span>
            </div>
            <div style={{
              height: 6, background: 'var(--bg-input)', borderRadius: 3,
              overflow: 'hidden',
            }}>
              <div style={{
                height: '100%',
                width: `${Math.min(100, (spent / Math.max(1, funded_ytd)) * 100)}%`,
                background: 'var(--accent-green)',
              }} />
            </div>
          </div>

          {/* Action nudges */}
          {at_risk > 100 && daysToDeadline < 90 && (
            <div style={{
              marginTop: 10, padding: '8px 10px',
              background: 'var(--accent-orange-bg)',
              border: '1px solid var(--accent-orange-border)',
              borderRadius: 6, fontSize: 11,
              color: 'var(--text-primary)', lineHeight: 1.4,
            }}>
              <strong style={{ color: 'var(--accent-orange)' }}>Use it or lose it: </strong>
              {fmtMoney(at_risk)} sits in your DCFSA with {daysToDeadline} days
              before the {planEnd.toLocaleDateString()} deadline. Submit
              eligible expenses (daycare, after-school, day camp, in-home
              care) before then or the funds are forfeited.
            </div>
          )}
          {remaining_to_fund > 0 && elapsedPaychecks < ppy && (
            <div style={{
              marginTop: 10, padding: '8px 10px',
              background: 'var(--accent-blue-bg)',
              border: '1px solid var(--accent-blue-border)',
              borderRadius: 6, fontSize: 11,
              color: 'var(--text-primary)', lineHeight: 1.4,
            }}>
              <strong style={{ color: 'var(--accent-blue)' }}>To max election: </strong>
              {fmtMoney(remaining_to_fund)} remaining over ~{ppy - elapsedPaychecks} paychecks.
            </div>
          )}
        </>
      )}

      {/* Edit form */}
      {editing && (
        <div style={{
          display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8,
          marginTop: 8,
        }}>
          <DcfsaField label="Annual election">
            <input type="number" min={0} max={5000} step={50}
              value={config.annual_election || ''}
              onChange={e => setConfig({ ...config, annual_election: Number(e.target.value) })}
              placeholder={`Up to $${DCFSA_LIMIT_2025} MFJ`}
              style={hsaInputStyle} />
          </DcfsaField>
          <DcfsaField label="Per paycheck">
            <input type="number" min={0} step={5}
              value={config.per_paycheck || ''}
              onChange={e => setConfig({ ...config, per_paycheck: Number(e.target.value) })}
              style={hsaInputStyle} />
          </DcfsaField>
          <DcfsaField label="Pay frequency">
            <select
              value={config.pay_frequency || 'biweekly'}
              onChange={e => setConfig({ ...config, pay_frequency: e.target.value })}
              style={hsaInputStyle}
            >
              <option value="weekly">Weekly</option>
              <option value="biweekly">Biweekly</option>
              <option value="semimonthly">Semimonthly</option>
              <option value="monthly">Monthly</option>
            </select>
          </DcfsaField>
          <DcfsaField label="Payroll start">
            <input type="date"
              value={config.payroll_start_date || ''}
              onChange={e => setConfig({ ...config, payroll_start_date: e.target.value })}
              style={hsaInputStyle} />
          </DcfsaField>
          <DcfsaField label="Spent / claimed YTD">
            <input type="number" min={0} step={50}
              value={config.spent_ytd || ''}
              onChange={e => setConfig({ ...config, spent_ytd: Number(e.target.value) })}
              style={hsaInputStyle} />
          </DcfsaField>
          <DcfsaField label="Plan year end">
            <input type="date"
              value={config.plan_year_end || ''}
              onChange={e => setConfig({ ...config, plan_year_end: e.target.value })}
              placeholder="12/31 default"
              style={hsaInputStyle} />
          </DcfsaField>
          <DcfsaField label="Marginal tax rate %" full>
            <input type="number" min={0} max={50} step={0.5}
              value={config.marginal_tax_rate ? Math.round(config.marginal_tax_rate * 1000) / 10 : ''}
              onChange={e => setConfig({ ...config, marginal_tax_rate: Number(e.target.value) / 100 })}
              placeholder={`default ${Math.round(DEFAULT_DCFSA_MARGINAL_RATE * 100)}%`}
              style={hsaInputStyle} />
          </DcfsaField>
        </div>
      )}
    </div>
  )
}

/**
 * LoanPayoffCountdown — at-a-glance "when does each loan pay off"
 * tile. Pulls from /api/loans/ (which returns months_remaining +
 * maturity_date + balance per loan when rate/payment data is on
 * file). Sorted by closest payoff so the next milestone sits up top.
 *
 * Hides silently when no loans have payoff data — i.e. no Plaid
 * MortgageDetail and no manual rate/payment override on file. To
 * surface a loan here, set its rate + monthly payment on the Loans
 * page and the tile picks it up automatically.
 */
export function LoanPayoffCountdown() {
  const [loans, setLoans] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    import('../api/client').then(({ getLoans }) => {
      getLoans()
        .then(d => setLoans(d.loans || []))
        .finally(() => setLoading(false))
    })
  }, [])

  if (loading) return <SkeletonCard titleWidth="35%" rows={3} />
  if (!loans || loans.length === 0) return null

  // Only show loans with computable payoff data. Sort closest-first.
  const withPayoff = loans
    .filter(l => l.months_remaining != null && l.months_remaining > 0)
    .sort((a, b) => a.months_remaining - b.months_remaining)

  if (withPayoff.length === 0) return null

  const fmtDate = (months) => {
    const d = new Date()
    d.setMonth(d.getMonth() + months)
    return d.toLocaleDateString('en-US', { month: 'short', year: 'numeric' })
  }

  return (
    <div className="card" style={tileCardStyle}>
      <div className="card-header">
        <span className="card-title" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <Calendar size={14} style={{ color: 'var(--accent-blue)' }} /> Loan payoff timeline
        </span>
        <a href="/loans" style={{ fontSize: 11, color: 'var(--accent-blue)' }}>
          Detail →
        </a>
      </div>
      {/* Loans list. flex: 1 absorbs the row's stretched height so a
          single-loan tile doesn't sit at the top with empty space
          below it. The per-loan rows space out evenly. */}
      <div style={{
        display: 'flex', flexDirection: 'column',
        gap: 10, paddingTop: 4, flex: 1,
      }}>
        {withPayoff.map((loan, idx) => {
          const yrs = Math.floor(loan.months_remaining / 12)
          const mos = loan.months_remaining % 12
          // Progress = how much of the original loan term is gone.
          // Falls back gracefully if original_term_months isn't known —
          // we just don't render the bar, the row collapses to its
          // existing layout.
          const totalMonths = loan.original_term_months
          const progressPct = totalMonths
            ? Math.min(100, Math.max(0, ((totalMonths - loan.months_remaining) / totalMonths) * 100))
            : null
          return (
            <div key={loan.id} style={{
              display: 'flex', flexDirection: 'column',
              gap: 6,
              paddingBottom: idx < withPayoff.length - 1 ? 12 : 0,
              borderBottom: idx < withPayoff.length - 1
                ? '1px solid var(--border-color, rgba(255,255,255,0.04))'
                : 'none',
            }}>
              <div style={{
                display: 'flex', alignItems: 'baseline',
                justifyContent: 'space-between', gap: 12,
              }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>
                    {loan.name}
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                    {fmtMoney(loan.balance)}
                    {loan.interest_rate != null && ` · ${(loan.interest_rate * 100).toFixed(2)}%`}
                  </div>
                </div>
                <div style={{ textAlign: 'right', flexShrink: 0 }}>
                  <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--accent-blue)' }}>
                    {yrs > 0 && `${yrs}y`}{yrs > 0 && mos > 0 && ' '}{mos > 0 && `${mos}mo`}
                    {yrs === 0 && mos === 0 && '—'}
                  </div>
                  <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>
                    → {fmtDate(loan.months_remaining)}
                  </div>
                </div>
              </div>
              {progressPct != null && (
                <div title={`${Math.round(progressPct)}% paid off (term-elapsed)`}>
                  <div style={{
                    height: 4, borderRadius: 2,
                    background: 'var(--border-color, rgba(255,255,255,0.06))',
                    overflow: 'hidden',
                  }}>
                    <div style={{
                      width: `${progressPct}%`, height: '100%',
                      background: 'var(--accent-blue)',
                      borderRadius: 2,
                    }} />
                  </div>
                  <div style={{
                    fontSize: 9, color: 'var(--text-dim)', marginTop: 2,
                    display: 'flex', justifyContent: 'space-between',
                  }}>
                    <span>{Math.round(progressPct)}% of term elapsed</span>
                    <span>{Math.round(100 - progressPct)}% to go</span>
                  </div>
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}


/* ─────────────────────── Portfolio Snapshot ─────────────────────── */

/**
 * PortfolioSnapshot — at-a-glance view of total portfolio value, the
 * unrealized gain vs. cost basis, asset allocation, and the top
 * holdings by market value.
 *
 * Sized 'standard' (3 row units) in the dashboard tile system. The
 * layout is three stacked sections with `flex: 1` on the middle one
 * so the allocation block absorbs spare vertical space when the tile
 * is rendered at the upper end of the standard size.
 *
 * Hidden entirely if the user has no investment accounts (or the
 * total comes back as zero) — same pattern as HsaTracker. Avoids a
 * fake-empty card on a household that doesn't invest through tracked
 * accounts.
 */
const ALLOC_PALETTE = [
  'var(--accent-purple)', 'var(--accent-blue)', 'var(--accent-green)',
  'var(--accent-amber)', 'var(--accent-pink)', 'var(--accent-coral)',
]

export function PortfolioSnapshot() {
  const [summary, setSummary] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    getInvestmentsSummary()
      .then(setSummary)
      .catch(() => setSummary(null))
      .finally(() => setLoading(false))
  }, [])

  if (loading) return <SkeletonCard titleWidth="40%" rows={4} />
  // No investments → render nothing so the grid doesn't reserve a
  // dead cell. Mirrors HsaTracker's behavior.
  if (!summary || !summary.total_value || summary.total_value <= 0) return null

  const {
    total_value,
    total_gain_loss,
    total_gain_loss_pct,
    allocation = [],
    top_holdings = [],
  } = summary

  const hasGain = total_gain_loss != null && Number.isFinite(total_gain_loss)
  const gainPositive = hasGain && total_gain_loss >= 0
  const gainColor = gainPositive ? 'var(--accent-green)' : 'var(--accent-red)'

  // Take the top 4 allocation slices; lump the rest into "Other" so
  // the bar always sums to 100 % and the legend doesn't sprawl past
  // a few entries on accounts with long-tail security types.
  const visibleAlloc = allocation.slice(0, 4)
  const remainingPct = allocation.slice(4).reduce((s, a) => s + (a.pct || 0), 0)
  const allocSlices = remainingPct > 0
    ? [...visibleAlloc, { type: 'other', label: 'Other', pct: remainingPct, value: 0 }]
    : visibleAlloc

  return (
    <div className="card" style={tileCardStyle}>
      <div className="card-header">
        <span className="card-title" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <PieChart size={14} style={{ color: 'var(--accent-purple)' }} /> Portfolio
        </span>
        <a href="/investments" style={{ fontSize: 11, color: 'var(--accent-blue)' }}>
          Detail →
        </a>
      </div>

      {/* Headline: total value + unrealized P&L */}
      <div style={{ marginTop: 4 }}>
        <div style={{
          fontSize: 10, color: 'var(--text-muted)',
          textTransform: 'uppercase', letterSpacing: 0.4,
        }}>
          Total value
        </div>
        <div style={{
          fontSize: 24, fontWeight: 700, color: 'var(--text-primary)',
          fontVariantNumeric: 'tabular-nums', marginTop: 2,
        }}>
          {fmtMoney(total_value)}
        </div>
        {hasGain && (
          <div style={{
            fontSize: 12, color: gainColor, marginTop: 4,
            fontWeight: 600, fontVariantNumeric: 'tabular-nums',
          }}>
            {gainPositive ? '+' : ''}{fmtMoney(total_gain_loss)}
            {total_gain_loss_pct != null && (
              <> · {gainPositive ? '+' : ''}{total_gain_loss_pct.toFixed(1)}%</>
            )}
            <span style={{ color: 'var(--text-dim)', fontWeight: 400 }}>
              {' '}unrealized
            </span>
          </div>
        )}
      </div>

      {/* Allocation: stacked bar + small legend. flex: 1 absorbs the
          row's stretched height so the allocation block sits in the
          middle of the tile, top holdings pinned to the bottom. */}
      {allocSlices.length > 0 && (
        <div style={{ flex: 1, marginTop: 14, display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
          <div style={{
            fontSize: 10, color: 'var(--text-muted)',
            textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 6,
          }}>
            Allocation
          </div>
          <div style={{
            display: 'flex', height: 8, borderRadius: 4, overflow: 'hidden',
            background: 'var(--border-color, rgba(255,255,255,0.06))',
          }}>
            {allocSlices.map((slice, i) => (
              <div
                key={(slice.type || slice.label || '') + i}
                title={`${slice.label || slice.type}: ${slice.pct.toFixed(1)}%`}
                style={{
                  width: `${slice.pct}%`,
                  background: ALLOC_PALETTE[i % ALLOC_PALETTE.length],
                }}
              />
            ))}
          </div>
          <div style={{
            display: 'flex', flexWrap: 'wrap', gap: '4px 12px',
            marginTop: 8, fontSize: 11, color: 'var(--text-secondary)',
          }}>
            {allocSlices.map((slice, i) => (
              <span key={(slice.type || slice.label || '') + i}
                    style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                <span style={{
                  width: 8, height: 8, borderRadius: 2, flexShrink: 0,
                  background: ALLOC_PALETTE[i % ALLOC_PALETTE.length],
                }} />
                {slice.label || slice.type} {Math.round(slice.pct)}%
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Top holdings — pinned to bottom of the tile. Show up to 4
          (instead of the previous 2) so the tile carries enough
          content to balance the height of Pulse / HSA in the same
          row. Account count footer below as a one-line summary. */}
      {top_holdings.length > 0 && (
        <div style={{
          marginTop: 'auto', paddingTop: 10,
          borderTop: '1px solid var(--border)', fontSize: 11,
        }}>
          <div style={{
            fontSize: 10, color: 'var(--text-muted)',
            textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 6,
          }}>
            Top holdings
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
            {top_holdings.slice(0, 4).map((h, i) => (
              <div key={i} style={{
                display: 'flex', justifyContent: 'space-between', gap: 8,
              }}>
                <span style={{
                  color: 'var(--text-secondary)', fontWeight: 500,
                  whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                  flex: 1, minWidth: 0,
                }}>
                  {h.ticker || h.security_name || 'Unknown'}
                </span>
                <span style={{
                  color: 'var(--text-secondary)',
                  fontVariantNumeric: 'tabular-nums', flexShrink: 0,
                }}>
                  {fmtMoney(h.value)} · {h.pct_of_portfolio.toFixed(1)}%
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Account-count footer — small, dim. Adds a final line of
          context (how many accounts the totals roll up) and gives
          the tile one more vertical row of content so it sits
          comfortably alongside Pulse and HSA in the same grid row. */}
      {summary.accounts && summary.accounts.length > 0 && (
        <div style={{
          marginTop: 8, fontSize: 10,
          color: 'var(--text-dim)', textAlign: 'center',
        }}>
          Across {summary.accounts.length} account{summary.accounts.length === 1 ? '' : 's'}
          {summary.total_cash > 0 && ` · ${fmtMoney(summary.total_cash)} cash`}
        </div>
      )}
    </div>
  )
}


function DcfsaField({ label, children, full }) {
  return (
    <label style={{
      display: 'flex', flexDirection: 'column', gap: 3,
      gridColumn: full ? '1 / -1' : undefined,
    }}>
      <span style={{
        fontSize: 9, color: 'var(--text-muted)',
        textTransform: 'uppercase', letterSpacing: 0.4,
      }}>{label}</span>
      {children}
    </label>
  )
}


/* ─────────────────────── Cash Balances ─────────────────────── */

/**
 * CashBalances — at-a-glance "is any checking account running low?"
 *
 * Scope: checking accounts only (depository / checking). Savings is
 * intentionally excluded — those accounts often sit at the institution's
 * minimum-to-stay-open ($5–$10) by design and would generate noise; the
 * problem we're trying to surface is "did a bill autopay just empty out
 * a checking account that's about to bounce the next one?"
 *
 * Sort: ascending by current_balance so the lowest is on top — the
 * answer to "is anything low" is in the first row by construction.
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
  const [accounts, setAccounts] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    getAccounts()
      .then(setAccounts)
      .finally(() => setLoading(false))
  }, [])

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
    .sort((a, b) => (a.current_balance || 0) - (b.current_balance || 0))

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

      {/* Per-account list, lowest first. flex: 1 lets the list
          stretch when the tile shares a row with a taller sibling. */}
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
                {new Intl.NumberFormat('en-US', {
                  style: 'currency', currency: 'USD',
                  minimumFractionDigits: 2, maximumFractionDigits: 2,
                }).format(balance)}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
