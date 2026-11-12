/**
 * Pure-function tests for src/format/dates.ts. Plain Node, run from mobile/:
 *   node scripts/test-dates.mjs
 */
import { longDate, monthYear } from '../src/format/dates.ts';

let failures = 0;
function eq(label, got, want) {
  const ok = Object.is(got, want);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
}

eq('monthYear', monthYear('2026-10-20'), 'Oct 2026');
eq('monthYear January', monthYear('2027-01-01'), 'Jan 2027');
eq('monthYear null', monthYear(null), '');
eq('monthYear blank', monthYear(''), '');
eq('longDate', longDate('2026-11-04'), 'Wednesday, November 4, 2026');
eq('longDate leap day', longDate('2028-02-29'), 'Tuesday, February 29, 2028');
eq('longDate bad input passes through', longDate('soon'), 'soon');

if (failures) {
  console.log(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log('\nAll date tests passed.');
