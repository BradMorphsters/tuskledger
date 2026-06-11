/**
 * Settings — the diagnostic + power-user screen, iOS-grouped style:
 * rounded section cards of rows (label left, value/control right).
 *
 * Surfaces the things that go wrong:
 *   - Which laptop am I paired with, and is it reachable?
 *   - When did I last sync, and what was the error if I haven't?
 *   - Wipe local data and re-pair when something's stuck.
 *
 * Deliberately read-only beyond the actions listed here. We don't
 * edit transactions, categories, budgets, etc. from the phone — that's
 * what the laptop is for. The phone is a window, not a workshop.
 * (See feedback_phone_no_writes memory.)
 */
import { ReactNode, useEffect, useState } from 'react';
import {
  Alert,
  Pressable,
  StyleSheet,
  Switch,
  Text,
  View,
} from 'react-native';
import appJson from '../../app.json';
import Card from '../components/Card';
import Screen from '../components/Screen';
import SectionHeader from '../components/SectionHeader';
import { resetMirror } from '../db/sqlite';
import { useAppStore } from '../state/appStore';
import { fetchManifest } from '../sync/api';
import { syncNow, useSyncStore } from '../sync/manager';
import {
  clearAllPairing,
  loadCursor,
  loadDemoMode,
  loadPairedHost,
  savePairedHost,
  setDemoMode,
} from '../sync/storage';
import type { PairedHost } from '../sync/types';
import { colors, formatRelative, layout, space, type } from '../theme';

interface Props {
  onUnpaired: () => void;
}

export default function SettingsScreen({ onUnpaired }: Props) {
  const status = useSyncStore((s) => s.status);
  const lastSyncedAt = useSyncStore((s) => s.lastSyncedAt);
  const lastError = useSyncStore((s) => s.lastError);
  const setDemoModeGlobal = useAppStore((s) => s.setDemoMode);
  const [host, setHost] = useState<PairedHost | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hostnameLive, setHostnameLive] = useState<string | null>(null);
  const [demoMode, setDemoModeLocal] = useState<boolean>(false);
  const [demoAvailable, setDemoAvailable] = useState<boolean>(true);

  // One effect, one manifest fetch. The previous version split this
  // into two effects — the second keyed on host?.baseUrl, which ran
  // once with host=null and again when the first effect's load landed,
  // double-fetching the manifest and racing the hostId backfill.
  // Loading storage first, then fetching the manifest once with the
  // freshly-loaded host in hand, removes the race entirely.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [h, c, d] = await Promise.all([
        loadPairedHost(),
        loadCursor(),
        loadDemoMode(),
      ]);
      if (cancelled) return;
      setHost(h);
      setCursor(c);
      setDemoModeLocal(d);
      try {
        const m = await fetchManifest();
        if (cancelled) return;
        setHostnameLive(m.hostname);
        // demo_available is a v2+ manifest field. Older backends omit
        // it — assume available so the toggle isn't hidden against an
        // older laptop that does support demo mode.
        setDemoAvailable(m.demo_available !== false);
        // Backfill the manifest fields into the stored host record
        // (the pair flow stores them empty because pair/claim doesn't
        // return them).
        if (h && (!h.hostId || !h.hostname)) {
          const updated = { ...h, hostId: m.host_id, hostname: m.hostname };
          await savePairedHost(updated);
          if (!cancelled) setHost(updated);
        }
      } catch {
        // Manifest is best-effort — Settings should still render.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleResync() {
    Alert.alert(
      'Resync from scratch?',
      "Wipes the local copy and pulls fresh from your laptop. Doesn't change anything on the laptop.",
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Resync',
          style: 'destructive',
          onPress: async () => {
            await resetMirror();
            await syncNow(true);
          },
        },
      ],
    );
  }

  function handleToggleDemo() {
    const turningOn = !demoMode;
    Alert.alert(
      turningOn ? 'Switch to demo mode?' : 'Switch back to real data?',
      turningOn
        ? "Wipes the local copy and replaces it with synthetic data from your laptop's demo database. Useful for screenshots — none of these numbers will be your real finances. You can switch back any time."
        : 'Wipes the synthetic data and pulls your real finances back in.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: turningOn ? 'Use demo data' : 'Use real data',
          onPress: async () => {
            await setDemoMode(turningOn);
            setDemoModeLocal(turningOn);
            // Keep the app store in step so SyncBadge flips its DEMO
            // pill immediately instead of polling SecureStore.
            setDemoModeGlobal(turningOn);
            await resetMirror();
            await syncNow(true);
          },
        },
      ],
    );
  }

  async function handleUnpair() {
    Alert.alert(
      'Unpair this phone?',
      "Your local copy will be erased. Your laptop's data is unchanged. You can pair again any time.",
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Unpair',
          style: 'destructive',
          onPress: async () => {
            await clearAllPairing();
            await resetMirror();
            onUnpaired();
          },
        },
      ],
    );
  }

  return (
    <Screen title="Settings" banner={false}>
      {/* ── Connection ──────────────────────────────────────────── */}
      <SectionHeader label="Connection" topGap={false} />
      <Card padded={false}>
        <Row label="Laptop" value={host?.baseUrl ?? '—'} first />
        <Row label="Name" value={hostnameLive ?? host?.hostname ?? '—'} />
        <Row
          label="Status"
          value={prettyStatus(status)}
          dot={statusColor(status)}
        />
        {lastError ? (
          <Text style={styles.errorText}>{lastError}</Text>
        ) : null}
        <Row label="Unpair this phone" onPress={handleUnpair} danger />
      </Card>

      {/* ── Sync ────────────────────────────────────────────────── */}
      <SectionHeader label="Sync" />
      <Card padded={false}>
        <Row label="Last synced" value={formatRelative(lastSyncedAt)} first />
        <Row
          label="Cursor"
          value={cursor ? cursor.slice(0, 19).replace('T', ' ') : '—'}
        />
        <Row label="Sync now" onPress={() => syncNow()} link />
        <Row label="Resync from scratch" onPress={handleResync} danger />
      </Card>

      {/* ── Display ─────────────────────────────────────────────── */}
      <SectionHeader label="Display" />
      <Card padded={false}>
        <Row
          label="Demo mode"
          first
          control={
            <Switch
              value={demoMode}
              onValueChange={demoAvailable ? handleToggleDemo : undefined}
              disabled={!demoAvailable}
              trackColor={{ true: colors.accent }}
              accessibilityLabel="Demo mode"
            />
          }
        />
      </Card>
      {demoMode ? (
        <Text style={styles.demoNote}>
          Demo mode is on. Numbers are synthetic Alex Carter data from the
          laptop's demo database — safe to share screenshots.
        </Text>
      ) : !demoAvailable ? (
        <Text style={styles.helpNote}>
          Demo mode isn't enabled on the paired laptop.
        </Text>
      ) : (
        <Text style={styles.helpNote}>
          Swaps in synthetic data for safe screenshots.
        </Text>
      )}

      {/* ── Read-only — the contract this app is built on ───────── */}
      <SectionHeader label="Read-only" />
      <Card style={styles.readonlyCard}>
        <View style={styles.readonlyHeader}>
          <Text style={styles.readonlyIcon}>👁️</Text>
          <View style={{ flex: 1 }}>
            <Text style={type.h2}>This phone is read-only</Text>
            <Text style={[type.small, { marginTop: 2, color: colors.accent }]}>
              On · by design
            </Text>
          </View>
        </View>
        <Text style={[type.small, { marginTop: space(3) }]}>
          Tusk Ledger on your phone never writes back to the laptop. Edits,
          categorization, budgets — all that lives on the laptop. The phone
          is a fast read of the same data.
        </Text>
      </Card>

      {/* ── About ───────────────────────────────────────────────── */}
      <SectionHeader label="About" />
      <Card padded={false}>
        <Row label="Version" value={appJson.expo.version} first />
      </Card>
    </Screen>
  );
}

function prettyStatus(s: string): string {
  switch (s) {
    case 'idle': return 'Up to date';
    case 'syncing': return 'Syncing now…';
    case 'offline': return 'Offline (Wi-Fi / laptop unreachable)';
    case 'error': return 'Error — see message below';
    case 'unauthed': return 'Token revoked — re-pair';
    case 'unpaired': return 'Not paired';
    default: return s;
  }
}

function statusColor(s: string): string {
  switch (s) {
    case 'idle': return colors.income;
    case 'syncing': return colors.accent;
    case 'offline': return colors.textMuted;
    case 'error': return colors.expense;
    default: return colors.warning;
  }
}

/**
 * iOS-grouped settings row. Three flavors:
 *   - value row: label left, muted value right (optional status dot)
 *   - action row: tappable label (link blue or destructive red)
 *   - control row: label left, an inline control (Switch) right
 */
function Row({
  label,
  value,
  dot,
  control,
  onPress,
  danger,
  link,
  first,
}: {
  label: string;
  value?: string;
  dot?: string;
  control?: ReactNode;
  onPress?: () => void;
  danger?: boolean;
  link?: boolean;
  first?: boolean;
}) {
  const isAction = !!onPress;
  const labelColor = danger ? colors.expense : link ? colors.link : colors.text;
  const inner = (
    <>
      <Text
        style={[type.body, { color: labelColor, flexShrink: 1 }]}
        numberOfLines={1}>
        {label}
      </Text>
      <View style={styles.rowRight}>
        {dot ? <View style={[styles.statusDot, { backgroundColor: dot }]} /> : null}
        {value != null ? (
          <Text style={styles.rowValue} numberOfLines={1}>
            {value}
          </Text>
        ) : null}
        {control ?? null}
        {isAction && !danger && !link ? (
          <Text style={styles.chevron}>›</Text>
        ) : null}
      </View>
    </>
  );

  if (isAction) {
    return (
      <Pressable
        onPress={onPress}
        accessibilityRole="button"
        accessibilityLabel={label}
        style={({ pressed }) => [
          styles.row,
          !first && styles.rowDivider,
          pressed && { opacity: 0.6 },
        ]}>
        {inner}
      </Pressable>
    );
  }
  return (
    <View style={[styles.row, !first && styles.rowDivider]}>{inner}</View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: layout.minTouch + 4,
    paddingHorizontal: layout.cardPad,
    paddingVertical: space(2.5),
    gap: space(3),
  },
  rowDivider: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  rowRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space(2),
    flexShrink: 1,
    minWidth: 0,
  },
  rowValue: {
    fontSize: 15,
    color: colors.textMuted,
    fontVariant: ['tabular-nums'],
    textAlign: 'right',
    flexShrink: 1,
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  chevron: {
    fontSize: 18,
    color: colors.textFaint,
  },
  errorText: {
    color: colors.expense,
    fontSize: 13,
    lineHeight: 18,
    paddingHorizontal: layout.cardPad,
    paddingBottom: space(2.5),
  },
  demoNote: {
    ...type.small,
    color: colors.warning,
    marginTop: space(2),
    paddingHorizontal: space(1),
  },
  helpNote: {
    ...type.small,
    color: colors.textFaint,
    marginTop: space(2),
    paddingHorizontal: space(1),
  },
  readonlyCard: {
    borderColor: colors.accentBg,
    backgroundColor: colors.surface,
  },
  readonlyHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space(3),
  },
  readonlyIcon: {
    fontSize: 22,
  },
});
