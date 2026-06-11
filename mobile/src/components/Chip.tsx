/**
 * Chip — small rounded badge with a soft alpha background. Used for
 * deltas ("▲ +$12,340 · 30d"), gain/loss percentages, pending states,
 * and the filter row on Transactions (via `selected` + onPress).
 */
import { Pressable, StyleSheet, Text, TextStyle, ViewStyle } from 'react-native';
import { colors, space } from '../theme';

type Tone = 'income' | 'expense' | 'accent' | 'warning' | 'neutral';

interface Props {
  label: string;
  tone?: Tone;
  /** Filter-chip mode: filled when selected, ghost otherwise. */
  selected?: boolean;
  onPress?: () => void;
  small?: boolean;
  style?: ViewStyle;
}

const toneFg: Record<Tone, string> = {
  income: colors.income,
  expense: colors.expense,
  accent: colors.accent,
  warning: colors.warning,
  neutral: colors.textMuted,
};

const toneBg: Record<Tone, string> = {
  income: colors.incomeBg,
  expense: colors.expenseBg,
  accent: colors.accentBg,
  warning: colors.warningBg,
  neutral: colors.surfaceElevated,
};

export default function Chip({
  label,
  tone = 'neutral',
  selected,
  onPress,
  small = false,
  style,
}: Props) {
  const isFilter = selected !== undefined;
  const bg = isFilter
    ? selected ? colors.accentBg : colors.surface
    : toneBg[tone];
  const fg = isFilter
    ? selected ? colors.accent : colors.textMuted
    : toneFg[tone];
  const borderColor = isFilter
    ? selected ? colors.accent : colors.border
    : 'transparent';

  const textStyle: TextStyle = {
    color: fg,
    fontSize: small ? 12 : 13,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
  };

  const body = (
    <Text style={textStyle} numberOfLines={1}>
      {label}
    </Text>
  );

  if (onPress) {
    return (
      <Pressable
        onPress={onPress}
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityState={isFilter ? { selected: !!selected } : undefined}
        hitSlop={6}
        style={({ pressed }) => [
          styles.chip,
          small && styles.small,
          { backgroundColor: bg, borderColor, opacity: pressed ? 0.7 : 1 },
          style,
        ]}>
        {body}
      </Pressable>
    );
  }
  return (
    <Pressable
      disabled
      style={[
        styles.chip,
        small && styles.small,
        { backgroundColor: bg, borderColor },
        style,
      ]}>
      {body}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  chip: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: space(3),
    paddingVertical: space(1.5),
    borderRadius: 999,
    borderWidth: 1,
  },
  small: {
    paddingHorizontal: space(2),
    paddingVertical: 3,
  },
});
