/**
 * Settings — the diagnostic + power-user screen.
 *
 * Surfaces the things that go wrong:
 *   - Which laptop am I paired with, and is it reachable?
 *   - When did I last sync, and what was the error if I haven't?
 *   - Wipe local data and re-pair when something's stuck.
 *
 * Deliberately read-only beyond the actions listed above. We don't
 * edit transactions, categories, budgets, etc. from here — that's
 * what the laptop is for. The phone is a window, not a workshop.
 * (See feedback_phone_no_writes memory.)
 */
import { useEffect, useState } from 'react';
import {
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { resetMirror } from '../db/sqlite';
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
import { colors, formatRelative, radius, space, type } from '../theme';

interface Props {
  onUnpaired: () => void;
}

export default function SettingsScreen({ onUnpaired }: Props) {
  const status = useSyncStore((s) => s.status);
  const lastSyncedAt = useSyncStore((s) => s.lastSyncedAt);
  const lastError = useSyncStore((s) => s.lastError);
  const [host, setHost] = useState<PairedHost | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hostnameLive, setHostnameLive] = useState<string | null>(null);
  const [demoMode, setDemoModeLocal] = useState<boolean>(false);
  const [demoAvailable, setDemoAvailable] = useState<boolean>(true);

  useEffect(() => {
    (async () => {
      setHost(await loadPairedHost());
      setCursor(await loadCursor());
      setDemoModeLocal(await loadDemoMode());
    })();
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const m = await fetchManifest();
        if (cancelled) return;
        setHostnameLive(m.hostname);
        // demo_available is a v2+ manifest field. Older backends omit
        // it — assume available so the toggle isn't hidden against an
        // older laptop that does support demo mode.
        setDemoAvailable(m.demo_available !== false);
        // Backfill the manifest fields into the stored host record on
        // first successful manifest fetch (the pair flow stores them
        // empty because pair/claim doesn't return them).
        if (host && (!host.hostId || !host.hostname)) {
          const updated = { ...host, hostId: m.host_id, hostname: m.hostname };
          await savePairedHost(updated);
          setHost(updated);
        }
      } catch {
        // Manifest is best-effort — Settings should still render.
      }
    })();
    return () => { cancelled = true; };
  }, [host?.baseUrl]);

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

  async function handleToggleDemo() {
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
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg }}>
      <ScrollView contentContainerStyle={{ padding: space(5) }}>
        <Text style={type.h1}>Settings</Text>

        <Text style={[type.caption, styles.section]}>PAIRED LAPTOP</Text>
        <View style={styles.card}>
          <KV label="Host" value={host?.baseUrl ?? '—'} />
          <KV
            label="Name"
            value={hostnameLive ?? host?.hostname ?? '—'}
          />
          <KV label="Status" value={prettyStatus(status)} />
          <KV label="Last synced" value={formatRelative(lastSyncedAt)} />
          <KV
            label="Cursor"
            value={cursor ? cursor.slice(0, 19).replace('T', ' ') : '—'}
          />
          {lastError && (
            <Text style={[type.small, { color: colors.expense, marginTop: space(2) }]}>
              {lastError}
            </Text>
          )}
        </View>

        <Text style={[type.caption, styles.section]}>ACTIONS</Text>
        <View style={styles.card}>
          <Action label="Sync now" onPress={() => syncNow()} />
          <Divider />
          <Action label="Resync from scratch" onPress={handleResync} />
          <Divider />
          <Action
            label={demoMode ? 'Exit demo mode' : 'Switch to demo mode'}
            onPress={demoAvailable ? handleToggleDemo : undefined}
            disabled={!demoAvailable}
            highlight={demoMode}
          />
          <Divider />
          <Action
            label="Unpair this phone"
            onPress={handleUnpair}
            danger
          />
        </View>
        {demoMode && (
          <Text style={[type.small, { marginTop: space(2), color: colors.warning }]}>
            Demo mode is on. Numbers are synthetic Alex Carter data from the laptop's demo database — safe to share screenshots.
          </Text>
        )}

        <Text style={[type.caption, styles.section]}>ABOUT</Text>
        <View style={styles.card}>
          <KV label="Read-only" value="Yes (by design)" />
          <Text style={[type.small, { marginTop: space(2) }]}>
            Tusk Ledger on your phone never writes back to the laptop. Edits,
            categorization, budgets — all that lives on the laptop. The phone
            is a fast read of the same data.
          </Text>
        </View>
      </ScrollView>
    </SafeAreaView>
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

function KV({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.kv}>
      <Text style={[type.small, { flex: 1 }]}>{label}</Text>
      <Text style={[type.body, { textAlign: 'right', flexShrink: 1 }]} numberOfLines={1}>
        {value}
      </Text>
    </View>
  );
}

function Action({
  label,
  onPress,
  danger,
  highlight,
  disabled,
}: {
  label: string;
  onPress: (() => void) | undefined;
  danger?: boolean;
  highlight?: boolean;
  disabled?: boolean;
}) {
  let color = colors.link;
  if (danger) color = colors.expense;
  else if (highlight) color = colors.warning;
  else if (disabled) color = colors.textFaint;
  return (
    <Pressable
      onPress={disabled ? undefined : onPress}
      style={[styles.action, disabled ? { opacity: 0.5 } : null]}>
      <Text style={[type.body, { color }]}>
        {label}
      </Text>
    </Pressable>
  );
}

function Divider() {
  return <View style={styles.divider} />;
}

const styles = StyleSheet.create({
  section: { marginTop: space(6), marginBottom: space(2) },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: space(4),
  },
  kv: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: space(1.5),
    gap: space(3),
  },
  action: { paddingVertical: space(3) },
  divider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.border,
  },
});
