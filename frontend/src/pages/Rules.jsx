/**
 * Category Rules & Business Rules — manage auto-categorization and auto-tagging.
 *
 * Each category rule is a substring match (lowercased) against
 * (merchant_name + " " + name). When a transaction lands during sync
 * and matches, its `custom_category` gets set to the rule's category.
 *
 * Business rules follow the same pattern but set the business_id.
 *
 * Both support retroactive application to existing transactions.
 */
import { useEffect, useState } from 'react'
import { Plus, Trash2, Filter, Briefcase } from 'lucide-react'
import {
  getRules, createRule, deleteRule, getCategories, globalSearch,
  getBusinessRules, createBusinessRule, deleteBusinessRule,
  getBusinesses, applyCategoryRule, applyBusinessRule,
} from '../api/client'
import EmptyState from '../components/EmptyState'

export default function Rules() {
  const [rules, setRules] = useState([])
  const [categories, setCategories] = useState([])
  const [businesses, setBusinesses] = useState([])
  const [businessRules, setBusinessRules] = useState([])
  const [loading, setLoading] = useState(true)
  const [pattern, setPattern] = useState('')
  const [category, setCategory] = useState('')
  const [bizPattern, setBizPattern] = useState('')
  const [businessId, setBusinessId] = useState('')
  const [priority, setPriority] = useState(100)
  const [saving, setSaving] = useState(false)
  const [feedback, setFeedback] = useState(null)
  // Live preview of how many transactions match the in-progress pattern.
  // Debounced fetch — query the global search endpoint and show count
  // + sample matches so the user can verify before clicking Add.
  const [patternPreview, setPatternPreview] = useState(null)
  useEffect(() => {
    if (!pattern.trim() || pattern.trim().length < 2) {
      setPatternPreview(null)
      return
    }
    const t = setTimeout(() => {
      globalSearch(pattern.trim(), 5)
        .then(r => setPatternPreview({
          count: r.transactions?.length || 0,
          // The /search endpoint returns up to `limit` matches; that's
          // also our "did this pattern hit a lot of transactions" hint.
          // For an exact count we'd need a separate endpoint; for v1
          // showing 5 sample matches is enough to validate the pattern.
          samples: r.transactions || [],
        }))
        .catch(() => setPatternPreview(null))
    }, 250)
    return () => clearTimeout(t)
  }, [pattern])
  const [bizPatternPreview, setBizPatternPreview] = useState(null)
  useEffect(() => {
    if (!bizPattern.trim() || bizPattern.trim().length < 2) {
      setBizPatternPreview(null)
      return
    }
    const t = setTimeout(() => {
      globalSearch(bizPattern.trim(), 5)
        .then(r => setBizPatternPreview({
          count: r.transactions?.length || 0,
          samples: r.transactions || [],
        }))
        .catch(() => setBizPatternPreview(null))
    }, 250)
    return () => clearTimeout(t)
  }, [bizPattern])

  const reload = () => {
    setLoading(true)
    Promise.all([
      getRules().catch(() => []),
      getCategories().catch(() => []),
      getBusinessRules().catch(() => []),
      getBusinesses().catch(() => []),
    ]).then(([r, c, br, b]) => {
      setRules(r)
      setCategories(c)
      setBusinessRules(br)
      setBusinesses(b)
    }).finally(() => setLoading(false))
  }

  useEffect(() => { reload() }, [])

  const submitCategory = async (e) => {
    e.preventDefault()
    if (!pattern.trim() || !category) return
    setSaving(true)
    try {
      const result = await createRule({ pattern: pattern.trim(), category })
      setPattern('')
      setCategory('')
      setFeedback({
        type: 'success',
        msg: `Rule saved · "${result.pattern}" → ${result.category}`,
      })
      reload()
      setTimeout(() => setFeedback(null), 5000)
    } catch (err) {
      setFeedback({ type: 'error', msg: err.message || 'Save failed' })
    } finally {
      setSaving(false)
    }
  }

  const submitBusiness = async (e) => {
    e.preventDefault()
    if (!bizPattern.trim() || !businessId) return
    setSaving(true)
    try {
      const result = await createBusinessRule({
        pattern: bizPattern.trim(),
        business_id: parseInt(businessId),
        priority: parseInt(priority) || 100,
      })
      setBizPattern('')
      setBusinessId('')
      setPriority(100)
      setFeedback({
        type: 'success',
        msg: `Business rule saved · "${result.pattern}" → ${result.business_name}`,
      })
      reload()
      setTimeout(() => setFeedback(null), 5000)
    } catch (err) {
      setFeedback({ type: 'error', msg: err.message || 'Save failed' })
    } finally {
      setSaving(false)
    }
  }

  const handleDeleteCategory = async (id, name) => {
    if (!confirm(`Delete rule "${name}"?`)) return
    await deleteRule(id)
    reload()
  }

  const handleDeleteBusiness = async (id, name) => {
    if (!confirm(`Delete business rule "${name}"?`)) return
    await deleteBusinessRule(id)
    reload()
  }

  const handleApplyCategory = async (id, pattern) => {
    try {
      const result = await applyCategoryRule(id)
      setFeedback({
        type: 'success',
        msg: `Tagged ${result.updated} transaction${result.updated !== 1 ? 's' : ''} · ${result.matched - result.updated} already categorized`,
      })
      setTimeout(() => setFeedback(null), 5000)
    } catch (err) {
      setFeedback({ type: 'error', msg: err.message || 'Apply failed' })
    }
  }

  const handleApplyBusiness = async (id, pattern, bizName) => {
    try {
      const result = await applyBusinessRule(id)
      setFeedback({
        type: 'success',
        msg: `Tagged ${result.updated} transaction${result.updated !== 1 ? 's' : ''} as ${bizName} · ${result.skipped_already_tagged} already tagged`,
      })
      setTimeout(() => setFeedback(null), 5000)
    } catch (err) {
      setFeedback({ type: 'error', msg: err.message || 'Apply failed' })
    }
  }

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">Auto-Tagging Rules</h1>
      </div>

      <p style={{ color: 'var(--text-secondary)', marginBottom: 'var(--space-6)', fontSize: 'var(--text-sm)', maxWidth: 720 }}>
        Create rules to automatically categorize transactions and assign them to businesses.
        Patterns are case-insensitive substring matches against merchant name and description.
      </p>

      {/* ─── Category Rules ─────────────────────────────────────────── */}
      <div className="card" style={{ marginBottom: 'var(--space-6)' }}>
        <div className="card-header">
          <span className="card-title">Categorization Rules</span>
        </div>
        <form onSubmit={submitCategory} style={{ display: 'grid', gridTemplateColumns: '2fr 2fr auto', gap: 'var(--space-3)', alignItems: 'end', marginBottom: 'var(--space-4)' }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 'var(--text-xs)', color: 'var(--text-secondary)' }}>
            When merchant or description contains
            <input
              value={pattern}
              onChange={e => setPattern(e.target.value)}
              placeholder="starbucks"
              style={INPUT_STYLE}
            />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 'var(--text-xs)', color: 'var(--text-secondary)' }}>
            Set category to
            <select value={category} onChange={e => setCategory(e.target.value)} style={INPUT_STYLE}>
              <option value="">— Select category —</option>
              {categories.map(c => (
                <option key={c.name} value={c.name}>{c.icon} {c.name}</option>
              ))}
            </select>
          </label>
          <button
            type="submit"
            className="btn btn-primary"
            disabled={saving || !pattern.trim() || !category}
            style={{ height: 38 }}
          >
            <Plus size={14} /> {saving ? 'Saving…' : 'Add'}
          </button>
        </form>

        {/* Live preview: shows sample matches before save so the user can
            verify their pattern hits the intended transactions and not
            something over-broad. Only renders when pattern is 2+ chars. */}
        {patternPreview && (
          <div style={{
            marginBottom: 16, padding: '8px 12px',
            background: 'var(--bg-elevated)', borderRadius: 6,
            fontSize: 12, color: 'var(--text-secondary)',
          }}>
            <div style={{ marginBottom: 4 }}>
              {patternPreview.count === 0
                ? <span style={{ color: 'var(--accent-orange)' }}>⚠ No transactions match "{pattern}"</span>
                : <>Matches <strong style={{ color: 'var(--text-primary)' }}>{patternPreview.count}+</strong> transaction{patternPreview.count !== 1 ? 's' : ''}{patternPreview.count >= 5 && ' (showing first 5)'}:</>
              }
            </div>
            {patternPreview.samples.length > 0 && (
              <ul style={{ listStyle: 'none', padding: 0, margin: 0, fontSize: 11 }}>
                {patternPreview.samples.map(s => (
                  <li key={s.id} style={{ padding: '2px 0', color: 'var(--text-muted)' }}>
                    · {s.name} — ${Math.abs(s.amount).toFixed(2)} ({s.date})
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {rules.length === 0 ? (
          <EmptyState
            icon={<Filter size={24} />}
            title="No category rules yet"
            description='Add your first rule above. Example: "starbucks" → Food &amp; Drink.'
            compact
          />
        ) : (
          <table style={{ width: '100%', fontSize: 'var(--text-sm)' }}>
            <thead>
              <tr>
                <th>Pattern</th>
                <th>Category</th>
                <th style={{ textAlign: 'right' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {rules.map(r => {
                const cat = categories.find(c => c.name === r.category)
                return (
                  <tr key={r.id}>
                    <td>
                      <code style={{
                        background: 'var(--bg-elevated)',
                        padding: '2px 8px',
                        borderRadius: 'var(--radius-xs)',
                        fontSize: 'var(--text-xs)',
                        fontFamily: "'SF Mono', Consolas, monospace",
                      }}>
                        {r.pattern}
                      </code>
                    </td>
                    <td>
                      <span className="category-badge">
                        {cat ? `${cat.icon} ${cat.name}` : r.category}
                      </span>
                    </td>
                    <td style={{ textAlign: 'right', display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                      <button
                        className="btn btn-sm"
                        onClick={() => handleApplyCategory(r.id, r.pattern)}
                        title="Apply to past transactions"
                        style={{ fontSize: 'var(--text-xs)', padding: '4px 8px' }}
                      >
                        Apply
                      </button>
                      <button
                        className="btn btn-danger btn-sm"
                        onClick={() => handleDeleteCategory(r.id, r.pattern)}
                        title="Delete rule"
                      >
                        <Trash2 size={12} />
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* ─── Business Rules ────────────────────────────────────────── */}
      <div className="card">
        <div className="card-header">
          <span className="card-title" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <Briefcase size={16} />
            Business Tagging Rules
          </span>
        </div>
        <form onSubmit={submitBusiness} style={{ display: 'grid', gridTemplateColumns: '2fr 2fr 1fr auto', gap: 'var(--space-3)', alignItems: 'end', marginBottom: 'var(--space-4)' }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 'var(--text-xs)', color: 'var(--text-secondary)' }}>
            When merchant or description contains
            <input
              value={bizPattern}
              onChange={e => setBizPattern(e.target.value)}
              placeholder="acme"
              style={INPUT_STYLE}
            />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 'var(--text-xs)', color: 'var(--text-secondary)' }}>
            Tag as business
            <select value={businessId} onChange={e => setBusinessId(e.target.value)} style={INPUT_STYLE}>
              <option value="">— Select business —</option>
              {businesses.map(b => (
                <option key={b.id} value={b.id}>{b.name}</option>
              ))}
            </select>
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 'var(--text-xs)', color: 'var(--text-secondary)' }}>
            Priority
            <input
              type="number"
              value={priority}
              onChange={e => setPriority(e.target.value)}
              min="1"
              max="999"
              style={INPUT_STYLE}
            />
          </label>
          <button
            type="submit"
            className="btn btn-primary"
            disabled={saving || !bizPattern.trim() || !businessId}
            style={{ height: 38 }}
          >
            <Plus size={14} /> {saving ? 'Saving…' : 'Add'}
          </button>
        </form>

        {businessRules.length === 0 ? (
          <EmptyState
            icon={<Briefcase size={24} />}
            title="No business rules yet"
            description='Add your first rule above. Example: "acme" → Acme Holdings.'
            compact
          />
        ) : (
          <table style={{ width: '100%', fontSize: 'var(--text-sm)' }}>
            <thead>
              <tr>
                <th>Pattern</th>
                <th>Business</th>
                <th style={{ textAlign: 'right' }}>Priority</th>
                <th style={{ textAlign: 'right' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {businessRules.map(r => (
                <tr key={r.id}>
                  <td>
                    <code style={{
                      background: 'var(--bg-elevated)',
                      padding: '2px 8px',
                      borderRadius: 'var(--radius-xs)',
                      fontSize: 'var(--text-xs)',
                      fontFamily: "'SF Mono', Consolas, monospace",
                    }}>
                      {r.pattern}
                    </code>
                  </td>
                  <td>{r.business_name || '—'}</td>
                  <td style={{ textAlign: 'right' }}>{r.priority}</td>
                  <td style={{ textAlign: 'right', display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                    <button
                      className="btn btn-sm"
                      onClick={() => handleApplyBusiness(r.id, r.pattern, r.business_name)}
                      title="Apply to past transactions"
                      style={{ fontSize: 'var(--text-xs)', padding: '4px 8px' }}
                    >
                      Apply
                    </button>
                    <button
                      className="btn btn-danger btn-sm"
                      onClick={() => handleDeleteBusiness(r.id, r.pattern)}
                      title="Delete rule"
                    >
                      <Trash2 size={12} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Feedback toast */}
      {feedback && (
        <div style={{
          position: 'fixed',
          bottom: 20,
          left: 20,
          padding: 'var(--space-3) var(--space-4)',
          borderRadius: 'var(--radius-sm)',
          background: feedback.type === 'error' ? 'var(--accent-red-bg)' : 'var(--accent-green-bg)',
          color: feedback.type === 'error' ? 'var(--accent-red)' : 'var(--accent-green)',
          border: `1px solid ${feedback.type === 'error' ? 'var(--accent-red-border)' : 'var(--accent-green-border)'}`,
          fontSize: 'var(--text-sm)',
          boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
          maxWidth: 400,
          zIndex: 1000,
        }}>
          {feedback.msg}
        </div>
      )}
    </div>
  )
}

const INPUT_STYLE = {
  background: 'var(--bg-input)',
  color: 'var(--text-primary)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius-sm)',
  padding: '8px 12px',
  fontSize: 'var(--text-base)',
  fontFamily: 'inherit',
  width: '100%',
  boxSizing: 'border-box',
}
