/**
 * SyncBadge — subtle header status: a small colored dot + relative
 * sync time. Tap to sync. The loud bordered pill of v1 is gone; status
 * should whisper unless something's wrong (error/offline keep their
 * semantic colors, and demo mode keeps the unmissable filled pill so
 * screenshots are self-evidently synthetic).
 *
 * Demo mode comes from the app store (hydrated once at launch, set by
 * the Settings toggle) — no more re-reading SecureStore on every
 * dataVersion bump.
 */
import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { useAppStore } from '../state/appStore';
import { syncNow, useSyncStore } from '../sync/manager';
import { colors, formatRelative, space } from '../theme';

export default function SyncBadge() {
  const status = useSyncStore((s) => s.status);
  const lastSyncedAt = useSyncStore((s) => s.lastSyncedAt);
  const demoMode = useAppStore((s) => s.demoMode);

  // Re-render every minute so "2m ago" doesn't fossilize while the
  // screen sits open.
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 60_000);
    return () => clearInterval(t);
  }, []);

  if (demoMode) {
    return (
      <Pressable
        onPress={() => syncNow()}
        hitSlop={8}
        accessibilityRole="button"
        accessibilityLabel="Demo mode on. Tap to sync.">
        <View style={styles.demoPill}>
          <Text style={styles.demoText}>DEMO</Text>
        </View>
      </Pressable>
    );
  }

  let label: string;
  let color: string;
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
    default:
      label = formatRelative(lastSyncedAt);
      color = colors.income;
  }

  return (
    <Pressable
      onPress={() => syncNow()}
      hitSlop={12}
      accessibilityRole="button"
      accessibilityLabel={`Sync status: ${label}. Tap to sync now.`}
      style={({ pressed }) => [styles.wrap, pressed && { opacity: 0.6 }]}>
      {busy ? (
        <ActivityIndicator size="small" color={color} />
      ) : (
        <View style={[styles.dot, { backgroundColor: color }]} />
      )}
      <Text style={[styles.label, status !== 'idle' ? { color } : null]}>
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  wrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space(1.5),
    paddingVertical: space(1),
  },
  dot: { width: 7, height: 7, borderRadius: 4 },
  label: {
    fontSize: 12,
    fontWeight: '500',
    color: colors.textMuted,
    fontVariant: ['tabular-nums'],
  },
  demoPill: {
    backgroundColor: colors.warning,
    borderRadius: 999,
    paddingHorizontal: space(3),
    paddingVertical: space(1.5),
  },
  demoText: {
    color: colors.onAccent,
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 0.8,
  },
});
