import { useState, useEffect } from 'react'
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
  PieChart, Pie, Cell,
} from 'recharts'
import {
  Plus, Trash2, Edit3, Download, TrendingUp, TrendingDown, DollarSign,
  FileText, Building2, ChevronRight, Receipt,
} from 'lucide-react'
import {
  getBusinesses, createBusiness, updateBusiness, deleteBusiness,
  getBusinessReport, getBusinessOverview, getBusinessExportUrl,
} from '../api/client'
import BusinessBadge, { ICON_MAP, BUSINESS_COLORS } from '../components/BusinessBadge'
import ScheduleCTab from '../components/ScheduleCTab'

function fmt(val) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(val)
}

const TABS = [
  { id: 'overview', label: 'Overview', icon: Building2 },
  { id: 'report', label: 'P&L Report', icon: FileText },
  { id: 'schedule_c', label: 'Schedule C', icon: Receipt },
  { id: 'manage', label: 'Manage Businesses', icon: Edit3 },
]

export default function Business() {
  const [tab, setTab] = useState('overview')
  const [businesses, setBusinesses] = useState([])
  const [selectedBiz, setSelectedBiz] = useState(null)
  const [report, setReport] = useState(null)
  const [overview, setOverview] = useState(null)
  const [reportMonths, setReportMonths] = useState(12)
  const [overviewMonths, setOverviewMonths] = useState(6)

  // Form state for manage tab
  const [form, setForm] = useState({ name: '', color: '#6366f1', icon: 'briefcase', description: '' })
  const [editingId, setEditingId] = useState(null)

  const loadBusinesses = () => getBusinesses().then(setBusinesses).catch(() => [])
  const loadOverview = () => getBusinessOverview(overviewMonths).then(setOverview).catch(() => null)

  useEffect(() => { loadBusinesses() }, [])
  useEffect(() => { loadOverview() }, [overviewMonths])
  useEffect(() => {
    if (selectedBiz) {
      getBusinessReport(selectedBiz, reportMonths).then(setReport).catch(() => null)
    }
  }, [selectedBiz, reportMonths])

  // Auto-select first business for report
  useEffect(() => {
    if (businesses.length > 0 && !selectedBiz) setSelectedBiz(businesses[0].id)
  }, [businesses])

  // ─── Manage tab handlers ───
  const handleSave = async () => {
    if (!form.name.trim()) return
    try {
      if (editingId) {
        await updateBusiness(editingId, form)
      } else {
        await createBusiness(form)
      }
      setForm({ name: '', color: '#6366f1', icon: 'briefcase', description: '' })
      setEditingId(null)
      loadBusinesses()
      loadOverview()
    } catch (e) {
      alert(e.message)
    }
  }

  const handleDelete = async (id) => {
    if (!confirm('Delete this business? Transactions will be untagged.')) return
    await deleteBusiness(id)
    if (selectedBiz === id) setSelectedBiz(null)
    loadBusinesses()
    loadOverview()
  }

  const startEdit = (biz) => {
    setEditingId(biz.id)
    setForm({ name: biz.name, color: biz.color, icon: biz.icon, description: biz.description || '' })
  }

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">Business</h1>
      </div>

      {/* Tabs */}
      <div style={{ marginBottom: 24 }}>
        <div className="tabs" role="tablist">
          {TABS.map(t => {
            const Icon = t.icon
            const active = tab === t.id
            return (
              <button
                key={t.id}
                role="tab"
                aria-selected={active}
                className={`tab ${active ? 'active' : ''}`}
                onClick={() => setTab(t.id)}
              >
                <Icon size={14} /> {t.label}
              </button>
            )
          })}
        </div>
      </div>

      {tab === 'overview' && <OverviewTab overview={overview} businesses={businesses} overviewMonths={overviewMonths} setOverviewMonths={setOverviewMonths} setSelectedBiz={setSelectedBiz} setTab={setTab} />}
      {tab === 'report' && <ReportTab report={report} businesses={businesses} selectedBiz={selectedBiz} setSelectedBiz={setSelectedBiz} reportMonths={reportMonths} setReportMonths={setReportMonths} />}
      {tab === 'schedule_c' && <ScheduleCTab businesses={businesses} />}
      {tab === 'manage' && <ManageTab businesses={businesses} form={form} setForm={setForm} editingId={editingId} handleSave={handleSave} handleDelete={handleDelete} startEdit={startEdit} setEditingId={setEditingId} />}
    </div>
  )
}


// ─── Overview Tab ─────────────────────────────────────────
function OverviewTab({ overview, businesses, overviewMonths, setOverviewMonths, setSelectedBiz, setTab }) {
  if (!overview || businesses.length === 0) {
    return (
      <div className="card" style={{ textAlign: 'center', padding: 60 }}>
        <Building2 size={48} style={{ color: 'var(--text-muted)', marginBottom: 16 }} />
        <p style={{ color: 'var(--text-muted)', fontSize: 16 }}>No businesses yet. Go to "Manage Businesses" to create one.</p>
      </div>
    )
  }

  return (
    <div>
      {/* Period toggle */}
      <div className="toolbar">
        <span style={{ fontSize: 12, color: 'var(--text-muted)', fontWeight: 500, textTransform: 'uppercase', letterSpacing: 0.5 }}>Period</span>
        <div className="segmented" role="group" aria-label="Overview period">
          {[3, 6, 12].map(m => (
            <button
              key={m}
              type="button"
              aria-pressed={overviewMonths === m}
              className={`segmented__option ${overviewMonths === m ? 'active' : ''}`}
              onClick={() => setOverviewMonths(m)}
            >
              {m} months
            </button>
          ))}
        </div>
      </div>

      {/* Totals */}
      <div className="stats-grid">
        <div className="stat-card">
          <div className="stat-label">Business Income</div>
          <div className="stat-value positive">{fmt(overview.totals.income)}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Business Expenses</div>
          <div className="stat-value negative">{fmt(overview.totals.expenses)}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Net Profit / Loss</div>
          <div className={`stat-value ${overview.totals.net >= 0 ? 'positive' : 'negative'}`}>
            {fmt(overview.totals.net)}
          </div>
        </div>
      </div>

      {/* Per-business cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))', gap: 16, marginTop: 16 }}>
        {overview.businesses.map(biz => (
          <div key={biz.id} className="card" style={{ cursor: 'pointer', borderLeft: `4px solid ${biz.color}` }}
            onClick={() => { setSelectedBiz(biz.id); setTab('report') }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
              <BusinessBadge business={biz} size="md" />
              <ChevronRight size={16} style={{ color: 'var(--text-muted)' }} />
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
              <div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>Income</div>
                <div style={{ color: 'var(--positive)', fontWeight: 600 }}>{fmt(biz.income)}</div>
              </div>
              <div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>Expenses</div>
                <div style={{ color: 'var(--negative)', fontWeight: 600 }}>{fmt(biz.expenses)}</div>
              </div>
              <div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>Net</div>
                <div style={{ color: biz.net >= 0 ? 'var(--positive)' : 'var(--negative)', fontWeight: 600 }}>{fmt(biz.net)}</div>
              </div>
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 8 }}>
              {biz.transaction_count} transactions
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}


// ─── P&L Report Tab ───────────────────────────────────────
function ReportTab({ report, businesses, selectedBiz, setSelectedBiz, reportMonths, setReportMonths }) {
  if (businesses.length === 0) {
    return <div className="card" style={{ textAlign: 'center', padding: 60, color: 'var(--text-muted)' }}>Create a business first to see reports.</div>
  }

  const PIE_COLORS = ['#6366f1', '#f43f5e', '#10b981', '#f59e0b', '#3b82f6', '#8b5cf6', '#ec4899', '#14b8a6']

  return (
    <div>
      {/* Controls */}
      <div className="toolbar">
        <select
          className="input"
          style={{ width: 220, height: 36 }}
          value={selectedBiz || ''}
          onChange={e => setSelectedBiz(Number(e.target.value))}
          aria-label="Select business"
        >
          {businesses.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
        </select>
        <div className="segmented" role="group" aria-label="Report period">
          {[3, 6, 12, 24].map(m => (
            <button
              key={m}
              type="button"
              aria-pressed={reportMonths === m}
              className={`segmented__option ${reportMonths === m ? 'active' : ''}`}
              onClick={() => setReportMonths(m)}
            >
              {m}mo
            </button>
          ))}
        </div>
        {report && (
          <a
            href={getBusinessExportUrl(selectedBiz)}
            className="btn btn-secondary toolbar__spacer"
            style={{ textDecoration: 'none' }}
          >
            <Download size={14} /> Export CSV
          </a>
        )}
      </div>

      {!report ? (
        <div className="card" style={{ textAlign: 'center', padding: 60, color: 'var(--text-muted)' }}>No data yet. Tag transactions to this business to see the P&L report.</div>
      ) : (
        <>
          {/* Summary cards */}
          <div className="stats-grid">
            <div className="stat-card">
              <div className="stat-label"><TrendingUp size={14} style={{ color: 'var(--positive)' }} /> Total Income</div>
              <div className="stat-value positive">{fmt(report.summary.total_income)}</div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Avg {fmt(report.summary.avg_monthly_income)}/mo</div>
            </div>
            <div className="stat-card">
              <div className="stat-label"><TrendingDown size={14} style={{ color: 'var(--negative)' }} /> Total Expenses</div>
              <div className="stat-value negative">{fmt(report.summary.total_expenses)}</div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Avg {fmt(report.summary.avg_monthly_expenses)}/mo</div>
            </div>
            <div className="stat-card">
              <div className="stat-label"><DollarSign size={14} /> Net Profit / Loss</div>
              <div className={`stat-value ${report.summary.net_profit >= 0 ? 'positive' : 'negative'}`}>
                {fmt(report.summary.net_profit)}
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{report.summary.transaction_count} transactions</div>
            </div>
          </div>

          {/* Monthly P&L chart */}
          {report.monthly.length > 0 && (
            <div className="card" style={{ marginTop: 16, marginBottom: 16 }}>
              <div className="card-header"><span className="card-title">Monthly Profit & Loss</span></div>
              <ResponsiveContainer width="100%" height={320}>
                <BarChart data={report.monthly}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#2a2d3a" />
                  <XAxis dataKey="month" stroke="#6b7280" fontSize={12} />
                  <YAxis stroke="#6b7280" fontSize={12} tickFormatter={v => `$${(v / 1000).toFixed(0)}k`} />
                  <Tooltip
                    formatter={val => fmt(val)}
                    contentStyle={{ background: '#1e2130', border: '1px solid #2a2d3a', borderRadius: 8 }}
                  />
                  <Legend />
                  <Bar dataKey="income" fill="#34d399" name="Income" radius={[4, 4, 0, 0]} />
                  <Bar dataKey="expenses" fill="#f87171" name="Expenses" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}

          {/* Bottom: categories + merchants */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
            {/* Expense categories pie */}
            <div className="card">
              <div className="card-header"><span className="card-title">Expense Categories</span></div>
              {report.categories.length > 0 ? (
                <>
                  <ResponsiveContainer width="100%" height={240}>
                    <PieChart>
                      <Pie data={report.categories} dataKey="amount" nameKey="category" cx="50%" cy="50%" outerRadius={90} label={({ category, percentage }) => `${category} ${percentage}%`} labelLine={false}>
                        {report.categories.map((_, i) => <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />)}
                      </Pie>
                      <Tooltip formatter={val => fmt(val)} contentStyle={{ background: '#1e2130', border: '1px solid #2a2d3a', borderRadius: 8 }} />
                    </PieChart>
                  </ResponsiveContainer>
                  <div style={{ marginTop: 8 }}>
                    {report.categories.map(c => (
                      <div key={c.category} style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px solid var(--border)' }}>
                        <span>{c.icon} {c.category}</span>
                        <span style={{ color: 'var(--negative)' }}>{fmt(c.amount)}</span>
                      </div>
                    ))}
                  </div>
                </>
              ) : <p style={{ color: 'var(--text-muted)', textAlign: 'center', padding: 40 }}>No expenses yet</p>}
            </div>

            {/* Top merchants */}
            <div className="card">
              <div className="card-header"><span className="card-title">Top Merchants</span></div>
              {report.top_merchants.length > 0 ? (
                <table style={{ width: '100%' }}>
                  <thead>
                    <tr style={{ color: 'var(--text-muted)', fontSize: 11, textTransform: 'uppercase' }}>
                      <th style={{ textAlign: 'left', padding: '8px 0' }}>#</th>
                      <th style={{ textAlign: 'left' }}>Merchant</th>
                      <th style={{ textAlign: 'right' }}>Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.top_merchants.map((m, i) => (
                      <tr key={m.merchant}>
                        <td style={{ padding: '8px 0', color: 'var(--text-muted)' }}>{i + 1}</td>
                        <td style={{ fontWeight: 500 }}>{m.merchant}</td>
                        <td style={{ textAlign: 'right', color: 'var(--negative)' }}>{fmt(m.amount)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : <p style={{ color: 'var(--text-muted)', textAlign: 'center', padding: 40 }}>No data yet</p>}
            </div>
          </div>
        </>
      )}
    </div>
  )
}


// ─── Manage Tab ──────────────────────────────────────────
function ManageTab({ businesses, form, setForm, editingId, handleSave, handleDelete, startEdit, setEditingId }) {
  return (
    <div>
      <div className="card" style={{ marginBottom: 24 }}>
        <div className="card-header">
          <span className="card-title">{editingId ? 'Edit Business' : 'Create Business'}</span>
        </div>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div style={{ flex: '1 1 200px' }}>
            <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>Name</label>
            <input
              className="input"
              placeholder="e.g. Acme Holdings LLC"
              value={form.name}
              onChange={e => setForm({ ...form, name: e.target.value })}
              style={{ width: '100%' }}
            />
          </div>
          <div style={{ flex: '0 0 180px' }}>
            <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'block', marginBottom: 6 }}>Color</label>
            <div className="swatch-group" role="radiogroup" aria-label="Business color">
              {BUSINESS_COLORS.map(c => (
                <button
                  key={c}
                  type="button"
                  role="radio"
                  aria-checked={form.color === c}
                  aria-label={`Color ${c}`}
                  title={c}
                  onClick={() => setForm({ ...form, color: c })}
                  className={`swatch ${form.color === c ? 'active' : ''}`}
                  style={{ background: c, color: c }}
                />
              ))}
            </div>
          </div>
          <div style={{ flex: '0 0 240px' }}>
            <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'block', marginBottom: 6 }}>Icon</label>
            <div className="swatch-group" role="radiogroup" aria-label="Business icon">
              {Object.entries(ICON_MAP).map(([key, emoji]) => (
                <button
                  key={key}
                  type="button"
                  role="radio"
                  aria-checked={form.icon === key}
                  aria-label={`Icon ${key}`}
                  title={key}
                  onClick={() => setForm({ ...form, icon: key })}
                  className={`icon-swatch ${form.icon === key ? 'active' : ''}`}
                >
                  {emoji}
                </button>
              ))}
            </div>
          </div>
        </div>
        <div style={{ marginTop: 12 }}>
          <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>Description (optional)</label>
          <input
            className="input"
            placeholder="Short description..."
            value={form.description}
            onChange={e => setForm({ ...form, description: e.target.value })}
            style={{ width: '100%' }}
          />
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
          <button className="btn btn-primary" onClick={handleSave}>
            <Plus size={14} /> {editingId ? 'Update' : 'Create'} Business
          </button>
          {editingId && (
            <button className="btn btn-secondary" onClick={() => {
              setEditingId(null)
              setForm({ name: '', color: '#6366f1', icon: 'briefcase', description: '' })
            }}>Cancel</button>
          )}
        </div>
      </div>

      {/* Business list */}
      {businesses.length === 0 ? (
        <div style={{ textAlign: 'center', color: 'var(--text-muted)', padding: 40 }}>
          No businesses yet. Create one above to start tracking business expenses.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {businesses.map(biz => (
            <div key={biz.id} className="card" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderLeft: `4px solid ${biz.color}` }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <BusinessBadge business={biz} size="md" />
                {biz.description && <span style={{ color: 'var(--text-muted)', fontSize: 13 }}>{biz.description}</span>}
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  className="btn btn-secondary btn-sm"
                  onClick={() => startEdit(biz)}
                  aria-label={`Edit ${biz.name}`}
                  title="Edit"
                >
                  <Edit3 size={13} /> Edit
                </button>
                <button
                  className="btn btn-danger btn-sm"
                  onClick={() => handleDelete(biz.id)}
                  aria-label={`Delete ${biz.name}`}
                  title="Delete business"
                >
                  <Trash2 size={13} /> Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
