/**
 * App-level UI state that isn't owned by the sync engine.
 *
 * Demo mode lives in SecureStore (it has to survive restarts and ride
 * along on every API request), but the UI shouldn't poll SecureStore
 * to know whether to show the DEMO pill — SyncBadge used to re-read it
 * on every dataVersion bump. Instead: hydrate once at app start, and
 * the Settings toggle writes both SecureStore (via sync/storage) and
 * this store, so badges update instantly without async reads.
 */
import { create } from 'zustand';
import { loadDemoMode } from '../sync/storage';

interface AppState {
  demoMode: boolean;
  setDemoMode(on: boolean): void;
  /**
   * Category drill-down handoff: Dashboard sets this then navigates to
   * the Transactions tab, which reads it as its active category filter.
   * A store field (not a navigation param) because the tabs are always
   * mounted — a param would only apply on the first navigate. Null =
   * no category filter.
   */
  txCategory: string | null;
  setTxCategory(category: string | null): void;
}

export const useAppStore = create<AppState>((set) => ({
  demoMode: false,
  setDemoMode: (demoMode) => set({ demoMode }),
  txCategory: null,
  setTxCategory: (txCategory) => set({ txCategory }),
}));

/** Read the persisted demo flag once (App.tsx calls this on launch). */
export async function hydrateDemoMode(): Promise<void> {
  try {
    const on = await loadDemoMode();
    useAppStore.getState().setDemoMode(on);
  } catch {
    // SecureStore hiccup — leave the default (off); Settings re-reads.
  }
}
