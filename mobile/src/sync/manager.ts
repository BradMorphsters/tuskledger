/**
 * SyncManager — single source of truth for "is the phone caught up?"
 *
 * Responsibilities:
 *   - Run sync on demand and on a periodic timer.
 *   - Persist the cursor between calls.
 *   - Translate transport errors into a coherent UI state
 *     (idle / syncing / offline / error / unauthed).
 *   - Drain `has_more` follow-ups so a single sync() call brings the
 *     phone fully up to date even if the backlog spans multiple pages.
 *
 * Concurrency: a single-flight guard prevents overlapping syncs. If
 * the user pulls to refresh while a periodic sync is running, the
 * second call no-ops and resolves with the in-progress promise.
 *
 * Subscribe via the Zustand store in src/state/store.ts; this module
 * just calls back into the store on transitions.
 */
import { create } from 'zustand';
import { applySync, resetMirror } from '../db/sqlite';
import {
  AuthError,
  fetchSync,
  NetworkError,
} from './api';
import {
  clearAllPairing,
  loadCursor,
  loadPairedHost,
  loadToken,
  saveCursor,
} from './storage';
import { publishSnapshot } from '../widget/snapshot';

export type SyncStatus =
  | 'idle'
  | 'syncing'
  | 'offline'
  | 'error'
  | 'unauthed'
  | 'unpaired';

interface SyncState {
  status: SyncStatus;
  /** Last successful sync time (ISO). null until the first one lands. */
  lastSyncedAt: string | null;
  /** Latest error message — surfaced on the Settings screen. */
  lastError: string | null;
  /** Bumped every applySync() so screens can invalidate their data. */
  dataVersion: number;

  setStatus(s: SyncStatus): void;
  bumpVersion(): void;
  setError(e: string | null): void;
  setLastSynced(iso: string | null): void;
}

export const useSyncStore = create<SyncState>((set) => ({
  status: 'idle',
  lastSyncedAt: null,
  lastError: null,
  dataVersion: 0,
  setStatus: (status) => set({ status }),
  bumpVersion: () => set((s) => ({ dataVersion: s.dataVersion + 1 })),
  setError: (lastError) => set({ lastError }),
  setLastSynced: (lastSyncedAt) => set({ lastSyncedAt }),
}));

let inflight: Promise<void> | null = null;
let periodicHandle: ReturnType<typeof setInterval> | null = null;

const PERIODIC_INTERVAL_MS = 5 * 60_000; // 5 minutes
const MAX_PAGES_PER_SYNC = 10; // safety stop on runaway has_more loops

/**
 * Sync now. Returns the same promise across overlapping calls.
 *
 * `force=true` is a "Resync from scratch" — wipes the local mirror
 * and pulls everything. Used by the Settings button. Default `false`
 * does an incremental delta from the persisted cursor.
 */
export async function syncNow(force = false): Promise<void> {
  if (inflight) return inflight;
  inflight = (async () => {
    const store = useSyncStore.getState();
    const [host, token] = await Promise.all([loadPairedHost(), loadToken()]);
    if (!host || !token) {
      store.setStatus('unpaired');
      return;
    }
    store.setStatus('syncing');
    store.setError(null);
    try {
      let since = force ? null : await loadCursor();
      let isFirstPage = true;
      let highwater: string | null = null;
      for (let page = 0; page < MAX_PAGES_PER_SYNC; page++) {
        const resp = await fetchSync({
          since,
          full: force && isFirstPage ? true : undefined,
        });
        await applySync(
          resp.accounts,
          resp.transactions,
          // Only the FIRST page of a forced sync wipes — subsequent
          // pages just upsert into the freshly-cleared mirror.
          resp.full && isFirstPage,
          {
            // Optional fields — present only on backends with
            // schema_version >= 2. Older backends omit them and
            // these arrays are simply empty.
            securities: resp.securities,
            holdings: resp.holdings,
            netWorthSnapshots: resp.net_worth_snapshots,
            manualAssets: resp.manual_assets,
          },
        );
        highwater = resp.server_time;
        store.bumpVersion();
        isFirstPage = false;
        if (!resp.has_more) break;
        // Advance the page cursor only when updated_at is present.
        // If updated_at is null, leave `since` unchanged — re-serving
        // the same page is safe because applySync upserts.
        const last = resp.transactions[resp.transactions.length - 1];
        if (last?.updated_at != null) {
          since = last.updated_at;
        }
      }
      // Persist the cursor once, after all pages land successfully.
      // Saving mid-loop means a failure on a later page permanently
      // skips unsynced pages because the cursor already advanced.
      if (highwater !== null) {
        await saveCursor(highwater);
      }
      store.setLastSynced(new Date().toISOString());
      store.setStatus('idle');
      // Best-effort widget update — publishSnapshot already swallows
      // all errors internally, so this never fails a successful sync.
      publishSnapshot();
    } catch (e) {
      if (e instanceof AuthError) {
        // Token revoked or unrecognized — wipe and prompt re-pair.
        // Wiping the mirror too because keeping stale data after an
        // unpair is confusing ("why am I still seeing transactions
        // when the laptop says I'm not paired?").
        await clearAllPairing();
        await resetMirror();
        store.setStatus('unauthed');
        store.setError(e.message);
        store.bumpVersion();
      } else if (e instanceof NetworkError) {
        store.setStatus('offline');
        store.setError(e.message);
      } else {
        store.setStatus('error');
        store.setError(e instanceof Error ? e.message : String(e));
      }
    }
  })();
  try {
    await inflight;
  } finally {
    inflight = null;
  }
}

/**
 * Start the periodic timer. Idempotent. Stop on app background to
 * avoid racing iOS's BGTaskScheduler — we re-trigger on foreground.
 */
export function startPeriodicSync(): void {
  if (periodicHandle) return;
  periodicHandle = setInterval(() => {
    syncNow().catch(() => {
      // syncNow already reports through the store; swallow here so
      // the interval doesn't crash on unhandled rejections.
    });
  }, PERIODIC_INTERVAL_MS);
}

export function stopPeriodicSync(): void {
  if (periodicHandle) {
    clearInterval(periodicHandle);
    periodicHandle = null;
  }
}
