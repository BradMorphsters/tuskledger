/**
 * Design system — dark-first, warm-gold brand.
 *
 * Consistent with the laptop UI's general feel (warm neutrals,
 * money-positive green, money-negative red) without being a literal
 * port — phone screens are read one-handed from the couch, so type
 * scales are bigger, density is lower, and money numerals dominate.
 *
 * Conventions:
 *   - Every money numeral uses fontVariant: ['tabular-nums'] (see
 *     components/MoneyText) so columns of figures align.
 *   - Section labels are 11pt UPPERCASE letterspaced captions.
 *   - Screen padding 20, card padding 16, card radius 16.
 */
export const colors = {
  // Surfaces
  bg: '#0e0f12',
  surface: '#16181d',
  surfaceElevated: '#1d2027',
  border: '#262b33',
  borderSubtle: '#1c2026',

  // Text
  text: '#f3f4f6',
  textMuted: '#9aa0a6',
  textFaint: '#6b7280',

  // Brand + semantics
  accent: '#c9a86a', // tusk warm gold
  income: '#5cd6a4',
  expense: '#ef6f6c',
  warning: '#ffb454',
  link: '#74a9ff',

  // Subtle alpha tints for chips / badges / soft banners
  accentBg: 'rgba(201, 168, 106, 0.14)',
  incomeBg: 'rgba(92, 214, 164, 0.13)',
  expenseBg: 'rgba(239, 111, 108, 0.13)',
  warningBg: 'rgba(255, 180, 84, 0.12)',

  /** Text/icon color when sitting on an accent-filled surface. */
  onAccent: '#0e0f12',
};

export const radius = { sm: 8, md: 12, lg: 16, xl: 20 };

export const space = (n: number) => n * 4;

/** Shared layout constants — keep screens on one rhythm. */
export const layout = {
  screenPad: 20,
  cardPad: 16,
  cardRadius: 16,
  /** Minimum touch target (Apple HIG). */
  minTouch: 44,
};

export const type = {
  /** Hero money numeral — net worth, portfolio value. */
  hero: {
    fontSize: 34,
    fontWeight: '800' as const,
    letterSpacing: -0.6,
    color: colors.text,
  },
  display: {
    fontSize: 28,
    fontWeight: '700' as const,
    letterSpacing: -0.4,
    color: colors.text,
  },
  h1: { fontSize: 22, fontWeight: '700' as const, color: colors.text },
  h2: { fontSize: 17, fontWeight: '600' as const, color: colors.text },
  body: { fontSize: 16, lineHeight: 21, color: colors.text },
  small: { fontSize: 13, lineHeight: 18, color: colors.textMuted },
  /** UPPERCASE 11pt letterspaced section label. */
  caption: {
    fontSize: 11,
    fontWeight: '600' as const,
    color: colors.textFaint,
    letterSpacing: 1,
    textTransform: 'uppercase' as const,
  },
  mono: { fontFamily: 'Courier', fontSize: 14, color: colors.text },
};

export function formatCurrency(n: number | null | undefined): string {
  if (n == null || isNaN(n)) return '—';
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  return sign + '$' + abs.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/** Whole-dollar variant for hero numerals — cents are noise at 34pt. */
export function formatCurrencyWhole(n: number | null | undefined): string {
  if (n == null || isNaN(n)) return '—';
  const sign = n < 0 ? '-' : '';
  return sign + '$' + Math.round(Math.abs(n)).toLocaleString();
}

/** Explicit-sign variant for deltas: "+$1,234" / "−$1,234". */
export function formatDelta(n: number | null | undefined): string {
  if (n == null || isNaN(n)) return '—';
  const sign = n < 0 ? '−' : '+';
  return sign + '$' + Math.round(Math.abs(n)).toLocaleString();
}

export function formatDate(iso: string): string {
  // 'YYYY-MM-DD' → 'May 8'
  const [y, m, d] = iso.split('-').map((s) => parseInt(s, 10));
  if (!y || !m || !d) return iso;
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[m - 1]} ${d}`;
}

function localIso(d: Date): string {
  const p = (x: number) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * Day label for transaction group headers: 'Today' / 'Yesterday' /
 * 'Mon, Jun 9'. Transaction dates are local-naive YYYY-MM-DD, so the
 * comparison uses the device's local calendar date, not UTC.
 */
export function formatDayLabel(iso: string): string {
  const now = new Date();
  if (iso === localIso(now)) return 'Today';
  const yesterday = new Date(now.getTime() - 86400000);
  if (iso === localIso(yesterday)) return 'Yesterday';
  const [y, m, d] = iso.split('-').map((s) => parseInt(s, 10));
  if (!y || !m || !d) return iso;
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const dow = days[new Date(y, m - 1, d).getDay()];
  return `${dow}, ${formatDate(iso)}`;
}

export function formatRelative(iso: string | null): string {
  if (!iso) return 'never';
  const t = new Date(iso).getTime();
  if (isNaN(t)) return iso;
  const diffSec = Math.floor((Date.now() - t) / 1000);
  if (diffSec < 60) return 'just now';
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
  return `${Math.floor(diffSec / 86400)}d ago`;
}
