/**
 * TabIcon — minimalist geometric tab-bar icons drawn with plain Views.
 *
 * Why not an icon font: @expo/vector-icons isn't physically installed
 * in this project and the brief is zero new dependencies. Four tiny
 * compositions of rounded rectangles read crisply at tab-bar size and
 * tint cleanly with the navigator's active/inactive colors:
 *
 *   dashboard     2×2 grid of rounded tiles
 *   transactions  three list bars of decreasing width
 *   investments   three ascending chart columns
 *   settings      two slider tracks with offset knobs
 */
import { StyleSheet, View } from 'react-native';

export type TabIconName =
  | 'dashboard'
  | 'transactions'
  | 'investments'
  | 'settings';

interface Props {
  name: TabIconName;
  color: string;
  size?: number;
}

export default function TabIcon({ name, color, size = 24 }: Props) {
  const s = size;
  switch (name) {
    case 'dashboard': {
      const tile = {
        width: s * 0.42,
        height: s * 0.42,
        borderRadius: s * 0.12,
        backgroundColor: color,
      };
      return (
        <View style={[styles.box, { width: s, height: s }]}>
          <View style={styles.gridRow}>
            <View style={tile} />
            <View style={[tile, { opacity: 0.55 }]} />
          </View>
          <View style={[styles.gridRow, { marginTop: s * 0.12 }]}>
            <View style={[tile, { opacity: 0.55 }]} />
            <View style={tile} />
          </View>
        </View>
      );
    }
    case 'transactions': {
      const bar = (w: number, o = 1) => (
        <View
          style={{
            width: s * w,
            height: s * 0.14,
            borderRadius: s * 0.07,
            backgroundColor: color,
            opacity: o,
          }}
        />
      );
      return (
        <View style={[styles.box, { width: s, height: s, alignItems: 'flex-start', justifyContent: 'center', gap: s * 0.16 }]}>
          {bar(0.95)}
          {bar(0.7, 0.7)}
          {bar(0.85, 0.45)}
        </View>
      );
    }
    case 'investments': {
      const col = (h: number, o = 1) => (
        <View
          style={{
            width: s * 0.2,
            height: s * h,
            borderRadius: s * 0.08,
            backgroundColor: color,
            opacity: o,
          }}
        />
      );
      return (
        <View style={[styles.box, { width: s, height: s, flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'center', gap: s * 0.12 }]}>
          {col(0.45, 0.5)}
          {col(0.7, 0.75)}
          {col(0.95)}
        </View>
      );
    }
    case 'settings': {
      const track = (knobLeft: number) => (
        <View
          style={{
            width: s * 0.95,
            height: s * 0.12,
            borderRadius: s * 0.06,
            backgroundColor: color,
            opacity: 0.45,
            justifyContent: 'center',
          }}>
          <View
            style={{
              position: 'absolute',
              left: s * knobLeft,
              width: s * 0.3,
              height: s * 0.3,
              borderRadius: s * 0.15,
              backgroundColor: color,
            }}
          />
        </View>
      );
      return (
        <View style={[styles.box, { width: s, height: s, justifyContent: 'center', gap: s * 0.32 }]}>
          {track(0.12)}
          {track(0.55)}
        </View>
      );
    }
  }
}

const styles = StyleSheet.create({
  box: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  gridRow: {
    flexDirection: 'row',
    gap: 0,
    columnGap: 0,
    justifyContent: 'space-between',
    width: '100%',
  },
});
