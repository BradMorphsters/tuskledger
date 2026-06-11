/**
 * Top-of-screen banner shown when the local data is concerning.
 *
 * Three concerning states (in priority order):
 *   1. We've never synced — first-launch or after "Resync from scratch."
 *      Shouldn't happen except briefly; if it persists, the laptop is
 *      unreachable.
 *   2. Sync is failing right now (status === 'offline' or 'error').
 *      Tell the user the data they're looking at is stale.
 *   3. Last successful sync was a long time ago (≥ STALE_THRESHOLD_MS)
 *      even though the manager isn't currently flagging an error —
 *      app probably hasn't been opened in a while, or background
 *      sync was throttled by iOS.
 *
 * Why a banner and not a modal: a modal blocks the user from looking
 * at their (cached) data. The data is still useful — just slightly
 * old. The banner says "fyi" without getting in the way, and tapping
 * it triggers a resync.
 */
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { syncNow, useSyncStore } from '../sync/manager';
import { colors, formatRelative, radius, space, type } from '../theme';

// 4 hours rather than 1: overnight background sync can lapse by ~8 h, and
// foreground rediscovery + resync takes up to ~8 s after the app opens.
// A 1 h threshold false-flashes the banner almost every morning; 4 h keeps
// it quiet during normal use while still catching genuinely stale data.
const STALE_THRESHOLD_MS = 4 * 60 * 60 * 1000; // 4 hours

export default function StaleBanner() {
  const status = useSyncStore((s) => s.status);
  const lastSyncedAt = useSyncStore((s) => s.lastSyncedAt);
  const lastError = useSyncStore((s) => s.lastError);

  // Pick a state. Order matters — explicit failures win over silence.
  let mode: 'offline' | 'error' | 'never' | 'stale' | null = null;
  if (status === 'offline') mode = 'offline';
  else if (status === 'error') mode = 'error';
  else if (!lastSyncedAt) mode = 'never';
  else if (Date.now() - new Date(lastSyncedAt).getTime() > STALE_THRESHOLD_MS) {
    mode = 'stale';
  }

  if (mode === null) return null;

  let title: string;
  let detail: string;
  let tone: string;
  switch (mode) {
    case 'offline':
      title = "Can't reach your laptop";
      detail =
        lastSyncedAt
          ? `Showing data from ${formatRelative(lastSyncedAt)}. Same Wi-Fi as the laptop?`
          : 'No connection yet — make sure the laptop is on the same Wi-Fi.';
      tone = colors.warning;
      break;
    case 'error':
      title = 'Sync error';
      detail = lastError || 'Something went wrong on the last sync. Tap to retry.';
      tone = colors.expense;
      break;
    case 'never':
      title = 'Not synced yet';
      detail = 'Tap to pull your finances from the laptop.';
      tone = colors.warning;
      break;
    case 'stale':
      title = 'Data is a bit old';
      detail = `Last synced ${formatRelative(lastSyncedAt)}. Tap to refresh.`;
      tone = colors.textMuted;
      break;
  }

  return (
    <Pressable
      onPress={() => syncNow()}
      style={[styles.wrap, { borderColor: tone }]}>
      <View style={[styles.dot, { backgroundColor: tone }]} />
      <View style={{ flex: 1 }}>
        <Text style={[type.body, { color: tone, fontWeight: '600' }]}>
          {title}
        </Text>
        <Text style={[type.small, { marginTop: 2 }]}>{detail}</Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  wrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space(3),
    margin: space(3),
    marginBottom: 0,
    padding: space(3),
    borderRadius: radius.md,
    borderWidth: 1,
    backgroundColor: colors.surface,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
});
