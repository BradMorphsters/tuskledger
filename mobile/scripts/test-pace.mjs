/**
 * Pure-function unit test for computePace() (src/db/pace.ts).
 *
 * Not jest — plain Node. Run from the mobile/ dir:
 *   node scripts/test-pace.mjs
 * Node >= 22.18 strips the TS types from pace.ts on import; on older Node
 * add the flag:  node --experimental-strip-types scripts/test-pace.mjs
 *
 * Covers the four cases the plan calls out:
 *   1. baseline months of differing lengths clamp correctly
 *   2. months with no data drop from the average (divisor = 2, not 4)
 *   3. delta / pct / projection match hand-computed values
 *   4. returns null with < 2 baseline months
 */
import { computePace } from '../src/db/pace.ts';

let failures = 0;
function eq(label, got, want) {
  const ok = Object.is(got, want);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}: got ${got}, want ${want}`);
}

// ── Scenario A — two baseline months of differing lengths, with data ──
// now = 15 Jul 2026 (local). Baseline months: Mar, Apr, May, Jun 2026.
// Only Apr (30 days) and May (31 days) carry spend → window = 2.
//
//   Apr: $100 on d10, $200 on d30   → cum: 0(<10), 100(10..29), 300(>=30, clamped)
//   May: $50 on d5, $50 on d20, $10 on d31 → cum: 0(<5),50(5..19),100(20..30),110(31)
//   Jul (MTD, cd=15): $300 on d3    → mtd through d15 = 300
//
// Hand-computed:
//   baselineToDate (d15) = (cumApr15 100 + cumMay15 50)/2 = 75
//   baselineFull   (d31) = (cumApr31 300 + cumMay31 110)/2 = 205
//   baseline d30         = (300 + 100)/2 = 200   ← Apr clamped flat 300 @ d30&d31,
//   baseline d31         = (300 + 110)/2 = 205      May rises 100→110 (clamp demo)
//   mtdTotal = 300
//   delta = 300 - 75 = 225 (over pace)
//   pct   = 225/75*100 = 300.0
//   projected = 300/75 * 205 = 820
const rowsA = [
  { date: '2026-04-10', total: 100 },
  { date: '2026-04-30', total: 200 },
  { date: '2026-05-05', total: 50 },
  { date: '2026-05-20', total: 50 },
  { date: '2026-05-31', total: 10 },
  { date: '2026-07-03', total: 300 },
];
const a = computePace(rowsA, new Date(2026, 6, 15));
if (!a) {
  console.log('FAIL  scenario A returned null');
  failures++;
} else {
  eq('A month', a.month, 7);
  eq('A today', a.today, 15);
  eq('A daysInMonth', a.daysInMonth, 31);
  eq('A baselineWindow (no-data months dropped → /2)', a.baselineWindow, 2);
  eq('A mtdTotal', a.mtdTotal, 300);
  eq('A baselineToDate', a.baselineToDate, 75);
  eq('A baselineFull', a.baselineFull, 205);
  eq('A delta', a.delta, 225);
  eq('A pct', a.pct, 300);
  eq('A projected', a.projected, 820);
  // Clamp: 30-day Apr stays 300 across d30→d31 while 31-day May rises.
  eq('A baseline @ d30 (points[29])', a.points[29].baseline, 200);
  eq('A baseline @ d31 (points[30])', a.points[30].baseline, 205);
  // MTD present through today, null after.
  eq('A mtd @ d15 (points[14])', a.points[14].mtd, 300);
  eq('A mtd @ d16 (points[15]) is null', a.points[15].mtd, null);
  eq('A mtd @ d2 (points[1]) pre-spend', a.points[1].mtd, 0);
  eq('A points length', a.points.length, 31);
}

// ── Scenario B — only one baseline month has data → null ──────────────
// Baseline months Mar..Jun; only May present → window 1 (< 2) → hide.
const rowsB = [
  { date: '2026-05-05', total: 50 },
  { date: '2026-07-03', total: 300 },
];
const b = computePace(rowsB, new Date(2026, 6, 15));
eq('B returns null (<2 baseline months)', b, null);

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
