/**
 * Pure-function unit test for parseLocalIntent() / resolvePeriod()
 * (src/ask/intent.ts). Plain Node — run from mobile/:
 *   node scripts/test-ask-intent.mjs
 */
import { parseLocalIntent, resolvePeriod } from '../src/ask/intent.ts';

let failures = 0;
function eq(label, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  const ok = g === w;
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}: got ${g}, want ${w}`);
}

// Fixed "now": Tue 15 Sep 2026 (local).
const now = new Date(2026, 8, 15, 12, 0, 0);
const P = (q) => parseLocalIntent(q, now);

// ── periods ──────────────────────────────────────────────────────
eq('default period = this month', resolvePeriod('how much did i spend', now), { label: 'this month', start: '2026-09-01', end: '2026-10-01' });
eq('last month', resolvePeriod('spend last month', now), { label: 'last month', start: '2026-08-01', end: '2026-09-01' });
eq('this week (7 days)', resolvePeriod('this week', now), { label: 'the last 7 days', start: '2026-09-09', end: '2026-09-16' });
eq('last week = prev Sun..Sat', resolvePeriod('last week', now), { label: 'last week', start: '2026-09-06', end: '2026-09-13' });
eq('today', resolvePeriod('today', now), { label: 'today', start: '2026-09-15', end: '2026-09-16' });
eq('named past month', resolvePeriod('in july', now), { label: 'July', start: '2026-07-01', end: '2026-08-01' });
eq('named future month → last year', resolvePeriod('in december', now), { label: 'December', start: '2025-12-01', end: '2026-01-01' });
eq('ytd', resolvePeriod('this year', now), { label: 'this year', start: '2026-01-01', end: '2027-01-01' });

// ── spend ────────────────────────────────────────────────────────
eq('spend total', P('How much have I spent this month?').kind, 'spend_total');
eq('spend total last month period', P('what did I spend last month').period.label, 'last month');
eq('spend category', P('how much on groceries this month?'), { kind: 'spend_category', category: 'groceries', period: { label: 'this month', start: '2026-09-01', end: '2026-10-01' } });
eq('spend category "for"', P('what did I spend for dining last month').category, 'dining');
eq('spend merchant', P('how much have I spent at costco this month'), { kind: 'spend_merchant', merchant: 'costco', period: { label: 'this month', start: '2026-09-01', end: '2026-10-01' }, lastOnly: false });
eq('spend merchant last time', P("what did I spend at costco last time?"), { kind: 'spend_merchant', merchant: 'costco', period: null, lastOnly: true });
eq('spend merchant with apostrophe', P("how much at trader joe's").merchant, "trader joe's");

// ── income / balance / net worth ─────────────────────────────────
eq('income', P('how much did I make this month').kind, 'income_total');
eq('income period', P('income last month').period.label, 'last month');
eq('balance named', P("what's my checking balance"), { kind: 'balance', account: 'checking' });
eq('balance "in"', P('how much is in savings'), { kind: 'balance', account: 'savings' });
eq('balance all', P('what are my balances'), { kind: 'balance', account: null });
eq('net worth', P("what's my net worth?"), { kind: 'net_worth' });

// ── bills / budget / biggest ─────────────────────────────────────
eq('bills all', P('what bills are due'), { kind: 'upcoming_bills', name: null });
eq('bills named', P('when is the mortgage due'), { kind: 'upcoming_bills', name: 'mortgage' });
eq('budget all', P('how am I doing on my budget'), { kind: 'budget_status', category: null });
eq('budget category', P('am I over on dining'), { kind: 'budget_status', category: 'dining' });
eq('biggest', P('biggest purchases this month'), { kind: 'biggest_expenses', period: { label: 'this month', start: '2026-09-01', end: '2026-10-01' }, limit: 5 });
eq('top n', P('top 3 expenses last month').limit, 3);

// ── unknown → null ───────────────────────────────────────────────
eq('unknown question', P('should I refinance my mortgage rate'), null);
eq('empty', P('   '), null);
eq('advice-y', P('what stock should I buy'), null);

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
