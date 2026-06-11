/**
 * MoneyText — every dollar figure in the app goes through here.
 *
 *   - tabular-nums always, so columns of money align
 *   - size variants matched to the type scale
 *   - tone: 'neutral' (default), 'income'/'expense' (forced),
 *     'auto' (green when positive, red when negative), 'muted'
 *   - signed: prefix an explicit +/− (deltas, income rows)
 *   - whole: drop cents (hero numerals)
 *
 * Hero/display sizes shrink-to-fit so an eight-figure net worth never
 * clips on a small iPhone.
 */
import { StyleSheet, Text, TextStyle } from 'react-native';
import {
  colors,
  formatCurrency,
  formatCurrencyWhole,
  type,
} from '../theme';

type Size = 'hero' | 'display' | 'title' | 'body' | 'small';
type Tone = 'neutral' | 'income' | 'expense' | 'auto' | 'muted';

interface Props {
  value: number | null | undefined;
  size?: Size;
  tone?: Tone;
  signed?: boolean;
  whole?: boolean;
  style?: TextStyle | TextStyle[];
}

const sizeStyle: Record<Size, TextStyle> = {
  hero: type.hero,
  display: type.display,
  title: { fontSize: 17, fontWeight: '600', color: colors.text },
  body: { fontSize: 16, color: colors.text },
  small: { fontSize: 13, color: colors.text },
};

function toneColor(tone: Tone, value: number | null | undefined): string | undefined {
  switch (tone) {
    case 'income': return colors.income;
    case 'expense': return colors.expense;
    case 'muted': return colors.textMuted;
    case 'auto':
      if (value == null) return undefined;
      return value >= 0 ? colors.income : colors.expense;
    default:
      return undefined;
  }
}

export default function MoneyText({
  value,
  size = 'body',
  tone = 'neutral',
  signed = false,
  whole = false,
  style,
}: Props) {
  const fmt = whole ? formatCurrencyWhole : formatCurrency;
  let text: string;
  if (value == null || isNaN(value)) {
    text = '—';
  } else if (signed) {
    text = (value < 0 ? '−' : '+') + fmt(Math.abs(value));
  } else {
    text = value < 0 ? '−' + fmt(Math.abs(value)) : fmt(value);
  }
  const color = toneColor(tone, value);
  const big = size === 'hero' || size === 'display';
  return (
    <Text
      style={[
        sizeStyle[size],
        styles.tabular,
        color ? { color } : null,
        style,
      ]}
      numberOfLines={1}
      adjustsFontSizeToFit={big}
      minimumFontScale={big ? 0.6 : undefined}>
      {text}
    </Text>
  );
}

const styles = StyleSheet.create({
  tabular: { fontVariant: ['tabular-nums'] },
});
