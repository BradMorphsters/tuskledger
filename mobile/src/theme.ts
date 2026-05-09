/**
 * Tiny design system. Consistent with the laptop UI's general feel
 * (warm neutrals, money-positive green, money-negative red) without
 * being a literal port — phone screens have less room and are read
 * one-handed, so type scales are bigger and density is lower.
 */
export const colors = {
  bg: '#0e0f12',
  surface: '#16181d',
  surfaceElevated: '#1d2027',
  border: '#2a2e36',
  text: '#f3f4f6',
  textMuted: '#9aa0a6',
  textFaint: '#6b7280',
  accent: '#c9a86a', // tusk warm gold
  income: '#5cd6a4',
  expense: '#ef6f6c',
  warning: '#ffb454',
  link: '#74a9ff',
};

export const radius = { sm: 6, md: 10, lg: 14 };

export const space = (n: number) => n * 4;

export const type = {
  display: { fontSize: 32, fontWeight: '700' as const, color: colors.text },
  h1: { fontSize: 22, fontWeight: '700' as const, color: colors.text },
  h2: { fontSize: 18, fontWeight: '600' as const, color: colors.text },
  body: { fontSize: 16, color: colors.text },
  small: { fontSize: 13, color: colors.textMuted },
  caption: { fontSize: 11, color: colors.textFaint, letterSpacing: 0.6 },
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

export function formatDate(iso: string): string {
  // 'YYYY-MM-DD' → 'May 8'
  const [y, m, d] = iso.split('-').map((s) => parseInt(s, 10));
  if (!y || !m || !d) return iso;
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[m - 1]} ${d}`;
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
