/**
 * Persistent state living *outside* the SQLite mirror.
 *
 * What goes here vs. SQLite:
 *   - Secrets (the device token) → SecureStore. iOS Keychain-backed,
 *     wiped on app delete, encrypted at rest. SQLite is convenient
 *     but not the right place for a bearer token.
 *   - Cursor + paired host metadata → SecureStore too, since they
 *     directly identify the laptop and pair with the token. Keeping
 *     them together means "unpair" is one wipe call.
 *   - Mirrored finance data → SQLite (see db/sqlite.ts). Reads are
 *     hot and need indexes; SecureStore is key/value and slow.
 */
import * as SecureStore from 'expo-secure-store';
import type { PairedHost } from './types';

const KEY_TOKEN = 'tuskledger_device_token';
const KEY_HOST = 'tuskledger_paired_host';
const KEY_CURSOR = 'tuskledger_sync_cursor';
const KEY_DEMO_MODE = 'tuskledger_demo_mode';

export async function saveToken(token: string): Promise<void> {
  await SecureStore.setItemAsync(KEY_TOKEN, token);
}

export async function loadToken(): Promise<string | null> {
  return SecureStore.getItemAsync(KEY_TOKEN);
}

export async function savePairedHost(host: PairedHost): Promise<void> {
  await SecureStore.setItemAsync(KEY_HOST, JSON.stringify(host));
}

export async function loadPairedHost(): Promise<PairedHost | null> {
  const raw = await SecureStore.getItemAsync(KEY_HOST);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as PairedHost;
  } catch {
    // Corrupt blob — wipe so we don't keep failing.
    await SecureStore.deleteItemAsync(KEY_HOST);
    return null;
  }
}

export async function saveCursor(cursor: string): Promise<void> {
  await SecureStore.setItemAsync(KEY_CURSOR, cursor);
}

export async function loadCursor(): Promise<string | null> {
  return SecureStore.getItemAsync(KEY_CURSOR);
}

/**
 * Demo mode: when on, the phone sends a `fintrack_mode=demo` cookie on
 * every /api/mobile/* request, which makes the laptop serve from its
 * synthetic demo database (12 months of Alex Carter data) instead of
 * the user's real Plaid-synced data. Useful for screenshots and demos
 * without exposing real balances.
 *
 * Stored as the string 'on' / 'off' (or absent → off) so the value
 * survives across app reinstalls of the same SecureStore namespace.
 */
export async function setDemoMode(on: boolean): Promise<void> {
  await SecureStore.setItemAsync(KEY_DEMO_MODE, on ? 'on' : 'off');
}

export async function loadDemoMode(): Promise<boolean> {
  return (await SecureStore.getItemAsync(KEY_DEMO_MODE)) === 'on';
}

/**
 * Wipe everything we know about the paired laptop. Used by the
 * "Unpair" button in Settings, and by the sync engine when it gets
 * a 401 (token revoked from the laptop side).
 *
 * Does NOT wipe the SQLite mirror — that's `db.resetMirror()`.
 * Splitting the two lets us choose whether to keep a stale read-only
 * copy of the data after unpair (we don't, but the choice is local
 * to the call site).
 */
export async function clearAllPairing(): Promise<void> {
  await Promise.all([
    SecureStore.deleteItemAsync(KEY_TOKEN),
    SecureStore.deleteItemAsync(KEY_HOST),
    SecureStore.deleteItemAsync(KEY_CURSOR),
    SecureStore.deleteItemAsync(KEY_DEMO_MODE),
  ]);
}
