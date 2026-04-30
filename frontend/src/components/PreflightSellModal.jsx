/**
 * Pre-flight sell modal — "if I sold this today, what's the tax /
 * wash-sale impact?"
 *
 * Triggered from the LtCountdownCard or any open-position row. Lets
 * the user pick a quantity and (optionally) override the price, then
 * surfaces the wash-sale risk + tax delta + recommendation tier
 * BEFORE they place the trade in their broker.
 *
 * The heavy lifting lives in the backend (services/trading_tax.py
 * `simulate_hypothetical_sell`) — this component is a thin form +
 * result viewer.
 */
import { useEffect, useState } from 'react'
import { AlertTriangle, CheckCircle, AlertCircle, X, Loader2 } from 'lucide-react'
import { preflightSell } from '../api/client'
import { formatCurrency, formatCurrencyZero, formatDate } from '../lib/format'

// Pure helpers — exported for unit tests.

export function recommendationStyle(rec) {
  // Three tiers map to three accent colors. Used for the result panel
  // background + the icon. Centralized so the visual language stays
  // consistent between the result panel and any future surfaces
  // (e.g. inline warnings on the open-position table).
  if (rec === 'avoid') {
    return {
      icon: AlertTriangle,
      accent: 'red',
      label: 'Avoid this sell',
    }
  }
  if (rec === 'caution') {
    return {
      icon: AlertCircle,
      accent: 'orange',
      label: 'Proceed with caution',
    }
  }
  return {
    icon: CheckCircle,
    accent: 'green',
    label: 'Safe to sell',
  }
}

export default function PreflightSellModal({ position, currentPrice, onClose }) {
  // `position` is the open-position record we're pre-flighting.
  //   { symbol, plaid_security_id, quantity, cost_basis, ... }
  // `currentPrice` is today's market price (from the holdings join).
  const [quantity, setQuantity] = useState(position?.quantity || 0)
  const [price, setPrice] = useState(currentPrice || 0)
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  useEffect(() => {
    if (!position || !quantity || !price || !position.plaid_security_id) {
      setData(null)
      return
    }
    setLoading(true)
    setError(null)
    const t = setTimeout(() => {
      preflightSell({
        plaid_security_id: position.plaid_security_id,
        quantity: Number(quantity),
        price: Number(price),
      })
        .then(setData)
        .catch(e => setError(e.message || 'Pre-flight failed'))
        .finally(() => setLoading(false))
    }, 250)
    return () => clearTimeout(t)
  }, [position, quantity, price])

  if (!position) return null

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 100,
        background: 'rgba(0, 0, 0, 0.55)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 20,
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          background: 'var(--bg-card)',
          border: '1px solid var(--border-color, rgba(255,255,255,0.08))',
          borderRadius: 10,
          width: '100%', maxWidth: 560,
          maxHeight: '90vh', overflowY: 'auto',
          boxShadow: '0 20px 60px rgba(0,0,0,0.5)',
        }}
      >
        <div style={{
          padding: '14px 18px',
          borderBottom: '1px solid var(--border-color, rgba(255,255,255,0.08))',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        }}>
          <div>
            <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>
              Pre-flight sell: {position.symbol}
            </h2>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
              Simulates the trade against your YTD activity — wash sales, ST/LT split, tax impact.
            </div>
          </div>
          <button
            onClick={onClose}
            style={{
              background: 'transparent', border: 'none',
              cursor: 'pointer', color: 'var(--text-muted)',
              padding: 4,
            }}
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </div>

        <div style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 14 }}>
          {/* Position context */}
          <div style={{
            padding: 12,
            background: 'var(--bg-input)',
            borderRadius: 6, fontSize: 12, color: 'var(--text-secondary)',
          }}>
            <div><strong>{position.symbol}</strong> · {position.quantity.toLocaleString(undefined, { maximumFractionDigits: 4 })} shares</div>
            <div style={{ marginTop: 4 }}>
              Cost basis {formatCurrency(position.cost_basis)}
              {position.earliest_buy_date && (
                <> · earliest buy {formatDate(position.earliest_buy_date)}</>
              )}
            </div>
            {position.days_until_lt !== undefined && (
              <div style={{ marginTop: 4 }}>
                {position.is_long_term
                  ? <span style={{ color: 'var(--accent-green)' }}>Already long-term</span>
                  : <span>Days until LT: <strong>{position.days_until_lt}</strong></span>}
              </div>
            )}
          </div>

          {/* Inputs */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <label style={{ fontSize: 12, color: 'var(--text-muted)' }}>
              Shares to sell
              <input type="number" min={0.0001} max={position.quantity} step={0.0001}
                value={quantity}
                onChange={e => setQuantity(Number(e.target.value))}
                style={inputStyle}
              />
            </label>
            <label style={{ fontSize: 12, color: 'var(--text-muted)' }}>
              Sell price (per share)
              <input type="number" min={0.01} step={0.01}
                value={price}
                onChange={e => setPrice(Number(e.target.value))}
                style={inputStyle}
              />
            </label>
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: -8 }}>
            Total proceeds: <strong style={{ color: 'var(--text-primary)' }}>
              {formatCurrency(quantity * price)}
            </strong> · vs basis {formatCurrency((position.cost_basis / position.quantity) * quantity)}
          </div>

          {/* Result */}
          {loading && !data && (
            <div style={{
              padding: 12, color: 'var(--text-muted)', fontSize: 12,
              display: 'flex', alignItems: 'center', gap: 8,
            }}>
              <Loader2 size={12} style={{ animation: 'spin 1s linear infinite' }} />
              Running simulation…
            </div>
          )}
          {error && (
            <div style={{
              padding: 10, background: 'var(--accent-orange-bg)',
              border: '1px solid var(--accent-orange-border)',
              borderRadius: 6, fontSize: 12, color: 'var(--accent-orange)',
            }}>
              {error}
            </div>
          )}
          {data && <PreflightResult data={data} />}
        </div>

        <div style={{
          padding: '12px 18px',
          borderTop: '1px solid var(--border-color, rgba(255,255,255,0.08))',
          fontSize: 11, color: 'var(--text-muted)',
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        }}>
          <span>This is a simulation. To execute, place the trade in your broker.</span>
          <button onClick={onClose} className="btn">Close</button>
        </div>
      </div>
    </div>
  )
}


function PreflightResult({ data }) {
  const style = recommendationStyle(data.recommendation)
  const Icon = style.icon
  const accent = `var(--accent-${style.accent})`
  const accentBg = `var(--accent-${style.accent}-bg)`
  const accentBorder = `var(--accent-${style.accent}-border)`

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/* Recommendation banner */}
      <div style={{
        padding: '12px 14px',
        background: accentBg,
        border: `1px solid ${accentBorder}`,
        borderLeft: `3px solid ${accent}`,
        borderRadius: 6,
        display: 'flex', alignItems: 'flex-start', gap: 10,
      }}>
        <Icon size={18} style={{ color: accent, flexShrink: 0, marginTop: 1 }} />
        <div>
          <div style={{ fontWeight: 700, color: accent, marginBottom: 4, fontSize: 13 }}>
            {style.label}
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-primary)', lineHeight: 1.45 }}>
            {data.recommendation_note}
          </div>
        </div>
      </div>

      {/* Wash sale callout (only when triggered) */}
      {data.wash_sale_warning && (
        <div style={{
          padding: 10, fontSize: 12,
          background: 'var(--accent-orange-bg)',
          border: '1px solid var(--accent-orange-border)',
          borderRadius: 6, color: 'var(--text-primary)', lineHeight: 1.45,
        }}>
          <strong style={{ color: 'var(--accent-orange)' }}>Wash sale: </strong>
          {data.wash_sale_warning}
        </div>
      )}

      {/* Numerical impact */}
      <div style={{
        display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 10,
      }}>
        <DeltaTile
          label="ST gain/loss added"
          value={data.delta.st_added}
          accent={data.delta.st_added > 0 ? 'orange' : 'green'}
        />
        <DeltaTile
          label="LT gain/loss added"
          value={data.delta.lt_added}
          accent={data.delta.lt_added > 0 ? 'green' : 'green'}
        />
        <DeltaTile
          label="Wash-sale disallowed"
          value={data.delta.wash_sale_added}
          accent={data.delta.wash_sale_added > 0 ? 'red' : 'muted'}
          hideSign
        />
        <DeltaTile
          label="Estimated tax added"
          value={data.delta.tax_added}
          accent={data.delta.tax_added > 0 ? 'orange' : 'green'}
        />
      </div>

      {/* Match breakdown */}
      {data.matches && data.matches.length > 0 && (
        <div>
          <div style={{
            fontSize: 11, fontWeight: 600, letterSpacing: 0.4,
            textTransform: 'uppercase', color: 'var(--text-muted)',
            marginBottom: 6,
          }}>
            Lots that would be consumed
          </div>
          <div style={{
            border: '1px solid var(--border-color, rgba(255,255,255,0.06))',
            borderRadius: 6, overflow: 'hidden',
          }}>
            <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
              <thead style={{ background: 'var(--bg-input)' }}>
                <tr>
                  <th style={thStyle}>Bought</th>
                  <th style={thStyle}>Held</th>
                  <th style={thStyle}>Term</th>
                  <th style={{ ...thStyle, textAlign: 'right' }}>Qty</th>
                  <th style={{ ...thStyle, textAlign: 'right' }}>Gain/loss</th>
                </tr>
              </thead>
              <tbody>
                {data.matches.map((m, i) => (
                  <tr key={i} style={{ borderTop: '1px solid var(--border-color, rgba(255,255,255,0.04))' }}>
                    <td style={tdStyle}>{formatDate(m.buy_date)}</td>
                    <td style={tdStyle}>{m.holding_period_days}d</td>
                    <td style={tdStyle}>
                      <span style={{
                        fontSize: 10, padding: '1px 6px', borderRadius: 3,
                        background: m.term === 'LT' ? 'var(--accent-green-bg)' : 'var(--accent-orange-bg)',
                        color: m.term === 'LT' ? 'var(--accent-green)' : 'var(--accent-orange)',
                        fontWeight: 600, letterSpacing: 0.4,
                      }}>{m.term}</span>
                    </td>
                    <td style={{ ...tdStyle, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                      {m.quantity.toLocaleString(undefined, { maximumFractionDigits: 4 })}
                    </td>
                    <td style={{
                      ...tdStyle, textAlign: 'right', fontVariantNumeric: 'tabular-nums',
                      color: m.gain_loss >= 0 ? 'var(--accent-green)' : 'var(--accent-red)',
                      fontWeight: 500,
                    }}>
                      {formatCurrency(m.gain_loss)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}


function DeltaTile({ label, value, accent = 'blue', hideSign = false }) {
  const color = accent === 'muted'
    ? 'var(--text-secondary)'
    : `var(--accent-${accent})`
  return (
    <div style={{
      padding: 10,
      background: 'var(--bg-input)',
      border: '1px solid var(--border-color, rgba(255,255,255,0.04))',
      borderRadius: 6,
    }}>
      <div style={{
        fontSize: 10, fontWeight: 600, letterSpacing: 0.4,
        textTransform: 'uppercase', color: 'var(--text-muted)',
      }}>
        {label}
      </div>
      <div style={{
        fontSize: 16, fontWeight: 700, color, marginTop: 2,
        fontVariantNumeric: 'tabular-nums',
      }}>
        {hideSign || value === 0
          ? formatCurrencyZero(Math.abs(value))
          : (value > 0 ? '+' : '') + formatCurrencyZero(value)}
      </div>
    </div>
  )
}


const inputStyle = {
  display: 'block', marginTop: 4, width: '100%',
  padding: '6px 8px', fontSize: 13,
  background: 'var(--bg-input)',
  border: '1px solid var(--border-color, rgba(255,255,255,0.1))',
  borderRadius: 4, color: 'var(--text-primary)',
  boxSizing: 'border-box',
}

const thStyle = {
  padding: '6px 8px', fontSize: 10,
  textAlign: 'left', fontWeight: 600,
  letterSpacing: 0.4, textTransform: 'uppercase',
  color: 'var(--text-muted)',
}

const tdStyle = {
  padding: '6px 8px', color: 'var(--text-primary)',
}
