/**
 * QuickActions — global UI patterns that live above the page layer.
 *
 * Bundles three related "everywhere" features:
 *   1. ThemeToggle — light / dark switch (CSS variable swap, persists to localStorage)
 *   2. QuickAddFab — floating action button to add a manual transaction from anywhere
 *   3. CommandPalette — Cmd-K modal with route navigation + global search
 *
 * Each is a standalone component but they share keyboard handling
 * (Cmd-K opens palette, Esc closes everything) and a common modal style.
 */
import { useEffect, useState, useCallback, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { Sun, Moon, Plus, X, Search, ArrowRight } from 'lucide-react'
import { createManualTransaction, globalSearch, getAccounts } from '../api/client'
import { useToast } from './Toast'

/* ───────────────────────────── Theme toggle ───────────────────────────── */

const THEME_KEY = 'tuskledger-theme'

export function useTheme() {
  // Hydrate from localStorage. Default = dark (preserves existing behavior
  // for users who don't touch the toggle). Setting data-theme on <html>
  // lets the CSS variables in index.css cascade everywhere.
  const [theme, setTheme] = useState(() => {
    try {
      return localStorage.getItem(THEME_KEY) || 'dark'
    } catch {
      return 'dark'
    }
  })

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
    try { localStorage.setItem(THEME_KEY, theme) } catch {}
  }, [theme])

  const toggle = useCallback(() => {
    setTheme(t => t === 'dark' ? 'light' : 'dark')
  }, [])

  return { theme, toggle, setTheme }
}

export function ThemeToggle({ theme, toggle }) {
  return (
    <button
      onClick={toggle}
      title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 6,
        padding: '5px 8px',
        background: 'transparent',
        color: 'var(--text-muted)',
        border: '1px solid var(--border)',
        borderRadius: 4,
        fontSize: 11, cursor: 'pointer',
        transition: 'all 0.15s',
      }}
      onMouseEnter={e => { e.currentTarget.style.color = 'var(--text-primary)' }}
      onMouseLeave={e => { e.currentTarget.style.color = 'var(--text-muted)' }}
    >
      {theme === 'dark' ? <Sun size={12} /> : <Moon size={12} />}
      {theme === 'dark' ? 'Light' : 'Dark'}
    </button>
  )
}

/* ───────────────────── Quick-add transaction FAB + modal ───────────────── */

export function QuickAddFab({ onSaved }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button
        onClick={() => setOpen(true)}
        title="Quick add transaction (Cmd-K → 'add' for keyboard equivalent)"
        style={{
          position: 'fixed', bottom: 24, right: 24,
          width: 52, height: 52, borderRadius: '50%',
          background: 'var(--accent-green)',
          color: '#0d0e14', border: 'none',
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          cursor: 'pointer', boxShadow: 'var(--shadow-lg)',
          zIndex: 50,
          transition: 'transform 0.15s',
        }}
        onMouseEnter={e => { e.currentTarget.style.transform = 'scale(1.06)' }}
        onMouseLeave={e => { e.currentTarget.style.transform = 'scale(1)' }}
      >
        <Plus size={22} strokeWidth={2.5} />
      </button>
      {open && (
        <QuickAddModal
          onClose={() => setOpen(false)}
          onSaved={(t) => { setOpen(false); onSaved?.(t) }}
        />
      )}
    </>
  )
}

function QuickAddModal({ onClose, onSaved }) {
  const { toast } = useToast()
  const [accounts, setAccounts] = useState([])
  const [form, setForm] = useState(() => ({
    amount: '',
    name: '',
    account_id: '',
    date: new Date().toISOString().slice(0, 10),
    category: '',
    notes: '',
  }))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)

  useEffect(() => {
    getAccounts().then(setAccounts).catch(() => {})
  }, [])

  // Default account = first depository / checking (most common for cash entries)
  useEffect(() => {
    if (!form.account_id && accounts.length) {
      const dep = accounts.find(a => a.type === 'depository' || a.subtype === 'checking')
      setForm(p => ({ ...p, account_id: (dep || accounts[0]).id }))
    }
  }, [accounts])

  // Esc closes
  useEffect(() => {
    const handler = (e) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  const submit = async (e) => {
    e.preventDefault()
    setSaving(true); setError(null)
    try {
      const t = await createManualTransaction({
        amount: Number(form.amount),
        name: form.name || 'Manual entry',
        account_id: Number(form.account_id),
        date: form.date,
        category: form.category || null,
        notes: form.notes || null,
      })
      // Success toast: shows the just-created amount + name so the user
      // gets visual confirmation in the bottom-right while the modal closes.
      toast({
        kind: 'success',
        message: `Added ${form.name || 'transaction'} for $${Math.abs(Number(form.amount)).toFixed(2)}`,
      })
      onSaved?.(t)
    } catch (err) {
      setError(err.message || 'Failed to save')
      toast({ kind: 'error', message: 'Failed to save transaction', timeout: 5000 })
      setSaving(false)
    }
  }

  return (
    <ModalShell onClose={onClose} title="Quick add transaction">
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          <Field label="Amount ($, + outflow / − inflow)">
            <input type="number" step="0.01" autoFocus required
              placeholder="e.g. 25.50" value={form.amount}
              onChange={e => setForm(p => ({ ...p, amount: e.target.value }))}
              style={inputStyle} />
          </Field>
          <Field label="Date">
            <input type="date" required value={form.date}
              onChange={e => setForm(p => ({ ...p, date: e.target.value }))}
              style={inputStyle} />
          </Field>
        </div>
        <Field label="Description / merchant">
          <input type="text" required placeholder="e.g. Coffee, gas, rent"
            value={form.name}
            onChange={e => setForm(p => ({ ...p, name: e.target.value }))}
            style={inputStyle} />
        </Field>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          <Field label="Account">
            <select required value={form.account_id}
              onChange={e => setForm(p => ({ ...p, account_id: e.target.value }))}
              style={inputStyle}>
              <option value="">Select…</option>
              {accounts.map(a => (
                <option key={a.id} value={a.id}>
                  {a.custom_name || a.name} ({a.institution_name})
                </option>
              ))}
            </select>
          </Field>
          <Field label="Category (optional)">
            <input type="text" placeholder="e.g. Food, Transport"
              value={form.category}
              onChange={e => setForm(p => ({ ...p, category: e.target.value }))}
              style={inputStyle} />
          </Field>
        </div>
        <Field label="Notes (optional)">
          <input type="text" placeholder="any context"
            value={form.notes}
            onChange={e => setForm(p => ({ ...p, notes: e.target.value }))}
            style={inputStyle} />
        </Field>
        {error && (
          <div style={{ color: 'var(--accent-red)', fontSize: 12 }}>{error}</div>
        )}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 4 }}>
          <button type="button" onClick={onClose}
            style={btnSecondary}>Cancel</button>
          <button type="submit" disabled={saving}
            style={btnPrimary}>
            {saving ? 'Saving…' : 'Add transaction'}
          </button>
        </div>
      </form>
    </ModalShell>
  )
}

/* ───────────────────────────── Command palette ────────────────────────── */

const ROUTES = [
  { label: 'Dashboard', path: '/', kind: 'page' },
  { label: 'Spending & Income', path: '/spending', kind: 'page' },
  { label: 'Transactions', path: '/transactions', kind: 'page' },
  { label: 'Budgets', path: '/budgets', kind: 'page' },
  { label: 'Goals', path: '/goals', kind: 'page' },
  { label: 'Net Worth', path: '/net-worth', kind: 'page' },
  { label: 'Retirement', path: '/retirement', kind: 'page' },
  { label: 'Cash Flow', path: '/cash-flow', kind: 'page' },
  { label: 'Bills Calendar', path: '/bills-calendar', kind: 'page' },
  { label: 'Investments', path: '/investments', kind: 'page' },
  { label: 'Insights', path: '/insights', kind: 'page' },
  { label: 'Business', path: '/business', kind: 'page' },
  { label: 'Rules', path: '/rules', kind: 'page' },
  { label: 'Accounts', path: '/connect', kind: 'page' },
]

const ACTIONS = [
  { label: 'Add transaction (cash entry)', kind: 'action', action: 'quick-add' },
  { label: 'Toggle theme (light / dark)', kind: 'action', action: 'theme' },
]

export function CommandPalette({ open, onClose, onAction }) {
  const navigate = useNavigate()
  const [query, setQuery] = useState('')
  const [searchResults, setSearchResults] = useState({ transactions: [], accounts: [] })
  const [selectedIdx, setSelectedIdx] = useState(0)
  const inputRef = useRef(null)

  // Reset on open
  useEffect(() => {
    if (open) {
      setQuery('')
      setSelectedIdx(0)
      setTimeout(() => inputRef.current?.focus(), 50)
    }
  }, [open])

  // Debounced API search when query non-empty
  useEffect(() => {
    if (!query || query.length < 2) {
      setSearchResults({ transactions: [], accounts: [] })
      return
    }
    const t = setTimeout(() => {
      globalSearch(query, 10)
        .then(setSearchResults)
        .catch(() => setSearchResults({ transactions: [], accounts: [] }))
    }, 200)
    return () => clearTimeout(t)
  }, [query])

  // Filtered routes + actions by query (instant fuzzy match)
  const matchedRoutes = ROUTES.filter(r =>
    !query || r.label.toLowerCase().includes(query.toLowerCase())
  )
  const matchedActions = ACTIONS.filter(a =>
    !query || a.label.toLowerCase().includes(query.toLowerCase())
  )
  const allItems = [
    ...matchedActions.map(a => ({ ...a, type: 'action' })),
    ...matchedRoutes.map(r => ({ ...r, type: 'route' })),
    ...searchResults.transactions.map(t => ({
      ...t, type: 'txn', label: `${t.name} — $${t.amount}`, sub: `${t.date} · ${t.category}`,
    })),
    ...searchResults.accounts.map(a => ({
      ...a, type: 'acct', label: a.name, sub: `${a.institution} · $${a.balance?.toFixed(0) || 0}`,
    })),
  ]

  // Keyboard nav
  useEffect(() => {
    if (!open) return
    const handler = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault(); onClose()
      } else if (e.key === 'ArrowDown') {
        e.preventDefault(); setSelectedIdx(i => Math.min(i + 1, allItems.length - 1))
      } else if (e.key === 'ArrowUp') {
        e.preventDefault(); setSelectedIdx(i => Math.max(i - 1, 0))
      } else if (e.key === 'Enter') {
        e.preventDefault()
        const item = allItems[selectedIdx]
        if (item) executeItem(item)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [open, selectedIdx, allItems])

  const executeItem = (item) => {
    if (item.type === 'route') {
      navigate(item.path)
      onClose()
    } else if (item.type === 'action') {
      onAction?.(item.action)
      onClose()
    } else if (item.type === 'txn') {
      // Navigate to transactions; ID highlighting could be a future enhancement
      navigate('/transactions')
      onClose()
    } else if (item.type === 'acct') {
      navigate('/connect')
      onClose()
    }
  }

  if (!open) return null
  return (
    <ModalShell onClose={onClose} variant="palette">
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
        <Search size={16} style={{ color: 'var(--text-muted)' }} />
        <input
          ref={inputRef}
          type="text"
          placeholder="Search pages, transactions, merchants, accounts…"
          value={query}
          onChange={e => { setQuery(e.target.value); setSelectedIdx(0) }}
          style={{
            flex: 1, fontSize: 16, padding: '8px 4px',
            background: 'transparent', border: 'none', color: 'inherit',
            outline: 'none',
          }}
        />
        <kbd style={kbdStyle}>Esc</kbd>
      </div>
      <div style={{ maxHeight: 400, overflowY: 'auto', margin: '0 -8px' }}>
        {allItems.length === 0 ? (
          <div style={{ padding: 20, textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
            No matches. Try a different query.
          </div>
        ) : (
          allItems.map((item, i) => (
            <div
              key={`${item.type}-${item.id || item.path || item.action || i}`}
              onMouseEnter={() => setSelectedIdx(i)}
              onClick={() => executeItem(item)}
              style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                padding: '8px 12px',
                background: i === selectedIdx ? 'var(--bg-hover)' : 'transparent',
                cursor: 'pointer', borderRadius: 6,
                gap: 8,
              }}
            >
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0, flex: 1 }}>
                <div style={{ fontSize: 13, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  <span style={{
                    display: 'inline-block', padding: '1px 6px', marginRight: 8,
                    background: typeBadgeBg(item.type), color: typeBadgeColor(item.type),
                    borderRadius: 3, fontSize: 9, fontWeight: 700,
                    textTransform: 'uppercase', letterSpacing: 0.4,
                  }}>{item.type}</span>
                  {item.label}
                </div>
                {item.sub && (
                  <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{item.sub}</div>
                )}
              </div>
              <ArrowRight size={12} style={{ color: 'var(--text-muted)', opacity: i === selectedIdx ? 1 : 0 }} />
            </div>
          ))
        )}
      </div>
      <div style={{
        marginTop: 12, paddingTop: 12,
        borderTop: '1px solid var(--border)',
        fontSize: 11, color: 'var(--text-muted)',
        display: 'flex', gap: 16, justifyContent: 'space-between',
      }}>
        <span><kbd style={kbdStyle}>↑↓</kbd> navigate · <kbd style={kbdStyle}>↵</kbd> select</span>
        <span>Cmd-K to toggle</span>
      </div>
    </ModalShell>
  )
}

function typeBadgeBg(type) {
  return {
    page: 'rgba(96,165,250,0.15)',
    action: 'rgba(52,211,153,0.15)',
    txn: 'rgba(251,146,60,0.15)',
    acct: 'rgba(167,139,250,0.15)',
  }[type] || 'rgba(255,255,255,0.06)'
}
function typeBadgeColor(type) {
  return {
    page: 'var(--accent-blue)',
    action: 'var(--accent-green)',
    txn: 'var(--accent-orange)',
    acct: 'var(--accent-purple)',
  }[type] || 'var(--text-muted)'
}

/* ───────────────────────────── Shared modal shell ─────────────────────── */

function ModalShell({ onClose, title, children, variant = 'default' }) {
  const isPalette = variant === 'palette'
  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0,
        background: 'rgba(0,0,0,0.5)',
        display: 'flex',
        alignItems: isPalette ? 'flex-start' : 'center',
        justifyContent: 'center',
        padding: isPalette ? '15vh 20px 20px' : 20,
        zIndex: 100,
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          background: 'var(--bg-card)',
          border: '1px solid var(--border)',
          borderRadius: 12,
          padding: 20,
          width: '100%',
          maxWidth: isPalette ? 580 : 480,
          boxShadow: 'var(--shadow-lg)',
          color: 'var(--text-primary)',
        }}
      >
        {title && (
          <div style={{
            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
            marginBottom: 14,
          }}>
            <div style={{ fontSize: 16, fontWeight: 600 }}>{title}</div>
            <button onClick={onClose} style={{
              background: 'transparent', border: 'none', cursor: 'pointer',
              color: 'var(--text-muted)',
            }}><X size={18} /></button>
          </div>
        )}
        {children}
      </div>
    </div>
  )
}

function Field({ label, children }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 }}>
      <span style={{
        fontSize: 11, color: 'var(--text-muted)',
        textTransform: 'uppercase', letterSpacing: 0.4,
      }}>{label}</span>
      {children}
    </label>
  )
}

const inputStyle = {
  width: '100%',
  padding: '7px 10px',
  fontSize: 13,
  border: '1px solid var(--border)',
  borderRadius: 6,
  background: 'var(--bg-input)',
  color: 'var(--text-primary)',
  height: 36,
  boxSizing: 'border-box',
}

const btnPrimary = {
  padding: '7px 16px', fontSize: 13, fontWeight: 600,
  background: 'var(--accent-green)', color: '#0d0e14',
  border: 'none', borderRadius: 6, cursor: 'pointer',
}
const btnSecondary = {
  padding: '7px 16px', fontSize: 13,
  background: 'transparent', color: 'var(--text-secondary)',
  border: '1px solid var(--border)', borderRadius: 6, cursor: 'pointer',
}
const kbdStyle = {
  padding: '1px 5px', fontSize: 10, fontFamily: 'monospace',
  background: 'var(--bg-elevated)', border: '1px solid var(--border)',
  borderRadius: 3, color: 'var(--text-muted)',
}
