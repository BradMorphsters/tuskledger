import { useEffect, useState, useMemo, useCallback } from 'react'
import { X, Split } from 'lucide-react'
import {
  getTransactions,
  getCategories,
  getBusinesses,
  updateTransaction,
} from '../api/client'
import Pill from './Pill'

/**
 * Slide-in drawer that shows the transactions making up a summary amount.
 *
 * Props:
 *   open            boolean — whether the drawer is visible
 *   onClose()       called when user dismisses (X, overlay, Esc)
 *   title           main header, e.g. "Food & Drink"
 *   subtitle        small line under the title, e.g. "March 2026"
 *   filters         object passed to GET /api/transactions:
 *                     { category?, business_id?, account_id?, start_date?, end_date? }
 *                   start_date/end_date are ISO yyyy-mm-dd strings.
 *   onDataChanged() optional — called whenever the user edits a transaction
 *                   (category or business). Parent should re-fetch the summary
 *                   so the number that was clicked stays honest.
 *
 * The drawer re-fetches when `open` flips to true or `filters` changes.
 * Supports inline recategorize (click the category badge) and business-tag
 * dropdown, mirroring the Transactions page row controls.
 */
export default function TransactionDrawer({
  open,
  onClose,
  title,
  subtitle,
  filters = {},
  onDataChanged,
}) {
  const [transactions, setTransactions] = useState([])
  const [categories, setCategories] = useState([])
  const [businesses, setBusinesses] = useState([])
  const [loading, setLoading] = useState(false)
  const [editingId, setEditingId] = useState(null)
  const [editCategory, setEditCategory] = useState('')
  const [editingNotesId, setEditingNotesId] = useState(null)
  const [editNotes, setEditNotes] = useState('')
  const [savingNotes, setSavingNotes] = useState(false)

  // Serialize filters so we can useEffect-dep on them without object identity churn.
  const filterKey = JSON.stringify(filters)

  const reload = useCallback(async () => {
    setLoading(true)
    try {
      const params = { limit: 500 }
      if (filters.category) params.category = filters.category
      if (filters.business_id) params.business_id = filters.business_id
      // is_business filter — drives the Budgets page Business rollup
      // drill-down (any business-tagged transaction). Only forwarded if
      // explicitly true/false; an unset filter shows everything.
      if (filters.is_business === true) params.is_business = true
      else if (filters.is_business === false) params.is_business = false
      if (filters.account_id) params.account_id = filters.account_id
      if (filters.start_date) params.start_date = filters.start_date
      if (filters.end_date) params.end_date = filters.end_date
      const txns = await getTransactions(params)
      setTransactions(txns)
    } catch (e) {
      setTransactions([])
    } finally {
      setLoading(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterKey])

  useEffect(() => {
    if (!open) return
    reload()
    // Load supporting data once per open — these rarely change within a session.
    if (categories.length === 0) getCategories().then(setCategories).catch(() => {})
    if (businesses.length === 0) getBusinesses().then(setBusinesses).catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, filterKey])

  // Escape closes the drawer. Only bind while it's open so we don't
  // leak listeners across pages.
  useEffect(() => {
    if (!open) return
    const onKey = (e) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  // Lock background scroll while open — without this the page jumps when
  // the drawer takes focus.
  useEffect(() => {
    if (!open) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = prev }
  }, [open])

  // Summary stats over the currently-loaded transactions.
  const summary = useMemo(() => {
    if (!transactions.length) return null
    // In this DB, spending amounts are positive, income negative.
    let spend = 0, income = 0, count = 0, largest = 0
    for (const t of transactions) {
      count += 1
      if (t.amount > 0) spend += t.amount
      else income += Math.abs(t.amount)
      if (Math.abs(t.amount) > Math.abs(largest)) largest = t.amount
    }
    const net = spend - income
    return { spend, income, net, count, largest, avg: spend / Math.max(count, 1) }
  }, [transactions])

  const commitCategory = async (txnId) => {
    try {
      await updateTransaction(txnId, { custom_category: editCategory })
      setEditingId(null)
      await reload()
      onDataChanged && onDataChanged()
    } catch (e) {
      // Leave editing state so the user can adjust.
      console.error('Recategorize failed:', e)
    }
  }

  const setBusiness = async (txnId, bizId) => {
    try {
      await updateTransaction(txnId, { business_id: bizId ? parseInt(bizId) : 0 })
      await reload()
      onDataChanged && onDataChanged()
    } catch (e) {
      console.error('Set business failed:', e)
    }
  }

  const saveNotes = async (txnId) => {
    setSavingNotes(true)
    try {
      await updateTransaction(txnId, { notes: editNotes })
      setEditingNotesId(null)
      setEditNotes('')
      await reload()
      onDataChanged && onDataChanged()
    } catch (e) {
      console.error('Save notes failed:', e)
    } finally {
      setSavingNotes(false)
    }
  }

  const formatCurrency = (n) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n || 0)

  if (!open) return null

  return (
    <>
      {/* Overlay */}
      <div
        onClick={onClose}
        style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)',
          zIndex: 900,
        }}
      />
      {/* Drawer panel */}
      <aside
        role="dialog"
        aria-label={title}
        style={{
          position: 'fixed', top: 0, right: 0, bottom: 0,
          width: 'min(680px, 100vw)',
          background: 'var(--bg-primary, #15171f)',
          borderLeft: '1px solid var(--border, #2a2d3a)',
          zIndex: 901,
          display: 'flex', flexDirection: 'column',
          boxShadow: '-12px 0 32px rgba(0,0,0,0.35)',
        }}
      >
        {/* Header */}
        <div style={{
          padding: '18px 22px', borderBottom: '1px solid var(--border, #2a2d3a)',
          display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start',
          flexShrink: 0,
        }}>
          <div>
            <div style={{ fontSize: 18, fontWeight: 600 }}>{title}</div>
            {subtitle && (
              <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 2 }}>{subtitle}</div>
            )}
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            style={{
              background: 'none', border: 'none', color: 'var(--text-secondary)',
              cursor: 'pointer', padding: 4,
            }}
          >
            <X size={20} />
          </button>
        </div>

        {/* Summary bar */}
        {summary && (
          <div style={{
            padding: '14px 22px',
            borderBottom: '1px solid var(--border, #2a2d3a)',
            display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12,
            fontSize: 12, color: 'var(--text-secondary)',
            flexShrink: 0,
          }}>
            <div>
              <div>Count</div>
              <div style={{ fontSize: 18, fontWeight: 600, color: 'var(--text-primary)' }}>{summary.count}</div>
            </div>
            <div>
              <div>Spend</div>
              <div style={{ fontSize: 18, fontWeight: 600, color: 'var(--text-primary)' }}>{formatCurrency(summary.spend)}</div>
            </div>
            <div>
              <div>Avg / txn</div>
              <div style={{ fontSize: 18, fontWeight: 600, color: 'var(--text-primary)' }}>{formatCurrency(summary.avg)}</div>
            </div>
            <div>
              <div>Largest</div>
              <div style={{ fontSize: 18, fontWeight: 600, color: 'var(--text-primary)' }}>
                {formatCurrency(Math.abs(summary.largest))}
              </div>
            </div>
          </div>
        )}

        {/* Transaction list */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '6px 0' }}>
          {loading ? (
            <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-muted)' }}>Loading…</div>
          ) : transactions.length === 0 ? (
            <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-muted)' }}>
              No transactions match this filter.
            </div>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <tbody>
                {transactions.map(t => {
                  const isEditing = editingId === t.id
                  const hasSplits = t.splits && t.splits.length > 0
                  const biz = businesses.find(b => b.id === t.business_id)
                  return (
                    <tr key={t.id} style={{ borderBottom: '1px solid var(--border, #2a2d3a)' }}>
                      <td style={{ padding: '10px 18px', whiteSpace: 'nowrap', color: 'var(--text-secondary)', fontSize: 12 }}>
                        {t.date}
                      </td>
                      <td style={{ padding: '10px 12px' }}>
                        <div style={{ fontWeight: 500, fontSize: 13, display: 'flex', alignItems: 'center', gap: 6 }}>
                          <span>{t.display_name || t.merchant_name || t.name}</span>
                          {t.is_transfer && (
                            <Pill tone="info" title="Transfer or bill payment — excluded from spending totals">
                              ↔ Transfer
                            </Pill>
                          )}
                        </div>
                        {t.display_name && t.display_name !== (t.merchant_name || t.name) && (
                          <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{t.merchant_name || t.name}</div>
                        )}
                        {/* Category editor */}
                        <div style={{ marginTop: 4 }}>
                          {isEditing ? (
                            <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                              <select
                                value={editCategory}
                                onChange={e => setEditCategory(e.target.value)}
                                autoFocus
                                style={{
                                  background: 'var(--bg-primary)', color: 'var(--text-primary)',
                                  border: '1px solid var(--accent-blue)', borderRadius: 6,
                                  padding: '3px 6px', fontSize: 11,
                                }}
                              >
                                <option value="">-- Select --</option>
                                {categories.map(c => (
                                  <option key={c.name} value={c.name}>{c.icon} {c.name}</option>
                                ))}
                              </select>
                              <button
                                onClick={() => commitCategory(t.id)}
                                style={{ background: 'var(--accent-green)', color: '#000', border: 'none', borderRadius: 4, padding: '2px 8px', fontSize: 11, cursor: 'pointer' }}
                              >Save</button>
                              <button
                                onClick={() => setEditingId(null)}
                                style={{ background: 'transparent', color: 'var(--text-secondary)', border: '1px solid var(--border)', borderRadius: 4, padding: '2px 6px', fontSize: 11, cursor: 'pointer' }}
                              >✕</button>
                            </div>
                          ) : hasSplits ? (
                            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                              {t.splits.map(s => (
                                <span key={s.id} className="category-badge" style={{ fontSize: 10 }}>
                                  <Split size={9} style={{ marginRight: 2 }} />{s.category} {formatCurrency(Math.abs(s.amount))}
                                </span>
                              ))}
                            </div>
                          ) : (
                            <span
                              className="category-badge"
                              style={{ cursor: 'pointer', fontSize: 11 }}
                              title="Click to recategorize"
                              onClick={() => {
                                setEditingId(t.id)
                                setEditCategory(t.custom_category || t.category || '')
                              }}
                            >
                              {t.custom_category || t.category || 'Uncategorized'}
                            </span>
                          )}
                        </div>
                        {/* Notes */}
                        <div style={{ marginTop: 8 }}>
                          {editingNotesId === t.id ? (
                            <div style={{ display: 'flex', gap: 4, flexDirection: 'column' }}>
                              <textarea
                                value={editNotes}
                                onChange={e => setEditNotes(e.target.value)}
                                placeholder="Add a note (optional)…"
                                autoFocus
                                style={{
                                  background: 'var(--bg-primary)', color: 'var(--text-primary)',
                                  border: '1px solid var(--accent-blue)', borderRadius: 4,
                                  padding: '6px 8px', fontSize: 11, fontFamily: 'inherit',
                                  minHeight: '60px', maxHeight: '90px', resize: 'vertical',
                                }}
                              />
                              <div style={{ display: 'flex', gap: 4 }}>
                                <button
                                  onClick={() => saveNotes(t.id)}
                                  disabled={savingNotes}
                                  style={{
                                    background: 'var(--accent-green)', color: '#000', border: 'none',
                                    borderRadius: 4, padding: '4px 10px', fontSize: 11, cursor: 'pointer',
                                    opacity: savingNotes ? 0.6 : 1,
                                  }}
                                >
                                  {savingNotes ? 'Saving…' : 'Save'}
                                </button>
                                <button
                                  onClick={() => setEditingNotesId(null)}
                                  style={{
                                    background: 'transparent', color: 'var(--text-secondary)',
                                    border: '1px solid var(--border)', borderRadius: 4, padding: '4px 8px',
                                    fontSize: 11, cursor: 'pointer'
                                  }}
                                >
                                  Cancel
                                </button>
                              </div>
                            </div>
                          ) : (
                            <div
                              onClick={() => {
                                setEditingNotesId(t.id)
                                setEditNotes(t.notes || '')
                              }}
                              style={{
                                padding: '6px 8px',
                                backgroundColor: t.notes ? 'var(--bg-secondary)' : 'transparent',
                                border: t.notes ? '1px solid var(--border)' : '1px dashed var(--text-muted)',
                                borderRadius: 4,
                                fontSize: 11,
                                color: t.notes ? 'var(--text-primary)' : 'var(--text-muted)',
                                cursor: 'pointer',
                                wordBreak: 'break-word',
                                minHeight: '20px',
                                display: 'flex',
                                alignItems: 'center',
                              }}
                              title="Click to edit notes"
                            >
                              {t.notes ? t.notes : '+ Add note'}
                            </div>
                          )}
                        </div>
                      </td>
                      <td style={{ padding: '10px 8px' }}>
                        {businesses.length > 0 ? (
                          <select
                            value={t.business_id || ''}
                            onChange={e => setBusiness(t.id, e.target.value)}
                            style={{
                              background: 'transparent', color: 'var(--text-primary)',
                              border: biz ? `1px solid ${biz.color}` : '1px solid var(--border)',
                              backgroundColor: biz ? `${biz.color}15` : 'transparent',
                              borderRadius: 6, padding: '3px 6px', fontSize: 11, cursor: 'pointer',
                            }}
                          >
                            <option value="">Personal</option>
                            {businesses.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
                          </select>
                        ) : null}
                      </td>
                      <td style={{ padding: '10px 18px', textAlign: 'right', whiteSpace: 'nowrap' }}>
                        <span
                          style={{ fontWeight: 500, fontSize: 13 }}
                          className={t.amount > 0 ? 'amount-negative' : 'amount-positive'}
                        >
                          {t.amount > 0 ? '-' : '+'}{formatCurrency(Math.abs(t.amount))}
                        </span>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </div>
      </aside>
    </>
  )
}
