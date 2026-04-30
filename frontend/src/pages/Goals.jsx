import { useState, useEffect } from 'react'
import { Plus, Trash2, Trophy, Target, Plane, Home as HomeIcon, ShieldCheck, Briefcase, Activity } from 'lucide-react'
import { getGoals, createGoal, updateGoal, deleteGoal, getAccounts } from '../api/client'
import { formatCurrencyZero as formatCurrency } from '../lib/format'

const INPUT_STYLE = {
  width: '100%',
  background: 'var(--bg-input, var(--bg-primary))',
  color: 'var(--text-primary)',
  border: '1px solid var(--border)',
  borderRadius: 6,
  padding: '8px 10px',
  fontSize: 13,
  fontFamily: 'inherit',
  boxSizing: 'border-box',
}

const GOAL_TYPES = [
  { id: 'emergency_fund', label: 'Emergency fund', icon: ShieldCheck, color: 'var(--accent-green)' },
  { id: 'down_payment', label: 'Down payment', icon: HomeIcon, color: 'var(--accent-blue)' },
  { id: 'vacation', label: 'Vacation', icon: Plane, color: 'var(--accent-orange)' },
  { id: 'retirement', label: 'Retirement', icon: Target, color: 'var(--accent-purple)' },
  { id: 'business', label: 'Business', icon: Briefcase, color: 'var(--accent-yellow)' },
  { id: 'custom', label: 'Custom', icon: Trophy, color: 'var(--text-secondary)' },
]

function goalTypeMeta(id) {
  return GOAL_TYPES.find(t => t.id === id) || GOAL_TYPES[GOAL_TYPES.length - 1]
}

function GoalCard({ goal, onEdit, onDelete }) {
  const meta = goalTypeMeta(goal.goal_type)
  const Icon = meta.icon
  const pct = Math.min(goal.progress_pct || 0, 100)
  const remaining = Math.max(goal.target_amount - goal.current_amount, 0)
  const reached = goal.current_amount >= goal.target_amount

  return (
    <div className="card" style={{ position: 'relative' }}>
      <div style={{
        position: 'absolute', top: 0, left: 0, right: 0, height: 3,
        background: meta.color, borderRadius: '8px 8px 0 0',
      }} />
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, marginBottom: 12 }}>
        <div style={{
          width: 38, height: 38, borderRadius: 8,
          background: meta.color + '20',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: meta.color,
          flexShrink: 0,
        }}>
          <Icon size={18} />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 600, fontSize: 15 }}>{goal.name}</div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.4 }}>
            {meta.label}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 4 }}>
          <button onClick={onEdit} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', padding: 6 }} title="Edit">
            <Activity size={14} />
          </button>
          <button onClick={onDelete} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--accent-red)', padding: 6 }} title="Delete">
            <Trash2 size={14} />
          </button>
        </div>
      </div>

      {/* Progress bar */}
      <div style={{ height: 10, background: 'var(--bg-hover)', borderRadius: 5, overflow: 'hidden', marginBottom: 8 }}>
        <div style={{
          width: `${pct}%`, height: '100%',
          background: reached ? 'var(--accent-green)' : meta.color,
          transition: 'width 0.4s',
        }} />
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 12 }}>
        <span style={{ fontWeight: 600 }}>
          {formatCurrency(goal.current_amount)}{' '}
          <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>of {formatCurrency(goal.target_amount)}</span>
        </span>
        <span style={{ color: reached ? 'var(--accent-green)' : 'var(--text-secondary)', fontWeight: 600 }}>
          {reached ? '🎉 Reached' : `${pct.toFixed(1)}%`}
        </span>
      </div>

      {/* Footer info */}
      <div style={{ fontSize: 12, color: 'var(--text-muted)', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
        <div>
          <div style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.4 }}>Remaining</div>
          <div style={{ color: 'var(--text-primary)', fontSize: 13, fontWeight: 500 }}>
            {reached ? '—' : formatCurrency(remaining)}
          </div>
        </div>
        {goal.target_date && (
          <div>
            <div style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.4 }}>Target date</div>
            <div style={{ color: 'var(--text-primary)', fontSize: 13, fontWeight: 500 }}>{goal.target_date}</div>
          </div>
        )}
        {goal.pace_per_month !== null && goal.pace_per_month !== undefined && (
          <div>
            <div style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.4 }}>Pace / mo</div>
            <div style={{
              fontSize: 13, fontWeight: 500,
              color: goal.pace_per_month >= 0 ? 'var(--accent-green)' : 'var(--accent-red)',
            }}>
              {goal.pace_per_month >= 0 ? '+' : ''}{formatCurrency(goal.pace_per_month)}
            </div>
          </div>
        )}
        {goal.projected_date && !reached && (
          <div>
            <div style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.4 }}>Projected reach</div>
            <div style={{
              fontSize: 13, fontWeight: 500,
              color: goal.on_track === false ? 'var(--accent-red)' : 'var(--accent-green)',
            }}>
              {goal.projected_date}
              {goal.on_track === true && ' ✓'}
              {goal.on_track === false && ' ⚠'}
            </div>
          </div>
        )}
      </div>

      {/* Required-pace recommendation: how much per month is needed to
          hit the target by the user's chosen date? Compares to current
          pace so the user immediately sees the gap (or surplus). Only
          renders when both target_date and a remaining amount exist. */}
      {!reached && goal.target_date && (() => {
        const today = new Date()
        const target = new Date(goal.target_date + 'T12:00:00')
        const monthsLeft = Math.max(
          (target.getFullYear() - today.getFullYear()) * 12
          + (target.getMonth() - today.getMonth())
          + (target.getDate() >= today.getDate() ? 0 : -1),
          0
        )
        if (monthsLeft <= 0) return null
        const required = remaining / monthsLeft
        const pace = goal.pace_per_month || 0
        const gap = required - pace
        const onPace = pace >= required && pace > 0
        return (
          <div style={{
            marginTop: 12, padding: '10px 12px',
            background: onPace
              ? 'rgba(52,211,153,0.08)'
              : 'rgba(251,191,36,0.08)',
            border: `1px solid ${onPace ? 'rgba(52,211,153,0.3)' : 'rgba(251,191,36,0.3)'}`,
            borderRadius: 6, fontSize: 12,
          }}>
            <div style={{
              fontSize: 10, color: 'var(--text-muted)',
              textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 4,
            }}>
              Required to hit by {goal.target_date}
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
              <span style={{
                fontSize: 16, fontWeight: 600,
                color: onPace ? 'var(--accent-green)' : 'var(--accent-yellow)',
                fontVariantNumeric: 'tabular-nums',
              }}>
                {formatCurrency(required)}<span style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 400 }}>/mo</span>
              </span>
              <span style={{ color: 'var(--text-secondary)', fontSize: 11 }}>
                {monthsLeft} month{monthsLeft === 1 ? '' : 's'} left
              </span>
            </div>
            {!onPace && pace > 0 && (
              <div style={{ marginTop: 4, color: 'var(--text-secondary)' }}>
                Current pace falls short by{' '}
                <strong style={{ color: 'var(--accent-yellow)' }}>{formatCurrency(gap)}/mo</strong>
              </div>
            )}
            {onPace && (
              <div style={{ marginTop: 4, color: 'var(--text-secondary)' }}>
                You're on pace — saving{' '}
                <strong style={{ color: 'var(--accent-green)' }}>{formatCurrency(pace - required)}/mo</strong>
                {' '}more than needed
              </div>
            )}
            {pace <= 0 && (
              <div style={{ marginTop: 4, color: 'var(--text-secondary)' }}>
                No saving pace detected in last 90 days.
              </div>
            )}
          </div>
        )
      })()}

      {goal.notes && (
        <div style={{ marginTop: 10, fontSize: 12, color: 'var(--text-secondary)', borderTop: '1px solid var(--border)', paddingTop: 8 }}>
          {goal.notes}
        </div>
      )}
    </div>
  )
}

function GoalEditModal({ mode, goal, accounts, onSave, onCancel }) {
  const [form, setForm] = useState(() => ({
    name: goal?.name || '',
    target_amount: goal?.target_amount?.toString() || '',
    target_date: goal?.target_date || '',
    goal_type: goal?.goal_type || 'custom',
    notes: goal?.notes || '',
    source_account_ids: goal?.source_account_ids || [],
    manual_current_amount: goal?.manual_current_amount?.toString() || '',
  }))
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))
  const toggleAccount = (id) => {
    setForm(f => ({
      ...f,
      source_account_ids: f.source_account_ids.includes(id)
        ? f.source_account_ids.filter(x => x !== id)
        : [...f.source_account_ids, id],
    }))
  }

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
    }} onClick={onCancel}>
      <div onClick={e => e.stopPropagation()} className="card" style={{
        width: 'min(560px, 92vw)', maxHeight: '88vh', overflow: 'auto', padding: 24,
      }}>
        <h3 style={{ margin: '0 0 16px' }}>{mode === 'new' ? 'New goal' : 'Edit goal'}</h3>

        <Field label="Name">
          <input style={INPUT_STYLE} value={form.name} onChange={e => set('name', e.target.value)} placeholder="e.g. Emergency fund" />
        </Field>

        <Field label="Type">
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {GOAL_TYPES.map(t => {
              const Icon = t.icon
              const active = form.goal_type === t.id
              return (
                <button key={t.id} type="button" onClick={() => set('goal_type', t.id)}
                  style={{
                    display: 'inline-flex', alignItems: 'center', gap: 6,
                    padding: '6px 12px', fontSize: 12, fontWeight: 500,
                    background: active ? t.color + '25' : 'transparent',
                    color: active ? t.color : 'var(--text-secondary)',
                    border: `1px solid ${active ? t.color : 'var(--border)'}`,
                    borderRadius: 6, cursor: 'pointer',
                  }}>
                  <Icon size={12} /> {t.label}
                </button>
              )
            })}
          </div>
        </Field>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <Field label="Target amount ($)">
            <input style={INPUT_STYLE} type="number" min="0" step="1" value={form.target_amount} onChange={e => set('target_amount', e.target.value)} placeholder="10000" />
          </Field>
          <Field label="Target date (optional)">
            <input style={INPUT_STYLE} type="date" value={form.target_date} onChange={e => set('target_date', e.target.value)} />
          </Field>
        </div>

        <Field label="Source accounts (sum of balances counts toward goal)">
          <div style={{
            maxHeight: 140, overflowY: 'auto',
            border: '1px solid var(--border)', borderRadius: 6, padding: 8,
          }}>
            {accounts.length === 0 ? (
              <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>No accounts found.</div>
            ) : accounts.map(a => (
              <label key={a.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0', cursor: 'pointer', fontSize: 13 }}>
                <input type="checkbox"
                  checked={form.source_account_ids.includes(a.id)}
                  onChange={() => toggleAccount(a.id)} />
                <span style={{ flex: 1 }}>{a.custom_name || a.name}</span>
                <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>
                  {formatCurrency(a.current_balance || 0)}
                </span>
              </label>
            ))}
          </div>
        </Field>

        <Field label="Manual current amount (overrides source-account sum)">
          <input style={INPUT_STYLE} type="number" min="0" step="0.01" value={form.manual_current_amount} onChange={e => set('manual_current_amount', e.target.value)} placeholder="leave blank for auto" />
        </Field>

        <Field label="Notes (optional)">
          <textarea style={INPUT_STYLE} rows={2} value={form.notes} onChange={e => set('notes', e.target.value)} />
        </Field>

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
          <button className="btn btn-secondary" onClick={onCancel}>Cancel</button>
          <button className="btn btn-primary"
            disabled={!form.name || !form.target_amount}
            onClick={() => onSave(form)}>
            {mode === 'new' ? 'Create goal' : 'Save changes'}
          </button>
        </div>
      </div>
    </div>
  )
}

function Field({ label, children }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 4 }}>
        {label}
      </div>
      {children}
    </div>
  )
}

export default function Goals() {
  const [goals, setGoals] = useState(null)
  const [accounts, setAccounts] = useState([])
  const [editing, setEditing] = useState(null)  // null | 'new' | <goalId>

  const reload = () => {
    getGoals().then(setGoals).catch(() => setGoals([]))
  }
  useEffect(() => {
    reload()
    getAccounts().then(setAccounts).catch(() => setAccounts([]))
  }, [])

  const handleSave = async (form) => {
    const payload = {
      name: form.name,
      target_amount: parseFloat(form.target_amount),
      target_date: form.target_date || null,
      goal_type: form.goal_type,
      notes: form.notes || null,
      source_account_ids: form.source_account_ids,
      manual_current_amount: form.manual_current_amount === '' ? null : parseFloat(form.manual_current_amount),
    }
    if (editing === 'new') await createGoal(payload)
    else await updateGoal(editing, payload)
    setEditing(null)
    reload()
  }

  const handleDelete = async (id) => {
    if (!confirm('Delete this goal? This only removes the target — your accounts are untouched.')) return
    await deleteGoal(id)
    reload()
  }

  if (goals === null) return <p style={{ color: 'var(--text-muted)', padding: 40, textAlign: 'center' }}>Loading…</p>

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">Goals</h1>
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <p style={{ color: 'var(--text-secondary)', fontSize: 14, margin: 0, maxWidth: 600 }}>
          Track progress toward a target. Pick which accounts contribute and Tusk Ledger
          summarizes balance, pace, and projected reach date based on your last 90 days
          of net-worth snapshots.
        </p>
        <button className="btn btn-primary" onClick={() => setEditing('new')}>
          <Plus size={14} /> New goal
        </button>
      </div>

      {goals.length === 0 ? (
        <div className="card" style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)' }}>
          <Trophy size={28} style={{ marginBottom: 12, color: 'var(--accent-orange)' }} />
          <h3 style={{ color: 'var(--text-primary)', margin: '0 0 6px' }}>No goals yet</h3>
          <p style={{ fontSize: 13, maxWidth: 440, margin: '0 auto' }}>
            Common starters: a 3-month emergency fund, a vacation pot, a down-payment target.
            Click "New goal" to add your first one.
          </p>
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(360px, 1fr))', gap: 16 }}>
          {goals.map(g => <GoalCard key={g.id} goal={g} onEdit={() => setEditing(g.id)} onDelete={() => handleDelete(g.id)} />)}
        </div>
      )}

      {editing && (
        <GoalEditModal
          mode={editing === 'new' ? 'new' : 'edit'}
          goal={editing === 'new' ? null : goals.find(g => g.id === editing)}
          accounts={accounts}
          onSave={handleSave}
          onCancel={() => setEditing(null)}
        />
      )}
    </div>
  )
}
