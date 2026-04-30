/**
 * ScheduleCTab — TaxAct-ready Schedule C preparation per business, per
 * tax year. Three sections:
 *
 *   1. Income summary (auto-aggregated from tagged transactions)
 *   2. Expense bucketizer — every Tusk Ledger category gets mapped to an
 *      IRS Schedule C line OR routed to the Asset Register as a capital
 *      purchase. Mapping persisted to localStorage per (business, category).
 *   3. Asset Register — manual list of capital purchases (date placed
 *      in service, cost, useful-life class, Section 179 elected).
 *      Persisted to localStorage per business.
 *
 * Output: a TaxAct-shaped totals panel showing each Schedule C line
 * (8-27b plus the home office line 30) plus Form 4562 inputs (current-
 * year additions, total Section 179 elected).
 *
 * Critical for capital-intensive businesses like display leasing where
 * misclassifying a capital purchase as "Supplies" loses Section 179
 * treatment and creates audit risk.
 */
import { useState, useEffect, useMemo } from 'react'
import { Plus, Trash2, FileText, Box, Settings, Printer } from 'lucide-react'
import { getScheduleCSummary } from '../api/client'
import { useStoredState } from '../lib/storage'
import { formatCurrencyZero as fmt } from '../lib/format'

// IRS Schedule C expense lines (Part II). Order matches the form so the
// summary at the bottom reads top-to-bottom in TaxAct's wizard order.
const SCHEDULE_C_LINES = [
  { code: 'L8',   label: 'Line 8 — Advertising' },
  { code: 'L9',   label: 'Line 9 — Car & truck expenses' },
  { code: 'L10',  label: 'Line 10 — Commissions & fees' },
  { code: 'L11',  label: 'Line 11 — Contract labor' },
  { code: 'L13',  label: 'Line 13 — Depreciation & §179 (from Form 4562)' },
  { code: 'L14',  label: 'Line 14 — Employee benefit programs' },
  { code: 'L15',  label: 'Line 15 — Insurance (other than health)' },
  { code: 'L16a', label: 'Line 16a — Mortgage interest' },
  { code: 'L16b', label: 'Line 16b — Other interest' },
  { code: 'L17',  label: 'Line 17 — Legal & professional services' },
  { code: 'L18',  label: 'Line 18 — Office expense' },
  { code: 'L19',  label: 'Line 19 — Pension & profit-sharing' },
  { code: 'L20a', label: 'Line 20a — Rent: vehicles, machinery, equipment' },
  { code: 'L20b', label: 'Line 20b — Rent: other business property' },
  { code: 'L21',  label: 'Line 21 — Repairs & maintenance' },
  { code: 'L22',  label: 'Line 22 — Supplies' },
  { code: 'L23',  label: 'Line 23 — Taxes & licenses' },
  { code: 'L24a', label: 'Line 24a — Travel' },
  { code: 'L24b', label: 'Line 24b — Deductible meals' },
  { code: 'L25',  label: 'Line 25 — Utilities' },
  { code: 'L26',  label: 'Line 26 — Wages (less employment credits)' },
  { code: 'L27b', label: 'Line 27b — Other expenses' },
  { code: 'L30',  label: 'Line 30 — Home office' },
  // Special routing — not a Schedule C line directly:
  { code: 'CAPITAL', label: '↗ Route to Asset Register (capital purchase)' },
  { code: 'SKIP',    label: '✕ Personal / not a business expense' },
]

// MACRS useful-life classes for Form 4562. Most display-leasing equipment
// will be 5-year (computer/electronics) or 7-year (general business
// equipment, furniture, fixtures).
const ASSET_LIFE_CLASSES = [
  { value: '3',    label: '3-year (tractors, certain rentals)' },
  { value: '5',    label: '5-year (computers, vehicles, electronics)' },
  { value: '7',    label: '7-year (furniture, equipment, fixtures)' },
  { value: '10',   label: '10-year (durable equipment)' },
  { value: '15',   label: '15-year (improvements, signs)' },
  { value: '20',   label: '20-year' },
  { value: '27.5', label: '27.5-year (residential rental real estate)' },
  { value: '39',   label: '39-year (nonresidential real estate)' },
]

// Storage key shapes (per business, per year):
//   tuskledger.scheduleC.mapping.v1 = { [business_id]: { [category]: 'L18' } }
//   tuskledger.scheduleC.assets.v1  = { [business_id]: [{...assetRow}] }
const MAPPING_KEY = 'tuskledger.scheduleC.mapping.v1'
const ASSETS_KEY = 'tuskledger.scheduleC.assets.v1'

export default function ScheduleCTab({ businesses }) {
  const [selectedBiz, setSelectedBiz] = useState(null)
  const [year, setYear] = useState(new Date().getFullYear())
  const [summary, setSummary] = useState(null)
  const [loading, setLoading] = useState(false)
  const [mappingByBiz, setMappingByBiz] = useStoredState(MAPPING_KEY, {})
  const [assetsByBiz, setAssetsByBiz] = useStoredState(ASSETS_KEY, {})

  // Auto-select first business once list loads.
  useEffect(() => {
    if (businesses.length > 0 && !selectedBiz) setSelectedBiz(businesses[0].id)
  }, [businesses])

  // Refetch summary when business / year changes.
  useEffect(() => {
    if (!selectedBiz) return
    setLoading(true)
    getScheduleCSummary(selectedBiz, year)
      .then(d => { setSummary(d); setLoading(false) })
      .catch(() => setLoading(false))
  }, [selectedBiz, year])

  if (businesses.length === 0) {
    return (
      <div className="card" style={{ textAlign: 'center', padding: 60 }}>
        <FileText size={48} style={{ color: 'var(--text-muted)', marginBottom: 16 }} />
        <p style={{ color: 'var(--text-muted)', fontSize: 16 }}>
          No businesses yet. Create one in the Manage Businesses tab.
        </p>
      </div>
    )
  }

  const mapping = mappingByBiz[selectedBiz] || {}
  const assets = assetsByBiz[selectedBiz] || []

  const setLineForCategory = (category, lineCode) => {
    setMappingByBiz(prev => ({
      ...prev,
      [selectedBiz]: { ...(prev[selectedBiz] || {}), [category]: lineCode },
    }))
  }

  const updateAssets = (next) => {
    setAssetsByBiz(prev => ({ ...prev, [selectedBiz]: next }))
  }

  // Roll up per-line totals for the TaxAct-ready summary at the bottom.
  // Capital purchases are summed separately for Form 4562.
  const lineTotals = useMemo(() => {
    if (!summary) return { byLine: {}, capital: 0, skipped: 0, unmapped: 0 }
    const byLine = {}
    let capital = 0
    let skipped = 0
    let unmapped = 0
    for (const cat of summary.expenses.by_category) {
      const code = mapping[cat.category]
      if (code === 'CAPITAL') capital += cat.total
      else if (code === 'SKIP') skipped += cat.total
      else if (code) byLine[code] = (byLine[code] || 0) + cat.total
      else unmapped += cat.total
    }
    // Asset Register's Section 179 elections roll into Line 13 too,
    // alongside any Tusk Ledger categories the user mapped to L13 directly.
    const assetSection179Total = assets
      .filter(a => a.year_placed === year && a.section_179_elected)
      .reduce((s, a) => s + (Number(a.cost) || 0), 0)
    if (assetSection179Total > 0) {
      byLine['L13'] = (byLine['L13'] || 0) + assetSection179Total
    }
    return { byLine, capital, skipped, unmapped, assetSection179Total }
  }, [summary, mapping, assets, year])

  // Total expenses for the bottom-line tentative-profit display.
  const mappedExpenseTotal = useMemo(() => {
    return Object.values(lineTotals.byLine).reduce((s, v) => s + v, 0)
  }, [lineTotals])

  return (
    <div>
      {/* Top controls — business + year selectors */}
      <div className="card" style={{ marginBottom: 16, padding: 12 }}>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          <label style={{ fontSize: 12, color: 'var(--text-muted)' }}>Business:</label>
          <select
            value={selectedBiz || ''}
            onChange={e => setSelectedBiz(Number(e.target.value))}
            style={selectStyle}
          >
            {businesses.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
          <label style={{ fontSize: 12, color: 'var(--text-muted)', marginLeft: 12 }}>Tax year:</label>
          <select value={year} onChange={e => setYear(Number(e.target.value))} style={selectStyle}>
            {[2024, 2025, 2026, 2027].map(y => <option key={y} value={y}>{y}</option>)}
          </select>
          <button
            onClick={() => window.print()}
            title="Print this Schedule C summary"
            style={{
              marginLeft: 'auto', padding: '4px 12px', fontSize: 12,
              background: 'var(--bg-hover)', color: 'var(--text-secondary)',
              border: '1px solid var(--border)', borderRadius: 4, cursor: 'pointer',
              display: 'inline-flex', alignItems: 'center', gap: 4,
            }}
          >
            <Printer size={12} /> Print
          </button>
        </div>
      </div>

      {loading && (
        <div className="card" style={{ padding: 20, textAlign: 'center', color: 'var(--text-muted)' }}>
          Loading summary…
        </div>
      )}

      {summary && !loading && (
        <>
          {/* Income panel */}
          <div className="card" style={{ marginBottom: 16 }}>
            <div className="card-header">
              <span className="card-title">
                Income · {summary.business_name} · {year}
              </span>
              <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                Schedule C, Line 1 (Gross receipts)
              </span>
            </div>
            <div style={{
              padding: '12px 0', display: 'flex', justifyContent: 'space-between',
              alignItems: 'baseline',
            }}>
              <div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.4 }}>
                  Gross receipts
                </div>
                <div style={{
                  fontSize: 28, fontWeight: 700, color: 'var(--accent-green)',
                  fontVariantNumeric: 'tabular-nums', marginTop: 2,
                }}>
                  {fmt(summary.income.gross_receipts)}
                </div>
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)', textAlign: 'right' }}>
                {summary.income.transaction_count} income transaction{summary.income.transaction_count === 1 ? '' : 's'}
                {summary.income.transactions.length > 0 && (
                  <details style={{ marginTop: 4 }}>
                    <summary style={{ cursor: 'pointer', color: 'var(--accent-blue)' }}>
                      view {summary.income.transactions.length}
                    </summary>
                    <ul style={{ listStyle: 'none', padding: 0, margin: '6px 0 0', fontSize: 11 }}>
                      {summary.income.transactions.map(t => (
                        <li key={t.id} style={{ padding: '2px 0' }}>
                          {t.date} · {t.merchant} · {fmt(t.amount)}
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
              </div>
            </div>
          </div>

          {/* Expense bucketizer — the core of the feature */}
          <div className="card" style={{ marginBottom: 16 }}>
            <div className="card-header">
              <span className="card-title">
                Expense bucketizer ({summary.expenses.by_category.length} categor{summary.expenses.by_category.length === 1 ? 'y' : 'ies'})
              </span>
              <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                Map each category to an IRS Schedule C line — or route capital purchases to the Asset Register
              </span>
            </div>
            {summary.expenses.by_category.length === 0 ? (
              <div style={{ padding: 20, color: 'var(--text-muted)', fontSize: 13, textAlign: 'center' }}>
                No expenses tagged to this business in {year}.
              </div>
            ) : (
              <div className="table-wrapper">
                <table>
                  <thead>
                    <tr>
                      <th>Category</th>
                      <th>Sample merchants</th>
                      <th style={{ textAlign: 'right' }}>Total</th>
                      <th style={{ textAlign: 'right' }}>Count</th>
                      <th>IRS Schedule C line</th>
                    </tr>
                  </thead>
                  <tbody>
                    {summary.expenses.by_category.map(cat => {
                      const currentLine = mapping[cat.category] || ''
                      const isCapital = currentLine === 'CAPITAL'
                      const isSkipped = currentLine === 'SKIP'
                      return (
                        <tr key={cat.category} style={{
                          opacity: isSkipped ? 0.5 : 1,
                        }}>
                          <td style={{ fontWeight: 500 }}>{cat.category}</td>
                          <td style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                            {cat.merchants.slice(0, 3).join(', ')}
                            {cat.merchants.length > 3 && ` +${cat.merchants.length - 3} more`}
                          </td>
                          <td style={{
                            textAlign: 'right', fontVariantNumeric: 'tabular-nums', fontWeight: 600,
                            color: isCapital ? 'var(--accent-yellow)' : undefined,
                          }}>
                            {fmt(cat.total)}
                          </td>
                          <td style={{ textAlign: 'right', color: 'var(--text-muted)', fontSize: 12 }}>
                            {cat.count}
                          </td>
                          <td>
                            <select
                              value={currentLine}
                              onChange={e => setLineForCategory(cat.category, e.target.value)}
                              style={{
                                ...selectStyle,
                                width: '100%',
                                background: !currentLine
                                  ? 'rgba(251,191,36,0.10)'
                                  : isCapital
                                  ? 'rgba(251,191,36,0.10)'
                                  : 'var(--bg-input)',
                                borderColor: !currentLine
                                  ? 'rgba(251,191,36,0.4)'
                                  : 'var(--border)',
                              }}
                            >
                              <option value="">— Choose line —</option>
                              {SCHEDULE_C_LINES.map(line => (
                                <option key={line.code} value={line.code}>{line.label}</option>
                              ))}
                            </select>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Asset Register — capital purchases for Form 4562 */}
          <AssetRegister
            assets={assets}
            year={year}
            updateAssets={updateAssets}
          />

          {/* TaxAct-ready summary */}
          <TaxActSummary
            summary={summary}
            lineTotals={lineTotals}
            mappedExpenseTotal={mappedExpenseTotal}
            year={year}
          />
        </>
      )}
    </div>
  )
}


/* ─────────────────────── Asset Register ─────────────────────── */

function AssetRegister({ assets, year, updateAssets }) {
  const [showForm, setShowForm] = useState(false)
  const [draft, setDraft] = useState(emptyAsset(year))

  const addAsset = () => {
    if (!draft.description.trim() || !draft.cost) return
    updateAssets([...assets, { ...draft, id: Date.now() }])
    setDraft(emptyAsset(year))
    setShowForm(false)
  }

  const removeAsset = (id) => {
    updateAssets(assets.filter(a => a.id !== id))
  }

  const toggleSection179 = (id) => {
    updateAssets(assets.map(a =>
      a.id === id ? { ...a, section_179_elected: !a.section_179_elected } : a
    ))
  }

  const yearAssets = assets.filter(a => a.year_placed === year)
  const totalCost = yearAssets.reduce((s, a) => s + (Number(a.cost) || 0), 0)
  const total179 = yearAssets
    .filter(a => a.section_179_elected)
    .reduce((s, a) => s + (Number(a.cost) || 0), 0)

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div className="card-header">
        <span className="card-title" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <Box size={14} style={{ color: 'var(--accent-yellow)' }} />
          Asset Register · {year}
          <span style={{
            fontSize: 10, color: 'var(--text-muted)',
            padding: '1px 6px', border: '1px solid var(--border)', borderRadius: 8,
            marginLeft: 4,
          }}>
            {yearAssets.length} item{yearAssets.length === 1 ? '' : 's'}
          </span>
        </span>
        <button
          onClick={() => setShowForm(o => !o)}
          style={{
            padding: '4px 10px', fontSize: 11,
            background: 'var(--accent-blue)', color: '#0d0e14',
            border: 'none', borderRadius: 4, cursor: 'pointer',
            display: 'inline-flex', alignItems: 'center', gap: 4,
          }}
        >
          <Plus size={11} /> Add asset
        </button>
      </div>

      {/* Add form */}
      {showForm && (
        <div style={{
          padding: 10, marginBottom: 10,
          background: 'rgba(255,255,255,0.03)',
          border: '1px dashed var(--border)',
          borderRadius: 4,
          display: 'grid', gridTemplateColumns: '2fr 1fr 1fr 1fr', gap: 8,
          fontSize: 11,
        }}>
          <AssetField label="Description (e.g. 'Moss wall display #1')">
            <input
              type="text"
              value={draft.description}
              onChange={e => setDraft({ ...draft, description: e.target.value })}
              style={inputStyle}
              autoFocus
            />
          </AssetField>
          <AssetField label="Date placed in service">
            <input
              type="date"
              value={draft.date_placed_in_service}
              onChange={e => setDraft({ ...draft, date_placed_in_service: e.target.value })}
              style={inputStyle}
            />
          </AssetField>
          <AssetField label="Cost">
            <input
              type="number"
              step="0.01"
              value={draft.cost}
              onChange={e => setDraft({ ...draft, cost: e.target.value })}
              style={inputStyle}
              placeholder="0.00"
            />
          </AssetField>
          <AssetField label="Useful life (MACRS)">
            <select
              value={draft.useful_life}
              onChange={e => setDraft({ ...draft, useful_life: e.target.value })}
              style={inputStyle}
            >
              {ASSET_LIFE_CLASSES.map(c => (
                <option key={c.value} value={c.value}>{c.label}</option>
              ))}
            </select>
          </AssetField>
          <label style={{
            gridColumn: '1 / -1', display: 'flex', alignItems: 'center', gap: 6,
            fontSize: 11, color: 'var(--text-secondary)',
          }}>
            <input
              type="checkbox"
              checked={draft.section_179_elected}
              onChange={e => setDraft({ ...draft, section_179_elected: e.target.checked })}
            />
            Elect Section 179 (fully expense in year placed in service, up to $1.25M for 2026)
          </label>
          <div style={{ gridColumn: '1 / -1', display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
            <button
              onClick={() => { setShowForm(false); setDraft(emptyAsset(year)) }}
              style={btnSecondaryStyle}
            >
              Cancel
            </button>
            <button onClick={addAsset} style={btnPrimaryStyle}>Add</button>
          </div>
        </div>
      )}

      {yearAssets.length === 0 ? (
        <div style={{ padding: 16, color: 'var(--text-muted)', fontSize: 12, textAlign: 'center' }}>
          No assets recorded for {year}. Capital purchases ($2,500+ items used in the
          business with multi-year useful life) belong here, not on Schedule C lines.
        </div>
      ) : (
        <div className="table-wrapper">
          <table>
            <thead>
              <tr>
                <th>Description</th>
                <th>Date placed in service</th>
                <th>Useful life</th>
                <th style={{ textAlign: 'right' }}>Cost</th>
                <th style={{ textAlign: 'center' }}>§179</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {yearAssets.map(a => (
                <tr key={a.id}>
                  <td style={{ fontWeight: 500 }}>{a.description}</td>
                  <td style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{a.date_placed_in_service || '—'}</td>
                  <td style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{a.useful_life || '—'}-year</td>
                  <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{fmt(a.cost)}</td>
                  <td style={{ textAlign: 'center' }}>
                    <input
                      type="checkbox"
                      checked={!!a.section_179_elected}
                      onChange={() => toggleSection179(a.id)}
                    />
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    <button
                      onClick={() => removeAsset(a.id)}
                      title="Delete"
                      style={{
                        background: 'none', border: 'none', cursor: 'pointer',
                        color: 'var(--accent-red)', padding: 4,
                      }}
                    >
                      <Trash2 size={12} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr style={{ borderTop: '2px solid var(--border)', fontWeight: 600 }}>
                <td colSpan={3}>Total {year}</td>
                <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                  {fmt(totalCost)}
                </td>
                <td style={{ textAlign: 'center', fontSize: 11, color: 'var(--accent-yellow)' }}>
                  {fmt(total179)}
                </td>
                <td></td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </div>
  )
}

function emptyAsset(year) {
  return {
    description: '',
    date_placed_in_service: `${year}-01-01`,
    cost: '',
    useful_life: '7',
    section_179_elected: true,
    year_placed: year,
  }
}


/* ─────────────────── TaxAct-ready summary ─────────────────── */

function TaxActSummary({ summary, lineTotals, mappedExpenseTotal, year }) {
  const tentative = summary.income.gross_receipts - mappedExpenseTotal
  const linesWithValues = SCHEDULE_C_LINES
    .filter(line => line.code !== 'CAPITAL' && line.code !== 'SKIP')
    .filter(line => (lineTotals.byLine[line.code] || 0) > 0)

  return (
    <div className="card" style={{ marginBottom: 16, background: 'rgba(52,211,153,0.04)' }}>
      <div className="card-header">
        <span className="card-title">TaxAct-ready summary · Schedule C {year}</span>
        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
          Type these numbers into TaxAct's Schedule C wizard
        </span>
      </div>

      {/* Warnings if anything is unmapped or routed to capital */}
      {(lineTotals.unmapped > 0 || lineTotals.capital > 0) && (
        <div style={{
          padding: '8px 12px', marginBottom: 12,
          background: 'rgba(251,191,36,0.08)',
          border: '1px solid rgba(251,191,36,0.25)',
          borderRadius: 6, fontSize: 12, color: 'var(--text-secondary)',
        }}>
          {lineTotals.unmapped > 0 && (
            <div>
              ⚠ <strong>{fmt(lineTotals.unmapped)}</strong> of expenses still unmapped — assign each category above to a Schedule C line.
            </div>
          )}
          {lineTotals.capital > 0 && (
            <div style={{ marginTop: lineTotals.unmapped > 0 ? 4 : 0 }}>
              📦 <strong>{fmt(lineTotals.capital)}</strong> of expenses routed to capital — make sure each item exists in the Asset Register above with Section 179 elected if you want to fully expense it this year.
            </div>
          )}
        </div>
      )}

      {linesWithValues.length === 0 ? (
        <div style={{ padding: 12, color: 'var(--text-muted)', fontSize: 13 }}>
          No mapped expenses yet. Use the bucketizer above to assign categories.
        </div>
      ) : (
        <table style={{ width: '100%', fontSize: 13 }}>
          <tbody>
            {linesWithValues.map(line => (
              <tr key={line.code} style={{ borderBottom: '1px solid var(--border)' }}>
                <td style={{ padding: '6px 0' }}>{line.label}</td>
                <td style={{
                  padding: '6px 0', textAlign: 'right', fontVariantNumeric: 'tabular-nums',
                  fontWeight: 600,
                }}>
                  {fmt(lineTotals.byLine[line.code])}
                </td>
              </tr>
            ))}
            <tr style={{ borderTop: '2px solid var(--border)' }}>
              <td style={{ padding: '8px 0', fontWeight: 600 }}>Total expenses (Line 28)</td>
              <td style={{
                padding: '8px 0', textAlign: 'right', fontVariantNumeric: 'tabular-nums',
                fontWeight: 700, color: 'var(--accent-red)',
              }}>
                {fmt(mappedExpenseTotal)}
              </td>
            </tr>
            <tr style={{ borderTop: '2px solid var(--border)' }}>
              <td style={{ padding: '8px 0', fontWeight: 700 }}>
                Tentative profit / (loss) (Line 29)
              </td>
              <td style={{
                padding: '8px 0', textAlign: 'right', fontVariantNumeric: 'tabular-nums',
                fontWeight: 700,
                color: tentative >= 0 ? 'var(--accent-green)' : 'var(--accent-red)',
              }}>
                {fmt(tentative)}
              </td>
            </tr>
          </tbody>
        </table>
      )}

      {/* Form 4562 panel — capital purchases this year + Section 179 elected */}
      {lineTotals.assetSection179Total > 0 && (
        <div style={{
          marginTop: 12, padding: '10px 12px',
          background: 'rgba(96,165,250,0.06)',
          border: '1px solid rgba(96,165,250,0.2)',
          borderRadius: 6, fontSize: 12, color: 'var(--text-secondary)',
        }}>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 4 }}>
            Form 4562 (Depreciation & §179)
          </div>
          <div>
            Section 179 elected this year: <strong style={{ color: 'var(--accent-blue)' }}>
            {fmt(lineTotals.assetSection179Total)}</strong>
            {' '}(2026 cap: $1.25M)
          </div>
          <div style={{ fontSize: 11, marginTop: 2, color: 'var(--text-muted)' }}>
            This amount is also included on Schedule C Line 13 above. In TaxAct, complete Form 4562 first.
          </div>
        </div>
      )}
    </div>
  )
}


/* ─────────────────────── Shared bits ─────────────────────── */

function AssetField({ label, children }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <span style={{
        fontSize: 10, color: 'var(--text-muted)',
        textTransform: 'uppercase', letterSpacing: 0.4,
      }}>{label}</span>
      {children}
    </label>
  )
}

const inputStyle = {
  width: '100%', padding: '5px 8px', fontSize: 12,
  border: '1px solid var(--border)', borderRadius: 3,
  background: 'var(--bg-input)', color: 'var(--text-primary)',
  fontFamily: 'inherit', boxSizing: 'border-box',
}

const selectStyle = {
  padding: '5px 10px', fontSize: 12,
  background: 'var(--bg-input)', color: 'var(--text-primary)',
  border: '1px solid var(--border)', borderRadius: 4,
}

const btnPrimaryStyle = {
  padding: '4px 10px', fontSize: 12,
  background: 'var(--accent-blue)', color: '#0d0e14',
  border: 'none', borderRadius: 3, cursor: 'pointer',
}

const btnSecondaryStyle = {
  padding: '4px 10px', fontSize: 12,
  background: 'transparent', color: 'var(--text-secondary)',
  border: '1px solid var(--border)', borderRadius: 3, cursor: 'pointer',
}
