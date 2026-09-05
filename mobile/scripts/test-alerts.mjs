/**
 * Pure-function unit test for buildAlerts() / dedupeAlerts()
 * (src/alerts/rules.ts). Plain Node — run from mobile/:
 *   node scripts/test-alerts.mjs
 *
 * Fictional data throughout.
 */
import { buildAlerts, dedupeAlerts } from '../src/alerts/rules.ts';

let failures = 0;
function eq(label, got, want) {
  const ok = Object.is(got, want);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
}

const base = {
  today: '2026-09-06', // a Sunday
  weekday: 0,
  bills: [
    { id: '1:mortgage', account_name: 'Home Loan', kind: 'mortgage', due_date: '2026-09-07', days_until: 1, amount: 1500 },
    { id: '2:credit_card', account_name: 'Visa', kind: 'credit_card', due_date: '2026-09-06', days_until: 0, amount: 200 },
    { id: '3:credit_card', account_name: 'Store Card', kind: 'credit_card', due_date: '2026-09-04', days_until: -2, amount: null },
    { id: '4:mortgage', account_name: 'Far Off', kind: 'mortgage', due_date: '2026-09-20', days_until: 14, amount: 900 },
  ],
  budget: {
    month: 9, year: 2026,
    rows: [
      { category: 'Groceries', limit_amount: 500, spent: 420 },   // 84% → tier 80
      { category: 'Dining', limit_amount: 200, spent: 250 },      // 125% → tier 100
      { category: 'Fuel', limit_amount: 150, spent: 60 },         // 40% → nothing
      { category: 'Zero', limit_amount: 0, spent: 10 },           // guard: no divide by zero
    ],
  },
  largeTransactions: [
    { merchant: 'Hardware Barn', date: '2026-09-03', amount: 640, typical_amount: 45 },
  ],
  priceHikes: [
    { merchant: 'StreamBox', latest_amount: 19, typical_amount: 15, delta_pct: 26.7 },
  ],
  digestWeekEnd: '2026-09-06',
};

const alerts = buildAlerts(base);
const kinds = alerts.map((a) => a.kind);
eq('bill alerts (tomorrow, today, overdue; not the 14-day one)', kinds.filter((k) => k === 'bill-due').length, 3);
eq('budget tier alerts (80 + 100, not 40%, not zero-limit)', kinds.filter((k) => k === 'budget-tier').length, 2);
eq('large charge alert', kinds.filter((k) => k === 'large-charge').length, 1);
eq('price hike alert', kinds.filter((k) => k === 'price-hike').length, 1);
eq('digest ready on Sunday', kinds.filter((k) => k === 'digest-ready').length, 1);

const overdue = alerts.find((a) => a.key.startsWith('bill:3:'));
eq('overdue title', overdue.title, 'Card payment overdue');
eq('overdue body without amount', overdue.body, 'Store Card');
const tomorrow = alerts.find((a) => a.key.startsWith('bill:1:'));
eq('tomorrow title', tomorrow.title, 'Mortgage due tomorrow');
eq('tomorrow body', tomorrow.body, 'Home Loan · $1,500');

const dining = alerts.find((a) => a.key === 'budget:2026-9:Dining:100');
eq('100% tier title', dining.title, 'Dining budget spent');
eq('100% tier body', dining.body, '$250 of $200 — $50 over.');
const groceries = alerts.find((a) => a.key === 'budget:2026-9:Groceries:80');
eq('80% tier title', groceries.title, 'Groceries at 84% of budget');

// Not Sunday → no digest alert
const weekdayAlerts = buildAlerts({ ...base, weekday: 3 });
eq('no digest on Wednesday', weekdayAlerts.some((a) => a.kind === 'digest-ready'), false);

// No digest cached → no digest alert even on Sunday
eq('no digest without cache', buildAlerts({ ...base, digestWeekEnd: null }).some((a) => a.kind === 'digest-ready'), false);

// Dedupe: first pass fires all; second pass fires none; keys recorded with today
let d = dedupeAlerts(alerts, {}, base.today);
eq('first pass fresh count', d.fresh.length, alerts.length);
eq('fired ledger size', Object.keys(d.fired).length, alerts.length);
let d2 = dedupeAlerts(alerts, d.fired, base.today);
eq('second pass fresh count', d2.fresh.length, 0);

// A bill moving from "tomorrow" to "today" is a new key → fires again
const nextDay = buildAlerts({
  ...base,
  today: '2026-09-07', weekday: 1,
  bills: [{ id: '1:mortgage', account_name: 'Home Loan', kind: 'mortgage', due_date: '2026-09-07', days_until: 0, amount: 1500 }],
  budget: null, largeTransactions: [], priceHikes: [],
});
const d3 = dedupeAlerts(nextDay, d2.fired, '2026-09-07');
eq('due-today fires after due-tomorrow', d3.fresh.length, 1);
eq('due-today title', d3.fresh[0].title, 'Mortgage due today');

// Pruning: a key fired 60 days ago drops out of the ledger
const old = { 'bill:old:2026-07-01:0': '2026-07-01', ...d3.fired };
const d4 = dedupeAlerts([], old, '2026-09-07');
eq('old key pruned', 'bill:old:2026-07-01:0' in d4.fired, false);
eq('recent keys kept', Object.keys(d4.fired).length, Object.keys(d3.fired).length);

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
