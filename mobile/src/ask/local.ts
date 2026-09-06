/**
 * On-device answers for Ask Tusk — the offline fallback.
 *
 * Runs the intent from ask/intent.ts against the SQLite mirror and writes
 * a one- or two-sentence answer with the exact figures. Every rule here
 * mirrors db/queries.ts (and therefore the laptop):
 *   spending = amount > 0 OR is_refund = 1, transfers excluded
 *              (a refund is a negative spend-side line, never income)
 *   income   = amount < 0 AND is_refund = 0, transfers excluded
 *   net worth = depository + investment + manual assets
 *             − credit − loan − manual liabilities
 *
 * No model, no network. When the laptop is reachable the screen never
 * calls this — the laptop's grounded assistant is richer and covers far
 * more questions. This exists so "how much have I spent on groceries this
 * month?" still works in the store with no Wi-Fi.
 */
import { getDb } from '../db/sqlite';
import { budgetProgress, netWorth, upcomingBills } from '../db/queries';
import { formatCurrency, formatDate } from '../theme';
import type { LocalIntent, Period } from './intent';

export interface LocalAnswer {
  answer: string;
  /** Short provenance line shown under the answer. */
  basis: string;
  /** Optional supporting rows (label/value) for a compact table. */
  rows?: { label: string; sub?: string; value: string }[];
}

const SPEND = '(amount > 0 OR is_refund = 1) AND is_transfer = 0';
const INCOME = 'amount < 0 AND is_refund = 0 AND is_transfer = 0';

function pretty(s: string): string {
  return s.replace(/\b\w/g, (c) => c.toUpperCase());
}

async function spendTotal(period: Period): Promise<LocalAnswer> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ total: number | null; cnt: number }>(
    `SELECT SUM(amount) AS total, COUNT(*) AS cnt FROM transactions
     WHERE date >= ? AND date < ? AND ${SPEND}`,
    [period.start, period.end],
  );
  const total = row?.total ?? 0;
  return {
    answer: `You've spent ${formatCurrency(total)} ${period.label} across ${row?.cnt ?? 0} transactions.`,
    basis: 'From your phone\'s local copy · transfers excluded, refunds netted',
  };
}

async function spendCategory(category: string, period: Period): Promise<LocalAnswer> {
  const db = await getDb();
  const rows = await db.getAllAsync<{ category: string; total: number }>(
    `SELECT COALESCE(custom_category, category, 'Uncategorized') AS category, SUM(amount) AS total
     FROM transactions
     WHERE date >= ? AND date < ? AND ${SPEND}
       AND LOWER(COALESCE(custom_category, category, 'Uncategorized')) LIKE ?
     GROUP BY 1 ORDER BY total DESC`,
    [period.start, period.end, `%${category.toLowerCase()}%`],
  );
  if (rows.length === 0) {
    return {
      answer: `Nothing recorded under "${pretty(category)}" ${period.label}.`,
      basis: 'From your phone\'s local copy',
    };
  }
  const total = rows.reduce((s, r) => s + r.total, 0);
  const name = rows.length === 1 ? rows[0].category : `${rows.length} matching categories`;
  return {
    answer: `${formatCurrency(total)} on ${name} ${period.label}.`,
    basis: 'From your phone\'s local copy · transfers excluded, refunds netted',
    rows: rows.length > 1 ? rows.map((r) => ({ label: r.category, value: formatCurrency(r.total) })) : undefined,
  };
}

async function spendMerchant(merchant: string, period: Period | null, lastOnly: boolean): Promise<LocalAnswer> {
  const db = await getDb();
  const pat = `%${merchant.toLowerCase()}%`;
  if (lastOnly) {
    const row = await db.getFirstAsync<{ name: string; amount: number; date: string }>(
      `SELECT COALESCE(merchant_name, name) AS name, amount, date FROM transactions
       WHERE (LOWER(COALESCE(merchant_name,'')) LIKE ? OR LOWER(name) LIKE ?) AND ${SPEND}
       ORDER BY date DESC, id DESC LIMIT 1`,
      [pat, pat],
    );
    if (!row) return { answer: `No charges from "${pretty(merchant)}" in your local copy.`, basis: 'From your phone\'s local copy' };
    return {
      answer: `Last time at ${row.name} you spent ${formatCurrency(row.amount)} on ${formatDate(row.date)}.`,
      basis: 'From your phone\'s local copy',
    };
  }
  const p = period!;
  const row = await db.getFirstAsync<{ total: number | null; cnt: number; name: string | null }>(
    `SELECT SUM(amount) AS total, COUNT(*) AS cnt, MAX(COALESCE(merchant_name, name)) AS name
     FROM transactions
     WHERE date >= ? AND date < ? AND ${SPEND}
       AND (LOWER(COALESCE(merchant_name,'')) LIKE ? OR LOWER(name) LIKE ?)`,
    [p.start, p.end, pat, pat],
  );
  if (!row || !row.cnt) {
    return { answer: `No charges from "${pretty(merchant)}" ${p.label}.`, basis: 'From your phone\'s local copy' };
  }
  const avg = (row.total ?? 0) / row.cnt;
  return {
    answer: `${formatCurrency(row.total ?? 0)} at ${row.name ?? pretty(merchant)} ${p.label} — ${row.cnt} visit${row.cnt === 1 ? '' : 's'}, about ${formatCurrency(avg)} each.`,
    basis: 'From your phone\'s local copy · refunds netted',
  };
}

async function incomeTotal(period: Period): Promise<LocalAnswer> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ total: number | null; cnt: number }>(
    `SELECT SUM(-amount) AS total, COUNT(*) AS cnt FROM transactions
     WHERE date >= ? AND date < ? AND ${INCOME}`,
    [period.start, period.end],
  );
  return {
    answer: `${formatCurrency(row?.total ?? 0)} came in ${period.label} (${row?.cnt ?? 0} deposits, transfers and refunds excluded).`,
    basis: 'From your phone\'s local copy',
  };
}

async function balance(account: string | null): Promise<LocalAnswer> {
  const db = await getDb();
  const rows = await db.getAllAsync<{ name: string; type: string; subtype: string | null; bal: number | null; inst: string | null }>(
    `SELECT COALESCE(custom_name, name) AS name, type, subtype, current_balance AS bal, institution_name AS inst
     FROM accounts ORDER BY type, name`,
  );
  let hits = rows;
  if (account) {
    const a = account.toLowerCase();
    hits = rows.filter((r) =>
      r.name.toLowerCase().includes(a)
      || (r.subtype || '').toLowerCase().includes(a)
      || (r.inst || '').toLowerCase().includes(a)
      || (a === 'cash' && r.type === 'depository'),
    );
  } else {
    hits = rows.filter((r) => r.type === 'depository');
  }
  if (hits.length === 0) {
    return { answer: `I don't see an account matching "${pretty(account ?? '')}" on this phone.`, basis: 'From your phone\'s local copy' };
  }
  const total = hits.reduce((s, r) => s + (r.bal ?? 0), 0);
  if (hits.length === 1) {
    return { answer: `${hits[0].name}: ${formatCurrency(hits[0].bal ?? 0)}.`, basis: 'Balance as of your last sync' };
  }
  return {
    answer: `${formatCurrency(total)} across ${hits.length} ${account ? 'matching' : 'cash'} accounts.`,
    basis: 'Balances as of your last sync',
    rows: hits.map((r) => ({ label: r.name, sub: r.inst ?? undefined, value: formatCurrency(r.bal ?? 0) })),
  };
}

async function netWorthAnswer(): Promise<LocalAnswer> {
  const nw = await netWorth();
  return {
    answer: `Your net worth is ${formatCurrency(nw.net)} — ${formatCurrency(nw.assets)} in assets against ${formatCurrency(nw.liabilities)} owed.`,
    basis: 'As of your last sync · includes manually tracked assets',
  };
}

async function bills(name: string | null): Promise<LocalAnswer> {
  let list = await upcomingBills(20);
  if (name) {
    const n = name.toLowerCase();
    list = list.filter((b) => b.account_name.toLowerCase().includes(n) || b.kind.replace('_', ' ').includes(n));
  }
  if (list.length === 0) {
    return { answer: name ? `No upcoming bill matching "${pretty(name)}".` : 'No bills coming up in the next 60 days.', basis: 'From your phone\'s local copy' };
  }
  const next = list[0];
  const when = next.days_until < 0 ? `${-next.days_until}d overdue` : next.days_until === 0 ? 'due today' : `due ${formatDate(next.due_date)} (in ${next.days_until}d)`;
  const total = list.reduce((s, b) => s + (b.amount ?? 0), 0);
  return {
    answer: list.length === 1
      ? `${next.account_name} is ${when}${next.amount != null ? ` — ${formatCurrency(next.amount)}` : ''}.`
      : `${list.length} bills coming up, ${formatCurrency(total)} total. Next: ${next.account_name}, ${when}.`,
    basis: 'Mortgage and card due dates synced from your laptop',
    rows: list.slice(0, 6).map((b) => ({
      label: b.account_name,
      sub: b.days_until < 0 ? 'overdue' : formatDate(b.due_date),
      value: b.amount != null ? formatCurrency(b.amount) : '—',
    })),
  };
}

async function budget(category: string | null): Promise<LocalAnswer> {
  const bp = await budgetProgress();
  if (!bp || bp.rows.length === 0) {
    return { answer: 'There\'s no budget set for this month.', basis: 'From your phone\'s local copy' };
  }
  if (category) {
    const c = category.toLowerCase();
    const row = bp.rows.find((r) => r.category.toLowerCase().includes(c));
    if (!row) return { answer: `No budget line matching "${pretty(category)}" this month.`, basis: 'From your phone\'s local copy' };
    const over = row.spent > row.limit_amount;
    return {
      answer: over
        ? `${row.category}: ${formatCurrency(row.spent)} of ${formatCurrency(row.limit_amount)} — ${formatCurrency(row.spent - row.limit_amount)} over.`
        : `${row.category}: ${formatCurrency(row.spent)} of ${formatCurrency(row.limit_amount)} (${Math.round(row.pct * 100)}%), ${formatCurrency(row.limit_amount - row.spent)} left.`,
      basis: 'Limits from your laptop · spending from your local copy',
    };
  }
  const over = bp.rows.filter((r) => r.pct > 1);
  const near = bp.rows.filter((r) => r.pct > 0.8 && r.pct <= 1);
  const totalLine = bp.total_limit != null ? `${formatCurrency(bp.total_spent)} of ${formatCurrency(bp.total_limit)} overall. ` : '';
  const status = over.length
    ? `Over on ${over.map((r) => r.category).join(', ')}.`
    : near.length
      ? `Close on ${near.map((r) => r.category).join(', ')}; everything else on track.`
      : 'Every category is on track.';
  return {
    answer: `${totalLine}${status}`,
    basis: 'Limits from your laptop · spending from your local copy',
    rows: bp.rows.slice(0, 8).map((r) => ({
      label: r.category,
      sub: `${Math.round(r.pct * 100)}%`,
      value: `${formatCurrency(r.spent)} / ${formatCurrency(r.limit_amount)}`,
    })),
  };
}

async function biggest(period: Period, limit: number): Promise<LocalAnswer> {
  const db = await getDb();
  const rows = await db.getAllAsync<{ name: string; amount: number; date: string }>(
    `SELECT COALESCE(merchant_name, name) AS name, amount, date FROM transactions
     WHERE date >= ? AND date < ? AND amount > 0 AND is_transfer = 0
     ORDER BY amount DESC LIMIT ?`,
    [period.start, period.end, limit],
  );
  if (rows.length === 0) return { answer: `No purchases recorded ${period.label}.`, basis: 'From your phone\'s local copy' };
  return {
    answer: `Your biggest ${period.label}: ${rows[0].name}, ${formatCurrency(rows[0].amount)} on ${formatDate(rows[0].date)}.`,
    basis: 'From your phone\'s local copy · transfers excluded',
    rows: rows.map((r) => ({ label: r.name, sub: formatDate(r.date), value: formatCurrency(r.amount) })),
  };
}

export async function answerLocally(intent: LocalIntent): Promise<LocalAnswer> {
  switch (intent.kind) {
    case 'spend_total': return spendTotal(intent.period);
    case 'spend_category': return spendCategory(intent.category, intent.period);
    case 'spend_merchant': return spendMerchant(intent.merchant, intent.period, intent.lastOnly);
    case 'income_total': return incomeTotal(intent.period);
    case 'balance': return balance(intent.account);
    case 'net_worth': return netWorthAnswer();
    case 'upcoming_bills': return bills(intent.name);
    case 'budget_status': return budget(intent.category);
    case 'biggest_expenses': return biggest(intent.period, intent.limit);
  }
}
