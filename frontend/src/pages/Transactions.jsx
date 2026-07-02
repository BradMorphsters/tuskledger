import { useState, useEffect, useRef, useMemo } from 'react'
import { Search, Filter, ChevronLeft, ChevronRight, Split, X, Plus, Star } from 'lucide-react'
import {
  getTransactions, getTransactionsTotals, updateTransaction, getCategories, getBusinesses,
  replaceTransactionSplits, clearTransactionSplits, getExportUrl,
} from '../api/client'
import { useAccounts } from '../hooks/useAccounts'
import { useFocusTrap } from '../hooks/useFocusTrap'
import { useLatestRequest } from '../hooks/useLatestRequest'
import BusinessBadge from '../components/BusinessBadge'
import Pill from '../components/Pill'
import MerchantDrawer from '../components/MerchantDrawer'
import { formatCurrency, formatDate, toLocalISODate } from '../lib/format'

export default function Transactions() {
  const [transactions, setTransactions] = useState([])
  // Server-computed aggregate across the FULL filter scope (not just the
  // current page). The header summary line reads from this so it stays
  // accurate when results exceed the page limit. Falls back to local
  // page sums while loading / on error.
  const [scopeTotals, setScopeTotals] = useState(null)
  const { accounts } = useAccounts()
  const [categories, setCategories] = useState([])
  const [filters, setFilters] = useState({
    account_id: '',
    category: '',
    business_id: '',
    q: '',
    start_date: '',
    end_date: '',
    limit: 50,
    offset: 0,
  })
  const [businesses, setBusinesses] = useState([])
  const [editingId, setEditingId] = useState(null)
  const [editCategory, setEditCategory] = useState('')
  const [splitTxn, setSplitTxn] = useState(null)  // transaction being split-edited
  const [suggestApplyCategory, setSuggestApplyCategory] = useState(null)  // auto-suggest state
  const [selectedIds, setSelectedIds] = useState(new Set())
  // Keyboard-nav cursor index. -1 = no row focused. J/K move up/down,
  // X toggles selection, E enters edit mode for the focused row's category.
  const [cursorIdx, setCursorIdx] = useState(-1)
  const [bulkCategory, setBulkCategory] = useState('')
  const [bulkCategoryOpen, setBulkCategoryOpen] = useState(false)
  const [merchantDrawerName, setMerchantDrawerName] = useState(null)

  // Pinned/starred transactions — local-only personal annotation, persisted
  // to localStorage. Useful for marking "investigate this", "tax-deductible",
  // or "ask spouse about this" without polluting the categorization model.
  const [pinnedIds, setPinnedIds] = useState(() => {
    try {
      const raw = localStorage.getItem('tuskledger.pinnedTransactions.v1')
      return raw ? new Set(JSON.parse(raw)) : new Set()
    } catch { return new Set() }
  })
  const [pinnedOnly, setPinnedOnly] = useState(false)

  const togglePin = (id) => {
    setPinnedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      try { localStorage.setItem('tuskledger.pinnedTransactions.v1', JSON.stringify([...next])) } catch {}
      return next
    })
  }

  const runLoad = useLatestRequest()
  const load = () => {
    const params = {}
    if (filters.account_id) params.account_id = filters.account_id
    if (filters.category) params.category = filters.category
    if (filters.business_id) params.business_id = filters.business_id
    if (filters.q) params.q = filters.q
    if (filters.start_date) params.start_date = filters.start_date
    if (filters.end_date) params.end_date = filters.end_date
    params.limit = filters.limit
    params.offset = filters.offset
    // Guard both fetches so a slow response for a previous filter/page
    // can't render under the current one.
    runLoad(token => {
      getTransactions(params).then(d => { if (token.live) setTransactions(d) }).catch(() => {})
      // Totals are computed across the full filter scope on the server —
      // limit/offset are stripped by getTransactionsTotals so paginating
      // doesn't change the summary line.
      getTransactionsTotals(params)
        .then(d => { if (token.live) setScopeTotals(d) })
        .catch(() => { if (token.live) setScopeTotals(null) })
    })
  }

  useEffect(() => {
    getCategories().then(setCategories).catch(() => {})
    getBusinesses().then(setBusinesses).catch(() => {})
    // Note: the initial transaction load is owned by the [filters] effect
    // below, which runs on mount too. Calling load() here as well fired a
    // duplicate request (plus a duplicate totals request) on every open.
  }, [])

  useEffect(() => {
    // Debounce the load based on filter changes. Runs on mount as well,
    // so it owns the initial load.
    const timeoutId = setTimeout(() => {
      load()
    }, 250)
    // A filter change invalidates the current selection: selected ids can
    // reference rows that are no longer on the page, and bulk actions
    // would then either throw or silently mutate invisible rows. Clear it.
    setSelectedIds(new Set())
    return () => clearTimeout(timeoutId)
  }, [filters])

  const handleCategoryUpdate = async (id) => {
    const txn = transactions.find(t => t.id === id)
    await updateTransaction(id, { custom_category: editCategory })
    setEditingId(null)
    
    // Auto-suggest: find other un/differently-categorized txns from same merchant
    if (txn && txn.merchant_name) {
      const merchant = txn.merchant_name
      const candidates = transactions.filter(t =>
        t.id !== id &&
        t.merchant_name === merchant &&
        (t.custom_category || t.category) !== editCategory
      )
      if (candidates.length >= 2) {
        setSuggestApplyCategory({
          category: editCategory,
          merchant: merchant,
          count: candidates.length,
          transactionIds: candidates.map(c => c.id),
        })
      }
    }
    
    load()
  }

  const handleBusinessUpdate = async (txnId, bizId) => {
    await updateTransaction(txnId, { business_id: bizId ? Number(bizId) : 0 })
    load()
  }

  const toggleSelect = (id) => {
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const toggleSelectAll = () => {
    if (selectedIds.size === displayed.length) {
      setSelectedIds(new Set())
    } else {
      setSelectedIds(new Set(displayed.map(t => t.id)))
    }
  }

  const bulkCategorize = async () => {
    if (!bulkCategory) return
    // Only act on selected rows still present on the current page —
    // selection can outlive a filter/page change, and mutating rows the
    // user can no longer see is surprising.
    await Promise.all(
      Array.from(selectedIds)
        .filter(id => transactions.some(t => t.id === id))
        .map(id => updateTransaction(id, { custom_category: bulkCategory }))
    )
    setBulkCategory('')
    setBulkCategoryOpen(false)
    setSelectedIds(new Set())
    load()
  }

  const bulkToggleTransfer = async () => {
    await Promise.all(
      Array.from(selectedIds).map(id => {
        const txn = transactions.find(t => t.id === id)
        // Guard: the selected row may have left the page after a filter
        // or pagination change, in which case find() returns undefined.
        if (!txn) return null
        return updateTransaction(id, { is_transfer: !txn.is_transfer })
      })
    )
    setSelectedIds(new Set())
    load()
  }

  const bulkClear = () => {
    setSelectedIds(new Set())
  }

  // Quick date range presets
  const setDatePreset = (preset) => {
    const now = new Date()
    let start = ''
    const end = toLocalISODate(now)
    if (preset === '7d') {
      const d = new Date(now); d.setDate(d.getDate() - 7)
      start = toLocalISODate(d)
    } else if (preset === '30d') {
      const d = new Date(now); d.setDate(d.getDate() - 30)
      start = toLocalISODate(d)
    } else if (preset === '90d') {
      const d = new Date(now); d.setDate(d.getDate() - 90)
      start = toLocalISODate(d)
    } else if (preset === 'month') {
      start = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`
    } else if (preset === 'all') {
      start = ''
    }
    setFilters(f => ({ ...f, start_date: start, end_date: preset === 'all' ? '' : end, offset: 0 }))
  }

  // Update the search filter. The actual debounced load is owned by the
  // [filters] effect, so there's no separate timer to manage here.
  const handleSearchChange = (value) => {
    setFilters(f => ({ ...f, q: value, offset: 0 }))
  }

  // Displayed transactions (server already filtered by q). Pinned-only
  // is a client-side filter — pinning is purely local so we can't push it
  // to the server, but on a 50-row page that's fine.
  const displayed = useMemo(
    () => pinnedOnly ? transactions.filter(t => pinnedIds.has(t.id)) : transactions,
    [transactions, pinnedOnly, pinnedIds]
  )

  // ── Keyboard navigation ───────────────────────────────────────
  // J / down arrow → move cursor down
  // K / up arrow   → move cursor up
  // X              → toggle selection of cursor row
  // E              → enter edit mode for cursor row's category
  // Esc            → exit edit mode
  // Suppressed when focus is in an input/select/textarea (so typing in
  // search/filters/edit fields doesn't navigate).
  useEffect(() => {
    const handler = (e) => {
      const tag = e.target.tagName
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (displayed.length === 0) return
      const k = e.key.toLowerCase()
      if (k === 'j' || e.key === 'ArrowDown') {
        e.preventDefault()
        setCursorIdx(i => Math.min(displayed.length - 1, (i < 0 ? 0 : i + 1)))
      } else if (k === 'k' || e.key === 'ArrowUp') {
        e.preventDefault()
        setCursorIdx(i => Math.max(0, (i < 0 ? 0 : i - 1)))
      } else if (k === 'x' && cursorIdx >= 0) {
        e.preventDefault()
        const t = displayed[cursorIdx]
        if (t) {
          setSelectedIds(prev => {
            const next = new Set(prev)
            if (next.has(t.id)) next.delete(t.id)
            else next.add(t.id)
            return next
          })
        }
      } else if (k === 'e' && cursorIdx >= 0) {
        e.preventDefault()
        const t = displayed[cursorIdx]
        if (t) {
          setEditingId(t.id)
          setEditCategory(t.custom_category || t.category || '')
        }
      } else if (e.key === 'Escape' && editingId) {
        e.preventDefault()
        setEditingId(null)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [displayed, cursorIdx, editingId])

  // Totals
  // ──────
  // Source of truth depends on which filter set is active:
  //
  //   1. Default — server-computed scopeTotals across ALL rows matching
  //      the current backend filter (account/category/business/dates/q).
  //      This is what the user expects: "Spent / Income at the top
  //      reflects the entire filtered result, not just the visible
  //      page." Paginating no longer changes the numbers.
  //
  //   2. Pinned-only toggle — pinning is a client-only annotation, so
  //      the server can't compute its scope. In that case fall back to
  //      summing the displayed rows (which are already filtered to
  //      pinned). The pinned-only filter is intended for spot-checking
  //      a small handful of starred items, so a page-bound sum is
  //      acceptable here.
  //
  //   3. Loading / error — fall back to page-derived totals so the
  //      header doesn't disappear during the first request.
  const pageSpending = displayed.filter(t => t.amount > 0).reduce((s, t) => s + t.amount, 0)
  const pageIncome = displayed.filter(t => t.amount < 0).reduce((s, t) => s + Math.abs(t.amount), 0)
  const useScope = scopeTotals && !pinnedOnly
  const totalSpending = useScope ? scopeTotals.spending : pageSpending
  const totalIncome = useScope ? scopeTotals.income : pageIncome
  const totalCount = useScope ? scopeTotals.count : displayed.length

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">Transactions</h1>
        <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>
          {totalCount} transaction{totalCount !== 1 ? 's' : ''}
          {!useScope && displayed.length !== totalCount && (
            <span title="Pinned-only is a local filter, so totals reflect the loaded page."> (page)</span>
          )}
          {totalSpending > 0 && <span> · Spent: <span style={{ color: 'var(--accent-red)' }}>{formatCurrency(totalSpending)}</span></span>}
          {totalIncome > 0 && <span> · Income: <span style={{ color: 'var(--accent-green)' }}>{formatCurrency(totalIncome)}</span></span>}
          {useScope && scopeTotals?.transfers_excluded > 0 && (
            <span
              title={
                `Excludes ${scopeTotals.transfers_excluded} transfer row${scopeTotals.transfers_excluded !== 1 ? 's' : ''} ` +
                `(account-to-account moves, CC autopays, etc.) so income and spending reflect real money movement, ` +
                `not paired internal flows. Transfer rows are still visible in the list below.`
              }
              style={{ marginLeft: 6, fontSize: 11, opacity: 0.7, cursor: 'help' }}
            >
              · excludes {scopeTotals.transfers_excluded} transfer{scopeTotals.transfers_excluded !== 1 ? 's' : ''}
            </span>
          )}
        </div>
      </div>

      {/* Filters */}
      <div className="card" style={{ padding: 16, marginBottom: 16 }}>
        {/* Account pills row — fastest path to "just show me Chase Checking"
            without diving into the dropdown. Pills are sorted with depository
            first (where most filtering happens), then credit, then everything
            else; loans are excluded because users rarely filter the
            transactions list to a mortgage account. The full list is still
            available in the Account dropdown below for users with many
            accounts or unusual types. Horizontal scroll keeps the row a
            single line even with 15+ accounts. */}
        {accounts.length > 1 && (
          <div style={{
            display: 'flex',
            gap: 6,
            overflowX: 'auto',
            paddingBottom: 8,
            marginBottom: 12,
            borderBottom: '1px solid var(--border-soft)',
          }}>
            {(() => {
              // Sort: depository → credit → investment → other.
              // Loans excluded — filtering txns to a mortgage account is
              // a rare workflow and adds noise to the chip row.
              const TYPE_ORDER = { depository: 0, credit: 1, investment: 2 }
              const visible = accounts
                .filter(a => a.type !== 'loan')
                .slice()
                .sort((a, b) => {
                  const oa = TYPE_ORDER[a.type] ?? 99
                  const ob = TYPE_ORDER[b.type] ?? 99
                  if (oa !== ob) return oa - ob
                  return (a.custom_name || a.name || '').localeCompare(b.custom_name || b.name || '')
                })
              const allActive = !filters.account_id
              const pillStyle = (active) => ({
                whiteSpace: 'nowrap',
                padding: '5px 12px',
                fontSize: 12,
                fontWeight: active ? 600 : 500,
                background: active ? 'var(--accent-blue)' : 'var(--bg-primary)',
                color: active ? '#000' : 'var(--text-secondary)',
                border: `1px solid ${active ? 'var(--accent-blue)' : 'var(--border)'}`,
                borderRadius: 999,
                cursor: 'pointer',
                transition: 'background 0.15s, color 0.15s, border-color 0.15s',
              })
              return (
                <>
                  <button
                    onClick={() => setFilters(f => ({ ...f, account_id: '', offset: 0 }))}
                    style={pillStyle(allActive)}
                    title="Show transactions across all accounts"
                  >
                    All
                  </button>
                  {visible.map(a => {
                    const active = String(filters.account_id) === String(a.id)
                    const label = a.custom_name || a.name || `Account ${a.id}`
                    // Truncate long account names so the pill stays compact.
                    // Full name shows in the title (browser tooltip).
                    const short = label.length > 22 ? label.slice(0, 20) + '…' : label
                    return (
                      <button
                        key={a.id}
                        onClick={() => setFilters(f => ({
                          ...f,
                          account_id: active ? '' : String(a.id),
                          offset: 0,
                        }))}
                        title={label + (a.mask ? ` ····${a.mask}` : '')}
                        style={pillStyle(active)}
                      >
                        {short}
                      </button>
                    )
                  })}
                </>
              )
            })()}
          </div>
        )}
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
          {/* Search */}
          <div style={{ position: 'relative', flex: 1, minWidth: 200 }}>
            <Search size={14} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }} />
            <input
              type="text"
              placeholder="Search transactions…"
              value={filters.q}
              onChange={e => handleSearchChange(e.target.value)}
              style={{
                background: 'var(--bg-primary)', color: 'var(--text-primary)', border: '1px solid var(--border)',
                borderRadius: 8, padding: `8px 12px 8px 32px`, paddingRight: filters.q ? 28 : 12, fontSize: 13, width: '100%'
              }}
            />
            {filters.q && (
              <button
                onClick={() => handleSearchChange('')}
                title="Clear search"
                style={{
                  position: 'absolute',
                  right: 8,
                  top: '50%',
                  transform: 'translateY(-50%)',
                  background: 'none',
                  border: 'none',
                  color: 'var(--text-muted)',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  padding: '4px',
                }}
              >
                <X size={14} />
              </button>
            )}
          </div>

          {/* Account filter */}
          <select
            value={filters.account_id}
            onChange={e => setFilters(f => ({ ...f, account_id: e.target.value, offset: 0 }))}
            style={{
              background: 'var(--bg-primary)', color: 'var(--text-primary)', border: '1px solid var(--border)',
              borderRadius: 8, padding: '8px 12px', fontSize: 13
            }}
          >
            <option value="">All Accounts</option>
            {accounts.map(a => <option key={a.id} value={a.id}>{a.custom_name || a.name}</option>)}
          </select>

          {/* Category filter */}
          <select
            value={filters.category}
            onChange={e => setFilters(f => ({ ...f, category: e.target.value, offset: 0 }))}
            style={{
              background: 'var(--bg-primary)', color: 'var(--text-primary)', border: '1px solid var(--border)',
              borderRadius: 8, padding: '8px 12px', fontSize: 13
            }}
          >
            <option value="">All Categories</option>
            {categories.map(c => <option key={c.name} value={c.name}>{c.icon} {c.name}</option>)}
          </select>

          {/* Business filter — only shows when there are businesses configured.
              Lets you slice the transactions list to a single business for
              tax prep, P&L reviews, and per-entity expense tracking. */}
          {businesses.length > 0 && (
            <select
              value={filters.business_id}
              onChange={e => setFilters(f => ({ ...f, business_id: e.target.value, offset: 0 }))}
              style={{
                background: 'var(--bg-primary)', color: 'var(--text-primary)', border: '1px solid var(--border)',
                borderRadius: 8, padding: '8px 12px', fontSize: 13,
              }}
            >
              <option value="">All Businesses</option>
              {businesses.map(b => <option key={b.id} value={b.id}>🏢 {b.name}</option>)}
            </select>
          )}

          {/* Export current filter to CSV. Uses the existing /export
              endpoint via getExportUrl. Date range comes through the
              start/end pickers; account / category / business filters
              are applied client-side after download (export endpoint
              currently only supports date range).
              For now: redirects to the URL which triggers download. */}
          <a
            href={getExportUrl(filters.start_date, filters.end_date, {
              account_id: filters.account_id || null,
              category: filters.category || null,
              business_id: filters.business_id || null,
            })}
            target="_blank"
            rel="noreferrer"
            style={{
              background: 'transparent', color: 'var(--text-secondary)',
              border: '1px solid var(--border)', borderRadius: 8,
              padding: '7px 12px', fontSize: 13, textDecoration: 'none',
              display: 'inline-flex', alignItems: 'center', gap: 4,
            }}
            title="Download filtered transactions as CSV"
          >
            ⬇ Export CSV
          </a>
        </div>

        {/* Quick filter chips — preset filter combos for the most common
            use cases. Click toggles the preset on/off. Lives in
            localStorage as the chip-bar state so the active chip
            survives reloads. */}
        <QuickFilterChips
          filters={filters}
          setFilters={setFilters}
          businesses={businesses}
          extra={
            pinnedIds.size > 0 && (
              <button
                onClick={() => setPinnedOnly(o => !o)}
                style={{
                  padding: '4px 10px', fontSize: 11,
                  background: pinnedOnly ? 'rgba(251,191,36,0.18)' : 'transparent',
                  color: pinnedOnly ? 'var(--accent-yellow)' : 'var(--text-secondary)',
                  border: `1px solid ${pinnedOnly ? 'var(--accent-yellow)' : 'var(--border)'}`,
                  borderRadius: 999, cursor: 'pointer',
                  fontWeight: pinnedOnly ? 600 : 400,
                  display: 'inline-flex', alignItems: 'center', gap: 4,
                }}
                title="Show only pinned transactions"
              >
                <Star size={11} fill={pinnedOnly ? 'currentColor' : 'none'} />
                Pinned ({pinnedIds.size})
              </button>
            )
          }
        />

        {/* Date range */}
        <div style={{ display: 'flex', gap: 8, marginTop: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={{ fontSize: 12, color: 'var(--text-muted)', marginRight: 4 }}>Date:</span>
          {[
            { label: 'This Month', value: 'month' },
            { label: '7 Days', value: '7d' },
            { label: '30 Days', value: '30d' },
            { label: '90 Days', value: '90d' },
            { label: 'All Time', value: 'all' },
          ].map(p => (
            <button
              key={p.value}
              onClick={() => setDatePreset(p.value)}
              style={{
                background: 'var(--bg-hover)', color: 'var(--text-secondary)', border: '1px solid var(--border)',
                borderRadius: 6, padding: '4px 12px', fontSize: 12, cursor: 'pointer'
              }}
            >
              {p.label}
            </button>
          ))}
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginLeft: 8 }}>
            <input
              type="date"
              value={filters.start_date}
              onChange={e => setFilters(f => ({ ...f, start_date: e.target.value, offset: 0 }))}
              style={{
                background: 'var(--bg-primary)', color: 'var(--text-primary)', border: '1px solid var(--border)',
                borderRadius: 6, padding: '4px 8px', fontSize: 12
              }}
            />
            <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>to</span>
            <input
              type="date"
              value={filters.end_date}
              onChange={e => setFilters(f => ({ ...f, end_date: e.target.value, offset: 0 }))}
              style={{
                background: 'var(--bg-primary)', color: 'var(--text-primary)', border: '1px solid var(--border)',
                borderRadius: 6, padding: '4px 8px', fontSize: 12
              }}
            />
          </div>
        </div>
      </div>

      {/* Transaction table */}
      <div className="card">
        <div className="table-wrapper">
          <table className="txn-table">
            <thead>
              <tr>
                <th style={{ width: 24 }}>
                  <input
                    type="checkbox"
                    checked={selectedIds.size === displayed.length && displayed.length > 0}
                    onChange={toggleSelectAll}
                    style={{ cursor: 'pointer' }}
                    title={selectedIds.size === displayed.length ? 'Deselect all' : 'Select all'}
                  />
                </th>
                <th>Date</th>
                <th>Description</th>
                <th>Category</th>
                <th>Business</th>
                <th>Account</th>
                <th style={{ textAlign: 'right' }}>Amount</th>
              </tr>
            </thead>
            <tbody>
              {displayed.map((t, idx) => {
                const acct = accounts.find(a => a.id === t.account_id)
                // Pending transactions get a muted, italicized treatment so
                // they're visually distinct from cleared rows. The user
                // wants to glance at the list and know "of these 30 rows,
                // 4 are still in flight at the bank." The badge inline with
                // the merchant name (rendered below) names it explicitly,
                // and the row-level dimming makes the list scannable
                // without reading every badge.
                const isPending = !!t.pending
                return (
                  <tr
                    key={t.id}
                    style={{
                      background: selectedIds.has(t.id)
                        ? 'rgba(96,165,250,0.12)'
                        : (idx === cursorIdx ? 'rgba(96,165,250,0.06)' : undefined),
                      // Subtle left-border highlight for the keyboard-cursor row
                      boxShadow: idx === cursorIdx ? 'inset 3px 0 0 var(--accent-blue)' : undefined,
                      opacity: isPending ? 0.65 : 1,
                      fontStyle: isPending ? 'italic' : 'normal',
                    }}
                  >
                    <td style={{ width: 24 }}>
                      <input
                        type="checkbox"
                        checked={selectedIds.has(t.id)}
                        onChange={() => toggleSelect(t.id)}
                        style={{ cursor: 'pointer' }}
                      />
                    </td>
                    <td style={{ whiteSpace: 'nowrap', fontSize: 13 }}>{formatDate(t.date)}</td>
                    <td>
                      <div style={{ fontWeight: 500, display: 'flex', alignItems: 'center', gap: 6 }}>
                        <button
                          onClick={() => togglePin(t.id)}
                          title={pinnedIds.has(t.id) ? 'Unpin' : 'Pin transaction'}
                          style={{
                            background: 'none', border: 'none', padding: 0, cursor: 'pointer',
                            color: pinnedIds.has(t.id) ? 'var(--accent-yellow)' : 'var(--text-muted)',
                            display: 'inline-flex', alignItems: 'center',
                            opacity: pinnedIds.has(t.id) ? 1 : 0.4,
                          }}
                        >
                          <Star size={13} fill={pinnedIds.has(t.id) ? 'currentColor' : 'none'} />
                        </button>
                        <span
                          onClick={() => setMerchantDrawerName(t.display_name || t.merchant_name || t.name)}
                          style={{ cursor: 'pointer', textDecoration: 'underline', color: 'var(--accent-blue)' }}
                          title="Click to view merchant details"
                        >
                          {t.display_name || t.merchant_name || t.name}
                        </span>
                        {t.is_transfer && (
                          <Pill tone="info" title="Account-to-account transfer or bill payment (not counted as spending)">
                            ↔ Transfer
                          </Pill>
                        )}
                        {isPending && (
                          <Pill
                            tone="warning"
                            title="Plaid reports this transaction as pending — amount, merchant, and category may all change once it clears."
                          >
                            Pending
                          </Pill>
                        )}
                      </div>
                      {t.display_name && (t.display_name !== (t.merchant_name || t.name)) && (
                        <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{t.merchant_name || t.name}</div>
                      )}
                    </td>
                    <td>
                      {editingId === t.id ? (
                        <div style={{ display: 'flex', gap: 4 }}>
                          <select
                            value={editCategory}
                            onChange={e => setEditCategory(e.target.value)}
                            autoFocus
                            style={{
                              background: 'var(--bg-primary)', color: 'var(--text-primary)',
                              border: '1px solid var(--accent-blue)', borderRadius: 6, padding: '4px 6px', fontSize: 12, width: 160
                            }}
                          >
                            <option value="">-- Select --</option>
                            {categories.map(c => (
                              <option key={c.name} value={c.name}>{c.icon} {c.name}</option>
                            ))}
                          </select>
                          <button
                            onClick={() => handleCategoryUpdate(t.id)}
                            style={{ background: 'var(--accent-green)', color: '#000', border: 'none', borderRadius: 6, padding: '4px 8px', fontSize: 11, cursor: 'pointer' }}
                          >Save</button>
                          <button
                            onClick={() => setEditingId(null)}
                            style={{ background: 'var(--bg-hover)', color: 'var(--text-secondary)', border: '1px solid var(--border)', borderRadius: 6, padding: '4px 8px', fontSize: 11, cursor: 'pointer' }}
                          >✕</button>
                        </div>
                      ) : t.splits && t.splits.length > 0 ? (
                        <div>
                          {t.splits.map(s => (
                            <div key={s.id} style={{ fontSize: 12, marginBottom: 2 }}>
                              <span className="category-badge" style={{ marginRight: 6 }}>{s.category}</span>
                              <span style={{ color: 'var(--text-muted)' }}>{formatCurrency(Math.abs(s.amount))}</span>
                            </div>
                          ))}
                          <button
                            onClick={() => setSplitTxn(t)}
                            style={{ background: 'none', border: 'none', color: 'var(--accent-blue)', fontSize: 11, cursor: 'pointer', padding: 0, marginTop: 2 }}
                          >edit splits</button>
                        </div>
                      ) : (
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          <span
                            className="category-badge"
                            onClick={() => { setEditingId(t.id); setEditCategory(t.custom_category || t.category || '') }}
                            style={{ cursor: 'pointer' }}
                            title="Click to recategorize"
                          >
                            {t.custom_category || t.category || 'Uncategorized'}
                          </span>
                          <button
                            onClick={() => setSplitTxn(t)}
                            title="Split this transaction across categories"
                            style={{
                              background: 'none', border: '1px solid var(--border)', borderRadius: 6,
                              padding: '2px 5px', cursor: 'pointer', color: 'var(--text-muted)',
                              display: 'inline-flex', alignItems: 'center',
                            }}
                          >
                            <Split size={11} />
                          </button>
                        </div>
                      )}
                    </td>
                    <td>
                      {businesses.length > 0 ? (
                        <select
                          value={t.business_id || ''}
                          onChange={e => handleBusinessUpdate(t.id, e.target.value)}
                          style={{
                            background: 'transparent', color: 'var(--text-primary)',
                            border: t.business_id ? `1px solid ${businesses.find(b => b.id === t.business_id)?.color || 'var(--border)'}` : '1px solid var(--border)',
                            borderRadius: 6, padding: '3px 6px', fontSize: 11, cursor: 'pointer',
                            backgroundColor: t.business_id ? `${businesses.find(b => b.id === t.business_id)?.color || ''}15` : 'transparent',
                          }}
                        >
                          <option value="">Personal</option>
                          {businesses.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
                        </select>
                      ) : (
                        <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>—</span>
                      )}
                    </td>
                    <td style={{ fontSize: 13, color: 'var(--text-secondary)' }}>{acct?.custom_name || acct?.name || '—'}</td>
                    <td style={{ textAlign: 'right' }}>
                      <span className={t.amount > 0 ? 'amount-negative' : 'amount-positive'}>
                        {t.amount > 0 ? '-' : '+'}{formatCurrency(Math.abs(t.amount))}
                      </span>
                    </td>
                  </tr>
                )
              })}
              {displayed.length === 0 && (
                <tr><td colSpan={7} style={{ textAlign: 'center', color: 'var(--text-muted)', padding: 40 }}>No transactions found</td></tr>
              )}
            </tbody>
          </table>
        </div>

        {/* Bulk action bar */}
        {selectedIds.size > 0 && (
          <div style={{
            position: 'fixed',
            bottom: 0,
            left: 0,
            right: 0,
            background: 'var(--bg-card)',
            borderTop: '1px solid var(--border)',
            padding: 16,
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            boxShadow: '0 -2px 8px rgba(0,0,0,0.1)',
            zIndex: 99,
          }}>
            <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
              {selectedIds.size} selected
            </span>
            <button
              onClick={() => setBulkCategoryOpen(!bulkCategoryOpen)}
              className="btn btn-secondary"
              style={{ padding: '6px 12px', fontSize: 12 }}
            >
              Categorize
            </button>
            <button
              onClick={bulkToggleTransfer}
              className="btn btn-secondary"
              style={{ padding: '6px 12px', fontSize: 12 }}
            >
              Mark as Transfer
            </button>
            <button
              onClick={bulkClear}
              className="btn btn-secondary"
              style={{ padding: '6px 12px', fontSize: 12 }}
            >
              Clear
            </button>
            <div style={{ marginLeft: 'auto' }} />
            {bulkCategoryOpen && (
              <div style={{ display: 'flex', gap: 6 }}>
                <select
                  value={bulkCategory}
                  onChange={e => setBulkCategory(e.target.value)}
                  style={{
                    background: 'var(--bg-primary)',
                    color: 'var(--text-primary)',
                    border: '1px solid var(--border)',
                    borderRadius: 6,
                    padding: '6px 8px',
                    fontSize: 12,
                  }}
                >
                  <option value="">-- Select category --</option>
                  {categories.map(c => (
                    <option key={c.name} value={c.name}>{c.icon} {c.name}</option>
                  ))}
                </select>
                <button
                  onClick={bulkCategorize}
                  disabled={!bulkCategory}
                  className="btn btn-primary"
                  style={{ padding: '6px 12px', fontSize: 12 }}
                >
                  Apply
                </button>
              </div>
            )}
          </div>
        )}

        {/* Pagination */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 16, paddingTop: 16, borderTop: '1px solid var(--border)', marginBottom: selectedIds.size > 0 ? 80 : 0 }}>
          <button
            onClick={() => setFilters(f => ({ ...f, offset: Math.max(0, f.offset - f.limit) }))}
            disabled={filters.offset === 0}
            className="btn btn-secondary"
            style={{ padding: '6px 14px', fontSize: 12, opacity: filters.offset === 0 ? 0.4 : 1 }}
          >
            <ChevronLeft size={14} /> Previous
          </button>
          <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>
            Showing {filters.offset + 1}–{filters.offset + displayed.length}
            {useScope && totalCount > displayed.length && ` of ${totalCount}`}
          </span>
          <button
            onClick={() => setFilters(f => ({ ...f, offset: f.offset + f.limit }))}
            disabled={transactions.length < filters.limit}
            className="btn btn-secondary"
            style={{ padding: '6px 14px', fontSize: 12, opacity: transactions.length < filters.limit ? 0.4 : 1 }}
          >
            Next <ChevronRight size={14} />
          </button>
        </div>
      </div>

      {/* Auto-suggest category application */}
      {suggestApplyCategory && (
        <div style={{
          position: 'fixed',
          bottom: 24,
          right: 24,
          background: 'var(--bg-card)',
          border: '1px solid var(--border)',
          borderRadius: 8,
          padding: 12,
          maxWidth: 320,
          boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
          zIndex: 999,
        }}>
          <div style={{ fontSize: 13, marginBottom: 8 }}>
            <span style={{ fontWeight: 500 }}>Apply '{suggestApplyCategory.category}' to {suggestApplyCategory.count} other transaction{suggestApplyCategory.count !== 1 ? 's' : ''} from <strong>{suggestApplyCategory.merchant}</strong>?</span>
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            <button
              onClick={async () => {
                // Apply category to all candidates
                await Promise.all(
                  suggestApplyCategory.transactionIds.map(tid =>
                    updateTransaction(tid, { custom_category: suggestApplyCategory.category })
                  )
                )
                setSuggestApplyCategory(null)
                load()
              }}
              style={{
                flex: 1,
                background: 'var(--accent-green)',
                color: '#000',
                border: 'none',
                borderRadius: 4,
                padding: '6px 10px',
                fontSize: 12,
                fontWeight: 500,
                cursor: 'pointer',
              }}
            >
              Apply
            </button>
            <button
              onClick={() => setSuggestApplyCategory(null)}
              style={{
                flex: 1,
                background: 'var(--bg-hover)',
                color: 'var(--text-secondary)',
                border: '1px solid var(--border)',
                borderRadius: 4,
                padding: '6px 10px',
                fontSize: 12,
                cursor: 'pointer',
              }}
            >
              Dismiss
            </button>
          </div>
        </div>
      )}

      {splitTxn && (
        <SplitModal
          transaction={splitTxn}
          categories={categories}
          onClose={() => setSplitTxn(null)}
          onSaved={() => { setSplitTxn(null); load() }}
        />
      )}

      <MerchantDrawer
        merchantName={merchantDrawerName}
        onClose={() => setMerchantDrawerName(null)}
      />
    </div>
  )
}


function SplitModal({ transaction, categories, onClose, onSaved }) {
  const parentAmount = transaction.amount
  const sign = parentAmount >= 0 ? 1 : -1
  const parentAbs = Math.abs(parentAmount)

  // Initialize: if txn already has splits, load them; else start with a 50/50 split
  const initial = transaction.splits && transaction.splits.length > 0
    ? transaction.splits.map(s => ({
        amount: String(Math.abs(s.amount).toFixed(2)),
        category: s.category,
        note: s.note || '',
      }))
    : [
        { amount: (parentAbs / 2).toFixed(2), category: transaction.custom_category || transaction.category || '', note: '' },
        { amount: (parentAbs / 2).toFixed(2), category: '', note: '' },
      ]

  const [rows, setRows] = useState(initial)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const containerRef = useRef(null)
  useFocusTrap(containerRef, true)

  // Escape closes the modal.
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const total = rows.reduce((s, r) => s + (parseFloat(r.amount) || 0), 0)
  const remaining = parentAbs - total
  const isValid =
    rows.length >= 2 &&
    rows.every(r => r.category && parseFloat(r.amount) > 0) &&
    Math.abs(remaining) < 0.01

  const updateRow = (i, patch) =>
    setRows(rs => rs.map((r, idx) => idx === i ? { ...r, ...patch } : r))
  const addRow = () =>
    setRows(rs => [...rs, { amount: Math.max(0, remaining).toFixed(2), category: '', note: '' }])
  const removeRow = (i) =>
    setRows(rs => rs.filter((_, idx) => idx !== i))

  const save = async () => {
    setError('')
    setSaving(true)
    try {
      const payload = rows.map(r => ({
        amount: parseFloat(r.amount) * sign,
        category: r.category,
        note: r.note || null,
      }))
      await replaceTransactionSplits(transaction.id, payload)
      onSaved()
    } catch (e) {
      setError(e.message || 'Failed to save splits')
    } finally {
      setSaving(false)
    }
  }

  const unsplit = async () => {
    setSaving(true)
    try {
      await clearTransactionSplits(transaction.id)
      onSaved()
    } finally {
      setSaving(false)
    }
  }

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
      }}
    >
      <div
        ref={containerRef}
        role="dialog"
        aria-modal="true"
        aria-label="Split transaction"
        onClick={e => e.stopPropagation()}
        style={{
          background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 12,
          padding: 24, width: 'min(560px, 92vw)', color: 'var(--text-primary)',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <h3 style={{ margin: 0 }}>Split transaction</h3>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer' }}>
            <X size={18} />
          </button>
        </div>

        <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 16 }}>
          <strong>{transaction.merchant_name || transaction.name}</strong>
          {' — '}
          {formatCurrency(parentAbs)}
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 12 }}>
          {rows.map((r, i) => (
            <div key={i} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <input
                type="number"
                step="0.01"
                value={r.amount}
                onChange={e => updateRow(i, { amount: e.target.value })}
                style={{
                  width: 100, background: 'var(--bg-primary)', color: 'var(--text-primary)',
                  border: '1px solid var(--border)', borderRadius: 6, padding: '6px 8px', fontSize: 13,
                }}
              />
              <select
                value={r.category}
                onChange={e => updateRow(i, { category: e.target.value })}
                style={{
                  flex: 1, background: 'var(--bg-primary)', color: 'var(--text-primary)',
                  border: '1px solid var(--border)', borderRadius: 6, padding: '6px 8px', fontSize: 13,
                }}
              >
                <option value="">-- Category --</option>
                {categories.map(c => <option key={c.name} value={c.name}>{c.icon} {c.name}</option>)}
              </select>
              <input
                type="text"
                placeholder="Note (optional)"
                value={r.note}
                onChange={e => updateRow(i, { note: e.target.value })}
                style={{
                  flex: 1, background: 'var(--bg-primary)', color: 'var(--text-primary)',
                  border: '1px solid var(--border)', borderRadius: 6, padding: '6px 8px', fontSize: 13,
                }}
              />
              {rows.length > 2 && (
                <button
                  onClick={() => removeRow(i)}
                  style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer' }}
                >
                  <X size={14} />
                </button>
              )}
            </div>
          ))}
        </div>

        <button
          onClick={addRow}
          style={{
            background: 'none', border: '1px dashed var(--border)', color: 'var(--text-secondary)',
            borderRadius: 6, padding: '6px 10px', fontSize: 12, cursor: 'pointer',
            display: 'inline-flex', alignItems: 'center', gap: 4, marginBottom: 16,
          }}
        >
          <Plus size={12} /> Add split
        </button>

        <div style={{
          padding: 10, borderRadius: 8, fontSize: 13, marginBottom: 12,
          background: Math.abs(remaining) < 0.01 ? 'rgba(34, 197, 94, 0.1)' : 'rgba(234, 179, 8, 0.1)',
          color: Math.abs(remaining) < 0.01 ? 'var(--accent-green)' : 'var(--accent-yellow)',
        }}>
          {Math.abs(remaining) < 0.01
            ? `✓ Splits sum to ${parentAbs.toFixed(2)}`
            : `${remaining > 0 ? 'Remaining' : 'Over by'} ${Math.abs(remaining).toFixed(2)}`}
        </div>

        {error && (
          <div style={{ color: 'var(--accent-red)', fontSize: 13, marginBottom: 12 }}>{error}</div>
        )}

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          {transaction.splits && transaction.splits.length > 0 && (
            <button
              onClick={unsplit}
              disabled={saving}
              className="btn btn-secondary"
              style={{ marginRight: 'auto' }}
            >
              Remove split
            </button>
          )}
          <button onClick={onClose} className="btn btn-secondary" disabled={saving}>Cancel</button>
          <button onClick={save} className="btn btn-primary" disabled={!isValid || saving}>
            {saving ? 'Saving…' : 'Save splits'}
          </button>
        </div>
      </div>
    </div>
  )
}


/**
 * QuickFilterChips — preset filter combos for the most common views.
 * Click a chip to apply its filter set; click again to clear. Active
 * chip is highlighted. Goes for "the 80% of common queries" — the
 * date pickers + dropdowns above still cover everything else.
 */
function QuickFilterChips({ filters, setFilters, businesses, extra }) {
  const today = toLocalISODate()
  const ago = (days) => {
    const d = new Date()
    d.setDate(d.getDate() - days)
    return toLocalISODate(d)
  }

  // Each chip describes a filter delta. matches() returns true if the
  // current filter state already represents that chip — so we can show
  // it active and toggle it off on second click.
  const chips = [
    {
      label: 'Recent income',
      apply: { category: 'Income', start_date: ago(30), end_date: today },
      matches: (f) => f.category === 'Income' && f.start_date === ago(30),
    },
    {
      label: 'Last 7 days',
      apply: { start_date: ago(7), end_date: today },
      matches: (f) => f.start_date === ago(7) && f.end_date === today,
    },
    {
      label: 'This year',
      apply: { start_date: `${new Date().getFullYear()}-01-01`, end_date: today },
      matches: (f) => f.start_date === `${new Date().getFullYear()}-01-01`,
    },
  ]
  // Add a "Business: <name>" chip per configured business
  businesses.forEach(b => {
    chips.push({
      label: `🏢 ${b.name}`,
      apply: { business_id: String(b.id) },
      matches: (f) => String(f.business_id) === String(b.id),
    })
  })

  const apply = (chip) => {
    if (chip.matches(filters)) {
      // Already active — clear the chip's filter contribution
      const cleared = { ...filters }
      Object.keys(chip.apply).forEach(k => { cleared[k] = '' })
      cleared.offset = 0
      setFilters(cleared)
    } else {
      setFilters(f => ({ ...f, ...chip.apply, offset: 0 }))
    }
  }

  return (
    <div style={{
      display: 'flex', gap: 6, marginTop: 12, alignItems: 'center', flexWrap: 'wrap',
    }}>
      <span style={{ fontSize: 11, color: 'var(--text-muted)', marginRight: 4 }}>Quick:</span>
      {chips.map((c, i) => {
        const active = c.matches(filters)
        return (
          <button
            key={i}
            onClick={() => apply(c)}
            style={{
              padding: '4px 10px', fontSize: 11,
              background: active ? 'var(--accent-blue-bg)' : 'transparent',
              color: active ? 'var(--accent-blue)' : 'var(--text-secondary)',
              border: `1px solid ${active ? 'var(--accent-blue-border)' : 'var(--border)'}`,
              borderRadius: 999, cursor: 'pointer',
              fontWeight: active ? 600 : 400,
            }}
          >
            {c.label}
          </button>
        )
      })}
      {extra}
    </div>
  )
}
