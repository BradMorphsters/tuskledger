/**
 * PaceChart — pure-RN two-series overlay for the Spending pace tile.
 *
 * No SVG / charting library (the app deliberately has none — see
 * Sparkline.tsx). One flex column per day of month, both series sharing
 * a bottom-aligned Y scale:
 *
 *   - Baseline (the N-month average curve) across the full month: a faint
 *     2px cap per day, reading as the dashed reference line.
 *   - MTD (this month's running total) through today only: a solid 2px
 *     cap with Sparkline's two-band soft fill underneath, colored by the
 *     caller (green under pace / red over pace).
 *   - A subtle 1px "today" hairline at today's column.
 *
 * Glanceable only — no axes, ticks or tooltips (phone idiom).
 */
import { StyleSheet, View, ViewStyle } from 'react-native';
import { colors } from '../theme';
import { PacePoint } from '../db/pace';

interface Props {
  points: PacePoint[];
  /** Day of month (1-based) for the marker + as an MTD sanity bound. */
  today: number;
  daysInMonth: number;
  /** Solid MTD color — colors.income under pace, colors.expense over. */
  color: string;
  height?: number;
  style?: ViewStyle;
}

export default function PaceChart({
  points,
  today,
  daysInMonth,
  color,
  height = 72,
  style,
}: Props) {
  if (points.length === 0) return null;

  // Shared Y scale. Epsilon keeps a degenerate all-zero month from
  // dividing by zero (every cap just sits on the baseline).
  const maxMtd = points.reduce((mx, p) => (p.mtd != null && p.mtd > mx ? p.mtd : mx), 0);
  const baselineFull = points.length ? points[points.length - 1].baseline : 0;
  const scale = Math.max(baselineFull, maxMtd, 0.01);

  // 2px headroom so a cap at the max never clips at the top edge.
  const usable = height - 2;
  const h = (v: number) => Math.max(0, Math.min(usable, (v / scale) * usable));

  return (
    <View style={[styles.row, { height }, style]} pointerEvents="none">
      {points.map((p) => {
        const baseH = h(p.baseline);
        const mtdH = p.mtd != null ? h(p.mtd) : null;
        const isToday = p.day === today;
        return (
          <View key={p.day} style={styles.col}>
            {/* Baseline reference cap (faint). */}
            <View
              style={{
                position: 'absolute',
                left: 0,
                right: 0,
                bottom: baseH,
                height: 2,
                backgroundColor: colors.textFaint,
                opacity: 0.55,
              }}
            />
            {/* MTD soft fill (two bands) + solid cap, through today only. */}
            {mtdH != null && (
              <>
                <View
                  style={{
                    position: 'absolute',
                    left: 0,
                    right: 0,
                    bottom: mtdH * 0.55,
                    height: mtdH * 0.45,
                    backgroundColor: color,
                    opacity: 0.16,
                  }}
                />
                <View
                  style={{
                    position: 'absolute',
                    left: 0,
                    right: 0,
                    bottom: 0,
                    height: mtdH * 0.55,
                    backgroundColor: color,
                    opacity: 0.05,
                  }}
                />
                <View
                  style={{
                    position: 'absolute',
                    left: 0,
                    right: 0,
                    bottom: mtdH,
                    height: 2,
                    backgroundColor: color,
                  }}
                />
              </>
            )}
            {/* Today hairline. */}
            {isToday && daysInMonth > 0 && (
              <View
                style={{
                  position: 'absolute',
                  right: 0,
                  top: 0,
                  bottom: 0,
                  width: 1,
                  backgroundColor: colors.border,
                }}
              />
            )}
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    overflow: 'hidden',
  },
  col: {
    flex: 1,
    height: '100%',
    position: 'relative',
  },
});
