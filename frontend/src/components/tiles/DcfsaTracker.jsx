import { useEffect, useState } from 'react'
import { Calendar } from 'lucide-react'
import { useStoredState } from '../../lib/storage'
import { getTransactions } from '../../api/client'
import { useAccounts } from '../../hooks/useAccounts'
import { openAccounts } from '../../lib/accountStatus'
import { isDcfsaAccount, isCashWalletAccount, summarizeDcfsa } from '../../lib/benefitCash'
import { tileCardStyle, PAYCHECKS_PER_YEAR, hsaInputStyle } from './shared'
import { fmtMoney } from './shared'

/**
 * DcfsaTracker — dependent-care FSA tracker.
 *
 * DCFSAs differ from HSAs in three important ways that this tile
 * encodes:
 *   1. Use-it-or-lose-it deadline (typically Dec 31 of plan year, or
 *      Mar 15 with grace period). HSA money rolls forward forever.
 *   2. Usually no bank account to sync — DCFSA is payroll-deducted and
 *      reimbursed via claim. When a manual DCFSA account exists (depository,
 *      subtype "fsa" — see lib/benefitCash.js) the tile reads funded /
 *      claimed / per-check / cadence from its transactions and only keeps
 *      election, plan-year end and tax rate in localStorage. Without one it
 *      falls back to the localStorage-driven estimate.
 *   3. Single annual limit (2025: $5,000 MFJ / $2,500 MFS), no
 *      coverage-type or age catch-up branching.
 *
 * Drives a "use it or lose it $X by [deadline]" warning when funded
 * but not spent — the most common DCFSA failure mode.
 *
 * Storage: tuskledger.dcfsaConfig.v1 = {
 *   annual_election,    // user's elected $ amount for the year
 *   per_paycheck,       // payroll deduction per check
 *   pay_frequency,      // weekly | biweekly | semimonthly | monthly
 *   payroll_start_date, // ISO date of first paycheck of the year
 *   spent_ytd,          // user-entered, what's been claimed/used
 *   plan_year_end,      // ISO date of plan-year deadline (default 12/31)
 *   marginal_tax_rate,  // for tax-savings display
 * }
 */
const DCFSA_CONFIG_KEY = 'tuskledger.dcfsaConfig.v1'
const DCFSA_LIMIT_2025 = 5000  // MFJ; MFS is half but rare for households
const DEFAULT_DCFSA_MARGINAL_RATE = 0.2625

function DcfsaField({ label, children, full }) {
  return (
    <label style={{
      display: 'flex', flexDirection: 'column', gap: 3,
      gridColumn: full ? '1 / -1' : undefined,
    }}>
      <span style={{
        fontSize: 9, color: 'var(--text-muted)',
        textTransform: 'uppercase', letterSpacing: 0.4,
      }}>{label}</span>
      {children}
    </label>
  )
}

/** Pick this plan year's DCFSA: prefer one whose name carries the year. */
function pickDcfsa(accounts, year) {
  const fsas = openAccounts(accounts).filter(isDcfsaAccount)
  if (fsas.length === 0) return null
  const named = fsas.find(a => `${a.custom_name || ''} ${a.name || ''}`.includes(String(year)))
  return named || fsas.sort((a, b) => b.id - a.id)[0]
}

/** The wallet the administrator pays claims into — same institution if possible. */
function pickWallet(accounts, fsa) {
  if (!fsa) return null
  const wallets = openAccounts(accounts).filter(isCashWalletAccount)
  return wallets.find(w => w.institution_name && w.institution_name === fsa.institution_name)
    || (wallets.length === 1 ? wallets[0] : null)
}

export function DcfsaTracker() {
  const [config, setConfig] = useStoredState(DCFSA_CONFIG_KEY, {})
  const [editing, setEditing] = useState(false)
  const { accounts } = useAccounts()
  const planYear = new Date().getFullYear()
  const fsaAcct = pickDcfsa(accounts, planYear)
  const wallet = pickWallet(accounts, fsaAcct)
  const fsaId = fsaAcct?.id
  const [summary, setSummary] = useState(null)

  useEffect(() => {
    if (!fsaId) { setSummary(null); return }
    let cancelled = false
    getTransactions({
      account_id: fsaId,
      start_date: `${planYear}-01-01`,
      end_date: `${planYear}-12-31`,
      limit: 500,
    })
      .then(txns => { if (!cancelled) setSummary(summarizeDcfsa(txns || [], planYear)) })
      .catch(() => { if (!cancelled) setSummary(null) })
    return () => { cancelled = true }
  }, [fsaId, planYear])

  const linked = !!(fsaAcct && summary)

  // Empty state — fills a standard-size tile (~330px tall) without
  // looking hollow. Layout: header pinned to top, value-prop content
  // centered vertically in the remaining space, "Configure tracker"
  // button pinned to bottom. The "what you'd see if configured"
  // preview list teaches the user what the tracker tracks before
  // they invest in setting it up — turns dead space into onboarding.
  if (!linked && !config.annual_election && !editing) {
    return (
      <div className="card" style={tileCardStyle}>
        <div className="card-header">
          <span className="card-title" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <Calendar size={14} style={{ color: 'var(--accent-blue)' }} /> Dependent-care FSA
          </span>
        </div>

        {/* Value-prop block. flex: 1 absorbs the slack between the
            header and the bottom-pinned configure button when the
            card is stretched to match a tall row neighbor. Content
            stays vertically centered in the available space. */}
        <div style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          gap: 10,
          padding: '6px 0 10px',
        }}>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.5 }}>
            Tax-advantaged account for daycare, after-school, summer camp.{' '}
            <strong style={{ color: 'var(--text-primary)' }}>Use-it-or-lose-it</strong> by Dec 31. Up to $5,000/yr MFJ.
          </div>
          <div style={{
            fontSize: 11, color: 'var(--text-dim)',
            textTransform: 'uppercase', letterSpacing: 0.4, fontWeight: 600,
            marginTop: 4,
          }}>
            What you&apos;ll see here
          </div>
          <ul style={{
            margin: 0, padding: 0, listStyle: 'none',
            display: 'flex', flexDirection: 'column', gap: 6,
            fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.4,
          }}>
            <li style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
              <span style={{ color: 'var(--accent-blue)', flexShrink: 0 }}>•</span>
              <span>YTD funded vs election, with paycheck pacing</span>
            </li>
            <li style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
              <span style={{ color: 'var(--accent-blue)', flexShrink: 0 }}>•</span>
              <span>At-risk dollars and days-to-deadline countdown</span>
            </li>
            <li style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
              <span style={{ color: 'var(--accent-blue)', flexShrink: 0 }}>•</span>
              <span>Tax savings projected at your marginal rate</span>
            </li>
          </ul>
        </div>

        <button
          type="button"
          onClick={() => setEditing(true)}
          style={{
            width: '100%', padding: '8px 12px',
            background: 'var(--accent-blue-bg)',
            border: '1px solid var(--accent-blue-border)',
            borderRadius: 6, color: 'var(--accent-blue)',
            fontSize: 12, fontWeight: 600, cursor: 'pointer',
          }}
        >
          + Configure tracker
        </button>
      </div>
    )
  }

  const today = new Date()
  const election = Number(config.annual_election)
    || (linked ? summary.projectedElection : 0)
  const perCheck = linked ? summary.perCheck : (Number(config.per_paycheck) || 0)
  const ppy = (linked && summary.paychecksPerYear)
    || PAYCHECKS_PER_YEAR[config.pay_frequency] || 26

  // Compute YTD payroll-funded amount the same way the HSA tracker
  // does — proportion of year elapsed × paychecks/yr.
  const yearStart = new Date(today.getFullYear(), 0, 1, 12)
  const yearEnd = new Date(today.getFullYear(), 11, 31, 12)
  const start = config.payroll_start_date
    ? new Date(config.payroll_start_date + 'T12:00:00')
    : yearStart
  const day = (a, b) => Math.max(0, Math.floor((b - a) / (1000 * 60 * 60 * 24)))
  const elapsedFrac = Math.min(1, day(start, today) / 365)
  const elapsedPaychecks = linked ? summary.contributions : Math.floor(elapsedFrac * ppy)
  const funded_ytd = linked ? summary.funded : elapsedPaychecks * perCheck

  const planEnd = config.plan_year_end
    ? new Date(config.plan_year_end + 'T12:00:00')
    : yearEnd
  const daysToDeadline = day(today, planEnd)

  const spent = linked ? summary.claimed : (Number(config.spent_ytd) || 0)
  const walletBalance = linked && wallet ? (wallet.current_balance || 0) : 0
  const remaining_to_spend = Math.max(0, funded_ytd - spent)
  const remaining_to_fund = Math.max(0, election - funded_ytd)

  const marginalRate = config.marginal_tax_rate
    || DEFAULT_DCFSA_MARGINAL_RATE
  const tax_savings_at_election = election * marginalRate

  // Risk: amount that's been deducted from your paycheck but won't
  // get used by the deadline. This is the actual money you'd lose.
  const at_risk = remaining_to_spend  // worst-case if no more spending

  return (
    <div className="card" style={tileCardStyle}>
      <div className="card-header">
        <span className="card-title" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <Calendar size={14} style={{ color: 'var(--accent-blue)' }} /> Dependent-care FSA
        </span>
        <button
          type="button"
          onClick={() => setEditing(!editing)}
          style={{
            background: 'transparent', border: 'none',
            color: 'var(--text-muted)', cursor: 'pointer', fontSize: 11,
          }}
        >
          {editing ? '✓ Done' : '⚙ Edit'}
        </button>
      </div>

      {linked && !editing && (
        <div style={{ fontSize: 11, color: 'var(--text-muted)', margin: '-2px 0 8px' }}>
          From {fsaAcct.custom_name || fsaAcct.name}
          {summary.lastContribution && ` · last contribution ${new Date(summary.lastContribution + 'T12:00:00').toLocaleDateString()}`}
          {!config.annual_election && election > 0 && ` · election est. from ${fmtMoney(perCheck)} × ${ppy}/yr`}
        </div>
      )}

      {/* Hero: at-risk dollars + deadline countdown */}
      {!editing && election > 0 && (
        <>
          <div style={{
            display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)',
            gap: 12, marginBottom: 10,
          }}>
            <div>
              <div style={{ fontSize: 10, color: 'var(--text-muted)',
                textTransform: 'uppercase', letterSpacing: 0.4 }}>
                At risk
              </div>
              <div style={{
                fontSize: 18, fontWeight: 700,
                color: at_risk > 0 ? 'var(--accent-orange)' : 'var(--accent-green)',
              }}>
                {fmtMoney(at_risk)}
              </div>
              <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>
                {linked ? 'funded but unclaimed' : 'funded but unspent'}
              </div>
            </div>
            <div>
              <div style={{ fontSize: 10, color: 'var(--text-muted)',
                textTransform: 'uppercase', letterSpacing: 0.4 }}>
                Days to deadline
              </div>
              <div style={{
                fontSize: 18, fontWeight: 700,
                color: daysToDeadline < 30 ? 'var(--accent-orange)'
                  : daysToDeadline < 90 ? 'var(--accent-yellow)'
                  : 'var(--text-primary)',
              }}>
                {daysToDeadline}
              </div>
              <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>
                {planEnd.toLocaleDateString()}
              </div>
            </div>
            <div>
              <div style={{ fontSize: 10, color: 'var(--text-muted)',
                textTransform: 'uppercase', letterSpacing: 0.4 }}>
                Tax savings
              </div>
              <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--accent-green)' }}>
                {fmtMoney(tax_savings_at_election)}
              </div>
              <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>
                @ {Math.round(marginalRate * 100)}% marginal
              </div>
            </div>
          </div>

          {/* Progress bar — funded vs election */}
          <div style={{ marginBottom: 6 }}>
            <div style={{
              fontSize: 11, color: 'var(--text-muted)', marginBottom: 3,
              display: 'flex', justifyContent: 'space-between',
            }}>
              <span>Funded YTD</span>
              <span>{fmtMoney(funded_ytd)} of {fmtMoney(election)}</span>
            </div>
            <div style={{
              height: 6, background: 'var(--bg-input)', borderRadius: 3,
              overflow: 'hidden',
            }}>
              <div style={{
                height: '100%',
                width: `${Math.min(100, (funded_ytd / Math.max(1, election)) * 100)}%`,
                background: 'var(--accent-blue)',
              }} />
            </div>
          </div>

          {/* Spent bar */}
          <div>
            <div style={{
              fontSize: 11, color: 'var(--text-muted)', marginBottom: 3,
              display: 'flex', justifyContent: 'space-between',
            }}>
              <span>Spent / claimed YTD</span>
              <span>{fmtMoney(spent)} of {fmtMoney(funded_ytd)} funded</span>
            </div>
            <div style={{
              height: 6, background: 'var(--bg-input)', borderRadius: 3,
              overflow: 'hidden',
            }}>
              <div style={{
                height: '100%',
                width: `${Math.min(100, (spent / Math.max(1, funded_ytd)) * 100)}%`,
                background: 'var(--accent-green)',
              }} />
            </div>
          </div>

          {/* Reimbursed money parked in the administrator's wallet */}
          {walletBalance > 0 && (
            <div style={{
              marginTop: 10, padding: '8px 10px',
              background: 'var(--accent-blue-bg)',
              border: '1px solid var(--accent-blue-border)',
              borderRadius: 6, fontSize: 11,
              color: 'var(--text-primary)', lineHeight: 1.4,
            }}>
              <strong style={{ color: 'var(--accent-blue)' }}>Reimbursed, not yet in checking: </strong>
              {fmtMoney(walletBalance)} is sitting in {wallet.custom_name || wallet.name}.
              Transfer it to your bank to use it.
            </div>
          )}

          {/* Action nudges */}
          {at_risk > 100 && daysToDeadline < 90 && (
            <div style={{
              marginTop: 10, padding: '8px 10px',
              background: 'var(--accent-orange-bg)',
              border: '1px solid var(--accent-orange-border)',
              borderRadius: 6, fontSize: 11,
              color: 'var(--text-primary)', lineHeight: 1.4,
            }}>
              <strong style={{ color: 'var(--accent-orange)' }}>Use it or lose it: </strong>
              {fmtMoney(at_risk)} sits in your DCFSA with {daysToDeadline} days
              before the {planEnd.toLocaleDateString()} deadline. Submit
              eligible expenses (daycare, after-school, day camp, in-home
              care) before then or the funds are forfeited.
            </div>
          )}
          {remaining_to_fund > 0 && elapsedPaychecks < ppy && (
            <div style={{
              marginTop: 10, padding: '8px 10px',
              background: 'var(--accent-blue-bg)',
              border: '1px solid var(--accent-blue-border)',
              borderRadius: 6, fontSize: 11,
              color: 'var(--text-primary)', lineHeight: 1.4,
            }}>
              <strong style={{ color: 'var(--accent-blue)' }}>To max election: </strong>
              {fmtMoney(remaining_to_fund)} remaining over ~{ppy - elapsedPaychecks} paychecks.
            </div>
          )}
        </>
      )}

      {/* Edit form */}
      {editing && (
        <div style={{
          display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8,
          marginTop: 8,
        }}>
          <DcfsaField label="Annual election">
            <input type="number" min={0} max={5000} step={50}
              value={config.annual_election || ''}
              onChange={e => setConfig({ ...config, annual_election: Number(e.target.value) })}
              placeholder={linked && summary.projectedElection
                ? `est. ${fmtMoney(summary.projectedElection)}`
                : `Up to $${DCFSA_LIMIT_2025} MFJ`}
              style={hsaInputStyle} />
          </DcfsaField>
          {!linked && <>
          <DcfsaField label="Per paycheck">
            <input type="number" min={0} step={5}
              value={config.per_paycheck || ''}
              onChange={e => setConfig({ ...config, per_paycheck: Number(e.target.value) })}
              style={hsaInputStyle} />
          </DcfsaField>
          <DcfsaField label="Pay frequency">
            <select
              value={config.pay_frequency || 'biweekly'}
              onChange={e => setConfig({ ...config, pay_frequency: e.target.value })}
              style={hsaInputStyle}
            >
              <option value="weekly">Weekly</option>
              <option value="biweekly">Biweekly</option>
              <option value="semimonthly">Semimonthly</option>
              <option value="monthly">Monthly</option>
            </select>
          </DcfsaField>
          <DcfsaField label="Payroll start">
            <input type="date"
              value={config.payroll_start_date || ''}
              onChange={e => setConfig({ ...config, payroll_start_date: e.target.value })}
              style={hsaInputStyle} />
          </DcfsaField>
          <DcfsaField label="Spent / claimed YTD">
            <input type="number" min={0} step={50}
              value={config.spent_ytd || ''}
              onChange={e => setConfig({ ...config, spent_ytd: Number(e.target.value) })}
              style={hsaInputStyle} />
          </DcfsaField>
          </>}
          <DcfsaField label="Plan year end">
            <input type="date"
              value={config.plan_year_end || ''}
              onChange={e => setConfig({ ...config, plan_year_end: e.target.value })}
              placeholder="12/31 default"
              style={hsaInputStyle} />
          </DcfsaField>
          <DcfsaField label="Marginal tax rate %" full>
            <input type="number" min={0} max={50} step={0.5}
              value={config.marginal_tax_rate ? Math.round(config.marginal_tax_rate * 1000) / 10 : ''}
              onChange={e => setConfig({ ...config, marginal_tax_rate: Number(e.target.value) / 100 })}
              placeholder={`default ${Math.round(DEFAULT_DCFSA_MARGINAL_RATE * 100)}%`}
              style={hsaInputStyle} />
          </DcfsaField>
        </div>
      )}
    </div>
  )
}
