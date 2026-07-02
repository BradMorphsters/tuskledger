/**
 * Widget snapshot — the small precomputed payload the iOS home-screen
 * widget reads on every render.
 *
 * The widget extension runs in its own process and can't reach into
 * the React Native runtime or the SQLite mirror directly. So every
 * time the phone finishes a sync, we:
 *
 *   1. compute a flat JSON snapshot from local SQLite (cheap, ~ms),
 *   2. write it to UserDefaults inside the shared App Group container
 *      via the `widget-bridge` native module, and
 *   3. tell WidgetKit to reload all timelines so the widget picks the
 *      new snapshot up immediately.
 *
 * The widget falls back to a baked-in placeholder when nothing is in
 * the container yet (fresh install, never paired) so the widget
 * gallery still has something to show.
 *
 * The shape here MUST match the `WidgetSnapshot` Codable struct on
 * the Swift side (mobile/targets/widget/Snapshot.swift). Keep them
 * in sync — adding a field on one side without the other will not
 * crash but the new field will silently fail to render.
 */
import { AccountRow, currentMonthSummary, listAccounts } from '../db/queries';
// Relative import: the native side of this local Expo module is autolinked
// from modules/, but Metro can't resolve the bare 'widget-bridge' name
// without a node_modules entry — so import the JS entry directly.
import * as WidgetBridge from '../../modules/widget-bridge/src/index';

export interface CashAccountSnapshot {
  id: number;
  displayName: string;
  institutionName: string | null;
  mask: string | null;
  balance: number;
}

export interface WidgetSnapshot {
  /** ISO timestamp of when this snapshot was generated. */
  updatedAt: string;
  netCashMtd: {
    income: number;
    spending: number;
    net: number;
    transactionCount: number;
  };
  /** Depository accounts sorted by current_balance descending. */
  cashAccounts: CashAccountSnapshot[];
  /** Sum of cashAccounts[].balance — precomputed so the widget doesn't iterate. */
  totalCash: number;
}

/**
 * "Cash" matches the dashboard's depository bucket (checking +
 * savings + money market + CD). The web `CashBalances` tile is
 * checking-only because its job is bill-bounce alerts; the widget
 * is broader because a glance at the lock screen wants total liquid
 * cash across all banking accounts, not just one subtype.
 */
function isCashAccount(a: AccountRow): boolean {
  return (a.type || '').toLowerCase() === 'depository';
}

export async function buildSnapshot(): Promise<WidgetSnapshot> {
  const [allAccounts, summary] = await Promise.all([
    listAccounts(),
    currentMonthSummary(),
  ]);

  const cashAccounts: CashAccountSnapshot[] = allAccounts
    .filter(isCashAccount)
    .map((a) => ({
      id: a.id,
      displayName: a.custom_name || a.name,
      institutionName: a.institution_name,
      mask: a.mask,
      balance: a.current_balance ?? 0,
    }))
    .sort((x, y) => y.balance - x.balance);

  const totalCash = cashAccounts.reduce((s, a) => s + a.balance, 0);

  return {
    updatedAt: new Date().toISOString(),
    netCashMtd: summary,
    cashAccounts,
    totalCash,
  };
}

/**
 * Persist the latest snapshot to the App Group container and reload
 * widget timelines. Best-effort: any failure is swallowed so the
 * sync never fails because the widget couldn't refresh.
 *
 * Common failure modes that are fine to ignore here:
 *   - Running in Expo Go (the widget-bridge native module isn't
 *     present, so requireNativeModule throws on first use).
 *   - App Group entitlement missing (only happens during initial
 *     bring-up before the first signed dev build).
 */
export async function publishSnapshot(): Promise<void> {
  try {
    const snapshot = await buildSnapshot();
    await WidgetBridge.writeSnapshot(JSON.stringify(snapshot));
    await WidgetBridge.reloadAll();
  } catch (e) {
    // Non-critical — surface to console but never to the user
    if (__DEV__) console.warn('[widget] publishSnapshot failed:', e);
  }
}

/**
 * Clear the App Group snapshot so the home-screen widget stops showing
 * real balances after an unpair or a 401 token-revoke wipe. Without
 * this the widget keeps rendering the last-published snapshot — real
 * cash totals — indefinitely, because the snapshot is only ever
 * overwritten on a *successful* sync (which no longer happens once
 * we're unpaired).
 *
 * Writing an empty string makes the Swift side fall back to its baked-in
 * placeholder (same path as a fresh, never-paired install). Best-effort:
 * any failure is swallowed for the same reasons publishSnapshot swallows.
 */
export async function clearSnapshot(): Promise<void> {
  try {
    await WidgetBridge.writeSnapshot('');
    await WidgetBridge.reloadAll();
  } catch (e) {
    if (__DEV__) console.warn('[widget] clearSnapshot failed:', e);
  }
}
