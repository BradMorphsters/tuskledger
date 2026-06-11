/**
 * Sparkline — pure-RN area chart for glance-level trends.
 *
 * No SVG dependency: the series is resampled to N columns; each column
 * draws a 2px "line cap" at the value height with a soft two-band fill
 * fading toward the baseline underneath. At 60+ columns the caps read
 * as a continuous line and the bands read as a gradient area fill —
 * the Copilot/Monarch look without a charting library.
 *
 * Trend color: green when the series ends above where it started,
 * red otherwise. Pass `color` to override.
 */
import { StyleSheet, View, ViewStyle } from 'react-native';
import { colors } from '../theme';

interface Props {
  data: number[];
  height?: number;
  columns?: number;
  color?: string;
  style?: ViewStyle;
}

export default function Sparkline({
  data,
  height = 64,
  columns = 64,
  color,
  style,
}: Props) {
  if (data.length < 2) return null;

  const resampled = resample(data, columns);
  const min = Math.min(...resampled);
  const max = Math.max(...resampled);
  const range = max - min || 1;
  const trendingUp = resampled[resampled.length - 1] >= resampled[0];
  const line = color ?? (trendingUp ? colors.income : colors.expense);

  // Leave 2px of headroom so the cap never clips at the max.
  const usable = height - 2;

  return (
    <View style={[styles.row, { height }, style]} pointerEvents="none">
      {resampled.map((v, i) => {
        const h = Math.max(2, ((v - min) / range) * usable);
        return (
          <View key={i} style={styles.col}>
            {/* Line cap */}
            <View style={{ height: 2, backgroundColor: line }} />
            {/* Two-band fill fading to transparent toward the baseline */}
            <View style={{ height: h * 0.45, backgroundColor: line, opacity: 0.16 }} />
            <View style={{ height: h * 0.55, backgroundColor: line, opacity: 0.05 }} />
          </View>
        );
      })}
    </View>
  );
}

function resample(xs: number[], n: number): number[] {
  if (xs.length === 0) return [];
  if (xs.length === n) return xs;
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const t = (i / (n - 1)) * (xs.length - 1);
    const lo = Math.floor(t);
    const hi = Math.ceil(t);
    if (lo === hi) {
      out.push(xs[lo]);
    } else {
      out.push(xs[lo] + (xs[hi] - xs[lo]) * (t - lo));
    }
  }
  return out;
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    overflow: 'hidden',
  },
  col: {
    flex: 1,
    justifyContent: 'flex-end',
  },
});
