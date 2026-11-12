import { ShieldAlert, Ban, Hourglass, RefreshCw, CalendarClock, Info } from 'lucide-react'
import { formatCurrencyZero, formatDate } from '../lib/format'

/**
 * Wash-sale watch — the forward-looking half of wash-sale tracking.
 *
 * The rest of the Trading Tax page reports wash sales after they happen.
 * This card answers the questions a trader has BEFORE acting:
 *   - Don't rebuy: loss sales from the last 30 days, with the first day a
 *     repurchase (in ANY account, retirement included) no longer washes.
 *   - Can't harvest yet: positions at a loss you bought more of in the
 *     last 30 days — selling them at a loss now would wash.
 *   - Not reported yet: trades the broker's positions show but its trade
 *     history hasn't delivered (Plaid often lags a day or more). These are
 *     estimates, with windows counted conservatively from today.
 *   - Year-end: when windows run into January.
 *
 * All data comes from `wash_watch` on GET /investments/trading-tax
 * (services/trading_tax.build_wash_watch); this component only lays it out.
 */

function daysLabel(n) {
  if (n <= 0) return 'clear today'
  return n === 1 ? '1 day left' : `${n} days left`
}

function Row({ left, sub, right, rightSub, tone = 'orange' }) {
  return (
    <div style={{
      display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12,
      padding: '8px 0', borderTop: '1px solid var(--border)',
    }}>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 600 }}>{left}</div>
        {sub && <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>{sub}</div>}
      </div>
      <div style={{ textAlign: 'right', flexShrink: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: `var(--accent-${tone})` }}>{right}</div>
        {rightSub && <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>{rightSub}</div>}
      </div>
    </div>
  )
}

function Group({ icon: Icon, title, hint, children }) {
  return (
    <div style={{ marginTop: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)' }}>
        <Icon size={13} /> {title}
      </div>
      {hint && <div style={{ fontSize: 11, color: 'var(--text-muted)', margin: '2px 0 4px' }}>{hint}</div>}
      {children}
    </div>
  )
}

export default function WashSaleWatch({ watch }) {
  if (!watch) return null
  const rebuy = watch.do_not_rebuy || []
  const blocked = watch.cannot_harvest_yet || []
  const unreported = watch.unreported_trades || []
  const lag = watch.data_lag || []
  const yearEnd = watch.year_end
  const retirement = watch.retirement_accounts || []
  const anything = rebuy.length || blocked.length || unreported.length

  return (
    <div
      data-testid="wash-watch"
      style={{
        background: 'var(--bg-card)', borderRadius: 8, padding: 16,
        border: `1px solid ${anything ? 'var(--accent-orange)' : 'var(--border)'}`,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 14, fontWeight: 600 }}>
        <ShieldAlert size={16} style={{ color: anything ? 'var(--accent-orange)' : 'var(--accent-green)' }} />
        Wash-sale watch
      </div>
      <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>
        {anything
          ? 'What to avoid buying back, and what you can’t sell at a loss yet, under the 30-day rule. It applies across every account you own.'
          : 'Nothing to watch right now: no loss sales or recent buys inside a 30-day window.'}
      </div>

      {lag.length > 0 && (
        <div style={{
          marginTop: 12, padding: '8px 10px', borderRadius: 6, fontSize: 12,
          background: 'var(--accent-yellow-bg)', display: 'flex', gap: 8,
        }}>
          <RefreshCw size={14} style={{ color: 'var(--accent-yellow)', flexShrink: 0, marginTop: 1 }} />
          <span>
            Trade history is behind: {lag.map(l => `${l.account_name} through ${l.trades_through ? formatDate(l.trades_through) : 'no trades yet'}`).join('; ')}.
            {' '}Positions are current, so the trades marked <em>estimated</em> below are inferred from what changed. Windows for those are counted from today to be safe.
          </span>
        </div>
      )}

      {rebuy.length > 0 && (
        <Group icon={Ban} title="Don't buy back" hint="Rebuying before the date moves the loss into the new shares’ cost basis instead of this year’s return.">
          {rebuy.map(r => (
            <Row
              key={r.symbol}
              left={<>{r.symbol}{r.estimated && <span style={{ fontWeight: 400, color: 'var(--text-muted)' }}> · estimated</span>}</>}
              sub={[
                r.accounts.join(', '),
                r.sell_date ? `sold ${formatDate(r.sell_date)}` : r.sold_since ? `sold since ${formatDate(r.sold_since)}` : null,
                `${formatCurrencyZero(r.loss)} loss${r.estimated ? ' (approx.)' : ''}`,
                r.already_washed > 0 ? `${formatCurrencyZero(r.already_washed)} already washed` : null,
              ].filter(Boolean).join(' · ')}
              right={`Safe ${formatDate(r.safe_to_rebuy_on)}`}
              rightSub={`${daysLabel(r.days_left)}${r.crosses_year_end ? ' · rebuy in Jan moves the loss to next year' : ''}`}
            />
          ))}
        </Group>
      )}

      {blocked.length > 0 && (
        <Group icon={Hourglass} title="Can't harvest the loss yet" hint="You bought more recently, so selling at a loss now would wash against that buy.">
          {blocked.map(r => (
            <Row
              key={r.plaid_security_id}
              tone="yellow"
              left={<>{r.symbol}{r.estimated && <span style={{ fontWeight: 400, color: 'var(--text-muted)' }}> · estimated</span>}</>}
              sub={`${r.accounts.join(', ')} · ${formatCurrencyZero(r.unrealized_loss)} unrealized loss · ${r.last_buy_date ? `bought ${formatDate(r.last_buy_date)} in ${r.bought_in}` : `recent buy in ${r.bought_in}, not reported yet`}`}
              right={`OK ${formatDate(r.harvest_ok_on)}`}
              rightSub={daysLabel(r.days_left)}
            />
          ))}
        </Group>
      )}

      {unreported.length > 0 && (
        <Group icon={RefreshCw} title="Trades not reported yet" hint="Inferred from your broker’s current positions. They’ll be replaced by the real trades once they sync.">
          {unreported.map(u => (
            <Row
              key={`${u.kind}-${u.account_id}-${u.plaid_security_id}`}
              tone={u.kind === 'sell' ? ((u.estimated_gain_loss ?? 0) < 0 ? 'red' : 'green') : 'blue'}
              left={`${u.kind === 'sell' ? 'Sold' : u.kind === 'buy' ? 'Bought' : 'Moved in'} ${u.symbol}`}
              sub={`${u.account_name} · ${+u.quantity.toFixed(4)} sh${u.transfer_from ? ` from ${u.transfer_from}` : ''}${u.since ? ` · since ${formatDate(u.since)}` : ''}`}
              right={u.kind === 'sell'
                ? (u.estimated_gain_loss != null ? `${u.estimated_gain_loss < 0 ? '−' : '+'}${formatCurrencyZero(Math.abs(u.estimated_gain_loss))}` : formatCurrencyZero(u.estimated_proceeds))
                : formatCurrencyZero(u.estimated_value)}
              rightSub={u.kind === 'sell' ? `≈${formatCurrencyZero(u.estimated_proceeds)} proceeds${u.term ? ` · ${u.term === 'LT' ? 'long' : 'short'}-term` : ''}` : u.kind === 'transfer_in' ? 'transfer, not a purchase' : 'counts as a buy for wash sales'}
            />
          ))}
        </Group>
      )}

      {yearEnd && (
        <div style={{ marginTop: 12, display: 'flex', gap: 8, fontSize: 12, color: 'var(--text-secondary)' }}>
          <CalendarClock size={14} style={{ flexShrink: 0, marginTop: 1 }} />
          <span>
            Year-end: a loss counts for {yearEnd.year} if sold by Dec 31 and not bought back within 30 days.
            Sell by {formatDate(yearEnd.rebuy_inside_year_if_sold_by)} if you want to buy back before New Year;
            later loss sales bought back in early January move the loss to {yearEnd.year + 1} or later.
          </span>
        </div>
      )}

      <div style={{ marginTop: 12, display: 'flex', gap: 8, fontSize: 11, color: 'var(--text-muted)' }}>
        <Info size={13} style={{ flexShrink: 0, marginTop: 1 }} />
        <span>
          Matches the same security only; a “substantially identical” fund (e.g. two S&amp;P 500 funds) can also wash.
          {retirement.length > 0 && <> Buys in {retirement.join(', ')} count too, and there the loss is lost for good.</>}
          {' '}Not tax advice.
        </span>
      </div>
    </div>
  )
}
