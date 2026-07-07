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
import { applySync, getMeta, resetMirror, setMeta } from '../db/sqlite';
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
import { clearSnapshot, publishSnapshot } from '../widget/snapshot';

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
const META_LAST_SYNCED_AT = 'last_synced_at';

/** Persist the last successful sync time to the SQLite meta table so it
 *  survives cold launches (Zustand state is memory-only). */
async function saveLastSyncedAt(iso: string): Promise<void> {
  try {
    await setMeta(META_LAST_SYNCED_AT, iso);
  } catch {
    // Non-fatal — the in-memory store still has it for this session.
  }
}

/**
 * Hydrate `lastSyncedAt` from the SQLite meta table at boot so the
 * staleness banner and Settings "Last synced" reflect prior sessions
 * instead of always showing "Not synced yet" on a cold launch.
 */
export async function hydrateLastSyncedAt(): Promise<void> {
  try {
    const iso = await getMeta(META_LAST_SYNCED_AT);
    if (iso) useSyncStore.getState().setLastSynced(iso);
  } catch {
    // Non-fatal — first launch or read failure leaves it null.
  }
}

/**
 * Sync now. Returns the same promise across overlapping calls.
 *
 * `force=true` is a "Resync from scratch" — wipes the local mirror
 * and pulls everything. Used by the Settings button. Default `false`
 * does an incremental delta from the persisted cursor.
 */
export async function syncNow(force = false): Promise<void> {
  if (inflight) {
    // A non-forced call can safely piggyback on whatever is already
    // running. But a forced "Resync from scratch" / demo toggle just
    // wiped the mirror and MUST do a full pull — returning the inflight
    // incremental sync would leave the wiped mirror holding only a
    // delta. Chain a forced sync after the current one settles so it
    // runs against a clean single-flight slot.
    if (!force) return inflight;
    return inflight.then(
      () => syncNow(true),
      () => syncNow(true),
    );
  }
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
      let lastRowUpdatedAt: string | null = null;
      let drained = false;
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
            budgets: resp.budgets,
            upcomingBills: resp.upcoming_bills,
          },
        );
        highwater = resp.server_time;
        // Track the last processed row's updated_at so that, if we bail
        // out on MAX_PAGES_PER_SYNC with a backlog still pending, we can
        // resume from where we stopped instead of jumping to server_time.
        const last = resp.transactions[resp.transactions.length - 1];
        if (last?.updated_at != null) {
          lastRowUpdatedAt = last.updated_at;
        }
        store.bumpVersion();
        isFirstPage = false;
        if (!resp.has_more) {
          drained = true;
          break;
        }
        // Advance the page cursor only when updated_at is present.
        // If updated_at is null, leave `since` unchanged — re-serving
        // the same page is safe because applySync upserts.
        if (last?.updated_at != null) {
          since = last.updated_at;
        }
      }
      // Persist the cursor once, after the loop ends (fully drained OR
      // bailed at MAX_PAGES_PER_SYNC) — never mid-loop, since a failure
      // on a later page would permanently skip unsynced pages because
      // the cursor already advanced.
      //
      // Only advance to server_time when the backlog is fully drained
      // (loop ended with has_more === false). If we bailed at
      // MAX_PAGES_PER_SYNC with has_more still true, persisting
      // server_time would skip every unfetched page forever — instead
      // resume from the last processed row's updated_at so the next
      // sync picks up the remaining backlog.
      if (drained) {
        if (highwater !== null) {
          await saveCursor(highwater);
        }
      } else if (lastRowUpdatedAt !== null) {
        await saveCursor(lastRowUpdatedAt);
      }
      const syncedAt = new Date().toISOString();
      await saveLastSyncedAt(syncedAt);
      store.setLastSynced(syncedAt);
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
        // Clear the widget's App Group snapshot too — otherwise the
        // home-screen widget keeps rendering the last real balances
        // after the token was revoked and the mirror wiped.
        await clearSnapshot();
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
