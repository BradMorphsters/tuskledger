/**
 * Pure date-label helpers (no React Native imports, so the plain-Node
 * test scripts can import them). Dates are local-naive 'YYYY-MM-DD'.
 */
const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];
const DOW = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** 'YYYY-MM-DD' → 'Oct 2026'. Empty for null/blank. */
export function monthYear(iso: string | null | undefined): string {
  if (!iso) return '';
  const [y, m] = iso.split('-').map((s) => parseInt(s, 10));
  return y && m ? `${MONTHS_SHORT[m - 1]} ${y}` : iso;
}

/** 'YYYY-MM-DD' → 'Tuesday, November 4, 2026' (local calendar). */
export function longDate(iso: string): string {
  const [y, m, d] = iso.split('-').map((s) => parseInt(s, 10));
  if (!y || !m || !d) return iso;
  return `${DOW[new Date(y, m - 1, d).getDay()]}, ${MONTHS_LONG[m - 1]} ${d}, ${y}`;
}
