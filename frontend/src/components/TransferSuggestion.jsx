/**
 * TransferSuggestion — "you just marked X as a transfer; make it a rule."
 *
 * The transfer detector can only pair moves between accounts Tusk Ledger
 * can see. Money sent to an external savings account, a relative or an
 * unlinked brokerage has no counterpart row, so Plaid's "Transfer" label
 * alone leaves it counted as spending. When the user flags such a row by
 * hand, this card asks the backend how many other unflagged rows share
 * the payee and offers a transfer rule: fixes history now, handles every
 * future sync. Rules can be deleted on the Rules page.
 *
 * Renders nothing while loading or when the payee has no other rows.
 */
import { useEffect, useState } from 'react'
import { Repeat } from 'lucide-react'
import { previewTransferRule, createTransferRule } from '../api/client'
import { useToast } from './Toast'
import { buildRulePattern } from '../lib/categoryFix'
import { formatCurrencyZero as formatCurrency } from '../lib/format'

export default function TransferSuggestion({ txn, onApplied, onDismiss, zIndex = 999 }) {
  const { toast } = useToast()
  const [preview, setPreview] = useState(null)
  const [busy, setBusy] = useState(false)
  const pattern = buildRulePattern(txn)
  const payee = txn?.display_name || txn?.merchant_name || txn?.name || 'this payee'

  useEffect(() => {
    let cancelled = false
    setPreview(null)
    if (!txn || !pattern) return
    previewTransferRule(pattern, txn.id)
      .then(p => { if (!cancelled) setPreview(p) })
      .catch(() => { if (!cancelled) setPreview(null) })
    return () => { cancelled = true }
  }, [txn?.id, pattern])

  if (!preview || preview.candidates.length === 0) return null
  const n = preview.candidates.length

  const makeRule = async () => {
    setBusy(true)
    try {
      const res = await createTransferRule(pattern)
      toast({
        kind: 'success',
        message: `Transfer rule saved: "${pattern}" · ${res?.retroactively_flagged ?? 0} past transaction${res?.retroactively_flagged === 1 ? '' : 's'} moved out of spending · future syncs too.`,
        timeout: 6000,
      })
      onApplied && onApplied(res)
      onDismiss && onDismiss()
    } catch (e) {
      toast({ kind: 'error', message: 'Could not save the transfer rule.' })
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
    <div role="dialog" aria-label="Make this payee a transfer rule" style={{
      position: 'fixed', bottom: 24, right: 24, zIndex,
      background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 8,
      padding: 12, maxWidth: 360, boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
    }}>
      <div style={{ fontSize: 13, marginBottom: 4, fontWeight: 500 }}>
        {n} other <strong>{payee}</strong> transaction{n === 1 ? '' : 's'} ({formatCurrency(preview.total_amount)}) still count as spending.
      </div>
      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 8 }}>
        Always treat this payee as a transfer? Fixes those now and every future sync.
      </div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        <button onClick={makeRule} disabled={busy}
          style={btn({ background: 'var(--accent-blue-bg, rgba(96,165,250,0.12))', color: 'var(--accent-blue, #60a5fa)' })}>
          <Repeat size={12} /> Always a transfer
        </button>
        <button onClick={onDismiss} disabled={busy}
          style={btn({ background: 'var(--bg-hover)', color: 'var(--text-secondary)' })}>
          Just this one
        </button>
      </div>
    </div>
  )
}
