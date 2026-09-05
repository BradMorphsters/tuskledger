/**
 * Pure helpers behind "you just recategorized X — make it stick".
 *
 * Kept free of React and network so the two decisions that matter can be
 * unit-tested: WHAT pattern a rule should use for a given transaction,
 * and HOW to reverse a batch of category changes.
 */

// Store/terminal suffixes that make a merchant string unique per visit:
// "COFFEE HUT #12", "SQ *TACO PLANET", "AMAZON MKTPL*AB12CD34X". A rule
// built from the raw string would match one receipt; the pattern has to
// be the part that repeats.
const _TRAILING_NOISE = /\s*(#\s*\d+|\*\s*[A-Z0-9]{4,}|\d{3,})\s*$/i
const _LEADING_PROCESSOR = /^(SQ|TST|DD|PP|PAYPAL|SP|WWW)\s*\*\s*/i

/**
 * Best substring for a category rule, given a transaction.
 *
 * Prefers the normalized display name (the backend has already stripped
 * ACH metadata), then merchant_name, then the raw name. Lower-cased and
 * trimmed to match the rule engine (case-insensitive substring over
 * merchant_name + " " + name). Returns null when nothing usable remains
 * (< 3 chars) — the UI then falls back to "Apply to N past" only.
 */
export function buildRulePattern(txn) {
  if (!txn) return null
  const raw = (txn.display_name || txn.merchant_name || txn.name || '').trim()
  if (!raw) return null
  let p = raw.replace(_LEADING_PROCESSOR, '')
  // Strip noise repeatedly — "AMAZON MKTPL*AB12CD34X #4" has two layers.
  let prev
  do { prev = p; p = p.replace(_TRAILING_NOISE, '') } while (p !== prev)
  p = p.replace(/\s+/g, ' ').trim().toLowerCase()
  return p.length >= 3 ? p : null
}

/**
 * Given the preview's candidates, produce the PATCH bodies that put every
 * row back exactly as it was. A row that had no override before is
 * restored with custom_category: "" (the API's "clear" convention).
 */
export function undoPlan(candidates) {
  return (candidates || []).map(c => ({
    id: c.id,
    body: { custom_category: c.prior_custom_category == null ? '' : c.prior_custom_category },
  }))
}

/**
 * Undo plan for a bulk edit made from a table: `rows` are the rows as
 * they were BEFORE the change. `field` is 'custom_category' or
 * 'is_transfer'.
 */
export function bulkUndoPlan(rows, field) {
  return (rows || []).map(r => {
    if (field === 'is_transfer') return { id: r.id, body: { is_transfer: !!r.is_transfer } }
    return { id: r.id, body: { custom_category: r.custom_category == null ? '' : r.custom_category } }
  })
}

/** Human sentence for the suggestion card. */
export function describeSuggestion({ merchant, category, count, alreadyCorrect }) {
  if (!count) return null
  const base = `${count} other ${merchant} transaction${count === 1 ? '' : 's'} ${count === 1 ? 'is' : 'are'} not ${category}`
  return alreadyCorrect > 0 ? `${base} (${alreadyCorrect} already ${alreadyCorrect === 1 ? 'is' : 'are'}).` : `${base}.`
}
