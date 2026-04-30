import { useState, useEffect } from 'react'
import { Plus, Trash2, Repeat, Copy, Briefcase } from 'lucide-react'
import { getSpendingSummary, getBudget, saveBudget } from '../api/client'
import TransactionDrawer from '../components/TransactionDrawer'
import { formatCurrencyZero as formatCurrency } from '../lib/format'

// View modes for separating business vs personal spend on the Budgets
// page. Persisted to localStorage so the user's choice survives reloads.
// 'personal' = the default, since the user asked for business not to
// inflate their personal category totals.
const VIEW_MODE_KEY = 'tuskledger.budgetViewMode.v1'
const VIEW_PERSONAL = 'personal'
const VIEW_BUSINESS = 'business'
const VIEW_ALL = 'all'

// Reserved category name for the synthetic "Business" rollup. The
// backend special-cases this name in spending-summary so it doesn't
// show up alongside normal personal categories. If the user already
// has a category literally named "Business", they'll need to rename it
// — which we surface in chat the first time it conflicts.
export const BUSINESS_CATEGORY = 'Business'

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

// Per-category "rolling" flag. When ON, any unspent amount from the
// PRIOR month is added to the current month's limit as a rollover
// credit. Useful for variable-cadence categories (home repair, auto
// maintenance, gifts) where it's normal to spend less in some months
// and a lot in others. Stored client-side in localStorage so we don't
// require a backend schema change — the underlying budget API just
// stores the periodic limit.
const ROLLOVER_KEY = 'tuskledger.budgetRollovers.v1'

function loadRollovers() {
  try { return JSON.parse(localStorage.getItem(ROLLOVER_KEY) || '{}') }
  catch { return {} }
}

function saveRollovers(o) {
  localStorage.setItem(ROLLOVER_KEY, JSON.stringify(o))
}

function monthRange(year, month) {
  const pad = n => String(n).padStart(2, '0')
  const first = `${year}-${pad(month)}-01`
  const lastDay = new Date(year, month, 0).getDate()
  const last = `${year}-${pad(month)}-${pad(lastDay)}`
  return { start_date: first, end_date: last }
}

// Walk back one month, handling January → December year wrap.
// Exported for unit tests (year-wrap is the easiest place to mis-handle).
export function priorMonth(year, month) {
  if (month === 1) return { year: year - 1, month: 12 }
  return { year, month: month - 1 }
}

// Compute the rollover credit a category receives this month from its
// prior month's unspent budget. Floored at 0 so an over-spend in a
// prior month does NOT carry forward as negative credit (industry
// rolling-budget convention — punishing a single bad month forever
// would be hostile design). Exported as a pure function so we can
// test the math without rendering Budgets.
export function rolloverCredit({ priorLimit, priorSpent }) {
  const limit = Number(priorLimit) || 0
  const spent = Number(priorSpent) || 0
  return Math.max(0, limit - spent)
}

// Decide which signal color a category should render in. The user's
// rule: NEVER red unless actually over budget. 90% used is still under
// — yellow is the soft "approaching limit" signal there; green for
// anything below that. Returns one of: 'over' | 'approaching' | 'ok'
// instead of CSS variables so callers can map to whatever theming they
// want (and tests don't have to assert against CSS strings).
export function budgetCategoryStatus({ spent, effectiveLimit }) {
  const s = Number(spent) || 0
  const l = Number(effectiveLimit) || 0
  if (l <= 0) return 'ok'  // no budget set → no signal
  if (s > l) return 'over'
  if (s / l >= 0.9) return 'approaching'
  return 'ok'
}

// Map a prior month's BudgetCategory list (as returned by GET
// /api/budgets/{month}/{year}) into the form-state shape used by this
// page: [{ category, limit_amount }]. The Copy-from-prior-month button
// uses this to populate the form for a fresh month so the user only has
// to tweak + save instead of re-entering every category. Exported pure
// so the year-wrap math + empty-list handling can be unit tested.
//
// - Filters out anything missing a category name (defensive: malformed
//   rows from a bad migration shouldn't poison the new month).
// - Coerces limit_amount to a number; non-numeric becomes 0 (the user
//   can re-edit before saving — better than crashing the form).
export function copyCategoriesFrom(priorCategories) {
  if (!Array.isArray(priorCategories)) return []
  return priorCategories
    .filter(c => c && typeof c.category === 'string' && c.category.trim() !== '')
    .map(c => ({
      category: c.category,
      limit_amount: Number(c.limit_amount) || 0,
    }))
}

export default function Budgets() {
  const now = new Date()
  const [month, setMonth] = useState(now.getMonth() + 1)
  const [year, setYear] = useState(now.getFullYear())
  const [spending, setSpending] = useState(null)
  const [categories, setCategories] = useState([])
  const [newCat, setNewCat] = useState('')
  const [newLimit, setNewLimit] = useState('')
  const [saving, setSaving] = useState(false)
  const [copying, setCopying] = useState(false)
  // Surfaces "Copied N categories from {priorMonth} — click Save to keep them"
  // or an error toast inline. Cleared on next month change.
  const [copyMessage, setCopyMessage] = useState(null)
  const [drillCategory, setDrillCategory] = useState(null)
  const [rollovers, setRollovers] = useState(loadRollovers)
  // Business-vs-personal view mode. Default 'personal' so business
  // spend doesn't inflate personal category totals.
  const [viewMode, setViewMode] = useState(() => {
    try { return localStorage.getItem(VIEW_MODE_KEY) || VIEW_PERSONAL }
    catch { return VIEW_PERSONAL }
  })
  const setViewModePersisted = (m) => {
    setViewMode(m)
    try { localStorage.setItem(VIEW_MODE_KEY, m) } catch { /* quota / private mode */ }
  }
  // Prior-month state for rollover credit calculation. We always load
  // both months when the user is viewing a budget, regardless of any
  // category being marked rolling — keeps the toggle responsive (no
  // round-trip needed when the user flips it ON).
  const [priorBudget, setPriorBudget] = useState([])
  const [priorSpending, setPriorSpending] = useState(null)

  const loadSpending = () => {
    getSpendingSummary(month, year, viewMode).then(setSpending).catch(() => setSpending(null))
  }

  useEffect(() => {
    loadSpending()
    setCopyMessage(null)  // clear any "copied N from..." banner when navigating months/view
    getBudget(month, year)
      .then(b => setCategories(b.categories.map(c => ({ category: c.category, limit_amount: c.limit_amount }))))
      .catch(() => setCategories([]))
    // Prior month for rollover math. Use the same view mode so personal
    // rollover credits don't include business spend (and vice versa).
    const pm = priorMonth(year, month)
    getBudget(pm.month, pm.year)
      .then(b => setPriorBudget(b.categories || []))
      .catch(() => setPriorBudget([]))
    getSpendingSummary(pm.month, pm.year, viewMode)
      .then(setPriorSpending)
      .catch(() => setPriorSpending(null))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [month, year, viewMode])

  // Tiny "saved" pulse shown inline after auto-save mutations (add /
  // delete) so the user gets feedback without needing the explicit
  // Save Budget button. Cleared by a setTimeout in autoSave below.
  const [autoSaved, setAutoSaved] = useState(false)

  // Persist a fresh categories list to the backend without going
  // through the "click Save Budget" flow. Used by add/delete so the
  // user doesn't have to remember to click Save — destructive actions
  // (delete) and quick adds should commit immediately, otherwise
  // navigating away loses them. Failures are rare (offline / backend
  // down) but we keep the local state pessimistically so the user can
  // retry via the explicit Save button.
  const autoSave = async (nextCategories) => {
    setSaving(true)
    try {
      await saveBudget({ month, year, categories: nextCategories })
      setAutoSaved(true)
      setTimeout(() => setAutoSaved(false), 1500)
    } catch (e) {
      // Surface failure via the copyMessage banner — same channel the
      // user already knows from the copy flow. Better to be loud than
      // silently keep stale state on the page.
      setCopyMessage({
        tone: 'warn',
        text: 'Auto-save failed. Click Save Budget to retry.',
      })
    } finally {
      setSaving(false)
    }
  }

  const addCategory = () => {
    if (!newCat || !newLimit) return
    const next = [...categories, { category: newCat, limit_amount: parseFloat(newLimit) }]
    setCategories(next)
    setNewCat('')
    setNewLimit('')
    autoSave(next)  // commit immediately so navigating away doesn't lose it
  }

  const removeCategory = (i) => {
    const next = categories.filter((_, idx) => idx !== i)
    setCategories(next)
    autoSave(next)  // delete is destructive — never let it linger uncommitted
  }

  const handleSave = async () => {
    setSaving(true)
    await saveBudget({ month, year, categories })
    setSaving(false)
    setCopyMessage(null)  // user has explicitly committed; banner no longer needed
  }

  // Copy categories + base limits from the prior month into the current
  // form state. Does NOT auto-save — the user gets a chance to tweak and
  // hit Save Budget. We surface a banner so they know what just happened
  // (form rows appearing out of nowhere is disorienting). Caveats:
  //   - If there's no prior-month budget, we tell them and bail.
  //   - If the current month already has categories, copy REPLACES them
  //     (this matches the behavior of the Save endpoint, which also
  //     replaces — so the user's mental model stays consistent).
  const handleCopyFromPrior = async () => {
    if (copying) return
    const pm = priorMonth(year, month)
    setCopying(true)
    try {
      const b = await getBudget(pm.month, pm.year)
      const copied = copyCategoriesFrom(b.categories)
      if (copied.length === 0) {
        setCopyMessage({
          tone: 'warn',
          text: `No budget found for ${MONTHS[pm.month - 1]} ${pm.year} to copy from.`,
        })
        return
      }
      setCategories(copied)
      setCopyMessage({
        tone: 'ok',
        text: `Copied ${copied.length} categor${copied.length === 1 ? 'y' : 'ies'} from ${MONTHS[pm.month - 1]} ${pm.year}. Adjust as needed and click Save Budget to keep them.`,
      })
    } catch (e) {
      setCopyMessage({
        tone: 'warn',
        text: `No budget found for ${MONTHS[pm.month - 1]} ${pm.year} to copy from.`,
      })
    } finally {
      setCopying(false)
    }
  }

  const getSpent = (cat) => {
    const found = spending?.categories?.find(c => c.category === cat)
    return found?.total || 0
  }

  // Rollover credit = prior month's unspent amount, floored at 0
  // (over-spend in a prior month does NOT roll into the current
  // month as negative — that would punish someone for a bad month
  // forever. Industry rolling-budget tools use the floor convention.)
  const getRolloverCredit = (catName) => {
    if (!rollovers[catName]) return 0
    const pb = priorBudget.find(c => c.category === catName)
    if (!pb) return 0
    const spent = priorSpending?.categories?.find(c => c.category === catName)?.total || 0
    return Math.max(0, pb.limit_amount - spent)
  }

  const toggleRollover = (catName) => {
    const next = { ...rollovers, [catName]: !rollovers[catName] }
    if (!next[catName]) delete next[catName]  // keep storage clean
    setRollovers(next)
    saveRollovers(next)
  }

  const pm = priorMonth(year, month)
  const priorMonthName = `${MONTHS[pm.month - 1]} ${pm.year}`

  // Split out the synthetic "Business" budget category so it renders on
  // its own rollup row (with spent = spending.business_total) and
  // doesn't appear in the personal categories list. Personal totals are
  // computed off the filtered list below so business spend doesn't
  // inflate the totals tile.
  const businessLimitCategory = categories.find(c => c.category === BUSINESS_CATEGORY)
  const personalCategories = categories.filter(c => c.category !== BUSINESS_CATEGORY)
  const businessSpent = spending?.business_total || 0
  const businessLimit = businessLimitCategory?.limit_amount
    ?? spending?.business_budget_limit
    ?? 0
  const businessStatus = budgetCategoryStatus({
    spent: businessSpent,
    effectiveLimit: businessLimit,
  })

  // Total budget incorporates rollover credits for any rolling categories.
  // Personal-side only — business is tracked on its own rollup row.
  const totalBaseLimit = personalCategories.reduce((s, c) => s + c.limit_amount, 0)
  const totalRolloverCredit = personalCategories.reduce(
    (s, c) => s + getRolloverCredit(c.category), 0,
  )
  const totalEffectiveLimit = totalBaseLimit + totalRolloverCredit

  // View-mode pill button factory. The selected mode controls which
  // transactions feed the categories list and totals tiles via the
  // business_filter sent to /spending-summary. The Business rollup row
  // is rendered separately and ALWAYS uses business_total regardless.
  const renderViewPill = (value, label, helpTitle) => {
    const active = viewMode === value
    return (
      <button
        key={value}
        onClick={() => setViewModePersisted(value)}
        title={helpTitle}
        style={{
          padding: '6px 12px',
          fontSize: 12,
          fontWeight: 600,
          letterSpacing: 0.3,
          textTransform: 'uppercase',
          borderRadius: 6,
          border: `1px solid ${active ? 'var(--accent-blue, #60a5fa)' : 'var(--border, rgba(255,255,255,0.1))'}`,
          background: active ? 'var(--accent-blue-bg, rgba(96,165,250,0.12))' : 'transparent',
          color: active ? 'var(--accent-blue, #60a5fa)' : 'var(--text-secondary)',
          cursor: 'pointer',
        }}
      >
        {label}
      </button>
    )
  }

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">Budgets</h1>
        <div style={{ display: 'flex', gap: 8 }}>
          <select
            value={month}
            onChange={e => setMonth(+e.target.value)}
            style={{ background: 'var(--bg-card)', color: 'var(--text-primary)', border: '1px solid var(--border)', borderRadius: 8, padding: '8px 12px' }}
          >
            {MONTHS.map((m, i) => <option key={i} value={i + 1}>{m}</option>)}
          </select>
          <select
            value={year}
            onChange={e => setYear(+e.target.value)}
            style={{ background: 'var(--bg-card)', color: 'var(--text-primary)', border: '1px solid var(--border)', borderRadius: 8, padding: '8px 12px' }}
          >
            {[2024, 2025, 2026, 2027].map(y => <option key={y} value={y}>{y}</option>)}
          </select>
        </div>
      </div>

      {/* Personal / Business / All view selector. Default 'personal' so
          business-tagged spend doesn't inflate personal category totals.
          'business' shows ONLY business-tagged spend grouped by category
          (useful for Schedule C bucketing during tax prep). 'all' is
          the legacy behavior for users who want one combined view. */}
      <div style={{
        display: 'flex',
        gap: 6,
        marginBottom: 16,
        alignItems: 'center',
      }}>
        <span style={{ fontSize: 12, color: 'var(--text-muted)', marginRight: 4 }}>View:</span>
        {renderViewPill(VIEW_PERSONAL, 'Personal', 'Hide business-tagged spend from category totals so personal numbers aren’t inflated. Business still shows as its own rollup row.')}
        {renderViewPill(VIEW_BUSINESS, 'Business only', 'Show ONLY business-tagged spend, grouped by its category — useful for Schedule C-style review during tax prep.')}
        {renderViewPill(VIEW_ALL, 'All', 'Combined view — business + personal in one set of category totals. The legacy behavior before this split was added.')}
      </div>

      {/* Budget overview */}
      <div className="stats-grid">
        <div className="stat-card">
          <div className="stat-label">Total Spent</div>
          <div className="stat-value">{formatCurrency(spending?.total_spent || 0)}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Total Budget</div>
          <div className="stat-value positive">
            {formatCurrency(totalEffectiveLimit)}
          </div>
          {totalRolloverCredit > 0 && (
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
              incl. {formatCurrency(totalRolloverCredit)} rolled from {priorMonthName}
            </div>
          )}
        </div>
        <div className="stat-card">
          <div className="stat-label">Remaining</div>
          <div className="stat-value" style={{
            color: (totalEffectiveLimit - (spending?.total_spent || 0)) >= 0
              ? 'var(--accent-green)' : 'var(--accent-red)'
          }}>
            {formatCurrency(totalEffectiveLimit - (spending?.total_spent || 0))}
          </div>
        </div>
      </div>

      {/* Category budgets */}
      <div className="card" style={{ marginBottom: 20 }}>
        <div className="card-header">
          <span className="card-title" style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
            Category Budgets
            {/* Subtle inline confirmation that an auto-save (add or
                delete) just succeeded. Pulses for ~1.5s then fades. */}
            {autoSaved && (
              <span
                style={{
                  fontSize: 11,
                  fontWeight: 600,
                  letterSpacing: 0.4,
                  textTransform: 'uppercase',
                  padding: '2px 8px',
                  borderRadius: 10,
                  background: 'var(--accent-green-bg, rgba(52,211,153,0.12))',
                  color: 'var(--accent-green, #34d399)',
                  border: '1px solid var(--accent-green-border, rgba(52,211,153,0.3))',
                }}
              >
                Saved
              </span>
            )}
          </span>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              className="btn btn-secondary"
              onClick={handleCopyFromPrior}
              disabled={copying}
              title={`Replace the form with whatever you budgeted in ${priorMonthName}. You can tweak before saving.`}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
            >
              <Copy size={14} />
              {copying ? 'Copying...' : `Copy from ${priorMonthName}`}
            </button>
            <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
              {saving ? 'Saving...' : 'Save Budget'}
            </button>
          </div>
        </div>

        {/* Banner shown after a copy: nudges the user to actually save (the
            categories on screen are uncommitted form state until they do). */}
        {copyMessage && (
          <div
            role="status"
            style={{
              marginBottom: 16,
              padding: '10px 12px',
              borderRadius: 8,
              fontSize: 13,
              background: copyMessage.tone === 'ok' ? 'var(--accent-blue-bg, rgba(96,165,250,0.1))' : 'var(--accent-yellow-bg, rgba(251,191,36,0.1))',
              border: `1px solid ${copyMessage.tone === 'ok' ? 'var(--accent-blue-border, rgba(96,165,250,0.3))' : 'var(--accent-yellow-border, rgba(251,191,36,0.3))'}`,
              color: copyMessage.tone === 'ok' ? 'var(--accent-blue, #60a5fa)' : 'var(--accent-yellow, #fbbf24)',
            }}
          >
            {copyMessage.text}
          </div>
        )}

        {/* Empty-state: large, friendly Copy CTA when no categories exist
            yet. Saves the user from staring at an empty form when they
            land on a fresh month. Hidden once at least one category is
            present (the header button is enough at that point). */}
        {categories.length === 0 && (
          <div
            style={{
              padding: '20px 16px',
              border: '1px dashed var(--border)',
              borderRadius: 8,
              textAlign: 'center',
              marginBottom: 16,
              color: 'var(--text-secondary)',
            }}
          >
            <div style={{ marginBottom: 10, fontSize: 14 }}>
              No budget set for {MONTHS[month - 1]} {year} yet.
            </div>
            <button
              className="btn btn-secondary"
              onClick={handleCopyFromPrior}
              disabled={copying}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
            >
              <Copy size={14} />
              {copying ? 'Copying...' : `Copy budget from ${priorMonthName}`}
            </button>
            <div style={{ marginTop: 8, fontSize: 12, color: 'var(--text-muted)' }}>
              …or add categories one at a time below.
            </div>
          </div>
        )}

        {/* Business rollup row — special-cased and rendered above the
            personal categories so business expenses are visible at a
            glance without inflating personal numbers. Only shown when
            in 'personal' or 'all' view; in 'business' view the regular
            categories list IS the business spend, so the rollup would
            duplicate it. */}
        {viewMode !== VIEW_BUSINESS && (businessSpent > 0 || (businessLimit && businessLimit > 0)) && (() => {
          const pctBiz = businessLimit > 0
            ? Math.min((businessSpent / businessLimit) * 100, 100)
            : 0
          const colorBiz =
            businessStatus === 'over' ? 'var(--accent-red)'
            : businessStatus === 'approaching' ? 'var(--accent-yellow)'
            : 'var(--accent-green)'
          return (
            <div
              style={{
                marginBottom: 20,
                paddingBottom: 16,
                borderBottom: '1px solid var(--border)',
                background: 'var(--bg-secondary, rgba(255,255,255,0.02))',
                padding: '12px 14px 16px',
                borderRadius: 8,
                marginTop: -4,  // tighten the visual anchor to the card
              }}
              title="Sum of all transactions tagged to a business this month, regardless of category. Lives outside the personal budget so it doesn't pollute personal totals."
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, flex: 1 }}>
                  <Briefcase size={16} style={{ color: 'var(--accent-blue, #60a5fa)' }} />
                  <span style={{ fontWeight: 600 }}>Business</span>
                  <span style={{
                    fontSize: 10, fontWeight: 600, letterSpacing: 0.4, textTransform: 'uppercase',
                    color: 'var(--text-muted)', padding: '2px 6px',
                    borderRadius: 10, border: '1px solid var(--border)',
                  }}>
                    rollup
                  </span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <span style={{ fontSize: 14, color: 'var(--text-secondary)' }}>
                    <button
                      onClick={() => setDrillCategory(BUSINESS_CATEGORY)}
                      title="View every business-tagged transaction this month"
                      style={{
                        background: 'none', border: 'none', padding: 0,
                        color: 'var(--accent-blue, #60a5fa)', fontSize: 14, fontWeight: 500,
                        cursor: 'pointer', textDecoration: 'underline dotted', textUnderlineOffset: 3,
                      }}
                    >
                      {formatCurrency(businessSpent)}
                    </button>
                    {businessLimit > 0 && <> {' / '} {formatCurrency(businessLimit)}</>}
                  </span>
                </div>
              </div>
              {businessLimit > 0 ? (
                <div className="progress-bar" style={{ marginTop: 8 }}>
                  <div className="progress-fill" style={{ width: `${pctBiz}%`, background: colorBiz }} />
                </div>
              ) : (
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 6 }}>
                  No limit set — add a category named “Business” below to track against a target.
                </div>
              )}
            </div>
          )
        })()}

        {personalCategories.map((cat, i) => {
          const spent = getSpent(cat.category)
          const rolloverCredit = getRolloverCredit(cat.category)
          const effectiveLimit = cat.limit_amount + rolloverCredit
          const pct = effectiveLimit > 0
            ? Math.min((spent / effectiveLimit) * 100, 100)
            : 0
          // Red ONLY when actually over budget. See budgetCategoryStatus
          // for the rule (red if over, yellow if >=90% under, green
          // otherwise / when no budget set).
          const status = budgetCategoryStatus({ spent, effectiveLimit })
          const color =
            status === 'over' ? 'var(--accent-red)'
            : status === 'approaching' ? 'var(--accent-yellow)'
            : 'var(--accent-green)'
          const isRolling = !!rollovers[cat.category]

          return (
            <div key={i} style={{ marginBottom: 20, paddingBottom: 16, borderBottom: '1px solid var(--border)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, flex: 1 }}>
                  <span style={{ fontWeight: 500 }}>{cat.category}</span>
                  <button
                    onClick={() => toggleRollover(cat.category)}
                    title={isRolling
                      ? `Rolling ON — unspent budget from ${priorMonthName} is added to this month. Click to disable.`
                      : `Rolling OFF — budget resets each month. Click to enable rollover from prior month (useful for variable categories like home repair, auto maintenance).`}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 4,
                      padding: '2px 8px', fontSize: 10, fontWeight: 600,
                      letterSpacing: 0.4, textTransform: 'uppercase',
                      borderRadius: 10, cursor: 'pointer',
                      background: isRolling ? 'var(--accent-blue-bg)' : 'var(--bg-input)',
                      border: `1px solid ${isRolling
                        ? 'var(--accent-blue-border)'
                        : 'var(--border-color, rgba(255,255,255,0.1))'}`,
                      color: isRolling ? 'var(--accent-blue)' : 'var(--text-muted)',
                    }}
                  >
                    <Repeat size={10} /> Rolling
                  </button>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <span style={{ fontSize: 14, color: 'var(--text-secondary)' }}>
                    <button
                      onClick={() => setDrillCategory(cat.category)}
                      title={`View ${cat.category} transactions for ${MONTHS[month - 1]} ${year}`}
                      style={{
                        background: 'none', border: 'none', padding: 0,
                        color: 'var(--accent-blue, #60a5fa)', fontSize: 14, fontWeight: 500,
                        cursor: 'pointer', textDecoration: 'underline dotted', textUnderlineOffset: 3,
                      }}
                    >
                      {formatCurrency(spent)}
                    </button>
                    {' / '}
                    {formatCurrency(effectiveLimit)}
                  </span>
                  <button onClick={() => removeCategory(i)} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer' }}>
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
              {/* Rollover annotation — surfaces both the credit AND the
                  base limit so the user understands where the larger
                  effective limit came from. Only renders when rolling
                  is on AND there's actually credit to display. */}
              {isRolling && rolloverCredit > 0 && (
                <div style={{
                  fontSize: 11, color: 'var(--accent-blue)', marginTop: 4,
                  display: 'flex', alignItems: 'center', gap: 4,
                }}>
                  <Repeat size={11} />
                  Base {formatCurrency(cat.limit_amount)} + {formatCurrency(rolloverCredit)} rolled from {priorMonthName}
                </div>
              )}
              {isRolling && rolloverCredit === 0 && (
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
                  No rollover from {priorMonthName} (over-spend doesn't roll forward)
                </div>
              )}
              <div className="progress-bar">
                <div className="progress-fill" style={{ width: `${pct}%`, background: color }} />
              </div>
            </div>
          )
        })}

        {/* Add new category */}
        <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
          <input
            type="text"
            placeholder="Category name"
            value={newCat}
            onChange={e => setNewCat(e.target.value)}
            style={{
              background: 'var(--bg-primary)', color: 'var(--text-primary)', border: '1px solid var(--border)',
              borderRadius: 8, padding: '8px 12px', fontSize: 14, flex: 1
            }}
          />
          <input
            type="number"
            placeholder="Limit ($)"
            value={newLimit}
            onChange={e => setNewLimit(e.target.value)}
            style={{
              background: 'var(--bg-primary)', color: 'var(--text-primary)', border: '1px solid var(--border)',
              borderRadius: 8, padding: '8px 12px', fontSize: 14, width: 120
            }}
          />
          <button className="btn btn-secondary" onClick={addCategory}><Plus size={16} /> Add</button>
        </div>
      </div>

      {/* Drill-down: click a category's spent amount → see the transactions.
          Business rollup is special-cased to filter on is_business=true
          rather than category=Business — the synthetic category doesn't
          exist on actual transaction rows, so a category-name match
          would return nothing. */}
      <TransactionDrawer
        open={!!drillCategory}
        onClose={() => setDrillCategory(null)}
        title={drillCategory || ''}
        subtitle={`${MONTHS[month - 1]} ${year}`}
        filters={
          drillCategory === BUSINESS_CATEGORY
            ? { is_business: true, ...monthRange(year, month) }
            : drillCategory
              ? { category: drillCategory, ...monthRange(year, month) }
              : {}
        }
        onDataChanged={loadSpending}
      />
    </div>
  )
}
