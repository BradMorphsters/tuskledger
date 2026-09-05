/**
 * "Can I afford this?" — the store-aisle question, answered from the
 * laptop's safe-to-spend breakdown without a network round-trip.
 *
 * Pure function so it is unit-testable in plain Node (see
 * scripts/test-afford.mjs) and so the card component stays dumb.
 *
 * Verdict ladder, from the safe-to-spend definition
 *   safe = checking − bills due before payday − usual spending before payday
 *
 *   'yes'    amount ≤ safe                      → still positive after buying
 *   'tight'  safe < amount ≤ safe + usualSpend  → eats into the "usual
 *            spending" allowance: affordable only by spending less than
 *            normal on everything else until payday
 *   'no'     amount > safe + usualSpend         → would need the bill
 *            reserve or savings; checking can't cover it and the bills
 *
 * `remaining` is what safe-to-spend becomes after the purchase (may be
 * negative). `usesSavings` flags the case where even checking + savings
 * can't cover the bills after the purchase — the "this is a real
 * decision, not a small one" signal.
 */
export type AffordVerdict = 'yes' | 'tight' | 'no';

export interface AffordInput {
  /** safe_to_spend from the laptop (already net of bills + usual spend). */
  safeToSpend: number;
  /** budget_remaining_pro_rata — the usual-spending allowance until payday. */
  usualSpending: number;
  /** spendable_cash — checking balances. */
  spendableCash: number;
  /** bills_due — bills before the next paycheck. */
  billsDue: number;
  /** savings_cash — reported but not counted toward safe-to-spend. */
  savingsCash: number;
}

export interface AffordResult {
  verdict: AffordVerdict;
  /** Safe-to-spend after the purchase. */
  remaining: number;
  /** How far the purchase cuts into the usual-spending allowance (0 when 'yes'). */
  allowanceUsed: number;
  /** True when checking + savings together can't cover bills after buying. */
  usesSavings: boolean;
  /** True when checking alone can't cover bills after buying. */
  dipsIntoBills: boolean;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function affordability(input: AffordInput, amount: number): AffordResult | null {
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const safe = input.safeToSpend;
  const usual = Math.max(input.usualSpending, 0);
  const remaining = round2(safe - amount);

  let verdict: AffordVerdict;
  if (amount <= safe) verdict = 'yes';
  else if (amount <= safe + usual) verdict = 'tight';
  else verdict = 'no';

  const allowanceUsed = verdict === 'yes' ? 0 : round2(Math.min(amount - safe, usual));
  const cashAfter = input.spendableCash - amount;
  const dipsIntoBills = cashAfter < input.billsDue;
  const usesSavings = cashAfter + Math.max(input.savingsCash, 0) < input.billsDue;

  return { verdict, remaining, allowanceUsed, usesSavings, dipsIntoBills };
}

/**
 * Parse what a person types into a money field: "$1,250.5", "1250",
 * "12.5k" → 12500. Returns null for anything that isn't a positive number.
 */
export function parseAmount(text: string): number | null {
  const cleaned = text.replace(/[$,\s]/g, '').toLowerCase();
  if (!cleaned) return null;
  const m = /^(\d+(?:\.\d+)?)(k)?$/.exec(cleaned);
  if (!m) return null;
  let n = parseFloat(m[1]);
  if (m[2] === 'k') n *= 1000;
  return n > 0 && Number.isFinite(n) ? n : null;
}
