/**
 * Pure-function unit test for affordability() / parseAmount()
 * (src/insights/afford.ts). Plain Node, no jest — run from mobile/:
 *   node scripts/test-afford.mjs
 * (Node < 22.18: node --experimental-strip-types scripts/test-afford.mjs)
 *
 * All figures are fictional round numbers.
 */
import { affordability, parseAmount } from '../src/insights/afford.ts';

let failures = 0;
function eq(label, got, want) {
  const ok = Object.is(got, want);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}: got ${got}, want ${want}`);
}

// Checking 2,000; bills 700; usual spending 500 → safe = 800; savings 3,000.
const base = {
  safeToSpend: 800,
  usualSpending: 500,
  spendableCash: 2000,
  billsDue: 700,
  savingsCash: 3000,
};

// 1. Comfortably affordable
let r = affordability(base, 300);
eq('yes verdict', r.verdict, 'yes');
eq('yes remaining', r.remaining, 500);
eq('yes allowanceUsed', r.allowanceUsed, 0);
eq('yes dipsIntoBills', r.dipsIntoBills, false);

// 2. Exactly the safe amount is still a yes
r = affordability(base, 800);
eq('boundary yes', r.verdict, 'yes');
eq('boundary remaining', r.remaining, 0);

// 3. Into the usual-spending allowance → tight
r = affordability(base, 1000);
eq('tight verdict', r.verdict, 'tight');
eq('tight remaining', r.remaining, -200);
eq('tight allowanceUsed', r.allowanceUsed, 200);
eq('tight dipsIntoBills', r.dipsIntoBills, false); // 2000-1000=1000 ≥ 700

// 4. Beyond safe + allowance → no; checking can't cover bills afterwards
r = affordability(base, 1500);
eq('no verdict', r.verdict, 'no');
eq('no remaining', r.remaining, -700);
eq('no allowanceUsed capped at usual', r.allowanceUsed, 500);
eq('no dipsIntoBills', r.dipsIntoBills, true); // 2000-1500=500 < 700
eq('no usesSavings (savings still covers)', r.usesSavings, false); // 500+3000 ≥ 700

// 5. Bigger than checking + savings can cover bills → usesSavings
r = affordability(base, 4500);
eq('usesSavings', r.usesSavings, true); // -2500+3000=500 < 700

// 6. Negative safe-to-spend: anything is at best tight
r = affordability({ ...base, safeToSpend: -100 }, 50);
eq('negative safe → tight', r.verdict, 'tight');
eq('negative safe allowanceUsed', r.allowanceUsed, 150);

// 7. Negative usual spending is clamped to 0 (defensive)
r = affordability({ ...base, usualSpending: -50 }, 900);
eq('clamped usual → no', r.verdict, 'no');

// 8. Invalid amounts
eq('zero → null', affordability(base, 0), null);
eq('negative → null', affordability(base, -5), null);
eq('NaN → null', affordability(base, NaN), null);

// 9. parseAmount
eq('parse plain', parseAmount('1250'), 1250);
eq('parse currency', parseAmount('$1,250.50'), 1250.5);
eq('parse k suffix', parseAmount('12.5k'), 12500);
eq('parse spaces', parseAmount(' 40 '), 40);
eq('parse junk', parseAmount('abc'), null);
eq('parse empty', parseAmount(''), null);
eq('parse zero', parseAmount('0'), null);

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
