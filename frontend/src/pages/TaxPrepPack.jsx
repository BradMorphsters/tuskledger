import { useEffect, useState } from 'react'
import { Loader2, Printer, Receipt } from 'lucide-react'
import {
  getHsaStatus, getBusinesses, getScheduleCSummary,
} from '../api/client'

/**
 * Tax Prep Pack — single page that bundles every tax-relevant tally
 * the app already computes, formatted for printing or PDF export.
 *
 * What's in the bundle:
 *   - HSA contribution status (per-account YTD, IRS limit, headroom).
 *     Useful for filling Form 8889.
 *   - Schedule C summary by IRS line for each tagged business.
 *     Useful for the CPA filling Schedule C.
 *   - Capital-loss carryover from localStorage (the Investments page
 *     tracker — no backend endpoint, so we read what the user entered).
 *
 * UX: opens as a normal page; user clicks "Print / Save PDF" to invoke
 * window.print(). Print stylesheet hides the sidebar / header / nav and
 * renders white-background, page-break-aware sections so the output is
 * a clean handoff to a CPA.
 */

const CAPITAL_LOSS_KEY = 'tuskledger.capitalLossCarryover.v1'

function fmt(n) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency', currency: 'USD', maximumFractionDigits: 0,
  }).format(n || 0)
}

function thisYear() { return new Date().getFullYear() }

export default function TaxPrepPack() {
  const [hsa, setHsa] = useState(null)
  const [businesses, setBusinesses] = useState([])
  const [scheduleC, setScheduleC] = useState({})  // {businessId: summary}
  const [loading, setLoading] = useState(true)
  const [year, setYear] = useState(thisYear())

  // Capital loss carryover lives in localStorage (Investments tracker).
  const [capitalLoss, setCapitalLoss] = useState(() => {
    try { return JSON.parse(localStorage.getItem(CAPITAL_LOSS_KEY) || '{}') }
    catch { return {} }
  })

  useEffect(() => {
    Promise.all([
      getHsaStatus(year).catch(() => null),
      getBusinesses().catch(() => []),
    ]).then(([hsaData, bizData]) => {
      setHsa(hsaData)
      setBusinesses(bizData || [])
      // Fetch Schedule C summary for each business.
      Promise.all(
        (bizData || []).map(b =>
          getScheduleCSummary(b.id, year).then(s => [b.id, s]).catch(() => [b.id, null])
        )
      ).then(results => {
        setScheduleC(Object.fromEntries(results.filter(([, s]) => s)))
        setLoading(false)
      })
    })
  }, [year])

  if (loading) {
    return (
      <div style={{ padding: 32 }}>
        <Loader2 size={16} style={{ animation: 'spin 1s linear infinite', marginRight: 8 }} />
        Loading tax prep data…
      </div>
    )
  }

  const totalCapitalLoss = (capitalLoss.shortTermCarryover || 0) + (capitalLoss.longTermCarryover || 0)

  return (
    <div style={{ padding: 16 }} className="tax-prep-page">
      {/* Header — hidden in print */}
      <div className="tax-prep-controls" style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        marginBottom: 16,
      }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 600 }}>
            <Receipt size={20} style={{ marginRight: 8, verticalAlign: 'middle', color: 'var(--accent-blue)' }} />
            Tax Prep Pack
          </h1>
          <p style={{ color: 'var(--text-muted)', marginTop: 4, fontSize: 13 }}>
            Year-end summary bundling HSA contributions, Schedule C buckets, and capital-loss carryover
            for handoff to your CPA.
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <label style={{ fontSize: 12, color: 'var(--text-muted)' }}>
            Tax year{' '}
            <input
              type="number" min={2020} max={2099} step={1}
              value={year}
              onChange={e => setYear(Number(e.target.value))}
              style={{
                width: 80, padding: '4px 6px', fontSize: 12,
                background: 'var(--bg-input)',
                border: '1px solid var(--border-color, rgba(255,255,255,0.15))',
                borderRadius: 4, color: 'var(--text-primary)',
              }}
            />
          </label>
          <button
            type="button"
            onClick={() => window.print()}
            style={{
              padding: '8px 14px', fontSize: 13, fontWeight: 600,
              background: 'var(--accent-blue)', color: 'white',
              border: 'none', borderRadius: 6, cursor: 'pointer',
              display: 'flex', alignItems: 'center', gap: 6,
            }}
          >
            <Printer size={14} /> Print / Save PDF
          </button>
        </div>
      </div>

      {/* ─────────────────── HSA SECTION ─────────────────── */}
      <Section title="HSA Contributions" subtitle="Form 8889 prep · per account">
        {!hsa || !hsa.accounts || hsa.accounts.length === 0 ? (
          <Empty msg="No HSA accounts detected." />
        ) : (
          <table className="tax-table">
            <thead>
              <tr>
                <th>Account</th>
                <th>Coverage</th>
                <th>IRS limit</th>
                <th>Personal YTD</th>
                <th>Employer YTD</th>
                <th>Total</th>
                <th>Headroom to max</th>
              </tr>
            </thead>
            <tbody>
              {hsa.accounts.map(a => {
                const cfgKey = `account_${a.id}`
                // The page can't read the per-account HSA config because
                // it's keyed by accountId in the dashboard tile's
                // localStorage — leaving for the user to fill manually
                // before printing if they haven't configured the tile.
                const limit = hsa.limits?.family || hsa.limits?.self || 8550
                return (
                  <tr key={a.id}>
                    <td>{a.name}</td>
                    <td>—</td>
                    <td>{fmt(limit)}</td>
                    <td>(see tracker)</td>
                    <td>(see tracker)</td>
                    <td>—</td>
                    <td>—</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 8 }}>
          Per-account YTD contribution amounts are stored in the Dashboard HSA tracker tile (localStorage).
          Open that tile, expand each account, then return here and print — the values
          {' '}<em>will appear in this report when stored centrally; for now reference the tracker directly.</em>
        </div>
      </Section>

      {/* ─────────────────── CAPITAL LOSS CARRYOVER ─────────────────── */}
      <Section title="Capital Loss Carryover" subtitle="Form 1040 Schedule D · prior year carryover available to offset gains">
        {totalCapitalLoss === 0 ? (
          <Empty msg="No capital loss carryover entered. Set on Investments page if applicable." />
        ) : (
          <table className="tax-table">
            <thead>
              <tr>
                <th>Type</th>
                <th>Carryover from prior year</th>
                <th>Notes</th>
              </tr>
            </thead>
            <tbody>
              {capitalLoss.shortTermCarryover > 0 && (
                <tr>
                  <td>Short-term</td>
                  <td>{fmt(capitalLoss.shortTermCarryover)}</td>
                  <td>Offsets short-term gains first, then long-term, then up to $3k ordinary</td>
                </tr>
              )}
              {capitalLoss.longTermCarryover > 0 && (
                <tr>
                  <td>Long-term</td>
                  <td>{fmt(capitalLoss.longTermCarryover)}</td>
                  <td>Offsets long-term gains first, then short-term, then up to $3k ordinary</td>
                </tr>
              )}
              <tr style={{ fontWeight: 600 }}>
                <td>Total available</td>
                <td>{fmt(totalCapitalLoss)}</td>
                <td>~{Math.ceil(totalCapitalLoss / 3000)} yrs of $3k ordinary deduction if no gains</td>
              </tr>
            </tbody>
          </table>
        )}
      </Section>

      {/* ─────────────────── SCHEDULE C SUMMARIES ─────────────────── */}
      {businesses.map(biz => {
        const sc = scheduleC[biz.id]
        if (!sc) return null
        return (
          <Section
            key={biz.id}
            title={`Schedule C: ${biz.name}`}
            subtitle="By IRS line · Form 1040 Schedule C ·  EIN/SSN as registered"
          >
            <table className="tax-table">
              <thead>
                <tr>
                  <th>IRS Line</th>
                  <th>Category</th>
                  <th>Amount</th>
                  <th>Notes</th>
                </tr>
              </thead>
              <tbody>
                {(sc.lines || []).map(line => (
                  <tr key={line.line_number}>
                    <td>Line {line.line_number}</td>
                    <td>{line.label}</td>
                    <td>{fmt(line.amount)}</td>
                    <td style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                      {line.note || ''}
                    </td>
                  </tr>
                ))}
                <tr style={{ fontWeight: 700, borderTop: '2px solid var(--text-primary)' }}>
                  <td colSpan={2}>Total expenses</td>
                  <td>{fmt(sc.total_expenses || 0)}</td>
                  <td></td>
                </tr>
                <tr style={{ fontWeight: 600 }}>
                  <td colSpan={2}>Gross income</td>
                  <td>{fmt(sc.total_income || 0)}</td>
                  <td></td>
                </tr>
                <tr style={{ fontWeight: 700, color: 'var(--accent-green)' }}>
                  <td colSpan={2}>Net Schedule C income</td>
                  <td>{fmt((sc.total_income || 0) - (sc.total_expenses || 0))}</td>
                  <td>SE tax applies (15.3% on net × 92.35%)</td>
                </tr>
              </tbody>
            </table>
            {sc.capital_assets && sc.capital_assets.length > 0 && (
              <div style={{ marginTop: 12 }}>
                <h4 style={{ margin: '0 0 6px', fontSize: 13 }}>Capital assets (Form 4562 — Section 179 / depreciation)</h4>
                <table className="tax-table">
                  <thead>
                    <tr><th>Date</th><th>Asset</th><th>Cost</th><th>Notes</th></tr>
                  </thead>
                  <tbody>
                    {sc.capital_assets.map((a, i) => (
                      <tr key={i}>
                        <td>{a.date}</td>
                        <td>{a.description}</td>
                        <td>{fmt(a.amount)}</td>
                        <td style={{ fontSize: 11, color: 'var(--text-muted)' }}>{a.note || ''}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Section>
        )
      })}

      {businesses.length === 0 && (
        <Section title="Schedule C" subtitle="Self-employment income">
          <Empty msg="No tagged businesses. Tag transactions on the Business page to populate Schedule C summaries." />
        </Section>
      )}

      {/* ─────────────────── FOOTER ─────────────────── */}
      <div style={{
        marginTop: 24, padding: 12,
        background: 'var(--bg-input)',
        border: '1px solid var(--border-color, rgba(255,255,255,0.08))',
        borderRadius: 6,
        fontSize: 11, color: 'var(--text-muted)',
      }}>
        <strong>Disclaimer:</strong> This report is generated from data you've entered into Tusk Ledger
        and is intended as an organizing aid for your CPA, not a substitute for professional tax advice.
        Verify all figures before filing.
      </div>

      {/* Print stylesheet — hides UI chrome, white background, page-break aware */}
      <style>{`
        .tax-table {
          width: 100%;
          border-collapse: collapse;
          font-size: 12px;
          margin-top: 8px;
        }
        .tax-table th {
          text-align: left;
          padding: 6px 8px;
          background: var(--bg-input);
          color: var(--text-muted);
          font-weight: 600;
          font-size: 11px;
          text-transform: uppercase;
          letter-spacing: 0.4px;
          border-bottom: 1px solid var(--border-color, rgba(255,255,255,0.1));
        }
        .tax-table td {
          padding: 6px 8px;
          color: var(--text-primary);
          border-bottom: 1px solid var(--border-color, rgba(255,255,255,0.04));
        }
        @media print {
          .tax-prep-controls { display: none !important; }
          aside, nav, .sidebar, header { display: none !important; }
          .tax-prep-page { padding: 0; color: black; background: white; }
          .tax-prep-page * { color: black !important; background: white !important; border-color: #ccc !important; }
          .tax-table th { background: #f4f4f4 !important; }
          h1, h2, h3, h4 { color: black !important; }
          section { page-break-inside: avoid; }
        }
      `}</style>
    </div>
  )
}


function Section({ title, subtitle, children }) {
  return (
    <section style={{ marginBottom: 24 }}>
      <h2 style={{ margin: '0 0 4px', fontSize: 16, fontWeight: 600 }}>{title}</h2>
      {subtitle && (
        <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 8 }}>
          {subtitle}
        </div>
      )}
      {children}
    </section>
  )
}

function Empty({ msg }) {
  return (
    <div style={{
      padding: 16, fontSize: 12, color: 'var(--text-muted)',
      fontStyle: 'italic', textAlign: 'center',
      background: 'var(--bg-input)',
      border: '1px dashed var(--border-color, rgba(255,255,255,0.1))',
      borderRadius: 6,
    }}>
      {msg}
    </div>
  )
}
