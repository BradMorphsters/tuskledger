/**
 * CapitalLossTracker — surfaces capital-loss carryover balance from
 * prior tax years, contextualizes against current unrealized gains,
 * and explains the runway.
 *
 * Capital losses in excess of the $3k/year ordinary-income offset cap
 * carry forward indefinitely on Schedule D. Households with a multi-
 * year carryover often forget it exists, which changes the math on
 * tax-loss harvesting (you don't need more losses; you need realized
 * gains to soak up the carryover). This tile keeps the balance front
 * and center.
 *
 * Storage: per-tax-year carryover balances in localStorage. Updated
 * once per year after filing (the new carryovers come straight off
 * the tax return's Capital Loss Carryover Worksheet).
 */
import { useState } from 'react'
import { TrendingDown, Settings } from 'lucide-react'
import { useStoredState } from '../lib/storage'
import { formatCurrencyZero as fmt } from '../lib/format'

const STORAGE_KEY = 'tuskledger.capitalLossCarryover.v1'
// Annual deduction cap against ordinary income — IRS rule, not
// inflation-adjusted historically. MFJ + Single both $3000; MFS $1500.
const ANNUAL_ORDINARY_OFFSET_CAP = 3000

export default function CapitalLossTracker({ unrealizedGain }) {
  const [config, setConfig] = useStoredState(STORAGE_KEY, {
    short_term: 0,
    long_term: 0,
    tax_year: new Date().getFullYear(),
  })
  const [editing, setEditing] = useState(false)

  const totalCarryover = (Number(config.short_term) || 0) + (Number(config.long_term) || 0)

  // Hide entirely when nothing is configured AND no unrealized gain to
  // contextualize. Avoids cluttering the page with a zero-state tile
  // that has nothing to say.
  if (totalCarryover === 0 && !unrealizedGain) return null

  // Years of $3k auto-deduction runway. The cap eats from ST first,
  // then LT, but the runway calc just divides total by cap (the
  // ordering doesn't change runway length, only the sequence).
  const runwayYears = totalCarryover > 0
    ? Math.ceil(totalCarryover / ANNUAL_ORDINARY_OFFSET_CAP)
    : 0

  // What gains (if any) could be sheltered by the carryover. ST losses
  // offset ST gains first; LT losses offset LT gains first; remainder
  // crosses over. For the user-facing message we just show "up to
  // $totalCarryover of realized gains can be offset" — accurate at the
  // aggregate level even if the tier-by-tier sequencing is more nuanced.
  const couldShelter = totalCarryover

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div className="card-header">
        <span className="card-title" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <TrendingDown size={14} style={{ color: 'var(--accent-yellow)' }} />
          Capital loss carryover
        </span>
        <button
          onClick={() => setEditing(o => !o)}
          title="Edit carryover balances"
          style={{
            background: 'none', border: 'none', cursor: 'pointer',
            color: 'var(--text-muted)', padding: 2,
          }}
        >
          <Settings size={14} />
        </button>
      </div>

      {totalCarryover > 0 ? (
        <>
          {/* Hero rollup — the headline insight */}
          <div style={{
            padding: '10px 12px',
            background: 'rgba(251,191,36,0.08)',
            border: '1px solid rgba(251,191,36,0.25)',
            borderRadius: 6, marginBottom: 12,
          }}>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.4 }}>
              Pre-paid loss credit available
            </div>
            <div style={{
              fontSize: 22, fontWeight: 700, color: 'var(--accent-yellow)',
              fontVariantNumeric: 'tabular-nums', marginTop: 2,
            }}>
              {fmt(totalCarryover)}
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 4, lineHeight: 1.5 }}>
              Realize gains freely up to <strong>{fmt(couldShelter)}</strong> — they'll be
              offset by these losses before any tax is owed. If unused against gains,
              <strong> {fmt(ANNUAL_ORDINARY_OFFSET_CAP)}/year</strong> auto-deducts
              from ordinary income (~{runwayYears} year runway).
            </div>
          </div>

          {/* ST / LT breakdown — small grid */}
          <div style={{
            display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12,
            fontSize: 12,
          }}>
            <CarryoverPill
              label="Short-term losses"
              amount={Number(config.short_term) || 0}
              hint="Offset ST gains first; tax-rate ≤ ordinary income"
            />
            <CarryoverPill
              label="Long-term losses"
              amount={Number(config.long_term) || 0}
              hint="Offset LT gains first; LTCG rates 0/15/20%"
            />
          </div>

          {/* Contextualize against current unrealized gain when present.
              "You have $X unrealized — selling realizes that gain but
              the carryover absorbs it." Powerful prompt for harvesting
              gains (the opposite of harvesting losses). */}
          {unrealizedGain > 0 && (
            <div style={{
              marginTop: 12, padding: '8px 12px',
              background: 'rgba(52,211,153,0.06)',
              border: '1px solid rgba(52,211,153,0.2)',
              borderRadius: 6, fontSize: 12, color: 'var(--text-secondary)',
            }}>
              You have <strong style={{ color: 'var(--accent-green)' }}>{fmt(unrealizedGain)}</strong>
              {' '}of unrealized portfolio gains. {unrealizedGain <= totalCarryover
                ? 'Realizing all of them would be fully sheltered by the carryover — zero capital gains tax owed.'
                : `${fmt(totalCarryover)} would be sheltered; ${fmt(unrealizedGain - totalCarryover)} would be taxed at LTCG rates.`}
            </div>
          )}
        </>
      ) : (
        <div style={{
          padding: '12px', fontSize: 12, color: 'var(--text-muted)',
          textAlign: 'center',
        }}>
          No capital loss carryover configured. Edit ⚙ to enter balances from your last tax return.
        </div>
      )}

      {/* Inline editor */}
      {editing && (
        <div style={{
          marginTop: 12, padding: 12,
          background: 'rgba(255,255,255,0.03)',
          border: '1px solid var(--border)',
          borderRadius: 6,
        }}>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 8 }}>
            From your last tax return's <em>Capital Loss Carryover Worksheet</em>
            {' '}(Schedule D instructions). Update once per year after filing.
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
            <CarryoverField label="Tax year">
              <input
                type="number"
                value={config.tax_year}
                onChange={e => setConfig({ ...config, tax_year: Number(e.target.value) || 0 })}
                style={inputStyle}
              />
            </CarryoverField>
            <CarryoverField label="Short-term carryover">
              <input
                type="number"
                value={config.short_term}
                onChange={e => setConfig({ ...config, short_term: Number(e.target.value) || 0 })}
                placeholder="0"
                style={inputStyle}
              />
            </CarryoverField>
            <CarryoverField label="Long-term carryover">
              <input
                type="number"
                value={config.long_term}
                onChange={e => setConfig({ ...config, long_term: Number(e.target.value) || 0 })}
                placeholder="0"
                style={inputStyle}
              />
            </CarryoverField>
          </div>
          <button
            onClick={() => setEditing(false)}
            style={{
              marginTop: 8, padding: '4px 12px', fontSize: 12,
              background: 'var(--accent-blue)', color: '#0d0e14',
              border: 'none', borderRadius: 4, cursor: 'pointer',
            }}
          >
            Done
          </button>
        </div>
      )}
    </div>
  )
}

function CarryoverPill({ label, amount, hint }) {
  return (
    <div style={{
      padding: '8px 10px',
      background: 'rgba(255,255,255,0.03)',
      border: '1px solid var(--border)',
      borderRadius: 4,
    }}>
      <div style={{
        fontSize: 10, color: 'var(--text-muted)',
        textTransform: 'uppercase', letterSpacing: 0.4,
      }}>
        {label}
      </div>
      <div style={{
        fontSize: 16, fontWeight: 600, color: 'var(--text-primary)',
        fontVariantNumeric: 'tabular-nums', marginTop: 2,
      }}>
        {fmt(amount)}
      </div>
      <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}>
        {hint}
      </div>
    </div>
  )
}

function CarryoverField({ label, children }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 2, fontSize: 11 }}>
      <span style={{
        fontSize: 10, color: 'var(--text-muted)',
        textTransform: 'uppercase', letterSpacing: 0.4,
      }}>{label}</span>
      {children}
    </label>
  )
}

const inputStyle = {
  width: '100%', padding: '5px 8px', fontSize: 12,
  border: '1px solid var(--border)', borderRadius: 3,
  background: 'var(--bg-input)', color: 'var(--text-primary)',
  fontFamily: 'inherit', boxSizing: 'border-box',
}
