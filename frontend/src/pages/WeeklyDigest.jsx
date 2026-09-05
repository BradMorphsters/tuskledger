import { useCallback, useEffect, useState } from 'react'
import { CalendarDays, TrendingUp, TrendingDown } from 'lucide-react'
import { getWeeklyDigest, getSafeToSpend } from '../api/client'
import { SkeletonPage } from '../components/Skeleton'
import LoadError from '../components/LoadError'
import { formatCurrencyZero as fmt, formatDate, toLocalISODate } from '../lib/format'
import { useLatestRequest } from '../hooks/useLatestRequest'
import { useSearchParams } from 'react-router-dom'

/**
 * WeeklyDigest — the once-a-week "what happened, what's coming, what
 * changed" read. Every section is prose-first (one plain sentence) with
 * a compact list underneath, because a once-a-week user wants the
 * takeaway, not a spreadsheet. All the numbers come straight from
 * GET /analytics/weekly-digest (app/services/weekly_digest.py) plus
 * GET /analytics/safe-to-spend for the top section — this page does no
 * math of its own.
 */
function pct(n) {
  if (n === null || n === undefined) return ''
  const sign = n > 0 ? '+' : ''
  return `${sign}${n.toFixed(0)}%`
}

function isValidWeekEnding(value, today = toLocalISODate()) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return false
  const parsed = new Date(`${value}T00:00:00`)
  return !Number.isNaN(parsed.getTime()) && toLocalISODate(parsed) === value && value <= today
}

function SectionCard({ title, icon, children }) {
  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div className="card-header">
        <span className="card-title" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          {icon} {title}
        </span>
      </div>
      {children}
    </div>
  )
}

export default function WeeklyDigest() {
  const [searchParams, setSearchParams] = useSearchParams()
  const today = toLocalISODate()
  const [weekEnding, setWeekEnding] = useState(() => {
    const queryDate = searchParams.get('week_ending')
    return isValidWeekEnding(queryDate, toLocalISODate()) ? queryDate : toLocalISODate()
  })
  const [digest, setDigest] = useState(null)
  const [safe, setSafe] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const runLatest = useLatestRequest()

  const load = useCallback(() => {
    setLoading(true)
    setError(false)
    return runLatest(token => Promise.all([
      getWeeklyDigest(weekEnding),
      getSafeToSpend().catch(() => null),
    ])
      .then(([d, s]) => {
        if (!token.live) return
        setDigest(d)
        setSafe(s)
        setLoading(false)
      })
      .catch(() => {
        if (!token.live) return
        setError(true)
        setLoading(false)
      }))
  }, [runLatest, weekEnding])

  useEffect(() => {
    return load()
  }, [load])

  const handleWeekEndingChange = (event) => {
    const next = event.target.value
    if (!isValidWeekEnding(next, today)) return
    setWeekEnding(next)
    setSearchParams(previous => {
      const nextParams = new URLSearchParams(previous)
      nextParams.set('week_ending', next)
      return nextParams
    }, { replace: true })
  }

  const historicalWeek = weekEnding !== today
  const overdueLabel = historicalWeek ? `overdue as of ${formatDate(weekEnding)}` : 'currently overdue'

  return (
    <div>
      <div className="page-header" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
        <h1 className="page-title">Weekly digest</h1>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--text-secondary)' }}>
          Week ending
          <input
            type="date"
            value={weekEnding}
            max={today}
            onChange={handleWeekEndingChange}
            style={{
              padding: '5px 8px', fontSize: 13, borderRadius: 6,
              border: '1px solid var(--border)', background: 'var(--bg-input)',
              color: 'var(--text-primary)',
            }}
          />
        </label>
      </div>

      {loading ? (
        <SkeletonPage stats={0} cards={4} rows={3} />
      ) : (
        <>
          {error && <LoadError what="the weekly digest" onRetry={load} />}
          {!error && digest && <>
            <p style={{ color: 'var(--text-muted)', fontSize: 13, marginTop: -8, marginBottom: 16 }}>
              {formatDate(digest.week_start)} – {formatDate(digest.week_end)}
            </p>

          {safe && (
            <SectionCard title="Safe to spend today (estimate)" icon={<CalendarDays size={14} style={{ color: 'var(--accent-blue)' }} />}>
              <p style={{ margin: '4px 0 8px' }}>
                You have <strong style={{ color: safe.safe_to_spend >= 0 ? 'var(--accent-green)' : 'var(--accent-red)' }}>
                  {fmt(safe.safe_to_spend)}
                </strong> safe to spend until your next paycheck on {formatDate(safe.next_paycheck_date)}.
              </p>
              <a href="/" style={{ fontSize: 12 }}>See the full breakdown on the Dashboard →</a>
            </SectionCard>
          )}

          <SectionCard
            title="Happened"
            icon={digest.happened.spend_delta.amount > 0
              ? <TrendingUp size={14} style={{ color: 'var(--accent-red)' }} />
              : <TrendingDown size={14} style={{ color: 'var(--accent-green)' }} />}
          >
            <p style={{ margin: '4px 0 8px' }}>
              You spent {fmt(digest.happened.spend)} this week
              {digest.happened.spend_delta.pct !== null && (
                <> ({pct(digest.happened.spend_delta.pct)} vs last week)</>
              )}, and brought in {fmt(digest.happened.income)} in income.
              {' '}{digest.happened.transaction_count} transaction{digest.happened.transaction_count === 1 ? '' : 's'}
              {digest.happened.refund_count > 0 && <>, including {digest.happened.refund_count} refund{digest.happened.refund_count === 1 ? '' : 's'}</>}.
            </p>
            {digest.happened.top_categories.length > 0 && (
              <ListBlock label="Top categories">
                {digest.happened.top_categories.map(c => (
                  <ListRow key={c.category} left={c.category} right={fmt(c.amount)}
                    sub={c.delta !== 0 ? `${c.delta > 0 ? '+' : ''}${fmt(c.delta)} vs last week` : null} />
                ))}
              </ListBlock>
            )}
            {digest.happened.top_merchants.length > 0 && (
              <ListBlock label="Top merchants">
                {digest.happened.top_merchants.map(m => (
                  <ListRow key={m.merchant} left={m.merchant} right={fmt(m.amount)} />
                ))}
              </ListBlock>
            )}
          </SectionCard>

          <SectionCard title="Notable">
            {digest.notable.new_merchants.length === 0 &&
             digest.notable.large_transactions.length === 0 &&
             digest.notable.price_hikes.length === 0 ? (
              <p style={{ margin: '4px 0' }}>Nothing unusual this week.</p>
            ) : (
              <>
                <p style={{ margin: '4px 0 8px' }}>A few things stood out this week.</p>
                {digest.notable.new_merchants.length > 0 && (
                  <ListBlock label="First-time merchants">
                    {digest.notable.new_merchants.map(m => (
                      <ListRow key={m.merchant} left={m.merchant} right={fmt(m.amount)} />
                    ))}
                  </ListBlock>
                )}
                {digest.notable.large_transactions.length > 0 && (
                  <ListBlock label="Unusually large transactions">
                    {digest.notable.large_transactions.map((t, i) => (
                      <ListRow key={i} left={`${t.merchant} · ${formatDate(t.date)}`} right={fmt(t.amount)}
                        sub={`typically ${fmt(t.typical_amount)}`} />
                    ))}
                  </ListBlock>
                )}
                {digest.notable.price_hikes.length > 0 && (
                  <ListBlock label="Possible price hikes on recurring charges">
                    {digest.notable.price_hikes.map((h, i) => (
                      <ListRow key={i} left={h.merchant} right={fmt(h.latest_amount)}
                        sub={`up ${h.delta_pct.toFixed(0)}% from ${fmt(h.typical_amount)}`} />
                    ))}
                  </ListBlock>
                )}
              </>
            )}
          </SectionCard>

          <SectionCard title="Coming (projection)" icon={<CalendarDays size={14} style={{ color: 'var(--accent-orange)' }} />}>
            <p style={{ margin: '4px 0 8px' }}>
              Projection uses current bill records; historical snapshots are unavailable.{' '}
              {digest.coming.next_paycheck_source === 'month_end_fallback'
                ? 'No recurring income detected; using an estimated payday of '
                : 'Your next paycheck is projected for '}
              {formatDate(digest.coming.next_paycheck_date)}.
              {(() => {
                const overdueCount = digest.coming.bills.filter(b => b.days_until < 0).length
                const upcomingCount = digest.coming.bills.length - overdueCount
                if (digest.coming.bills.length === 0) return ` No bills due in the next 14 days or ${overdueLabel}.`
                const parts = []
                if (upcomingCount > 0) parts.push(`${upcomingCount} bill${upcomingCount === 1 ? '' : 's'} due in the next 14 days`)
                if (overdueCount > 0) parts.push(`${overdueCount} ${overdueLabel}`)
                return ` ${parts.join(' and ')}.`
              })()}
            </p>
            {digest.coming.bills.length > 0 && (
              <ListBlock>
                {digest.coming.bills.map((b, i) => (
                  <ListRow key={i} left={`${b.name} · ${formatDate(b.date)}${b.days_until < 0 ? ` · ${historicalWeek ? overdueLabel : 'overdue'}` : ''}`} right={b.amount != null ? fmt(b.amount) : '—'} />
                ))}
              </ListBlock>
            )}
          </SectionCard>

          <SectionCard title="Budget status">
            {digest.budget_status === null ? (
              <p style={{ margin: '4px 0' }}>No budget set for this month.</p>
            ) : digest.budget_status.over_pace.length === 0 ? (
              <p style={{ margin: '4px 0' }}>Every budget line is on pace this month.</p>
            ) : (
              <>
                <p style={{ margin: '4px 0 8px' }}>
                  {digest.budget_status.over_pace.length} of {digest.budget_status.lines} budget line{digest.budget_status.lines === 1 ? '' : 's'} running over pace.
                </p>
                <ListBlock>
                  {digest.budget_status.over_pace.map(l => (
                    <ListRow key={l.category} left={l.category} right={`${fmt(l.spent)} / ${fmt(l.limit)}`}
                      sub={`pace ${fmt(l.pace_limit)}`} />
                  ))}
                </ListBlock>
              </>
            )}
          </SectionCard>

          <SectionCard title="Net worth">
            {digest.net_worth === null ? (
              <p style={{ margin: '4px 0' }}>No net-worth snapshots recorded yet.</p>
            ) : (
              <p style={{ margin: '4px 0' }}>
                Net worth is {fmt(digest.net_worth.net_worth)} as of {formatDate(digest.net_worth.date)}
                {digest.net_worth.delta !== null && digest.net_worth.prior_date && (
                  <>, {digest.net_worth.delta >= 0 ? 'up' : 'down'} {fmt(Math.abs(digest.net_worth.delta))} from {formatDate(digest.net_worth.prior_date)}</>
                )}.
              </p>
            )}
          </SectionCard>

          <SectionCard title="Action items">
            {digest.action_items.unpaired_transfers.count === 0 && digest.action_items.uncategorized.count === 0 ? (
              <p style={{ margin: '4px 0' }}>Nothing needs cleanup this week.</p>
            ) : (
              <ListBlock>
                {digest.action_items.unpaired_transfers.count > 0 && (
                  <ListRow
                    left={<a href={digest.action_items.unpaired_transfers.url}>Unpaired transfer-outs</a>}
                    right={digest.action_items.unpaired_transfers.count}
                  />
                )}
                {digest.action_items.uncategorized.count > 0 && (
                  <ListRow
                    left={<a href={digest.action_items.uncategorized.url}>Uncategorized transactions</a>}
                    right={digest.action_items.uncategorized.count}
                  />
                )}
              </ListBlock>
            )}
          </SectionCard>
          </>}
        </>
      )}
    </div>
  )
}

function ListBlock({ label, children }) {
  return (
    <div style={{ marginTop: 8 }}>
      {label && (
        <div style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 4 }}>
          {label}
        </div>
      )}
      <div style={{ display: 'flex', flexDirection: 'column' }}>{children}</div>
    </div>
  )
}

function ListRow({ left, right, sub }) {
  return (
    <div style={{
      display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
      padding: '4px 0', borderBottom: '1px dotted var(--border)', fontSize: 13, gap: 12,
    }}>
      <div style={{ minWidth: 0 }}>
        <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{left}</div>
        {sub && <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{sub}</div>}
      </div>
      <div style={{ fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>{right}</div>
    </div>
  )
}
