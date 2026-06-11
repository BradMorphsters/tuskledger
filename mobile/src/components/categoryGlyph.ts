/**
 * categoryGlyph — maps a transaction category to a small glyph for the
 * circle avatar in transaction rows. Keyword matching over a curated
 * list (categories come from Plaid's taxonomy plus the user's custom
 * names, so exact matching would miss most of them). Falls back to the
 * category's first letter on a gold tint.
 */
import { colors } from '../theme';

export interface Glyph {
  /** Emoji, or null → render `initial` as a letter avatar. */
  emoji: string | null;
  initial: string;
  /** Circle background. */
  bg: string;
  /** Letter color when emoji is null. */
  fg: string;
}

const RULES: [RegExp, string][] = [
  [/grocer|supermarket/i, '🛒'],
  [/coffee|cafe/i, '☕'],
  [/restaurant|dining|food|takeout|fast food|delivery/i, '🍽️'],
  [/bar|alcohol|brewer/i, '🍺'],
  [/travel|flight|airline|hotel|lodging|vacation/i, '✈️'],
  [/gas|fuel/i, '⛽'],
  [/uber|lyft|taxi|ride|transit|parking|toll|transport/i, '🚗'],
  [/shop|merchandise|cloth|apparel|amazon|retail/i, '🛍️'],
  [/entertainment|movie|music|game|stream/i, '🎬'],
  [/subscri|membership/i, '🔁'],
  [/utilit|electric|water|internet|phone|cable/i, '💡'],
  [/rent|mortgage|home improvement|home|hardware/i, '🏠'],
  [/health|medical|doctor|dental|pharma|fitness|gym/i, '🩺'],
  [/insurance/i, '🛡️'],
  [/income|payroll|paycheck|salary|deposit|interest earned/i, '💵'],
  [/transfer/i, '↔️'],
  [/invest|brokerage|dividend|retirement/i, '📈'],
  [/loan|debt|credit card payment/i, '🏦'],
  [/fee|charge|tax/i, '🧾'],
  [/education|tuition|school|book/i, '🎓'],
  [/pet|vet/i, '🐾'],
  [/kid|child|baby|toy/i, '🧸'],
  [/gift|donation|charity/i, '🎁'],
  [/personal care|salon|barber|spa/i, '💇'],
];

export function categoryGlyph(category: string | null | undefined): Glyph {
  const cat = (category || 'Uncategorized').trim();
  for (const [re, emoji] of RULES) {
    if (re.test(cat)) {
      return {
        emoji,
        initial: cat.charAt(0).toUpperCase(),
        bg: colors.surfaceElevated,
        fg: colors.accent,
      };
    }
  }
  return {
    emoji: null,
    initial: cat.charAt(0).toUpperCase() || '?',
    bg: colors.accentBg,
    fg: colors.accent,
  };
}
