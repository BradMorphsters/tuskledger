/**
 * PairingScreen — first-run flow.
 *
 * Two paths in:
 *   1. QR scan (default). The laptop generates a tuskledger://pair?…
 *      payload; we parse host/port/code from the URL.
 *   2. Manual entry (fallback). User types an IP and the 8-char code.
 *      For when the camera permission is denied, the QR is too small
 *      to scan, or the user is debugging.
 *
 * On success: stash the device token + paired host in SecureStore,
 * kick off the first sync, and let App.tsx route to the tab navigator.
 *
 * The pairing/claim logic in `complete()` is untouched from v1 — this
 * file's redesign is presentation only (brand mark, step copy, corner-
 * accented scan frame, styled manual form).
 */
import { CameraView, useCameraPermissions } from 'expo-camera';
import { useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { fetchManifest, pairClaim, probeHost } from '../sync/api';
import { syncNow } from '../sync/manager';
import { savePairedHost, saveToken } from '../sync/storage';
import { colors, layout, radius, space, type } from '../theme';

interface ParsedPayload {
  host: string;
  port: number;
  code: string;
}

function parseDeepLink(url: string): ParsedPayload | null {
  // Accepts tuskledger://pair?host=…&port=…&code=… and
  // http(s)://host:port/?code=… as a forgiving fallback.
  try {
    // RN's URL global is shimmed; this works for both schemes.
    const parsed = new URL(url);
    const host =
      parsed.searchParams.get('host') ||
      parsed.hostname ||
      '';
    const port = parseInt(
      parsed.searchParams.get('port') || parsed.port || '8000',
      10,
    );
    const code = parsed.searchParams.get('code') || '';
    if (!host || !code) return null;
    return { host, port, code };
  } catch {
    return null;
  }
}

interface Props {
  onPaired: () => void;
}

/** Brand mark — tusk + wordmark, shared by every pairing state. */
function BrandMark() {
  return (
    <View style={styles.brand}>
      <View style={styles.brandBadge}>
        <Text style={styles.brandEmoji}>🐘</Text>
      </View>
      <Text style={styles.wordmark}>
        Tusk <Text style={{ color: colors.accent }}>Ledger</Text>
      </Text>
      <Text style={[type.small, { marginTop: space(1) }]}>
        Your finances, glanceable from the couch.
      </Text>
    </View>
  );
}

export default function PairingScreen({ onPaired }: Props) {
  const [permission, requestPermission] = useCameraPermissions();
  const [mode, setMode] = useState<'scan' | 'manual'>('scan');
  const [busy, setBusy] = useState(false);
  const [manualHost, setManualHost] = useState('');
  const [manualCode, setManualCode] = useState('');
  // Synchronous guard for the camera scanner. `onBarcodeScanned` fires
  // many times per second; the async `busy` state hasn't flushed before
  // the next frame arrives, so a state-only guard lets duplicate scans
  // through — each one calls pairClaim and burns the one-time code,
  // which then surfaces a spurious "code not recognized" over an
  // already-successful pairing. A ref flips synchronously, before the
  // first await, so only the first frame gets through.
  const scanClaimed = useRef(false);

  async function complete(host: string, port: number, code: string) {
    setBusy(true);
    const baseUrl = `http://${host}:${port}`;
    try {
      // Probe first so a typo gives a clean error before we burn the
      // pairing code on a server that's not actually there.
      const reachable = await probeHost(baseUrl);
      if (!reachable) {
        throw new Error(
          `No Tusk Ledger at ${baseUrl}. Is the laptop on, and on the same Wi-Fi?`,
        );
      }
      const claim = await pairClaim(baseUrl, code, deviceLabel());
      await saveToken(claim.token);
      // Save with empty hostId first so authedFetch can read the
      // paired host record when fetchManifest runs below.
      await savePairedHost({
        baseUrl,
        hostId: '',
        hostname: '',
      });
      // Fetch the manifest to get the real hostId and hostname so
      // Bonjour rediscovery (which short-circuits on falsy hostId)
      // can find the laptop again after a Wi-Fi change.
      try {
        const manifest = await fetchManifest();
        await savePairedHost({
          baseUrl,
          hostId: manifest.host_id,
          hostname: manifest.hostname,
        });
      } catch {
        // Non-fatal — pairing still works, rediscovery just won't
        // have a hostId until the next successful manifest fetch.
      }
      // First sync, primed and persistent.
      await syncNow(true);
      onPaired();
    } catch (e) {
      // Release the scan guard so the user can retry (a fresh QR, or the
      // same one if the failure was transient) without leaving the screen.
      scanClaimed.current = false;
      Alert.alert('Pairing failed', e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  function onScan(data: string) {
    // Synchronous single-shot guard — see `scanClaimed` above. Set it
    // before any async work so a burst of scan frames can't double-fire.
    if (scanClaimed.current || busy) return;
    const parsed = parseDeepLink(data);
    if (!parsed) {
      // Not our QR — don't consume the guard so the user can keep the
      // camera pointed at the right code.
      Alert.alert(
        'Not a Tusk Ledger code',
        'That QR code did not match the pairing format. Try again, or pair manually.',
      );
      return;
    }
    scanClaimed.current = true;
    complete(parsed.host, parsed.port, parsed.code);
  }

  if (mode === 'scan') {
    if (!permission) {
      return (
        <SafeAreaView style={styles.center}>
          <ActivityIndicator color={colors.textMuted} />
        </SafeAreaView>
      );
    }
    if (!permission.granted) {
      return (
        <SafeAreaView style={styles.container}>
          <ScrollView contentContainerStyle={styles.padBig}>
            <BrandMark />
            <Text style={[type.h1, { marginTop: space(8) }]}>
              Pair this phone
            </Text>
            <Text style={[type.body, styles.muted, { marginTop: space(2) }]}>
              Tusk Ledger needs camera access to scan the pairing code on
              your laptop screen. Or you can enter the code manually.
            </Text>
            <Steps
              steps={[
                'Open Tusk Ledger on your laptop',
                'Go to Settings → Pair phone',
                'Scan the QR code it shows',
              ]}
            />
            <Pressable
              style={({ pressed }) => [
                styles.primaryButton,
                { marginTop: space(6), opacity: pressed ? 0.8 : 1 },
              ]}
              accessibilityRole="button"
              onPress={requestPermission}>
              <Text style={styles.primaryButtonText}>Allow camera</Text>
            </Pressable>
            <Pressable
              style={[styles.linkButton, { marginTop: space(3) }]}
              accessibilityRole="button"
              onPress={() => setMode('manual')}>
              <Text style={styles.linkButtonText}>Enter code manually</Text>
            </Pressable>
          </ScrollView>
        </SafeAreaView>
      );
    }
    return (
      <View style={styles.container}>
        <CameraView
          style={StyleSheet.absoluteFill}
          barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
          onBarcodeScanned={busy ? undefined : (e) => onScan(e.data)}
        />
        <SafeAreaView style={[styles.scanOverlay, { pointerEvents: 'box-none' }]}>
          <Text style={styles.scanWordmark}>
            Tusk <Text style={{ color: colors.accent }}>Ledger</Text>
          </Text>
          {/* Scan frame: transparent center, gold corner accents. */}
          <View style={styles.scanFrame}>
            <View style={[styles.corner, styles.cornerTL]} />
            <View style={[styles.corner, styles.cornerTR]} />
            <View style={[styles.corner, styles.cornerBL]} />
            <View style={[styles.corner, styles.cornerBR]} />
          </View>
          <Text style={styles.scanHint}>
            Point at the pairing QR on your laptop
          </Text>
          <Text style={[type.small, { color: 'rgba(255,255,255,0.7)', marginTop: space(1), textAlign: 'center' }]}>
            Laptop → Settings → Pair phone
          </Text>
          <Pressable
            style={[styles.linkButton, { marginTop: space(4) }]}
            accessibilityRole="button"
            onPress={() => setMode('manual')}>
            <Text style={[styles.linkButtonText, { color: '#fff' }]}>
              Enter code manually
            </Text>
          </Pressable>
          {busy && (
            <View style={styles.scanBusy}>
              <ActivityIndicator color="#fff" />
              <Text style={[type.body, { color: '#fff', marginTop: space(2) }]}>
                Pairing…
              </Text>
            </View>
          )}
        </SafeAreaView>
      </View>
    );
  }

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={styles.container}>
      <SafeAreaView style={styles.container}>
        <ScrollView contentContainerStyle={styles.padBig}>
          <BrandMark />
          <Text style={[type.h1, { marginTop: space(8) }]}>Pair manually</Text>
          <Text style={[type.body, styles.muted, { marginTop: space(2) }]}>
            On your laptop, open Tusk Ledger → Settings → Pair phone, and
            type what's shown here.
          </Text>

          <Text style={[type.caption, styles.label]}>Laptop address</Text>
          <TextInput
            value={manualHost}
            onChangeText={setManualHost}
            placeholder="192.168.1.42:8000"
            placeholderTextColor={colors.textFaint}
            style={styles.input}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            accessibilityLabel="Laptop address"
          />

          <Text style={[type.caption, styles.label]}>Pairing code</Text>
          <TextInput
            value={manualCode}
            onChangeText={(s) => setManualCode(s.toUpperCase())}
            placeholder="ABCD2345"
            placeholderTextColor={colors.textFaint}
            style={[styles.input, styles.codeInput]}
            autoCapitalize="characters"
            autoCorrect={false}
            accessibilityLabel="Pairing code"
          />

          <Pressable
            disabled={busy}
            accessibilityRole="button"
            style={({ pressed }) => [
              styles.primaryButton,
              { marginTop: space(6), opacity: busy ? 0.5 : pressed ? 0.8 : 1 },
            ]}
            onPress={() => {
              const [host, portStr = '8000'] = manualHost.trim().split(':');
              const port = parseInt(portStr, 10);
              if (!host || !port || !manualCode.trim()) {
                Alert.alert('Missing fields', 'Address and code are required.');
                return;
              }
              complete(host, port, manualCode.trim());
            }}>
            {busy ? <ActivityIndicator color={colors.onAccent} /> : (
              <Text style={styles.primaryButtonText}>Pair</Text>
            )}
          </Pressable>

          <Pressable
            style={[styles.linkButton, { marginTop: space(3) }]}
            accessibilityRole="button"
            onPress={() => setMode('scan')}>
            <Text style={styles.linkButtonText}>Scan a QR instead</Text>
          </Pressable>
        </ScrollView>
      </SafeAreaView>
    </KeyboardAvoidingView>
  );
}

function Steps({ steps }: { steps: string[] }) {
  return (
    <View style={styles.steps}>
      {steps.map((s, i) => (
        <View key={s} style={styles.stepRow}>
          <View style={styles.stepNum}>
            <Text style={styles.stepNumText}>{i + 1}</Text>
          </View>
          <Text style={[type.body, { flex: 1 }]}>{s}</Text>
        </View>
      ))}
    </View>
  );
}

function deviceLabel(): string {
  // Simple heuristic — Expo's Constants.deviceName is async on some
  // platforms and not worth the round-trip here. Pick something
  // identifiable enough that the laptop's "Devices" page is readable.
  const hint = Platform.OS === 'ios' ? 'iPhone' : 'Android';
  return `${hint} (${new Date().toISOString().slice(0, 10)})`;
}

const CORNER = 30;
const CORNER_W = 3.5;

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  center: {
    flex: 1, alignItems: 'center', justifyContent: 'center',
    backgroundColor: colors.bg,
  },
  padBig: { padding: space(6), paddingTop: space(10) },
  muted: { color: colors.textMuted },
  brand: { alignItems: 'center' },
  brandBadge: {
    width: 72,
    height: 72,
    borderRadius: 22,
    backgroundColor: colors.accentBg,
    borderWidth: 1,
    borderColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: space(3),
  },
  brandEmoji: { fontSize: 34 },
  wordmark: {
    fontSize: 26,
    fontWeight: '800',
    letterSpacing: -0.4,
    color: colors.text,
  },
  steps: {
    marginTop: space(6),
    gap: space(3),
  },
  stepRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space(3),
  },
  stepNum: {
    width: 26,
    height: 26,
    borderRadius: 13,
    backgroundColor: colors.accentBg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepNumText: {
    color: colors.accent,
    fontSize: 13,
    fontWeight: '700',
  },
  label: { marginTop: space(5), marginBottom: space(2) },
  input: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radius.md,
    padding: space(3.5),
    color: colors.text,
    fontSize: 16,
    minHeight: layout.minTouch,
  },
  codeInput: {
    fontSize: 20,
    fontWeight: '600',
    letterSpacing: 4,
    fontVariant: ['tabular-nums'],
  },
  primaryButton: {
    backgroundColor: colors.accent,
    paddingVertical: space(3.5),
    borderRadius: radius.md,
    alignItems: 'center',
    minHeight: layout.minTouch,
    justifyContent: 'center',
  },
  primaryButtonText: { color: colors.onAccent, fontWeight: '700', fontSize: 16 },
  linkButton: {
    padding: space(3),
    alignItems: 'center',
    minHeight: layout.minTouch,
    justifyContent: 'center',
  },
  linkButtonText: { color: colors.link, fontSize: 15 },
  scanOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: space(6),
  },
  scanWordmark: {
    fontSize: 22,
    fontWeight: '800',
    color: '#fff',
    marginBottom: space(6),
  },
  scanFrame: {
    width: 250,
    height: 250,
    borderRadius: radius.lg,
  },
  scanHint: {
    ...type.h2,
    color: '#fff',
    textAlign: 'center',
    marginTop: space(5),
  },
  corner: {
    position: 'absolute',
    width: CORNER,
    height: CORNER,
    borderColor: colors.accent,
  },
  cornerTL: {
    top: 0, left: 0,
    borderTopWidth: CORNER_W, borderLeftWidth: CORNER_W,
    borderTopLeftRadius: radius.lg,
  },
  cornerTR: {
    top: 0, right: 0,
    borderTopWidth: CORNER_W, borderRightWidth: CORNER_W,
    borderTopRightRadius: radius.lg,
  },
  cornerBL: {
    bottom: 0, left: 0,
    borderBottomWidth: CORNER_W, borderLeftWidth: CORNER_W,
    borderBottomLeftRadius: radius.lg,
  },
  cornerBR: {
    bottom: 0, right: 0,
    borderBottomWidth: CORNER_W, borderRightWidth: CORNER_W,
    borderBottomRightRadius: radius.lg,
  },
  scanBusy: {
    position: 'absolute', bottom: space(20),
    alignItems: 'center',
  },
});
