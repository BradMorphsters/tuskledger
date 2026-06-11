/**
 * Card — the standard surface container. Padding 16, radius 16,
 * hairline border. `padded={false}` for cards whose rows manage their
 * own horizontal padding (lists with full-width separators).
 * `elevated` for the rare card that should sit above its siblings.
 */
import { ReactNode } from 'react';
import { StyleSheet, View, ViewStyle } from 'react-native';
import { colors, layout } from '../theme';

interface Props {
  children: ReactNode;
  padded?: boolean;
  elevated?: boolean;
  style?: ViewStyle | ViewStyle[];
}

export default function Card({ children, padded = true, elevated = false, style }: Props) {
  return (
    <View
      style={[
        styles.card,
        padded && styles.padded,
        elevated && styles.elevated,
        style,
      ]}>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderRadius: layout.cardRadius,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    overflow: 'hidden',
  },
  padded: {
    padding: layout.cardPad,
  },
  elevated: {
    backgroundColor: colors.surfaceElevated,
    borderColor: colors.border,
  },
});
