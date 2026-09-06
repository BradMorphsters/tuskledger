/**
 * Pure-function unit test for parseLocalIntent() / resolvePeriod()
 * (src/ask/intent.ts). Plain Node — run from mobile/:
 *   node scripts/test-ask-intent.mjs
 *
 * The corpus mirrors backend/tests/test_ask_common_questions.py so the phone's
 * offline parser and the laptop's router agree on what everyday phrasings mean.
 */
import { parseLocalIntent, resolvePeriod } from '../src/ask/intent.ts';

let failures = 0;
function eq(label, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  const ok = g === w;
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}: got ${g}, want ${w}`);
}
function kind(q, want) {
  const r = parseLocalIntent(q, now);
  eq(`route "${q}"`, r ? r.kind : null, want);
  return r;
}

// Fixed "now": Tue 15 Sep 2026 (local).
const now = new Date(2026, 8, 15, 12, 0, 0);

// ── periods ──────────────────────────────────────────────────────
eq('default period = this month', resolvePeriod('how much did i spend', now), { label: 'this month', start: '2026-09-01', end: '2026-10-01' });
eq('last month', resolvePeriod('spend last month', now), { label: 'last month', start: '2026-08-01', end: '2026-09-01' });
eq('this week (7 days)', resolvePeriod('this week', now), { label: 'the last 7 days', start: '2026-09-09', end: '2026-09-16' });
eq('last week = prev Sun..Sat', resolvePeriod('last week', now), { label: 'last week', start: '2026-09-06', end: '2026-09-13' });
eq('today', resolvePeriod('today', now), { label: 'today', start: '2026-09-15', end: '2026-09-16' });
eq('yesterday', resolvePeriod('yesterday', now), { label: 'yesterday', start: '2026-09-14', end: '2026-09-15' });
eq('named past month', resolvePeriod('in july', now), { label: 'July', start: '2026-07-01', end: '2026-08-01' });
eq('named future month → last year', resolvePeriod('in december', now), { label: 'December', start: '2025-12-01', end: '2026-01-01' });
eq('ytd', resolvePeriod('this year', now), { label: 'this year', start: '2026-01-01', end: '2027-01-01' });
eq('since july', resolvePeriod('since july', now), { label: 'since July', start: '2026-07-01', end: '2026-09-16' });
eq('this weekend = most recent Sat–Sun', resolvePeriod('this weekend', now), { label: 'this weekend', start: '2026-09-12', end: '2026-09-14' });
eq('last 14 days', resolvePeriod('in the last 14 days', now), { label: 'the last 14 days', start: '2026-09-02', end: '2026-09-16' });

// ── spending ─────────────────────────────────────────────────────
kind('How much have I spent this month?', 'spend_total');
eq('spend total last month period', parseLocalIntent('what did I spend last month', now).period.label, 'last month');
kind('spending this weekend', 'spend_total');
kind('how many transactions this month', 'spend_total');
eq('spend category', kind('how much on groceries this month?', 'spend_category').category, 'groceries');
eq('spend category "for"', kind('what did I spend for dining last month', 'spend_category').category, 'dining');
eq('food', kind('what did I spend on food this month', 'spend_category').category, 'food');
eq('eating out', kind('how much have I spent eating out', 'spend_category').category, 'eating out');
eq('gas', kind('how much did I spend on gas', 'spend_category').category, 'gas');
eq('amazon goes through as a word (local.ts tries store then category)', kind('how much did I spend on Amazon', 'spend_category').category, 'amazon');
eq('spend merchant', kind('how much have I spent at costco this month', 'spend_merchant').merchant, 'costco');
eq('merchant + named month', kind('what did I spend at Grocer Mart in July', 'spend_merchant').period.label, 'July');
eq('spend merchant last time', kind("what did I spend at costco last time?", 'spend_merchant').lastOnly, true);
eq('merchant with apostrophe', kind("how much at trader joe's", 'spend_merchant').merchant, "trader joe's");
eq('how often → visits', kind('how often do I go to Coffee Corner', 'spend_merchant').visits, true);
eq('restaurants parsed as merchant word (local.ts falls to category)', kind('how much did I spend at restaurants in august', 'spend_merchant').merchant, 'restaurants');

// ── rankings / comparisons / averages ────────────────────────────
kind('Where does most of my money go?', 'top_categories');
kind('what did I spend the most on last month', 'top_categories');
eq('biggest', kind('biggest purchases this month', 'biggest_expenses').limit, 5);
eq('top n', kind('top 3 expenses last month', 'biggest_expenses').limit, 3);
kind('am I spending more than last month', 'spend_compare');
kind('how does this month compare to last month', 'spend_compare');
kind('why is my spending up', 'spend_compare');
eq('avg purchase', kind("what's my average grocery bill", 'average_spend'), { kind: 'average_spend', target: 'groceries', unit: 'purchase' });
eq('per week', kind('how much do I usually spend per week', 'average_spend').unit, 'week');
eq('per month on category', kind('how much do I spend on utilities a month', 'average_spend'), { kind: 'average_spend', target: 'utilities', unit: 'month' });

// ── lists ────────────────────────────────────────────────────────
eq('recent at merchant', kind('recent purchases at Mega Mart', 'recent_transactions').merchant, 'mega mart');
eq('what did I buy yesterday', kind('what did I buy yesterday', 'recent_transactions').period.label, 'yesterday');
kind('show me recent transactions', 'recent_transactions');

// ── income / cash flow ───────────────────────────────────────────
kind('how much did I make this month', 'income_total');
eq('income period', kind('income last month', 'income_total').period.label, 'last month');
kind('did I get paid this week', 'income_total');
kind('how much did I save last month', 'cash_flow');
kind('am I saving money this month', 'cash_flow');
kind("what's my income vs spending", 'cash_flow');
kind('how much have I saved this year', 'cash_flow');

// ── balances / debt / net worth ──────────────────────────────────
eq('balance named', kind("what's my checking balance", 'balance').account, 'checking');
eq('balance "in"', kind('how much is in savings', 'balance').account, 'savings');
eq('balance all', kind('what are my balances', 'balance').account, null);
eq('how much money do I have', kind('how much money do I have', 'balance').account, null);
eq('checking and savings → all cash', kind('how much do I have in checking and savings', 'balance').account, null);
eq('credit card balance', kind("what's my credit card balance", 'balance').account, 'credit card');
eq('owe on home loan', kind('what do I owe on the home loan', 'balance').account, 'home loan');
kind("what's my total debt", 'debt_total');
kind('how much do I owe', 'debt_total');
kind("what's my net worth?", 'net_worth');

// ── bills / payments / budget ────────────────────────────────────
eq('bills all', kind('what bills are due', 'upcoming_bills'), { kind: 'upcoming_bills', name: null, biggest: false, withinDays: null });
eq('bills named', kind('when is the mortgage due', 'upcoming_bills').name, 'mortgage');
eq('mortgage payment amount', kind('how much is my mortgage payment', 'upcoming_bills').name, 'mortgage');
eq('biggest bill', kind("what's my biggest bill", 'upcoming_bills').biggest, true);
eq('due this week', kind("what's due this week", 'upcoming_bills').withinDays, 7);
eq('did I pay mortgage', kind('did I pay the mortgage this month', 'payment_made').what, 'mortgage');
eq('card payment made', kind('is my card payment made', 'payment_made').what, 'card');
kind('how am I doing on my budget', 'budget_status');
eq('budget category', kind('am I over on dining', 'budget_status').category, 'dining');
eq('budget for groceries', kind("what's my budget for groceries", 'budget_status').category, 'groceries');
kind('am I on track this month', 'budget_status');
kind('how much is left this month', 'budget_status');

// ── cached-insight intents / meta ────────────────────────────────
eq('afford amount', kind('can I afford $500', 'affordability').amount, 500);
eq('afford k', kind('can I afford a 1.2k purchase', 'affordability').amount, 1200);
kind('how much cash after bills', 'affordability');
kind('when is my next paycheck', 'next_paycheck');
kind('any unusual charges this week', 'unusual');
kind('did anything get more expensive', 'unusual');
kind('hi', 'help');
kind('what can you do', 'help');
kind('how am I doing', 'briefing');
kind("what's new", 'briefing');
kind('give me a rundown', 'briefing');

// ── unknown → null, never a confident wrong answer ────────────────
eq('advice question', parseLocalIntent('should I refinance my mortgage rate', now), null);
eq('empty', parseLocalIntent('   ', now), null);
eq('stocks', parseLocalIntent('what stock should I buy', now), null);
eq('weather', parseLocalIntent("what's the weather like", now), null);

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
