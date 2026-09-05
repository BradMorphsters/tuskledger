/**
 * Alert scheduler — runs after every successful sync.
 *
 *   1. Is the user opted in? (Settings → Alerts; off by default, stored
 *      in the SQLite meta table so it survives cold launches.)
 *   2. Gather inputs from the mirror + cached insights.
 *   3. buildAlerts() → dedupeAlerts() against the persisted fired-key
 *      ledger so each event notifies once.
 *   4. Present the fresh ones as local notifications, capped per run so
 *      a first sync after a long gap doesn't dump a dozen banners.
 *
 * Everything is best-effort: any failure is swallowed (sync must never
 * fail because a notification couldn't be shown).
 */
import { getMeta, setMeta } from '../db/sqlite';
import { budgetProgress, upcomingBills } from '../db/queries';
import { useInsightsStore } from '../insights/store';
import { presentNow } from './notify';
import { buildAlerts, dedupeAlerts, type Alert, type AlertInputs } from './rules';

const META_ENABLED = 'alerts_enabled';
const META_FIRED = 'alerts_fired_v1';
const MAX_PER_RUN = 4;

export async function alertsEnabled(): Promise<boolean> {
  try {
    return (await getMeta(META_ENABLED)) === 'on';
  } catch {
    return false;
  }
}

export async function setAlertsEnabled(on: boolean): Promise<void> {
  await setMeta(META_ENABLED, on ? 'on' : 'off');
}

function localToday(now = new Date()): { today: string; weekday: number } {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return { today: `${y}-${m}-${d}`, weekday: now.getDay() };
}

async function loadFired(): Promise<Record<string, string>> {
  try {
    const raw = await getMeta(META_FIRED);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

/** Assemble rule inputs from the mirror and the cached insights. */
export async function collectAlertInputs(now = new Date()): Promise<AlertInputs> {
  const { today, weekday } = localToday(now);
  const [bills, budget] = await Promise.all([upcomingBills(20), budgetProgress()]);
  const insights = useInsightsStore.getState().insights;
  const digest = insights?.weekly_digest ?? null;
  return {
    today,
    weekday,
    bills: bills.map((b) => ({
      id: b.id,
      account_name: b.account_name,
      kind: b.kind,
      due_date: b.due_date,
      days_until: b.days_until,
      amount: b.amount,
    })),
    budget: budget
      ? {
          month: budget.month,
          year: budget.year,
          rows: budget.rows.map((r) => ({
            category: r.category,
            limit_amount: r.limit_amount,
            spent: r.spent,
          })),
        }
      : null,
    largeTransactions: digest?.notable.large_transactions ?? [],
    priceHikes: digest?.notable.price_hikes ?? [],
    digestWeekEnd: digest?.week_end ?? null,
  };
}

/**
 * Evaluate rules and present anything new. Returns the alerts actually
 * presented (useful for a Settings "test" row and for debugging).
 */
export async function runAlertsAfterSync(): Promise<Alert[]> {
  try {
    if (!(await alertsEnabled())) return [];
    const inputs = await collectAlertInputs();
    const candidates = buildAlerts(inputs);
    const { fresh, fired } = dedupeAlerts(candidates, await loadFired(), inputs.today);
    // Persist the ledger BEFORE presenting so a crash mid-loop can't
    // re-fire the same batch next sync.
    await setMeta(META_FIRED, JSON.stringify(fired));
    const shown: Alert[] = [];
    for (const a of fresh.slice(0, MAX_PER_RUN)) {
      if (await presentNow(a.title, a.body, { kind: a.kind, key: a.key })) shown.push(a);
    }
    return shown;
  } catch (e) {
    if (__DEV__) console.warn('[alerts] run failed:', e);
    return [];
  }
}

/** Forget the fired-key ledger (unpair / resync from scratch). */
export async function clearAlertLedger(): Promise<void> {
  try {
    await setMeta(META_FIRED, '');
  } catch {
    // ignore
  }
}
