/**
 * Trading Tax dashboard — YTD realized P&L + wash-sale audit + open-
 * position long-term countdown for swing traders.
 *
 * Renders four sections:
 *   1. Headline tiles: ST net, LT net, wash-sale disallowed, est. tax
 *   2. Open-position cards sorted by tax-savings-from-holding-to-LT
 *      (the killer feature: "AAPL has 18 days to LT, save $340")
 *   3. Audit table: every match the calculator produced — these are
 *      the future Form 8949 line items
 *   4. Settings strip: year selector + tax-rate inputs
 *
 * All math happens server-side (services/trading_tax.py); this
 * component is purely a viewer. Refetches when year / account /
 * tax-rate inputs change.
 */
import { useEffect, useMemo, useState } from 'react'
import { Loader2, AlertTriangle, Clock, TrendingUp, FileText, Calendar, DollarSign, Zap, Wallet, TrendingDown, Trophy, Download, AlertCircle, Scissors } from 'lucide-react'
import { getTradingTax, getHoldings, tradingTaxForm8949Url } from '../api/client'
import { formatCurrency, formatCurrencyZero, formatDate } from '../lib/format'
import PreflightSellModal from './PreflightSellModal'

const STORAGE_KEY = 'tuskledger.tradingTaxRates.v1'
const SCOPE_STORAGE_KEY = 'tuskledger.tradingTaxWashScope.v1'

// Pure helpers — exported for unit tests.

export function termColor(term) {
  // Visual coding: ST is the more taxed term, so it carries the
  // attention-grabbing accent. LT gets the calmer green.
  return term === 'LT' ? 'var(--accent-green)' : 'var(--accent-orange)'
}

export function gainLossColor(amount) {
  if (amount > 0) return 'var(--accent-green)'
  if (amount < 0) return 'var(--accent-red)'
  return 'var(--text-muted)'
}

export function formatHoldingPeriod(days) {
  // Compact "2y 4mo" / "8mo" / "23d" form for the audit table. Months
  // here are 30-day approximations — this is for human scan, not tax math.
  if (days >= 365) {
    const yrs = Math.floor(days / 365)
    const months = Math.floor((days % 365) / 30)
    return months > 0 ? `${yrs}y ${months}mo` : `${yrs}y`
  }
  if (days >= 30) return `${Math.floor(days / 30)}mo`
  return `${days}d`
}

export default function TradingTax({ accountFilter }) {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const currentYear = new Date().getFullYear()
  const [year, setYear] = useState(currentYear)
  // Pre-flight modal state. `position` carries everything the modal
  // needs (symbol, plaid_security_id, quantity, cost_basis,
  // earliest_buy_date, days_until_lt). `currentPrice` is looked up
  // from the holdings table by symbol.
  const [preflightTarget, setPreflightTarget] = useState(null)
  // Symbol → today's price, needed to seed the modal's price input.
  const [priceMap, setPriceMap] = useState({})

  useEffect(() => {
    // Holdings give us a fresh institution_price per symbol — used as
    // the pre-flight price default. Cheap call; no debounce needed.
    getHoldings()
      .then(hs => {
        const m = {}
        for (const h of hs) {
          const sym = h.security?.ticker_symbol
          if (sym && h.institution_price) m[sym] = h.institution_price
        }
        setPriceMap(m)
      })
      .catch(() => {})
  }, [])
  // Tax-rate inputs persist across page loads — most users have a
  // stable bracket year-to-year and don't want to re-enter every visit.
  const [rates, setRates] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null') || {
        ordinary: 22, ltcg: 15, state: 4.25,
      }
    } catch {
      return { ordinary: 22, ltcg: 15, state: 4.25 }
    }
  })
  // Wash-sale scope. 'all_accounts' = IRS-correct default (taxpayer-wide).
  // 'per_account' = informational, broker-style — only flags washes
  // when the replacement buy is in the same account as the loss.
  const [washScope, setWashScope] = useState(() => {
    try {
      return localStorage.getItem(SCOPE_STORAGE_KEY) || 'all_accounts'
    } catch {
      return 'all_accounts'
    }
  })

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(rates))
  }, [rates])
  useEffect(() => {
    localStorage.setItem(SCOPE_STORAGE_KEY, washScope)
  }, [washScope])

  useEffect(() => {
    setLoading(true)
    setError(null)
    const params = {
      year,
      ordinary_marginal_rate: rates.ordinary / 100,
      ltcg_rate: rates.ltcg / 100,
      state_rate: rates.state / 100,
      wash_sale_scope: washScope,
    }
    if (accountFilter) params.account_id = accountFilter
    const t = setTimeout(() => {
      getTradingTax(params)
        .then(setData)
        .catch(e => setError(e.message || 'Failed to load trading-tax data'))
        .finally(() => setLoading(false))
    }, 200)
    return () => clearTimeout(t)
  }, [year, rates, accountFilter, washScope])

  if (loading && !data) {
    return (
      <div style={{ padding: 24, color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 8 }}>
        <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} />
        Computing realized P&L…
      </div>
    )
  }

  if (error) {
    return (
      <div style={{
        padding: 16, background: 'var(--accent-orange-bg)',
        border: '1px solid var(--accent-orange-border)',
        borderRadius: 8, color: 'var(--text-primary)', fontSize: 13,
      }}>
        <AlertTriangle size={14} style={{ display: 'inline', marginRight: 6, color: 'var(--accent-orange)' }} />
        {error}
      </div>
    )
  }

  if (!data) return null

  const { summary, tax, matches, open_positions, lt_savings } = data
  const hasActivity = summary.match_count > 0
  const hasOpenPositions = (open_positions || []).length > 0

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Settings strip — year + tax rates */}
      <div style={{
        display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap',
        padding: '10px 14px',
        background: 'var(--bg-card)',
        border: '1px solid var(--border-color, rgba(255,255,255,0.08))',
        borderRadius: 8, fontSize: 12,
      }}>
        <Calendar size={14} style={{ color: 'var(--accent-blue)' }} />
        <label style={{ color: 'var(--text-muted)' }}>
          Year{' '}
          <select
            value={year}
            onChange={e => setYear(Number(e.target.value))}
            style={selectStyle}
          >
            {[currentYear, currentYear - 1, currentYear - 2].map(y =>
              <option key={y} value={y}>{y}</option>
            )}
          </select>
        </label>
        <span style={{ color: 'var(--text-muted)', marginLeft: 8 }}>·</span>
        <label style={{ color: 'var(--text-muted)' }}>
          ST rate %{' '}
          <input type="number" min={0} max={50} step={0.25} value={rates.ordinary}
            onChange={e => setRates(r => ({ ...r, ordinary: Number(e.target.value) }))}
            style={smallNumberStyle}
            title="Your marginal ordinary-income rate. Short-term gains tax at this rate."
          />
        </label>
        <label style={{ color: 'var(--text-muted)' }}>
          LTCG %{' '}
          <input type="number" min={0} max={50} step={0.5} value={rates.ltcg}
            onChange={e => setRates(r => ({ ...r, ltcg: Number(e.target.value) }))}
            style={smallNumberStyle}
            title="Long-term capital gains rate. 15% covers most MFJ filers; 20% above $583k."
          />
        </label>
        <label style={{ color: 'var(--text-muted)' }}>
          State %{' '}
          <input type="number" min={0} max={15} step={0.25} value={rates.state}
            onChange={e => setRates(r => ({ ...r, state: Number(e.target.value) }))}
            style={smallNumberStyle}
            title="State income tax rate (MI = 4.25%)."
          />
        </label>
        <label style={{ color: 'var(--text-muted)', marginLeft: 'auto' }}>
          Wash scope{' '}
          <select
            value={washScope}
            onChange={e => setWashScope(e.target.value)}
            style={selectStyle}
            title="Which accounts to scan for wash-sale replacement buys. All-accounts is the IRS rule (IRC §1091); per-account matches what brokers actually enforce on your 1099-B."
          >
            <option value="all_accounts">All accounts (IRS)</option>
            <option value="per_account">Per-account (broker-style)</option>
          </select>
        </label>
        <span style={{ color: 'var(--text-muted)' }}>
          As of {data.as_of}
        </span>
      </div>

      {/* Wash-scope explainer — copy adapts to the selected mode. The
          all-accounts mode is IRS-correct; per-account is informational
          and we say so explicitly so the user doesn't think it's the
          authoritative answer at tax time. */}
      {data.wash_sale_scope === 'per_account' ? (
        <div style={{
          padding: '10px 14px',
          background: 'var(--accent-orange-bg)',
          border: '1px solid var(--accent-orange-border)',
          borderLeft: '3px solid var(--accent-orange)',
          borderRadius: 6, fontSize: 12, color: 'var(--text-primary)',
          lineHeight: 1.5,
        }}>
          <strong style={{ color: 'var(--accent-orange)' }}>Per-account wash detection (informational): </strong>
          Wash sales are only flagged when the replacement buy is in the same
          account as the loss — matches what brokers enforce on 1099-Bs but does
          NOT match the IRS rule (IRC §1091 applies per taxpayer). Use this
          mode if your retirement accounts hold only index funds and can't
          generate cross-account washes against your trading. For tax-time
          reporting, switch back to <strong>All accounts (IRS)</strong>.
        </div>
      ) : (data.is_account_filtered || (data.cross_account_wash_count || 0) > 0) && (
        <div style={{
          padding: '10px 14px',
          background: 'var(--accent-blue-bg)',
          border: '1px solid var(--accent-blue-border)',
          borderLeft: '3px solid var(--accent-blue)',
          borderRadius: 6, fontSize: 12, color: 'var(--text-primary)',
          lineHeight: 1.5,
        }}>
          <strong style={{ color: 'var(--accent-blue)' }}>Cross-account wash-sale detection: </strong>
          Wash-sale checks run across all your investment accounts because IRC
          §1091 applies per taxpayer (a buy in your IRA after a loss in your
          brokerage is still a wash).
          {data.cross_account_wash_count > 0 && (
            <> <strong>{data.cross_account_wash_count}</strong> cross-account
            wash{data.cross_account_wash_count === 1 ? ' was' : 'es were'} detected
            this year — affected matches are flagged in the audit table below.</>
          )}
          {data.is_account_filtered && (
            <> Numbers shown are scoped to the selected account; the calculation
            considered all accounts for wash-sale purposes.</>
          )}
        </div>
      )}

      {/* Headline tiles */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(4, 1fr)',
        gap: 12,
      }}>
        <HeadlineTile
          label="Short-term net"
          value={summary.st_net}
          sub={`${formatCurrencyZero(summary.st_gain)} gain · ${formatCurrencyZero(summary.st_loss)} loss`}
          accent="orange"
        />
        <HeadlineTile
          label="Long-term net"
          value={summary.lt_net}
          sub={`${formatCurrencyZero(summary.lt_gain)} gain · ${formatCurrencyZero(summary.lt_loss)} loss`}
          accent="green"
        />
        <HeadlineTile
          label="Wash-sale locked"
          value={summary.wash_sale_disallowed_locked || 0}
          sub={
            summary.wash_sale_disallowed_locked > 0
              ? `truly stuck — replacement still open${summary.wash_sale_disallowed_captured > 0
                  ? ` · ${formatCurrency(summary.wash_sale_disallowed_captured)} captured downstream`
                  : ''}`
              : summary.wash_sale_disallowed > 0
                ? `${formatCurrency(summary.wash_sale_disallowed_captured || summary.wash_sale_disallowed)} captured downstream — chain terminated`
                : "no wash sales detected"
          }
          accent={
            summary.wash_sale_disallowed_locked > 0
              ? 'orange'
              : summary.wash_sale_disallowed > 0 ? 'green' : 'muted'
          }
          hideSign
        />
        <HeadlineTile
          label="Estimated tax owed"
          value={tax.estimated_tax_total}
          sub={tax.carryover_to_next_year < 0
            ? `${formatCurrencyZero(tax.carryover_to_next_year)} carryover`
            : `at ${rates.ordinary}% ST / ${rates.ltcg}% LT`}
          accent="blue"
          hideSign
        />
      </div>

      {/* Empty state — no trades in this year yet */}
      {!hasActivity && !hasOpenPositions && (
        <div style={{
          padding: 32, textAlign: 'center',
          background: 'var(--bg-card)',
          border: '1px solid var(--border-color, rgba(255,255,255,0.08))',
          borderRadius: 8, color: 'var(--text-muted)',
        }}>
          <FileText size={28} style={{ color: 'var(--accent-blue)', marginBottom: 8 }} />
          <div style={{ fontSize: 14, color: 'var(--text-primary)', marginBottom: 4 }}>
            No trading activity in {year}
          </div>
          <div style={{ fontSize: 12 }}>
            Once buys and sells from your investment accounts sync via Plaid, the
            realized P&L, wash-sale detection, and open-position LT countdown
            populate automatically.
          </div>
        </div>
      )}

      {/* Open-position long-term countdown — the killer feature */}
      {lt_savings && lt_savings.length > 0 && (
        <div>
          <SectionHeader
            icon={Clock}
            title="Hold-to-long-term opportunities"
            subtitle="Open positions where waiting for LT treatment converts ST tax to LTCG. Sorted by potential savings."
          />
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
            gap: 12,
          }}>
            {lt_savings.slice(0, 6).map(p => {
              // Find the matching open_positions row to get
              // plaid_security_id + earliest_buy_date for the modal.
              const fullPos = open_positions.find(op => op.symbol === p.symbol)
              return (
                <LtCountdownCard
                  key={p.symbol}
                  pos={p}
                  onPreflight={fullPos ? () => setPreflightTarget({
                    ...fullPos,
                    quantity: p.quantity,
                  }) : undefined}
                />
              )
            })}
          </div>
        </div>
      )}

      {/* Quarterly estimated-tax pacing — surfaces the "April surprise"
          risk for active traders. Tile shows YTD tax owed, projected
          full-year, the four IRS deadlines + which have passed, and
          a flag if projected tax > $1k (penalty-risk threshold). */}
      {data.quarterly_pacing && data.quarterly_pacing.projected_full_year_tax > 0 && (
        <QuarterlyPacingTile pacing={data.quarterly_pacing} />
      )}

      {/* Top winners / losers — ranks closed positions by realized $.
          Two cards side-by-side so you see at a glance what drove the
          headline ST/LT numbers. */}
      {(data.top_winners?.length > 0 || data.top_losers?.length > 0) && (
        <div>
          <SectionHeader
            icon={Trophy}
            title="Top realized winners & losers"
            subtitle="Closed positions ranked by realized $ this year. Use to see what's actually driving the headline numbers."
          />
          <div style={{
            display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 12,
          }}>
            <WinnersLosersCard rows={data.top_winners} kind="winners" />
            <WinnersLosersCard rows={data.top_losers} kind="losers" />
          </div>
        </div>
      )}

      {/* Per-symbol realized P&L rollup. Aggregate across all matches
          for a given ticker — trade count, total realized, ST/LT split. */}
      {data.by_symbol && data.by_symbol.length > 0 && (
        <div>
          <SectionHeader
            icon={DollarSign}
            title={`Per-symbol realized P&L (${data.by_symbol.length} symbol${data.by_symbol.length === 1 ? '' : 's'})`}
            subtitle="Every ticker you've closed this year, sorted by absolute realized magnitude."
          />
          <div className="card" style={{ padding: 0 }}>
            <div className="table-wrapper">
              <table>
                <thead>
                  <tr>
                    <th>Symbol</th>
                    <th style={{ textAlign: 'right' }}>Trades</th>
                    <th style={{ textAlign: 'right' }}>Shares</th>
                    <th style={{ textAlign: 'right' }}>ST realized</th>
                    <th style={{ textAlign: 'right' }}>LT realized</th>
                    <th style={{ textAlign: 'right' }}>Wash disallowed</th>
                    <th style={{ textAlign: 'right' }}>Net realized</th>
                  </tr>
                </thead>
                <tbody>
                  {data.by_symbol.map(s => (
                    <tr key={s.symbol}>
                      <td style={{ fontWeight: 500 }}>{s.symbol}</td>
                      <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                        {s.trade_count}
                      </td>
                      <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: 'var(--text-secondary)' }}>
                        {s.shares_total.toLocaleString(undefined, { maximumFractionDigits: 4 })}
                      </td>
                      <td style={{
                        textAlign: 'right', fontVariantNumeric: 'tabular-nums',
                        color: gainLossColor(s.st_realized),
                      }}>
                        {s.st_realized !== 0
                          ? (s.st_realized > 0 ? '+' : '') + formatCurrency(s.st_realized)
                          : '—'}
                      </td>
                      <td style={{
                        textAlign: 'right', fontVariantNumeric: 'tabular-nums',
                        color: gainLossColor(s.lt_realized),
                      }}>
                        {s.lt_realized !== 0
                          ? (s.lt_realized > 0 ? '+' : '') + formatCurrency(s.lt_realized)
                          : '—'}
                      </td>
                      <td style={{
                        textAlign: 'right', fontVariantNumeric: 'tabular-nums',
                        color: s.wash_disallowed > 0 ? 'var(--accent-orange)' : 'var(--text-muted)',
                      }}>
                        {s.wash_disallowed > 0 ? formatCurrency(s.wash_disallowed) : '—'}
                      </td>
                      <td style={{
                        textAlign: 'right', fontVariantNumeric: 'tabular-nums',
                        color: gainLossColor(s.realized),
                        fontWeight: 600,
                      }}>
                        {(s.realized > 0 ? '+' : '') + formatCurrency(s.realized)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* Tax-loss harvesting candidates — open positions in taxable
          accounts currently sitting at an unrealized loss. Each card
          shows the harvestable loss, estimated tax savings (using the
          user's marginal rate), suggested replacement security, and
          a wash-sale safety check. The Pre-flight button reuses the
          existing modal so the user can model the actual tax-time
          impact before placing the trade. */}
      {data.tlh_candidates && data.tlh_candidates.length > 0 && (
        <div>
          <SectionHeader
            icon={Scissors}
            title={`Tax-loss harvesting candidates · ${formatCurrency(data.tlh_total_savings)} potential savings`}
            subtitle={`${data.tlh_candidates.length} open position${data.tlh_candidates.length === 1 ? '' : 's'} at a loss in taxable accounts. Selling realizes the loss to offset gains; replacement-security suggestions preserve exposure without triggering a wash.`}
          />
          {/* Year-end nudge in Q4 (Oct 1+). Frames TLH as a calendar-locked
              decision so the user doesn't drift past Dec 31. */}
          {(() => {
            const now = new Date()
            const dec31 = new Date(now.getFullYear(), 11, 31)
            const daysToYearEnd = Math.ceil((dec31 - now) / (1000 * 60 * 60 * 24))
            if (daysToYearEnd > 90) return null
            return (
              <div style={{
                padding: '8px 12px', marginBottom: 10, fontSize: 12,
                background: 'var(--accent-orange-bg)',
                border: '1px solid var(--accent-orange-border)',
                borderLeft: '3px solid var(--accent-orange)',
                borderRadius: 6, color: 'var(--text-primary)',
              }}>
                <strong style={{ color: 'var(--accent-orange)' }}>
                  Tax year ends in {daysToYearEnd} days.
                </strong>{' '}
                Harvest decisions need to be executed before Dec 31 to count for this year.
              </div>
            )
          })()}
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))',
            gap: 12,
          }}>
            {data.tlh_candidates.map(c => (
              <TlhCandidateCard
                key={c.symbol + c.account_id}
                candidate={c}
                onPreflight={() => setPreflightTarget({
                  symbol: c.symbol,
                  plaid_security_id: c.plaid_security_id,
                  account_id: c.account_id,
                  quantity: c.quantity,
                  cost_basis: c.cost_basis,
                  earliest_buy_date: null,
                  days_until_lt: c.days_until_lt,
                  is_long_term: c.is_long_term,
                })}
              />
            ))}
          </div>
        </div>
      )}

      {/* Cash & buying power — sourced from Holdings rows where the
          security is flagged is_cash_equivalent (Plaid convention for
          settled cash + money-market sweep). Useful as swing-trade
          context: how much could you deploy without selling. */}
      {data.cash_by_account && data.cash_by_account.length > 0 && (
        <div>
          <SectionHeader
            icon={Wallet}
            title={`Cash & buying power · ${formatCurrency(data.total_cash)} total`}
            subtitle="Settled cash + money-market sweep across investment accounts. Available to deploy without selling positions."
          />
          <div className="card" style={{ padding: 0 }}>
            <div className="table-wrapper">
              <table>
                <thead>
                  <tr>
                    <th>Account</th>
                    <th style={{ textAlign: 'right' }}>Cash</th>
                    <th style={{ textAlign: 'right' }}>% of total cash</th>
                  </tr>
                </thead>
                <tbody>
                  {data.cash_by_account.map(c => (
                    <tr key={c.account_id}>
                      <td style={{ fontWeight: 500 }}>{c.account_name}</td>
                      <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                        {formatCurrency(c.cash_value)}
                      </td>
                      <td style={{
                        textAlign: 'right', fontVariantNumeric: 'tabular-nums',
                        color: 'var(--text-secondary)',
                      }}>
                        {data.total_cash > 0
                          ? `${((c.cash_value / data.total_cash) * 100).toFixed(1)}%`
                          : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* All open positions (compact list) */}
      {hasOpenPositions && (
        <div>
          <SectionHeader
            icon={TrendingUp}
            title="Open positions"
            subtitle="Lots still held — sorted by earliest buy date so the closest-to-LT show first."
          />
          <div className="card" style={{ padding: 0 }}>
            <div className="table-wrapper">
              <table>
                <thead>
                  <tr>
                    <th>Symbol</th>
                    <th>Account</th>
                    <th style={{ textAlign: 'right' }}>Qty</th>
                    <th style={{ textAlign: 'right' }}>Avg/share</th>
                    <th style={{ textAlign: 'right' }}>Cost basis</th>
                    <th style={{ textAlign: 'right' }}>Current value</th>
                    <th style={{ textAlign: 'right' }}>Unrealized</th>
                    <th>Earliest buy</th>
                    <th style={{ textAlign: 'right' }}>Days held</th>
                    <th style={{ textAlign: 'right' }}>Days to LT</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {open_positions.map(p => (
                    <tr key={p.symbol + (p.account_id || '_') + p.earliest_buy_date}>
                      <td style={{ fontWeight: 500 }}>{p.symbol}</td>
                      <td style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                        {p.account_name || '—'}
                      </td>
                      <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                        {p.quantity.toLocaleString(undefined, { maximumFractionDigits: 4 })}
                      </td>
                      <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: 'var(--text-secondary)' }}>
                        {formatCurrency(p.avg_cost_per_share)}
                      </td>
                      <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                        {formatCurrency(p.cost_basis)}
                      </td>
                      <td style={{
                        textAlign: 'right', fontVariantNumeric: 'tabular-nums',
                        fontWeight: 500,
                      }} title={p.current_price ? `@ ${formatCurrency(p.current_price)}/share` : 'no current price available'}>
                        {p.current_value != null ? formatCurrency(p.current_value) : '—'}
                      </td>
                      <td style={{
                        textAlign: 'right', fontVariantNumeric: 'tabular-nums',
                        color: p.unrealized_gain == null
                          ? 'var(--text-muted)'
                          : gainLossColor(p.unrealized_gain),
                        fontWeight: 500,
                      }}>
                        {p.unrealized_gain != null
                          ? (p.unrealized_gain >= 0 ? '+' : '') + formatCurrency(p.unrealized_gain)
                          : '—'}
                      </td>
                      <td style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                        {formatDate(p.earliest_buy_date)}
                      </td>
                      <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                        {p.days_held_so_far}
                      </td>
                      <td style={{
                        textAlign: 'right', fontVariantNumeric: 'tabular-nums',
                        color: p.is_long_term ? 'var(--accent-green)' : 'var(--text-primary)',
                        fontWeight: p.is_long_term ? 600 : 400,
                      }}>
                        {p.is_long_term ? 'LT' : p.days_until_lt}
                      </td>
                      <td style={{ textAlign: 'right' }}>
                        <button
                          onClick={() => setPreflightTarget(p)}
                          title="Run a pre-flight check on a hypothetical sell of this position"
                          style={{
                            display: 'inline-flex', alignItems: 'center', gap: 4,
                            padding: '3px 8px', fontSize: 11,
                            background: 'transparent',
                            border: '1px solid var(--border-color, rgba(255,255,255,0.15))',
                            color: 'var(--text-secondary)',
                            borderRadius: 4, cursor: 'pointer',
                          }}
                        >
                          <Zap size={11} /> Pre-flight
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* Audit table — Form 8949 lines */}
      {hasActivity && (
        <div>
          <div style={{
            display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end',
            marginBottom: 8, gap: 12,
          }}>
            <SectionHeader
              icon={FileText}
              title={`Realized matches (${matches.length})`}
              subtitle="Per buy-lot match. Each row maps to one Form 8949 line at tax time. Wash-sale rows show the disallowed loss."
            />
            <a
              href={tradingTaxForm8949Url({
                year,
                account_id: accountFilter || undefined,
                wash_sale_scope: washScope,
              })}
              download={`form-8949-${year}.csv`}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 6,
                padding: '6px 12px', fontSize: 12, fontWeight: 600,
                background: 'var(--accent-blue)',
                color: '#0d0e14',
                border: 'none', borderRadius: 4,
                textDecoration: 'none', whiteSpace: 'nowrap',
              }}
              title="Download these matches as a Form 8949-ready CSV. Open in Excel or hand to your accountant for tax filing."
            >
              <Download size={12} /> Export Form 8949 CSV
            </a>
          </div>
          <div className="card" style={{ padding: 0 }}>
            <div className="table-wrapper">
              <table>
                <thead>
                  <tr>
                    <th>Symbol</th>
                    <th>Account</th>
                    <th>Bought</th>
                    <th>Sold</th>
                    <th>Held</th>
                    <th>Term</th>
                    <th style={{ textAlign: 'right' }}>Qty</th>
                    <th style={{ textAlign: 'right' }}>Proceeds</th>
                    <th style={{ textAlign: 'right' }}>Basis</th>
                    <th style={{ textAlign: 'right' }}>Gain / loss</th>
                    <th style={{ textAlign: 'right' }}>Wash</th>
                  </tr>
                </thead>
                <tbody>
                  {matches.map((m, i) => (
                    <tr key={i}>
                      <td style={{ fontWeight: 500 }}>{m.symbol}</td>
                      <td style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                        {m.account_name || '—'}
                      </td>
                      <td style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                        {formatDate(m.buy_date)}
                      </td>
                      <td style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                        {formatDate(m.sell_date)}
                      </td>
                      <td style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                        {formatHoldingPeriod(m.holding_period_days)}
                      </td>
                      <td>
                        <span style={{
                          fontSize: 10, padding: '2px 6px', borderRadius: 4,
                          background: m.term === 'LT'
                            ? 'var(--accent-green-bg)' : 'var(--accent-orange-bg)',
                          color: termColor(m.term),
                          fontWeight: 600, letterSpacing: 0.4,
                        }}>{m.term}</span>
                      </td>
                      <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                        {m.quantity.toLocaleString(undefined, { maximumFractionDigits: 4 })}
                      </td>
                      <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                        {formatCurrency(m.proceeds)}
                      </td>
                      <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: 'var(--text-secondary)' }}>
                        {formatCurrency(m.basis)}
                      </td>
                      <td style={{
                        textAlign: 'right', fontVariantNumeric: 'tabular-nums',
                        color: gainLossColor(m.gain_loss),
                        fontWeight: 500,
                      }}>
                        {formatCurrency(m.gain_loss)}
                      </td>
                      <td style={{
                        textAlign: 'right', fontVariantNumeric: 'tabular-nums',
                        color: m.wash_sale_disallowed > 0 ? 'var(--accent-orange)' : 'var(--text-muted)',
                      }}>
                        {m.wash_sale_disallowed > 0 ? (
                          <span title={m.wash_sale_replacement_account_name
                            ? `Cross-account wash: replacement buy was in ${m.wash_sale_replacement_account_name}`
                            : 'Wash sale within this account'}>
                            {formatCurrency(m.wash_sale_disallowed)}
                            {m.wash_sale_replacement_account_name && (
                              <span style={{ fontSize: 10, marginLeft: 4 }}>⤳</span>
                            )}
                          </span>
                        ) : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* Pre-flight modal — null target means closed. */}
      {preflightTarget && (
        <PreflightSellModal
          position={preflightTarget}
          currentPrice={priceMap[preflightTarget.symbol]}
          onClose={() => setPreflightTarget(null)}
        />
      )}
    </div>
  )
}


function HeadlineTile({ label, value, sub, accent = 'blue', hideSign = false }) {
  const color = `var(--accent-${accent === 'muted' ? 'blue' : accent})`
  const numberColor = accent === 'muted' ? 'var(--text-secondary)' : color
  return (
    <div style={{
      padding: 14,
      background: 'var(--bg-card)',
      border: '1px solid var(--border-color, rgba(255,255,255,0.08))',
      borderLeft: `3px solid ${color}`,
      borderRadius: 8,
    }}>
      <div style={{
        fontSize: 10, fontWeight: 600, letterSpacing: 0.4,
        textTransform: 'uppercase', color: 'var(--text-muted)',
      }}>
        {label}
      </div>
      <div style={{
        fontSize: 22, fontWeight: 700, color: numberColor,
        marginTop: 4, fontVariantNumeric: 'tabular-nums',
      }}>
        {hideSign || value === 0
          ? formatCurrencyZero(Math.abs(value))
          : (value > 0 ? '+' : '') + formatCurrencyZero(value)}
      </div>
      {sub && (
        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
          {sub}
        </div>
      )}
    </div>
  )
}


function LtCountdownCard({ pos, onPreflight }) {
  return (
    <div style={{
      padding: 14,
      background: 'var(--bg-card)',
      border: '1px solid var(--border-color, rgba(255,255,255,0.08))',
      borderLeft: '3px solid var(--accent-green)',
      borderRadius: 8,
    }}>
      <div style={{
        display: 'flex', alignItems: 'baseline',
        justifyContent: 'space-between', marginBottom: 6,
      }}>
        <span style={{ fontSize: 14, fontWeight: 700 }}>{pos.symbol}</span>
        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
          {pos.quantity.toLocaleString(undefined, { maximumFractionDigits: 4 })} shares
        </span>
      </div>
      <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 8 }}>
        Currently {formatCurrency(pos.current_value)} ·
        <span style={{ color: 'var(--accent-green)' }}>
          {' +'}{formatCurrency(pos.unrealized_gain)}
        </span> unrealized
      </div>
      <div style={{
        display: 'grid', gridTemplateColumns: '1fr auto', gap: 4,
        fontSize: 12, color: 'var(--text-secondary)',
      }}>
        <span>If sold today (ST)</span>
        <span style={{ color: 'var(--accent-orange)', fontVariantNumeric: 'tabular-nums' }}>
          −{formatCurrency(pos.tax_if_sold_today)} tax
        </span>
        <span>If held to LT</span>
        <span style={{ color: 'var(--accent-green)', fontVariantNumeric: 'tabular-nums' }}>
          −{formatCurrency(pos.tax_if_held_to_lt)} tax
        </span>
      </div>
      <div style={{
        marginTop: 10, padding: '8px 10px',
        background: 'var(--accent-green-bg)',
        border: '1px solid var(--accent-green-border)',
        borderRadius: 6,
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        fontSize: 12,
      }}>
        <span style={{ color: 'var(--accent-green)', fontWeight: 600 }}>
          Save {formatCurrency(pos.savings_from_holding)}
        </span>
        <span style={{ color: 'var(--text-secondary)' }}>
          hold {pos.days_until_lt} more {pos.days_until_lt === 1 ? 'day' : 'days'}
        </span>
      </div>
      {onPreflight && (
        <button
          onClick={onPreflight}
          title="Run a pre-flight check on this position to see the wash-sale risk and tax impact"
          style={{
            marginTop: 8, width: '100%',
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 5,
            padding: '5px 10px', fontSize: 11, fontWeight: 600,
            background: 'transparent',
            border: '1px solid var(--border-color, rgba(255,255,255,0.15))',
            color: 'var(--text-secondary)',
            borderRadius: 4, cursor: 'pointer',
          }}
        >
          <Zap size={11} /> Pre-flight a sell
        </button>
      )}
    </div>
  )
}


function TlhCandidateCard({ candidate, onPreflight }) {
  const c = candidate
  const isWashRisk = !!c.wash_sale_risk
  const accent = isWashRisk ? 'orange' : 'green'
  return (
    <div style={{
      padding: 14,
      background: 'var(--bg-card)',
      border: '1px solid var(--border-color, rgba(255,255,255,0.08))',
      borderLeft: `3px solid var(--accent-${accent})`,
      borderRadius: 8,
    }}>
      <div style={{
        display: 'flex', alignItems: 'baseline',
        justifyContent: 'space-between', marginBottom: 6,
      }}>
        <span style={{ fontSize: 14, fontWeight: 700 }}>{c.symbol}</span>
        <span style={{
          fontSize: 10, padding: '2px 6px', borderRadius: 3,
          background: c.term === 'LT' ? 'var(--accent-green-bg)' : 'var(--accent-orange-bg)',
          color: c.term === 'LT' ? 'var(--accent-green)' : 'var(--accent-orange)',
          fontWeight: 600, letterSpacing: 0.4,
        }}>{c.term}</span>
      </div>
      <div style={{
        display: 'grid', gridTemplateColumns: '1fr auto', gap: 4,
        fontSize: 12, color: 'var(--text-secondary)', marginBottom: 8,
      }}>
        <span>Quantity</span>
        <span style={{ fontVariantNumeric: 'tabular-nums' }}>
          {c.quantity.toLocaleString(undefined, { maximumFractionDigits: 4 })}
        </span>
        <span>Cost basis</span>
        <span style={{ fontVariantNumeric: 'tabular-nums' }}>{formatCurrency(c.cost_basis)}</span>
        <span>Current value</span>
        <span style={{ fontVariantNumeric: 'tabular-nums' }}>{formatCurrency(c.current_value)}</span>
        <span style={{ fontWeight: 600 }}>Unrealized loss</span>
        <span style={{
          fontVariantNumeric: 'tabular-nums',
          color: 'var(--accent-red)', fontWeight: 600,
        }}>−{formatCurrency(c.unrealized_loss)}</span>
      </div>
      <div style={{
        padding: '8px 10px', marginBottom: 8,
        background: `var(--accent-${accent}-bg)`,
        border: `1px solid var(--accent-${accent}-border)`,
        borderRadius: 6, fontSize: 12,
      }}>
        <div style={{
          color: `var(--accent-${accent})`, fontWeight: 600,
          marginBottom: 2,
        }}>
          {isWashRisk ? 'Harvest blocked: wash-sale risk' : `Save ${formatCurrency(c.estimated_tax_savings)} in tax`}
        </div>
        <div style={{ color: 'var(--text-secondary)', fontSize: 11, lineHeight: 1.4 }}>
          {c.notes}
        </div>
      </div>
      {!c.is_long_term && c.days_until_lt > 0 && c.days_until_lt <= 30 && (
        <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 6 }}>
          Note: only {c.days_until_lt} days from LT — harvesting now keeps it as ST loss (more tax-efficient if you have ST gains to offset).
        </div>
      )}
      <button
        onClick={onPreflight}
        disabled={isWashRisk}
        title={isWashRisk
          ? 'Pre-flight blocked: wash-sale window not clear yet'
          : 'Run a pre-flight check on this position to see the actual tax impact'}
        style={{
          width: '100%', padding: '6px 10px', fontSize: 11, fontWeight: 600,
          background: isWashRisk ? 'transparent' : 'var(--accent-green)',
          color: isWashRisk ? 'var(--text-muted)' : '#0d0e14',
          border: isWashRisk
            ? '1px dashed var(--border-color, rgba(255,255,255,0.15))'
            : 'none',
          borderRadius: 4,
          cursor: isWashRisk ? 'not-allowed' : 'pointer',
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 5,
        }}
      >
        <Zap size={11} /> Pre-flight harvest
      </button>
    </div>
  )
}


function WinnersLosersCard({ rows, kind }) {
  const isWinners = kind === 'winners'
  const accent = isWinners ? 'var(--accent-green)' : 'var(--accent-red)'
  const Icon = isWinners ? TrendingUp : TrendingDown
  const empty = !rows || rows.length === 0
  return (
    <div style={{
      padding: 14,
      background: 'var(--bg-card)',
      border: '1px solid var(--border-color, rgba(255,255,255,0.08))',
      borderLeft: `3px solid ${accent}`,
      borderRadius: 8,
    }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 6,
        fontSize: 11, fontWeight: 700, letterSpacing: 0.4,
        textTransform: 'uppercase', color: accent,
        marginBottom: 8,
      }}>
        <Icon size={12} /> {isWinners ? 'Top winners' : 'Top losers'}
      </div>
      {empty ? (
        <div style={{ fontSize: 12, color: 'var(--text-muted)', fontStyle: 'italic' }}>
          {isWinners ? 'No realized winners this year yet.' : 'No realized losers this year — clean run.'}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {rows.map(r => (
            <div key={r.symbol} style={{
              display: 'grid',
              gridTemplateColumns: '1fr auto auto',
              gap: 8, alignItems: 'center',
              padding: '4px 0',
              borderBottom: '1px solid var(--border-color, rgba(255,255,255,0.04))',
              fontSize: 12,
            }}>
              <span style={{ fontWeight: 500 }}>{r.symbol}</span>
              <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                {r.trade_count} trade{r.trade_count === 1 ? '' : 's'}
              </span>
              <span style={{
                color: accent, fontWeight: 600,
                fontVariantNumeric: 'tabular-nums',
              }}>
                {(r.realized > 0 ? '+' : '') + formatCurrency(r.realized)}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}


function QuarterlyPacingTile({ pacing }) {
  const accent = pacing.underpayment_risk
    ? 'var(--accent-orange)'
    : 'var(--accent-blue)'
  const accentBg = pacing.underpayment_risk
    ? 'var(--accent-orange-bg)'
    : 'var(--accent-blue-bg)'
  const accentBorder = pacing.underpayment_risk
    ? 'var(--accent-orange-border)'
    : 'var(--accent-blue-border)'
  const nextQuarter = pacing.quarters.find(q => !q.passed)
  return (
    <div style={{
      padding: 14,
      background: accentBg,
      border: `1px solid ${accentBorder}`,
      borderLeft: `3px solid ${accent}`,
      borderRadius: 8,
    }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 6,
        fontSize: 11, fontWeight: 700, letterSpacing: 0.4,
        textTransform: 'uppercase', color: accent,
        marginBottom: 8,
      }}>
        <AlertCircle size={12} /> Quarterly estimated tax pacing
      </div>
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(4, 1fr)',
        gap: 10,
        marginBottom: 10,
      }}>
        <PacingMetric label="YTD tax owed" value={formatCurrency(pacing.ytd_tax_owed)} />
        <PacingMetric label="Projected full-year"
          value={formatCurrency(pacing.projected_full_year_tax)}
          accent={accent} />
        <PacingMetric label="Quarterly amount"
          value={formatCurrency(pacing.quarterly_amount)} />
        <PacingMetric label="Year elapsed"
          value={`${(pacing.fraction_elapsed * 100).toFixed(0)}%`} />
      </div>
      <div style={{
        display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 6,
        marginBottom: 8,
      }}>
        {pacing.quarters.map(q => (
          <div key={q.label} style={{
            padding: '6px 8px',
            borderRadius: 4,
            fontSize: 11,
            background: q.passed ? 'var(--bg-input)' : 'var(--bg-card)',
            border: `1px solid ${
              q === nextQuarter ? accent : 'var(--border-color, rgba(255,255,255,0.08))'
            }`,
            opacity: q.passed ? 0.6 : 1,
          }}>
            <div style={{
              fontWeight: 600, color: q === nextQuarter ? accent : 'var(--text-primary)',
            }}>
              {q.label} {q.passed ? '· passed' : '· next'}
            </div>
            <div style={{ color: 'var(--text-muted)', fontSize: 10 }}>
              by {q.deadline}
            </div>
            <div style={{
              fontVariantNumeric: 'tabular-nums', marginTop: 2,
              color: 'var(--text-secondary)',
            }}>
              cum {formatCurrency(q.cumulative_obligation)}
            </div>
          </div>
        ))}
      </div>
      <div style={{ fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.5 }}>
        {pacing.underpayment_risk ? (
          <>
            <strong style={{ color: accent }}>Heads up: </strong>
          </>
        ) : null}
        {pacing.note}
      </div>
    </div>
  )
}


function PacingMetric({ label, value, accent }) {
  return (
    <div>
      <div style={{
        fontSize: 10, fontWeight: 600, letterSpacing: 0.4,
        textTransform: 'uppercase', color: 'var(--text-muted)',
      }}>
        {label}
      </div>
      <div style={{
        fontSize: 16, fontWeight: 700,
        color: accent || 'var(--text-primary)',
        fontVariantNumeric: 'tabular-nums', marginTop: 2,
      }}>
        {value}
      </div>
    </div>
  )
}


function SectionHeader({ icon: Icon, title, subtitle }) {
  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8,
        fontSize: 13, fontWeight: 600,
      }}>
        <Icon size={14} style={{ color: 'var(--accent-blue)' }} />
        {title}
      </div>
      {subtitle && (
        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2, marginLeft: 22 }}>
          {subtitle}
        </div>
      )}
    </div>
  )
}


const selectStyle = {
  background: 'var(--bg-input)',
  color: 'var(--text-primary)',
  border: '1px solid var(--border-color, rgba(255,255,255,0.1))',
  borderRadius: 4, padding: '3px 6px', fontSize: 12,
}

const smallNumberStyle = {
  width: 60, padding: '3px 6px', fontSize: 12,
  background: 'var(--bg-input)',
  border: '1px solid var(--border-color, rgba(255,255,255,0.1))',
  borderRadius: 4, color: 'var(--text-primary)',
}
