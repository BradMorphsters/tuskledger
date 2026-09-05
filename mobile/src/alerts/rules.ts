/**
 * Alert rules — the phone's "say something when it matters" layer.
 *
 * The phone already holds everything needed to notice these moments
 * (mirrored bills, budgets, transactions, and the laptop-computed
 * insights). This module turns that data into a short list of alerts at
 * sync time. It is a pure function of its inputs so it can be tested in
 * plain Node (scripts/test-alerts.mjs) and so the scheduler stays thin.
 *
 * Every alert carries a `key` that is stable across syncs for the SAME
 * underlying event (a given bill on a given due date, a given budget line
 * crossing a given tier in a given month, a given transaction id). The
 * scheduler persists fired keys, so an alert is delivered once even
 * though sync runs every five minutes.
 *
 * Rules
 *   bill-due        a mirrored bill is due today or tomorrow (or overdue)
 *   budget-tier     a budget line crossed 80% or 100% of its limit
 *   large-charge    an unusually large charge appeared this week (the
 *                   laptop's own detection via the weekly digest — we
 *                   don't re-derive the statistic on the phone)
 *   price-hike      a recurring charge came in well above its usual amount
 *   digest-ready    first sync on/after the digest day (Sunday) — "your
 *                   week in review is ready"
 *
 * Nothing here has side effects and nothing formats real balances into
 * the notification body beyond the specific amounts the rule is about.
 */

export interface AlertInputBill {
  id: string;
  account_name: string;
  kind: string;
  due_date: string; // YYYY-MM-DD
  days_until: number;
  amount: number | null;
}

export interface AlertInputBudgetRow {
  category: string;
  limit_amount: number;
  spent: number;
}

export interface AlertInputLargeTxn {
  merchant: string;
  date: string;
  amount: number;
  typical_amount: number;
}

export interface AlertInputPriceHike {
  merchant: string;
  latest_amount: number;
  typical_amount: number;
  delta_pct: number;
}

export interface AlertInputs {
  /** Local calendar date of "now" (YYYY-MM-DD). */
  today: string;
  /** 0 = Sunday … 6 = Saturday, for `today`. */
  weekday: number;
  bills: AlertInputBill[];
  /** Current-month budget lines with spent computed locally. */
  budget: { month: number; year: number; rows: AlertInputBudgetRow[] } | null;
  largeTransactions: AlertInputLargeTxn[];
  priceHikes: AlertInputPriceHike[];
  /** week_end of the cached digest, if any (YYYY-MM-DD). */
  digestWeekEnd: string | null;
}

export type AlertKind = 'bill-due' | 'budget-tier' | 'large-charge' | 'price-hike' | 'digest-ready';

export interface Alert {
  key: string;
  kind: AlertKind;
  title: string;
  body: string;
}

/** Digest day: Sunday. The laptop's DigestNotifier uses the same anchor. */
export const DIGEST_WEEKDAY = 0;

function money(n: number): string {
  const sign = n < 0 ? '-' : '';
  return sign + '$' + Math.abs(n).toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  });
}

function kindLabel(kind: string): string {
  return kind === 'mortgage' ? 'Mortgage' : kind === 'credit_card' ? 'Card payment' : 'Bill';
}

export function buildAlerts(input: AlertInputs): Alert[] {
  const out: Alert[] = [];

  // ── Bills: overdue, due today, due tomorrow ──────────────────────
  for (const b of input.bills) {
    if (b.days_until > 1) continue;
    const amt = b.amount != null ? ` · ${money(b.amount)}` : '';
    let title: string;
    if (b.days_until < 0) title = `${kindLabel(b.kind)} overdue`;
    else if (b.days_until === 0) title = `${kindLabel(b.kind)} due today`;
    else title = `${kindLabel(b.kind)} due tomorrow`;
    out.push({
      key: `bill:${b.id}:${b.due_date}:${b.days_until < 0 ? 'overdue' : b.days_until}`,
      kind: 'bill-due',
      title,
      body: `${b.account_name}${amt}`,
    });
  }

  // ── Budget tiers: 80% and 100% of a line's limit ────────────────
  if (input.budget) {
    const { month, year, rows } = input.budget;
    for (const r of rows) {
      if (r.limit_amount <= 0) continue;
      const pct = r.spent / r.limit_amount;
      if (pct >= 1) {
        out.push({
          key: `budget:${year}-${month}:${r.category}:100`,
          kind: 'budget-tier',
          title: `${r.category} budget spent`,
          body: `${money(r.spent)} of ${money(r.limit_amount)} — ${money(r.spent - r.limit_amount)} over.`,
        });
      } else if (pct >= 0.8) {
        out.push({
          key: `budget:${year}-${month}:${r.category}:80`,
          kind: 'budget-tier',
          title: `${r.category} at ${Math.round(pct * 100)}% of budget`,
          body: `${money(r.limit_amount - r.spent)} left this month.`,
        });
      }
    }
  }

  // ── Unusually large charges (laptop-detected) ───────────────────
  for (const t of input.largeTransactions) {
    out.push({
      key: `large:${t.merchant}:${t.date}:${t.amount}`,
      kind: 'large-charge',
      title: `Unusually large charge at ${t.merchant}`,
      body: `${money(t.amount)} · usually about ${money(t.typical_amount)}.`,
    });
  }

  // ── Possible price hikes on recurring charges ───────────────────
  for (const p of input.priceHikes) {
    out.push({
      key: `hike:${p.merchant}:${p.latest_amount}`,
      kind: 'price-hike',
      title: `${p.merchant} charged more than usual`,
      body: `${money(p.latest_amount)}, up ${Math.round(p.delta_pct)}% from about ${money(p.typical_amount)}. Possible price hike.`,
    });
  }

  // ── Weekly digest ready (Sunday, once per week) ─────────────────
  if (input.weekday === DIGEST_WEEKDAY && input.digestWeekEnd) {
    out.push({
      key: `digest:${input.digestWeekEnd}`,
      kind: 'digest-ready',
      title: 'Your week in review is ready',
      body: 'Spending, income, upcoming bills and anything worth a look — on the Dashboard.',
    });
  }

  return out;
}

/**
 * Drop alerts already delivered, and prune the fired-key ledger so it
 * doesn't grow forever. Keys older than `keepDays` (by the date they were
 * fired) fall off; the events they guard against are long past by then.
 */
export function dedupeAlerts(
  alerts: Alert[],
  fired: Record<string, string>,
  today: string,
  keepDays = 45,
): { fresh: Alert[]; fired: Record<string, string> } {
  const cutoff = new Date(today + 'T00:00:00');
  cutoff.setDate(cutoff.getDate() - keepDays);
  const pruned: Record<string, string> = {};
  for (const [k, d] of Object.entries(fired)) {
    const t = new Date(d + 'T00:00:00');
    if (!Number.isNaN(t.getTime()) && t >= cutoff) pruned[k] = d;
  }
  const fresh = alerts.filter((a) => !(a.key in pruned));
  for (const a of fresh) pruned[a.key] = today;
  return { fresh, fired: pruned };
}
