/**
 * Categories — manage the dropdown that powers transaction
 * categorization across the app.
 *
 * Two sections:
 *
 *   1. **Built-in** — STANDARD_CATEGORIES from the backend, listed
 *      read-only with their icons. Every Tusk Ledger install has these;
 *      they map to Plaid's personal_finance_category vocabulary.
 *
 *   2. **Custom** — user-defined additions stored in the
 *      `custom_categories` table. Editable / deletable. An "Add" form
 *      at the top lets the user add a name + emoji icon.
 *
 * Delete protection: tapping Delete on a custom that has transactions
 * tagged to it shows the count first ("312 transactions still tagged
 * 'Pet Care' — they'll keep that label but stop appearing in the
 * dropdown. Continue?") so the user isn't surprised.
 *
 * What this page does NOT do (yet):
 *   - Reorder customs (the sort_order column exists; no UI for it).
 *   - Bulk-rename existing transactions when a custom is renamed.
 *   - Sub-categories.
 */
import { useEffect, useMemo, useState } from 'react'
import { Tag, Plus, Trash2, Edit2, Save, X } from 'lucide-react'
import {
  getCategories,
  createCustomCategory,
  updateCustomCategory,
  deleteCustomCategory,
  getCustomCategoryUsage,
} from '../api/client'

export default function Categories() {
  const [items, setItems] = useState(null)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  // New-category form state — kept local to this page; doesn't bleed
  // into a global store because there's nothing else on the app that
  // needs to know about an in-progress add.
  const [newName, setNewName] = useState('')
  const [newIcon, setNewIcon] = useState('📦')
  // Edit mode is a single-row affair; we don't need multi-row editing.
  const [editingId, setEditingId] = useState(null)
  const [editName, setEditName] = useState('')
  const [editIcon, setEditIcon] = useState('')

  async function reload() {
    try {
      const list = await getCategories()
      setItems(list)
      setError(null)
    } catch (e) {
      setError(e.message || String(e))
    }
  }

  useEffect(() => { reload() }, [])

  // Split for rendering. The backend returns them in a single list
  // with an `is_custom` discriminator; we group here so the page has
  // two visually distinct sections.
  const { standards, customs } = useMemo(() => {
    if (!items) return { standards: [], customs: [] }
    return {
      standards: items.filter((c) => !c.is_custom),
      customs: items.filter((c) => c.is_custom),
    }
  }, [items])

  async function handleAdd(e) {
    e.preventDefault()
    const name = newName.trim()
    if (!name) return
    setBusy(true)
    try {
      await createCustomCategory({ name, icon: newIcon.trim() || '📦' })
      setNewName('')
      setNewIcon('📦')
      await reload()
    } catch (e) {
      setError(e.message || String(e))
    } finally {
      setBusy(false)
    }
  }

  async function handleSaveEdit(id) {
    const name = editName.trim()
    if (!name) return
    setBusy(true)
    try {
      await updateCustomCategory(id, { name, icon: editIcon.trim() || '📦' })
      setEditingId(null)
      await reload()
    } catch (e) {
      setError(e.message || String(e))
    } finally {
      setBusy(false)
    }
  }

  async function handleDelete(c) {
    // Pre-check transaction count so the confirm message is honest
    // about what's about to happen. Skipping the prompt entirely on
    // zero-usage categories would be tidier UX, but the confirm is
    // also the only barrier to accidental deletion — keeping it for
    // safety.
    let usage = { transaction_count: 0 }
    try { usage = await getCustomCategoryUsage(c.id) } catch {}
    const message = usage.transaction_count > 0
      ? `Delete "${c.name}"? ${usage.transaction_count} transaction${usage.transaction_count === 1 ? '' : 's'} `
        + 'will keep that label but stop appearing in the dropdown.'
      : `Delete "${c.name}"? No transactions reference it, so this is safe.`
    if (!window.confirm(message)) return
    setBusy(true)
    try {
      await deleteCustomCategory(c.id)
      await reload()
    } catch (e) {
      setError(e.message || String(e))
    } finally {
      setBusy(false)
    }
  }

  if (items === null) {
    return (
      <div className="page">
        <h1><Tag size={22} style={{ verticalAlign: '-3px', marginRight: 8 }} />Categories</h1>
        <p style={{ color: 'var(--text-muted)' }}>Loading…</p>
      </div>
    )
  }

  return (
    <div className="page">
      <div className="page-header">
        <h1>
          <Tag size={22} style={{ verticalAlign: '-3px', marginRight: 8 }} />
          Categories
        </h1>
        <p style={{ color: 'var(--text-secondary)', maxWidth: 720 }}>
          Categories drive the dropdown on every transaction row. The
          built-in list is tied to Plaid's category vocabulary and stays
          fixed. Add your own below for things the standard list
          doesn't cover — pet care, hobbies, side-business sub-buckets,
          whatever you actually spend on.
        </p>
      </div>

      {error && (
        <div style={{
          margin: '8px 0 16px',
          padding: '10px 14px',
          borderRadius: 8,
          background: 'rgba(239,111,108,0.10)',
          border: '1px solid rgba(239,111,108,0.4)',
          color: 'var(--text-primary)',
          fontSize: 13,
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        }}>
          <span>{error}</span>
          <button
            onClick={() => setError(null)}
            style={{
              background: 'none', border: 'none', cursor: 'pointer',
              color: 'var(--text-secondary)', padding: 4,
            }}
          >
            <X size={14} />
          </button>
        </div>
      )}

      {/* Add a custom — form at the top so the user's eye lands on it
          first. Icon defaults to a parcel emoji; name is required. */}
      <section className="card" style={{ padding: 20, maxWidth: 640, marginBottom: 24 }}>
        <h2 style={{ marginTop: 0, fontSize: 16 }}>Add a custom category</h2>
        <form
          onSubmit={handleAdd}
          style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}
        >
          <input
            type="text"
            value={newIcon}
            onChange={(e) => setNewIcon(e.target.value)}
            maxLength={4}
            placeholder="📦"
            title="Emoji or short text icon"
            style={{
              width: 56, textAlign: 'center', fontSize: 18,
              padding: '8px 6px',
              background: 'var(--bg-primary)', color: 'var(--text-primary)',
              border: '1px solid var(--border)', borderRadius: 8,
            }}
          />
          <input
            type="text"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="Category name (e.g. Pet Care)"
            maxLength={64}
            style={{
              flex: 1, minWidth: 200,
              padding: '8px 12px',
              background: 'var(--bg-primary)', color: 'var(--text-primary)',
              border: '1px solid var(--border)', borderRadius: 8,
              fontSize: 13,
            }}
          />
          <button
            type="submit"
            disabled={busy || !newName.trim()}
            className="primary-btn"
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
          >
            <Plus size={14} /> Add
          </button>
        </form>
        <p style={{ color: 'var(--text-muted)', fontSize: 12, margin: '10px 0 0' }}>
          Tip: use emoji directly in the icon field (e.g. paste 🐾 for Pet Care).
        </p>
      </section>

      <section style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 16 }}>
        {/* Custom column */}
        <div className="card" style={{ padding: 20 }}>
          <h2 style={{ marginTop: 0, fontSize: 16 }}>Custom · {customs.length}</h2>
          {customs.length === 0 ? (
            <p style={{ color: 'var(--text-muted)', fontSize: 13 }}>
              No custom categories yet. Use the form above to add one.
            </p>
          ) : (
            <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
              {customs.map((c) => (
                <li
                  key={c.id}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 8,
                    padding: '8px 0',
                    borderTop: '1px solid var(--border-soft)',
                  }}
                >
                  {editingId === c.id ? (
                    <>
                      <input
                        type="text" value={editIcon}
                        onChange={(e) => setEditIcon(e.target.value)}
                        maxLength={4}
                        style={{
                          width: 44, textAlign: 'center', fontSize: 16,
                          padding: '4px 4px',
                          background: 'var(--bg-primary)', color: 'var(--text-primary)',
                          border: '1px solid var(--border)', borderRadius: 6,
                        }}
                      />
                      <input
                        type="text" value={editName}
                        onChange={(e) => setEditName(e.target.value)}
                        maxLength={64}
                        autoFocus
                        style={{
                          flex: 1,
                          padding: '4px 8px',
                          background: 'var(--bg-primary)', color: 'var(--text-primary)',
                          border: '1px solid var(--border)', borderRadius: 6,
                          fontSize: 13,
                        }}
                      />
                      <button
                        onClick={() => handleSaveEdit(c.id)}
                        disabled={busy}
                        title="Save"
                        className="ghost-btn"
                        style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
                      >
                        <Save size={12} />
                      </button>
                      <button
                        onClick={() => setEditingId(null)}
                        title="Cancel"
                        className="ghost-btn"
                        style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
                      >
                        <X size={12} />
                      </button>
                    </>
                  ) : (
                    <>
                      <span style={{ fontSize: 18, width: 28, textAlign: 'center' }}>{c.icon}</span>
                      <span style={{ flex: 1, fontSize: 13 }}>{c.name}</span>
                      <button
                        onClick={() => {
                          setEditingId(c.id)
                          setEditName(c.name)
                          setEditIcon(c.icon || '📦')
                        }}
                        title="Edit name / icon"
                        className="ghost-btn"
                        style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
                      >
                        <Edit2 size={12} />
                      </button>
                      <button
                        onClick={() => handleDelete(c)}
                        disabled={busy}
                        title="Delete this custom category"
                        className="ghost-btn"
                        style={{
                          display: 'inline-flex', alignItems: 'center', gap: 4,
                          color: 'var(--accent-red)',
                        }}
                      >
                        <Trash2 size={12} />
                      </button>
                    </>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Standards column — read-only reference. Two columns side-by-side
            on wide screens so the user sees the full available vocabulary
            at a glance. */}
        <div className="card" style={{ padding: 20 }}>
          <h2 style={{ marginTop: 0, fontSize: 16 }}>Built-in · {standards.length}</h2>
          <p style={{ color: 'var(--text-muted)', fontSize: 12, margin: '0 0 12px' }}>
            Tied to Plaid's vocabulary — read-only.
          </p>
          <ul style={{
            listStyle: 'none', padding: 0, margin: 0,
            display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
            columnGap: 16,
          }}>
            {standards.map((c) => (
              <li
                key={c.name}
                style={{
                  display: 'flex', alignItems: 'center', gap: 8,
                  padding: '6px 0',
                  fontSize: 13,
                  color: 'var(--text-secondary)',
                }}
              >
                <span style={{ fontSize: 16, width: 24, textAlign: 'center' }}>{c.icon}</span>
                <span>{c.name}</span>
              </li>
            ))}
          </ul>
        </div>
      </section>
    </div>
  )
}
