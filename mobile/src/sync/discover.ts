/**
 * Bonjour discovery on the phone.
 *
 * What this fixes: phones cache the laptop's IP at pair time. If the
 * router hands the laptop a different IP later (DHCP lease expired,
 * Mac rebooted, joined a different network briefly), the phone will
 * sit on "Offline" until the user re-pairs manually. mDNS lets us
 * find the laptop by service name, IP-agnostic.
 *
 * Why this is gated behind a runtime require() instead of an import:
 * react-native-zeroconf is a native module. It works in development
 * builds (`eas build --profile development`) and in TestFlight/release
 * builds, but **not in Expo Go** — Expo Go's bundled native modules
 * don't include it, and importing it crashes the JS runtime. Wrapping
 * the require() in a try/catch lets the same source code work in
 * both environments — Expo Go gets a no-op stub, dev builds get
 * real discovery.
 *
 * When discovery succeeds AND the discovered host's `host_id` matches
 * the one cached at pair time, we silently update the stored baseUrl.
 * If the host_id mismatches, we DON'T update — that's a different
 * Tusk Ledger install (e.g. someone else's laptop, or the user
 * rotated their SESSION_SECRET) and the phone should keep pointing
 * at the original.
 */
import { fetchManifest } from './api';
import { loadPairedHost, savePairedHost } from './storage';

interface ZeroconfService {
  name: string;
  fullName: string;
  host: string;       // hostname.local.
  addresses: string[]; // IPv4 / v6
  port: number;
  txt?: Record<string, string>;
}

interface ZeroconfModule {
  on(event: 'resolved', cb: (svc: ZeroconfService) => void): void;
  on(event: 'error', cb: (err: Error) => void): void;
  removeAllListeners(): void;
  scan(type: string, protocol: string, domain: string): void;
  stop(): void;
}

let _zeroconf: ZeroconfModule | null = null;
let _attempted = false;

/**
 * Lazy-load the native module. Returns null in environments where
 * it's not available (Expo Go, web). Idempotent — caches the result
 * (success or failure) so we don't pay the require() cost twice.
 */
function getZeroconf(): ZeroconfModule | null {
  if (_attempted) return _zeroconf;
  _attempted = true;
  try {
    // Optional dep — eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('react-native-zeroconf');
    const Z = mod.default || mod;
    _zeroconf = new Z();
  } catch {
    // Either the package isn't installed (Expo Go) or it's installed
    // but the native side isn't linked (rebuild needed). Either way,
    // discovery is a nice-to-have, not a requirement.
    _zeroconf = null;
  }
  return _zeroconf;
}

/**
 * Browse for _tuskledger._tcp.local. for `timeoutMs`, returning the
 * first service whose host_id (TXT record) matches the one we paired
 * with. Resolves to null if nothing matches in time, or if the native
 * module isn't available.
 */
export async function discoverPairedHost(
  timeoutMs = 4000,
): Promise<ZeroconfService | null> {
  const zc = getZeroconf();
  const cachedHost = await loadPairedHost();
  if (!zc || !cachedHost?.hostId) return null;

  return new Promise((resolve) => {
    let done = false;
    const finish = (result: ZeroconfService | null) => {
      if (done) return;
      done = true;
      try {
        zc.removeAllListeners();
        zc.stop();
      } catch {
        // already stopped, fine
      }
      resolve(result);
    };

    zc.on('resolved', (svc: ZeroconfService) => {
      const advertisedHostId = svc.txt?.host_id;
      // Don't accept a service that lacks a host_id — that's not a
      // genuine Tusk Ledger advertisement, it's something else
      // squatting on the same service type.
      if (!advertisedHostId) return;
      if (advertisedHostId !== cachedHost.hostId) {
        // Different install — could be a roommate's Tusk Ledger.
        // Ignore and keep scanning.
        return;
      }
      finish(svc);
    });
    zc.on('error', () => finish(null));

    try {
      zc.scan('tuskledger', 'tcp', 'local.');
    } catch {
      finish(null);
      return;
    }
    setTimeout(() => finish(null), timeoutMs);
  });
}

/**
 * Try to discover the paired laptop and silently update the cached
 * baseUrl if its IP has moved. Called on app foreground BEFORE the
 * sync runs, so a stale IP doesn't cause a phantom "offline" state.
 *
 * Returns true if a swap happened (callers can use this to log /
 * surface a tiny "rediscovered" indicator if desired). Returns false
 * if discovery wasn't possible OR the cached IP was already correct.
 *
 * Two safety checks before swapping:
 *   1. The discovered service's host_id must match the cached one
 *      (handled in discoverPairedHost).
 *   2. After updating the baseUrl, fetch /manifest with the new URL
 *      AND the existing token. If the manifest call fails, revert
 *      the swap — we caught a different host_id matching by collision,
 *      or the new IP was for a brief moment and is already gone.
 */
export async function rediscoverIfNeeded(): Promise<boolean> {
  const cached = await loadPairedHost();
  if (!cached) return false;

  const svc = await discoverPairedHost();
  if (!svc) return false;

  const ipv4 = svc.addresses.find((a) => /^\d+\.\d+\.\d+\.\d+$/.test(a));
  if (!ipv4) return false;
  const candidateBaseUrl = `http://${ipv4}:${svc.port}`;
  if (candidateBaseUrl === cached.baseUrl) return false;

  // Speculative update — try the manifest with the new URL. If it
  // succeeds, keep the swap. If not, restore the old one.
  const speculative = { ...cached, baseUrl: candidateBaseUrl };
  await savePairedHost(speculative);
  try {
    const m = await fetchManifest();
    if (m.host_id !== cached.hostId) {
      throw new Error('host_id changed mid-flight');
    }
    return true;
  } catch {
    await savePairedHost(cached);
    return false;
  }
}
