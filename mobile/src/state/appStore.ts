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
}

export const useAppStore = create<AppState>((set) => ({
  demoMode: false,
  setDemoMode: (demoMode) => set({ demoMode }),
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
