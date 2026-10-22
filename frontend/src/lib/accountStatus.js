/**
 * Closed-account helpers.
 *
 * A closed account (status === 'closed') keeps its transaction history but
 * holds no money. "Current" views — balances, pickers for new data, alerts —
 * leave it out; history views (Transactions, Spending, CSV import of an old
 * statement) keep it, labelled so it's clear it's no longer in use.
 */
export const isClosed = (a) => a?.status === 'closed'

export const openAccounts = (accounts) => (accounts || []).filter((a) => !isClosed(a))

/** Display name with a "(closed)" suffix for closed accounts. */
export const accountLabel = (a) => {
  const name = a?.custom_name || a?.name || (a?.id != null ? `Account ${a.id}` : '')
  return isClosed(a) ? `${name} (closed)` : name
}
