/**
 * UpcomingBills — chronological card listing the next 60 days of bills
 * pulled from MortgageDetail / CreditCardDetail.
 *
 * Color cues:
 *   - Overdue (days_until < 0): red
 *   - Due in <3 days: red
 *   - Due in <7 days: orange
 *   - Otherwise: muted
 *
 * Each row shows: account · institution · due date · amount.
 * Manual-liability accounts (Apple Card, Nelnet, Hyundai) currently
 * don't appear here — their payment fields aren't structured yet. We'll
 * surface them once we add `next_payment_due_date` to manual_assets.
 */
import { useEffect, useState } from 'react'
import { Calendar, AlertTriangle } from 'lucide-react'
import { getUpcomingBills } from '../api/client'
import { useToast } from './Toast'
import { formatCurrency } from '../lib/format'

// Local-only "marked paid" tracking. We don't have a server-side
// payment ledger for bills (those would normally come from Plaid
// transactions matching the bill amount near the due date), so
// "mark paid" persists to localStorage as a list of dismissed-bill
// keys. Each key is `${kind}-${account_id}-${due_date}` — stable
// across reloads. Shown on UpcomingBills only; restore via Undo toast.
const PAID_BILLS_KEY = 'tuskledger-paid-bills'
function loadPaidBills() {
  try {
    return new Set(JSON.parse(localStorage.getItem(PAID_BILLS_KEY) || '[]'))
  } catch { return new Set() }
}
function savePaidBills(set) {
  try { localStorage.setItem(PAID_BILLS_KEY, JSON.stringify([...set])) } catch {}
}
function billKey(b) {
  return `${b.kind}-${b.account_id}-${b.due_date}`
}

function formatDate(iso) {
  const d = new Date(iso + 'T00:00:00')
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

function urgency(days) {
  if (days < 0) return { color: 'var(--accent-red)', label: 'overdue' }
  if (days === 0) return { color: 'var(--accent-red)', label: 'today' }
  if (days <= 3) return { color: 'var(--accent-red)', label: `${days}d` }
  if (days <= 7) return { color: 'var(--accent-orange)', label: `${days}d` }
  return { color: 'var(--text-muted)', label: `${days}d` }
}

export default function UpcomingBills({ daysAhead = 60 }) {
  const [bills, setBills] = useState([])
  const [loading, setLoading] = useState(true)
  const [paidKeys, setPaidKeys] = useState(loadPaidBills)
  const { toast } = useToast()

  useEffect(() => {
    getUpcomingBills({ days_ahead: daysAhead })
      .then(setBills)
      .catch(() => setBills([]))
      .finally(() => setLoading(false))
  }, [daysAhead])

  const markPaid = (b) => {
    const key = billKey(b)
    const next = new Set(paidKeys)
    next.add(key)
    setPaidKeys(next)
    savePaidBills(next)
    toast({
      kind: 'undo',
      message: `Marked ${b.account_name} as paid`,
      timeout: 5000,
      onUndo: () => {
        const restored = new Set(next)
        restored.delete(key)
        setPaidKeys(restored)
        savePaidBills(restored)
      },
    })
  }

  // Filter out bills marked paid in this UI session (or earlier).
  const visibleBills = bills.filter(b => !paidKeys.has(billKey(b)))

  if (loading) return null

  return (
    <div className="card" style={{ marginBottom: 'var(--space-6)' }}>
      <div className="card-header">
        <span className="card-title" style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          <Calendar size={16} style={{ color: 'var(--text-muted)' }} />
          Upcoming Bills
        </span>
        <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>
          next {daysAhead}d
        </span>
      </div>
      {visibleBills.length === 0 ? (
        <div style={{ color: 'var(--text-muted)', fontSize: 'var(--text-sm)', padding: 'var(--space-4) 0' }}>
          {bills.length === 0
            ? 'No bills with structured due-dates in the next ' + daysAhead + ' days. Bills appear here once Plaid Liabilities returns payment detail for an account.'
            : `All ${bills.length} upcoming bill${bills.length !== 1 ? 's' : ''} marked paid 🎉`}
        </div>
      ) : (
        <table style={{ width: '100%' }}>
          <tbody>
            {visibleBills.map(b => {
              const u = urgency(b.days_until)
              const overdue = b.days_until < 0
              return (
                <tr key={billKey(b)}>
                  <td style={{ width: 56, paddingLeft: 0 }}>
                    <div style={{
                      display: 'flex', flexDirection: 'column', alignItems: 'center',
                      gap: 2, minWidth: 48,
                    }}>
                      <span style={{ fontSize: 'var(--text-2xs)', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.4 }}>
                        {formatDate(b.due_date)}
                      </span>
                      <span style={{
                        fontSize: 'var(--text-xs)', color: u.color,
                        fontWeight: 600,
                        display: 'inline-flex', alignItems: 'center', gap: 2,
                      }}>
                        {overdue && <AlertTriangle size={10} />}
                        {u.label}
                      </span>
                    </div>
                  </td>
                  <td>
                    <div style={{ fontWeight: 500 }}>{b.account_name}</div>
                    <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', marginTop: 2 }}>
                      {b.institution || ''} · {b.kind === 'mortgage' ? 'mortgage payment' : 'credit card statement'}
                    </div>
                  </td>
                  <td style={{ textAlign: 'right' }} className="tabular">
                    <div style={{ fontWeight: 500 }}>{formatCurrency(b.amount)}</div>
                    {b.minimum !== null && b.minimum !== undefined && b.kind === 'credit_card' && b.minimum !== b.amount && (
                      <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', marginTop: 2 }}>
                        min {formatCurrency(b.minimum)}
                      </div>
                    )}
                  </td>
                  <td style={{ width: 80, textAlign: 'right', paddingRight: 0 }}>
                    <button
                      onClick={() => markPaid(b)}
                      title="Mark as paid (5-second undo via toast)"
                      style={{
                        padding: '3px 8px', fontSize: 11,
                        background: 'transparent', color: 'var(--accent-green)',
                        border: '1px solid var(--accent-green-border)',
                        borderRadius: 4, cursor: 'pointer',
                      }}
                    >
                      ✓ Paid
                    </button>
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
