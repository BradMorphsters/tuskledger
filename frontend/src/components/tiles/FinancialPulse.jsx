import { useEffect, useState } from 'react'
import { Activity } from 'lucide-react'
import { getFinancialPulse } from '../../api/client'
import { SkeletonCard } from '../Skeleton'
import { fmtMoney, tileCardStyle } from './shared'

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
  // Defensive: components may be absent if the backend returns a minimal
  // shape (e.g. a 0-transaction fresh install). Guard once here so every
  // access below is safe without per-field optional chaining.
  const components = data.components ?? {
    liquidity: { score: 0, value: 0, label: 'months of runway', weight: 0.3, pure_cash: 0, taxable_brokerage: 0, available_runway: 0 },
    savings:   { score: 0, value: 0, label: 'savings rate %', weight: 0.3, visible_rate_pct: 0, true_rate_pct: 0, monthly_payroll_deferral: 0, uses_true_rate: false },
    debt:      { score: 0, value: 0, label: 'debt-to-assets %', weight: 0.2 },
    budget:    { score: 0, value: 0, label: 'budget adherence %', weight: 0.2 },
  }
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
            {components?.liquidity?.value ?? '—'}mo runway · {components?.savings?.value ?? '—'}% saving
          </span>
        </div>
      </div>
      {/* Runway composition — shown when taxable brokerage is meaningful
          (>0) so the user understands how the runway number is built. */}
      {components.liquidity.taxable_brokerage > 0 && (
        <div style={{
          marginBottom: 14, padding: '6px 10px',
          background: 'var(--bg-elevated)', borderRadius: 6,
          fontSize: 11, color: 'var(--text-secondary)',
        }}>
          Runway = {fmtMoney(components.liquidity.pure_cash)} cash
          + {fmtMoney(components.liquidity.taxable_brokerage)} taxable brokerage
          (penalty-free, 2-day liquid)
        </div>
      )}
      {/* Component bars */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {Object.entries(components).map(([key, c]) => (
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
        {components.savings.uses_true_rate ? (
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
            <span>
              Savings rate: <strong style={{ color: 'var(--text-primary)' }}>
                {components.savings.true_rate_pct}% true
              </strong>
              <span style={{ color: 'var(--text-muted)' }}>
                {' '}({components.savings.visible_rate_pct}% visible
                + ${components.savings.monthly_payroll_deferral}/mo 401k)
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
