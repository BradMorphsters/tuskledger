/**
 * ProgressBar — thin rounded bar for category spend, income vs
 * spending comparisons, allocation fills. Pure View, no animation —
 * it renders inside lists and should stay cheap.
 */
import { StyleSheet, View, ViewStyle } from 'react-native';
import { colors } from '../theme';

interface Props {
  /** 0..1, clamped. */
  progress: number;
  color?: string;
  height?: number;
  style?: ViewStyle;
}

export default function ProgressBar({
  progress,
  color = colors.accent,
  height = 4,
  style,
}: Props) {
  const pct = Math.max(0, Math.min(1, progress));
  return (
    <View style={[styles.track, { height, borderRadius: height / 2 }, style]}>
      <View
        style={{
          width: `${pct * 100}%`,
          height,
          borderRadius: height / 2,
          backgroundColor: color,
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  track: {
    backgroundColor: colors.surfaceElevated,
    overflow: 'hidden',
    width: '100%',
  },
});
