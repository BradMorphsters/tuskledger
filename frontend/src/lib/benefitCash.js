/**
 * Benefit-account helpers — dependent-care FSA and the cash "wallets"
 * benefit administrators pay reimbursements into.
 *
 * A DCFSA is a manual depository account (subtype "fsa"). Its ledger is:
 *   inflows  (amount < 0) — pre-tax payroll contributions
 *   outflows (amount > 0) — claims paid out (reimbursements)
 * so its current balance is "funded but not yet claimed" — the money that
 * is forfeited if it isn't claimed by the plan-year deadline.
 *
 * Many administrators don't deposit reimbursements straight to the bank;
 * they land in a holding wallet first (a depository account with subtype
 * "cash management"). That balance is real, spendable cash that just
 * hasn't been moved to checking yet.
 */

const DCFSA_NAME_RE = /dependent[\s-]*care|\bdcfsa\b|\bdc\s*fsa\b/i

/** True for a dependent-care FSA account. */
export function isDcfsaAccount(a) {
  if (!a || a.type !== 'depository') return false
  const sub = (a.subtype || '').toLowerCase()
  const name = `${a.custom_name || ''} ${a.name || ''}`
  return sub === 'fsa' || DCFSA_NAME_RE.test(name)
}

/** True for a cash-holding wallet (Plaid subtype "cash management"). */
export function isCashWalletAccount(a) {
  if (!a || a.type !== 'depository') return false
  return (a.subtype || '').toLowerCase() === 'cash management'
}

/**
 * "Other cash" for the Cash balances tile: open depository accounts that
 * aren't checking or savings but still hold the household's cash —
 * benefit wallets and FSAs. Savings stays excluded on purpose (see
 * CashBalances.jsx).
 */
export function isOtherCashAccount(a) {
  return isCashWalletAccount(a) || isDcfsaAccount(a)
}

/**
 * Pay periods per year inferred from the gaps between contribution
 * dates. Returns null with fewer than two contributions.
 *   ≤ 10 days → weekly (52), ≤ 14.5 → biweekly (26),
 *   ≤ 20 → semimonthly (24), otherwise monthly (12)
 */
export function inferPaychecksPerYear(dates) {
  const ds = [...new Set(dates)].sort()
  if (ds.length < 2) return null
  const gaps = []
  for (let i = 1; i < ds.length; i++) {
    const a = new Date(ds[i - 1] + 'T12:00:00')
    const b = new Date(ds[i] + 'T12:00:00')
    gaps.push((b - a) / 86_400_000)
  }
  gaps.sort((x, y) => x - y)
  const median = gaps[Math.floor(gaps.length / 2)]
  if (median <= 10) return 52
  if (median <= 14.5) return 26
  if (median <= 20) return 24
  return 12
}

/**
 * Summarise a DCFSA's plan-year activity from its transactions.
 *
 * @param {Array} txns   transactions on the FSA account (app sign convention)
 * @param {number} year  plan year to summarise
 * @returns {{
 *   funded: number, claimed: number, contributions: number,
 *   perCheck: number, paychecksPerYear: number|null,
 *   projectedElection: number, lastContribution: string|null,
 * }}
 */
export function summarizeDcfsa(txns, year) {
  const prefix = String(year)
  let funded = 0
  let claimed = 0
  const contribs = []
  for (const t of txns || []) {
    if (!t?.date || !String(t.date).startsWith(prefix)) continue
    const amt = Number(t.amount) || 0
    if (amt < 0) {
      funded += -amt
      contribs.push(t)
    } else if (amt > 0) {
      claimed += amt
    }
  }
  contribs.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
  const last = contribs[contribs.length - 1] || null
  const perCheck = last ? Math.abs(Number(last.amount) || 0) : 0
  const ppy = inferPaychecksPerYear(contribs.map((t) => t.date))
  // Per-check deductions are usually election / periods, rounded to the
  // cent ($3,000 / 26 = $115.38), so round the projection to $10.
  const projectedElection = ppy && perCheck ? Math.round((perCheck * ppy) / 10) * 10 : 0
  return {
    funded: round2(funded),
    claimed: round2(claimed),
    contributions: contribs.length,
    perCheck,
    paychecksPerYear: ppy,
    projectedElection,
    lastContribution: last ? last.date : null,
  }
}

const round2 = (n) => Math.round(n * 100) / 100
