/**
 * Tiny inline net-worth sparkline for the Dashboard.
 *
 * Pure RN — hand-drawn polyline via expo's underlying RN <Svg> isn't
 * a default dep, so we fake a sparkline with a tight row of bars.
 * Each bar is one snapshot, height proportional to (value - min) /
 * (max - min). This gets across "trend up / trend down" at a glance
 * without pulling in a charting library that doubles the bundle size.
 *
 * If we ever want a "real" chart, swap react-native-svg-charts in here
 * and the call sites won't notice.
 */
import { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { netWorthHistory, NetWorthPoint } from '../db/queries';
import { useSyncStore } from '../sync/manager';
import { colors } from '../theme';

const BARS = 60;
const HEIGHT = 36;

export default function NetWorthSparkline() {
  const dataVersion = useSyncStore((s) => s.dataVersion);
  const [points, setPoints] = useState<NetWorthPoint[]>([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const p = await netWorthHistory(90);
      if (!cancelled) setPoints(p);
    })();
    return () => { cancelled = true; };
  }, [dataVersion]);

  if (points.length < 2) return null;

  // Resample to BARS points so the row is consistent regardless of
  // how many snapshots we have. Linear interpolation is fine here —
  // we're rendering a glance-level trend, not a precise series.
  const resampled = resample(points.map((p) => p.net_worth), BARS);
  const min = Math.min(...resampled);
  const max = Math.max(...resampled);
  const range = max - min || 1;
  const trendingUp = resampled[resampled.length - 1] >= resampled[0];
  const color = trendingUp ? colors.income : colors.expense;

  return (
    <View style={styles.row}>
      {resampled.map((v, i) => {
        const h = ((v - min) / range) * HEIGHT;
        return (
          <View
            key={i}
            style={{
              flex: 1,
              height: Math.max(2, h),
              backgroundColor: color,
              opacity: 0.6 + (i / resampled.length) * 0.4,
              borderRadius: 1,
            }}
          />
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
    gap: 1,
    height: HEIGHT,
    marginTop: 12,
  },
});
