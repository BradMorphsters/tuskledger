/**
 * Insights cache — where the phone keeps the laptop-computed
 * safe-to-spend estimate and weekly digest between syncs.
 *
 * Why the `meta` key/value table and not a mirrored table: these two
 * payloads are single derived documents, not row sets. They have no
 * cursor, no primary key and no partial updates — every sync replaces
 * the whole thing. A JSON blob in `meta` gives us offline rendering on
 * cold launch without a SCHEMA_VERSION bump (which would drop and
 * recreate every mirrored table on the user's phone).
 *
 * The Zustand store is the in-memory view for screens; `hydrateInsights`
 * fills it from SQLite at boot, and `storeInsights` writes both.
 */
import { create } from 'zustand';
import { getMeta, setMeta } from '../db/sqlite';
import type { InsightsResponse } from '../sync/types';

const META_KEY = 'insights_v1';

interface InsightsState {
  insights: InsightsResponse | null;
  setInsights(i: InsightsResponse | null): void;
}

export const useInsightsStore = create<InsightsState>((set) => ({
  insights: null,
  setInsights: (insights) => set({ insights }),
}));

/** Persist + publish a fresh payload from /api/mobile/insights. */
export async function storeInsights(payload: InsightsResponse): Promise<void> {
  useInsightsStore.getState().setInsights(payload);
  try {
    await setMeta(META_KEY, JSON.stringify(payload));
  } catch {
    // Non-fatal: the in-memory copy still serves this session.
  }
}

/** Load the last payload from SQLite so cards render before the first
 *  sync of the session lands (and while offline). */
export async function hydrateInsights(): Promise<void> {
  try {
    const raw = await getMeta(META_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as InsightsResponse;
    if (parsed && parsed.safe_to_spend && parsed.weekly_digest) {
      useInsightsStore.getState().setInsights(parsed);
    }
  } catch {
    // Corrupt or missing — leave null; the next sync repopulates.
  }
}

/** Forget the cached payload (unpair / 401 wipe / resync from scratch). */
export async function clearInsights(): Promise<void> {
  useInsightsStore.getState().setInsights(null);
  try {
    await setMeta(META_KEY, '');
  } catch {
    // ignore
  }
}
