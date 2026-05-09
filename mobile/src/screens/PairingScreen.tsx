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
 */
import { CameraView, useCameraPermissions } from 'expo-camera';
import { useState } from 'react';
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
import { pairClaim, probeHost } from '../sync/api';
import { syncNow } from '../sync/manager';
import { savePairedHost, saveToken } from '../sync/storage';
import { colors, radius, space, type } from '../theme';

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

export default function PairingScreen({ onPaired }: Props) {
  const [permission, requestPermission] = useCameraPermissions();
  const [mode, setMode] = useState<'scan' | 'manual'>('scan');
  const [busy, setBusy] = useState(false);
  const [manualHost, setManualHost] = useState('');
  const [manualCode, setManualCode] = useState('');

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
      await savePairedHost({
        baseUrl,
        hostId: '', // populated on first manifest fetch
        hostname: '',
      });
      // First sync, primed and persistent.
      await syncNow(true);
      onPaired();
    } catch (e) {
      Alert.alert('Pairing failed', e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  function onScan(data: string) {
    if (busy) return;
    const parsed = parseDeepLink(data);
    if (!parsed) {
      Alert.alert(
        'Not a Tusk Ledger code',
        'That QR code did not match the pairing format. Try again, or pair manually.',
      );
      return;
    }
    complete(parsed.host, parsed.port, parsed.code);
  }

  if (mode === 'scan') {
    if (!permission) {
      return (
        <SafeAreaView style={styles.center}>
          <ActivityIndicator />
        </SafeAreaView>
      );
    }
    if (!permission.granted) {
      return (
        <SafeAreaView style={[styles.container, styles.padBig]}>
          <Text style={type.h1}>Pair this phone</Text>
          <Text style={[type.body, { marginTop: space(3) }]}>
            Tusk Ledger needs camera access to scan the pairing code on your
            laptop screen. Or you can enter the code manually.
          </Text>
          <Pressable
            style={[styles.primaryButton, { marginTop: space(6) }]}
            onPress={requestPermission}>
            <Text style={styles.primaryButtonText}>Allow camera</Text>
          </Pressable>
          <Pressable
            style={[styles.linkButton, { marginTop: space(3) }]}
            onPress={() => setMode('manual')}>
            <Text style={styles.linkButtonText}>Enter code manually</Text>
          </Pressable>
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
          <View style={styles.scanFrame} />
          <Text style={[type.h2, { color: '#fff', textAlign: 'center', marginTop: space(4) }]}>
            Point at the pairing QR on your laptop
          </Text>
          <Pressable
            style={[styles.linkButton, { marginTop: space(4) }]}
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
          <Text style={type.h1}>Pair manually</Text>
          <Text style={[type.body, { marginTop: space(3) }]}>
            On your laptop, open Tusk Ledger → Settings → Pair phone, and
            type what's shown here.
          </Text>

          <Text style={[type.caption, styles.label]}>LAPTOP ADDRESS</Text>
          <TextInput
            value={manualHost}
            onChangeText={setManualHost}
            placeholder="192.168.1.42:8000"
            placeholderTextColor={colors.textFaint}
            style={styles.input}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
          />

          <Text style={[type.caption, styles.label]}>PAIRING CODE</Text>
          <TextInput
            value={manualCode}
            onChangeText={(s) => setManualCode(s.toUpperCase())}
            placeholder="ABCD2345"
            placeholderTextColor={colors.textFaint}
            style={styles.input}
            autoCapitalize="characters"
            autoCorrect={false}
          />

          <Pressable
            disabled={busy}
            style={[
              styles.primaryButton,
              { marginTop: space(6), opacity: busy ? 0.5 : 1 },
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
            {busy ? <ActivityIndicator color="#000" /> : (
              <Text style={styles.primaryButtonText}>Pair</Text>
            )}
          </Pressable>

          <Pressable
            style={[styles.linkButton, { marginTop: space(3) }]}
            onPress={() => setMode('scan')}>
            <Text style={styles.linkButtonText}>Scan a QR instead</Text>
          </Pressable>
        </ScrollView>
      </SafeAreaView>
    </KeyboardAvoidingView>
  );
}

function deviceLabel(): string {
  // Simple heuristic — Expo's Constants.deviceName is async on some
  // platforms and not worth the round-trip here. Pick something
  // identifiable enough that the laptop's "Devices" page is readable.
  const hint = Platform.OS === 'ios' ? 'iPhone' : 'Android';
  return `${hint} (${new Date().toISOString().slice(0, 10)})`;
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  center: {
    flex: 1, alignItems: 'center', justifyContent: 'center',
    backgroundColor: colors.bg,
  },
  padBig: { padding: space(6) },
  label: { marginTop: space(5), marginBottom: space(2), color: colors.textFaint },
  input: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radius.md,
    padding: space(3),
    color: colors.text,
    fontSize: 16,
  },
  primaryButton: {
    backgroundColor: colors.accent,
    paddingVertical: space(3.5),
    borderRadius: radius.md,
    alignItems: 'center',
  },
  primaryButtonText: { color: '#0e0f12', fontWeight: '700', fontSize: 16 },
  linkButton: { padding: space(3), alignItems: 'center' },
  linkButtonText: { color: colors.link, fontSize: 15 },
  scanOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: space(6),
  },
  scanFrame: {
    width: 240,
    height: 240,
    borderColor: '#fff',
    borderWidth: 3,
    borderRadius: radius.lg,
  },
  scanBusy: {
    position: 'absolute', bottom: space(20),
    alignItems: 'center',
  },
});
