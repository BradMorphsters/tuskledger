/**
 * CategorySuggestion — "you just recategorized X; make it stick."
 *
 * Shown after a single-row recategorize (Transactions table and the
 * drill-down drawer). Asks the backend what the same merchant looks like
 * across ALL history — the previous version counted only rows loaded on
 * the current page, so a merchant with two years of history got "apply
 * to 3 others" and the rest stayed wrong — and offers three exits:
 *
 *   Apply to N past   PATCH exactly the listed rows. Undoable for 8s via
 *                     the toast (each row goes back to its prior override,
 *                     or to none).
 *   Always → rule     POST /analytics/rules — the engine applies it to
 *                     history now (its own conservative semantics: never
 *                     overrides a different hand-set category) and to
 *                     every future sync. Rules can be deleted on the
 *                     Rules page.
 *   Not now           Dismiss.
 *
 * Renders nothing while loading or when there is nothing to suggest, so
 * a one-off merchant never produces a card.
 */
import { useEffect, useState } from 'react'
import { Repeat, ListChecks } from 'lucide-react'
import { previewRule, createRule, updateTransaction } from '../api/client'
import { useToast } from './Toast'
import { buildRulePattern, undoPlan, describeSuggestion } from '../lib/categoryFix'

// How long the Undo stays available. Long enough to read the toast and
// react; short enough that a later edit can't be silently reverted.
const UNDO_MS = 8000

export default function CategorySuggestion({ txn, category, onApplied, onDismiss, zIndex = 999 }) {
  const { toast } = useToast()
  const [preview, setPreview] = useState(null)
  const [busy, setBusy] = useState(false)
  const pattern = buildRulePattern(txn)
  const merchant = txn?.display_name || txn?.merchant_name || txn?.name || 'this merchant'

  useEffect(() => {
    let cancelled = false
    setPreview(null)
    if (!txn || !category || !pattern) return
    previewRule(pattern, category, txn.id)
      .then(p => { if (!cancelled) setPreview(p) })
      .catch(() => { if (!cancelled) setPreview(null) })
    return () => { cancelled = true }
  }, [txn?.id, category, pattern])

  if (!preview || preview.candidates.length === 0) return null
  const count = preview.candidates.length
  const sentence = describeSuggestion({ merchant, category, count, alreadyCorrect: preview.already_correct })

  const applyToPast = async () => {
    setBusy(true)
    const plan = undoPlan(preview.candidates)
    try {
      await Promise.all(preview.candidates.map(c => updateTransaction(c.id, { custom_category: category })))
      onApplied && onApplied({ count })
      toast({
        kind: 'undo',
        message: `${count} ${merchant} transaction${count === 1 ? '' : 's'} → ${category}`,
        timeout: UNDO_MS,
        onUndo: async () => {
          await Promise.all(plan.map(p => updateTransaction(p.id, p.body)))
          onApplied && onApplied({ count, undone: true })
        },
      })
      onDismiss && onDismiss()
    } catch (e) {
      toast({ kind: 'error', message: 'Could not apply — check the connection and try again.' })
    } finally {
      setBusy(false)
    }
  }

  const makeRule = async () => {
    setBusy(true)
    try {
      const res = await createRule({ pattern, category })
      onApplied && onApplied({ count: res?.retroactively_applied ?? 0, rule: true })
      toast({
        kind: 'success',
        message: `Rule saved: "${pattern}" → ${category}` +
          (res?.retroactively_applied ? ` · ${res.retroactively_applied} past transaction${res.retroactively_applied === 1 ? '' : 's'} updated` : '') +
          ' · future syncs too. Manage on the Rules page.',
        timeout: 6000,
      })
      onDismiss && onDismiss()
    } catch (e) {
      toast({ kind: 'error', message: 'Could not save the rule.' })
    } finally {
      setBusy(false)
    }
  }

  const btn = (extra) => ({
    border: '1px solid var(--border)', borderRadius: 4, padding: '6px 10px',
    fontSize: 12, fontWeight: 500, cursor: busy ? 'wait' : 'pointer',
    display: 'inline-flex', alignItems: 'center', gap: 5, ...extra,
  })

  return (
    <div role="dialog" aria-label="Apply this category to similar transactions" style={{
      position: 'fixed', bottom: 24, right: 24, zIndex,
      background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 8,
      padding: 12, maxWidth: 360, boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
    }}>
      <div style={{ fontSize: 13, marginBottom: 4, fontWeight: 500 }}>{sentence}</div>
      {preview.sample?.length > 0 && (
        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 8 }}>
          e.g. {preview.sample.slice(0, 3).map(s => `${s.date} · ${s.current_category}`).join(' · ')}
          {count > 3 ? ` · +${count - 3} more` : ''}
        </div>
      )}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        <button onClick={applyToPast} disabled={busy}
          style={btn({ background: 'var(--accent-green)', color: '#000', borderColor: 'transparent' })}>
          <ListChecks size={12} /> Apply to {count} past
        </button>
        <button onClick={makeRule} disabled={busy}
          title={`Create a rule: any transaction containing "${pattern}" → ${category}. Applies to ${preview.rule_would_update} past transaction${preview.rule_would_update === 1 ? '' : 's'} now (never overrides a category you set by hand) and to every future sync.`}
          style={btn({ background: 'var(--accent-blue-bg, rgba(96,165,250,0.12))', color: 'var(--accent-blue, #60a5fa)' })}>
          <Repeat size={12} /> Always
        </button>
        <button onClick={onDismiss} disabled={busy}
          style={btn({ background: 'var(--bg-hover)', color: 'var(--text-secondary)' })}>
          Not now
        </button>
      </div>
    </div>
  )
}
