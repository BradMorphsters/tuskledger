/**
 * Always-visible sync status pill. Click → triggers a sync.
 *
 * Status reading is the same source as everywhere else — the Zustand
 * store from sync/manager.ts. Color choices map to the same semantics
 * used on the laptop's "stale account" badge so users build one
 * mental model.
 *
 * Demo mode: when the phone is in demo mode (showing synthetic data
 * for screenshots), the sync pill swaps for a bright orange "DEMO"
 * pill. Two reasons:
 *   1. Unmistakable in screenshots — anyone looking can immediately
 *      see this isn't real data.
 *   2. Reminds the user they're in demo mode, since otherwise the
 *      screens would look just like real data with different numbers.
 */
import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { syncNow, useSyncStore } from '../sync/manager';
import { loadDemoMode } from '../sync/storage';
import { colors, radius, space, type } from '../theme';

export default function SyncBadge() {
  const status = useSyncStore((s) => s.status);
  // dataVersion is bumped on every applySync — convenient signal for
  // re-checking demo mode (it gets toggled via the Settings tab, which
  // calls syncNow → bumps the version).
  const dataVersion = useSyncStore((s) => s.dataVersion);
  const [demoMode, setDemoMode] = useState(false);

  useEffect(() => {
    let cancelled = false;
    loadDemoMode().then((on) => { if (!cancelled) setDemoMode(on); });
    return () => { cancelled = true; };
  }, [dataVersion]);

  if (demoMode) {
    return (
      <Pressable onPress={() => syncNow()} hitSlop={8}>
        <View style={[styles.pill, styles.demoPill]}>
          <Text
            style={[type.small, { color: '#0e0f12', fontWeight: '700', letterSpacing: 0.6 }]}>
            DEMO
          </Text>
        </View>
      </Pressable>
    );
  }

  let label = 'Synced';
  let color = colors.income;
  let busy = false;
  switch (status) {
    case 'syncing':
      label = 'Syncing';
      color = colors.accent;
      busy = true;
      break;
    case 'offline':
      label = 'Offline';
      color = colors.textMuted;
      break;
    case 'error':
      label = 'Error';
      color = colors.expense;
      break;
    case 'unauthed':
      label = 'Re-pair';
      color = colors.warning;
      break;
    case 'unpaired':
      label = 'Unpaired';
      color = colors.warning;
      break;
  }

  return (
    <Pressable onPress={() => syncNow()} hitSlop={8}>
      <View style={[styles.pill, { borderColor: color }]}>
        {busy ? (
          <ActivityIndicator size="small" color={color} />
        ) : (
          <View style={[styles.dot, { backgroundColor: color }]} />
        )}
        <Text style={[type.small, { color, marginLeft: space(2) }]}>{label}</Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: space(3),
    paddingVertical: space(1.5),
    borderRadius: radius.lg,
    borderWidth: 1,
  },
  dot: { width: 8, height: 8, borderRadius: 4 },
  // Filled, opaque pill so it's unmistakable in screenshots — outline
  // style would be too easy to miss when the rest of the app already
  // uses outline pills for sync status. Filled background also reads
  // well at very small dimensions if a screenshot gets thumbnailed.
  demoPill: {
    backgroundColor: colors.warning,
    borderColor: colors.warning,
  },
});
