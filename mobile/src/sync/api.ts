/**
 * HTTP client for /api/mobile/*.
 *
 * Two flavors of fetch wrapper:
 *   - `pairFetch(baseUrl, ...)`: unauthenticated, used during pairing
 *     (POST /pair/claim). The phone has no token yet at this point.
 *   - `mobileFetch(...)`: authenticated, attaches X-Device-Token from
 *     SecureStore and reads `baseUrl` from the paired-host record.
 *     Throws `AuthError` on 401 so the SyncManager knows to wipe and
 *     prompt re-pair.
 *
 * Timeouts: 8s for sync (large LAN response, but a non-responsive
 * server should give up quickly so we surface "offline" in the UI).
 */
import { loadDemoMode, loadPairedHost, loadToken } from './storage';
import type {
  ManifestResponse,
  PairClaimResponse,
  SyncResponse,
} from './types';

export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthError';
  }
}

export class NetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NetworkError';
  }
}

const DEFAULT_TIMEOUT_MS = 8000;

async function fetchWithTimeout(
  input: RequestInfo,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<Response> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, ...rest } = init;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(input, { ...rest, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

export async function pairClaim(
  baseUrl: string,
  code: string,
  label: string,
): Promise<PairClaimResponse> {
  let res: Response;
  try {
    res = await fetchWithTimeout(`${baseUrl}/api/mobile/pair/claim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, label }),
      timeoutMs: 6000,
    });
  } catch (e) {
    throw new NetworkError(
      `Couldn't reach ${baseUrl}. Are you on the same Wi-Fi as the laptop?`,
    );
  }
  if (res.status === 404) {
    throw new Error('Pairing code not recognized. Try generating a fresh one on the laptop.');
  }
  if (res.status === 410) {
    throw new Error('Pairing code expired. Generate a fresh one on the laptop.');
  }
  if (!res.ok) {
    throw new Error(`Pair claim failed (${res.status}).`);
  }
  return (await res.json()) as PairClaimResponse;
}

async function authedFetch(
  path: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<Response> {
  const [host, token, demoMode] = await Promise.all([
    loadPairedHost(),
    loadToken(),
    loadDemoMode(),
  ]);
  if (!host || !token) {
    throw new AuthError('No paired laptop. Run pairing first.');
  }
  // Demo mode: send the same fintrack_mode=demo cookie the laptop's web
  // UI uses to flip into demo mode. The backend's get_db dependency
  // reads this and serves from tuskledger_demo.db. Token auth is
  // unaffected — require_device_token always uses get_real_db.
  const headers: Record<string, string> = {
    ...((init.headers as Record<string, string>) || {}),
    'X-Device-Token': token,
  };
  if (demoMode) {
    headers.Cookie = 'fintrack_mode=demo';
  }
  let res: Response;
  try {
    res = await fetchWithTimeout(`${host.baseUrl}${path}`, {
      ...init,
      headers,
    });
  } catch (e) {
    throw new NetworkError("Can't reach the laptop right now.");
  }
  if (res.status === 401) {
    throw new AuthError('Device token rejected. Re-pair this phone.');
  }
  return res;
}

export async function fetchManifest(): Promise<ManifestResponse> {
  const res = await authedFetch('/api/mobile/manifest', { timeoutMs: 4000 });
  if (!res.ok) throw new Error(`Manifest failed (${res.status}).`);
  return (await res.json()) as ManifestResponse;
}

export async function fetchSync(opts: {
  since: string | null;
  full?: boolean;
}): Promise<SyncResponse> {
  const params = new URLSearchParams();
  if (opts.full) params.set('full', 'true');
  else if (opts.since) params.set('since', opts.since);
  const res = await authedFetch(`/api/mobile/sync?${params.toString()}`);
  if (!res.ok) throw new Error(`Sync failed (${res.status}).`);
  return (await res.json()) as SyncResponse;
}

/**
 * Unauthenticated probe used by the manual-host setup screen — given
 * a base URL the user typed in, see if there's a Tusk Ledger on the
 * other end. Doesn't touch the device-token codepath because the
 * user might be probing a DIFFERENT laptop than the one they're
 * currently paired with.
 */
export async function probeHost(baseUrl: string): Promise<boolean> {
  try {
    const res = await fetchWithTimeout(`${baseUrl}/api/health`, {
      timeoutMs: 3000,
    });
    if (!res.ok) return false;
    const body = await res.json();
    return body && typeof body === 'object' && 'app' in body;
  } catch {
    return false;
  }
}
