/**
 * On-device answers for Ask Tusk — the offline fallback.
 *
 * Runs the intent from ask/intent.ts against the SQLite mirror (and the
 * cached insights from the last sync) and writes a one- or two-sentence
 * answer with exact figures. Every rule mirrors db/queries.ts and
 * therefore the laptop:
 *   spending  = amount > 0 OR is_refund = 1, transfers excluded
 *               (a refund is a negative spend-side line, never income)
 *   income    = amount < 0 AND is_refund = 0, transfers excluded
 *   net worth = depository + investment + manual assets
 *             − credit − loan − manual liabilities
 *
 * Category words people use don't match ledger names one-to-one, so a
 * small synonym table maps "gas" → Transportation / Gas & Fuel, "eating
 * out" → Dining / Food & Dining, "food" → Groceries + Dining together.
 * When a word matches no category, it's tried as a merchant, and vice
 * versa — "on Amazon" is a store, "at restaurants" is a category.
 *
 * Safe-to-spend, payday, and anomaly answers come from the insights cached
 * at the last sync (laptop-computed); they are labelled as such.
 *
 * No model, no network. When the laptop is reachable the screen never calls
 * this — the laptop's grounded assistant is richer and covers far more.
 */
import { getDb } from '../db/sqlite';
import { budgetProgress, netWorth, upcomingBills } from '../db/queries';
import { useInsightsStore } from '../insights/store';
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
const LOCAL = "From your phone's local copy";
const CAT_SQL = "COALESCE(custom_category, category, 'Uncategorized')";

/** Word → LIKE patterns against the ledger's category names, most specific first. */
const CATEGORY_SYNONYMS: [RegExp, string[]][] = [
  [/^(groceries|grocery)$/, ['%grocer%']],
  [/^(dining|dining out|eating out|restaurants?|takeout|take-out|food & dining)$/, ['%dining%', '%restaurant%', '%food & drink%']],
  [/^(gas|fuel)$/, ['%gas%', '%fuel%', '%transport%']],
  [/^(transport|transportation|car|uber|rideshare)$/, ['%transport%']],
  [/^(shopping|clothes|clothing)$/, ['%shopping%']],
  [/^(entertainment|movies|streaming|subscriptions?)$/, ['%entertainment%', '%subscription%']],
  [/^(utilities|electric|power bill|internet|bills)$/, ['%utilit%', '%bills%']],
  [/^(health|medical|doctor|pharmacy)$/, ['%health%', '%medical%']],
  [/^(travel|vacation|flights?|hotels?)$/, ['%travel%']],
  [/^(home|home improvement|hardware)$/, ['%home%']],
  [/^(personal care|haircut)$/, ['%personal%']],
  [/^(kids|children)$/, ['%kid%', '%child%']],
  [/^(pets?)$/, ['%pet%']],
  [/^(gifts?|donations?)$/, ['%gift%', '%donat%']],
  [/^(insurance)$/, ['%insurance%']],
  [/^(rent|mortgage)$/, ['%rent%', '%mortgage%', '%loan%']],
];

function categoryPatterns(word: string): string[] {
  const w = word.toLowerCase().trim();
  for (const [re, pats] of CATEGORY_SYNONYMS) if (re.test(w)) return pats;
  return [`%${w}%`];
}

function pretty(s: string): string {
  return s.replace(/\b\w/g, (c) => c.toUpperCase());
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

async function spendTotal(period: Period): Promise<LocalAnswer> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ total: number | null; cnt: number }>(
    `SELECT SUM(amount) AS total, COUNT(*) AS cnt FROM transactions WHERE date >= ? AND date < ? AND ${SPEND}`,
    [period.start, period.end],
  );
  const total = row?.total ?? 0;
  const cnt = row?.cnt ?? 0;
  if (!cnt) return { answer: `No spending recorded ${period.label}.`, basis: LOCAL };
  return {
    answer: `You've spent ${formatCurrency(total)} ${period.label} across ${plural(cnt, 'transaction')}.`,
    basis: `${LOCAL} · transfers excluded, refunds netted`,
  };
}

async function categoryRows(word: string, period: Period) {
  const db = await getDb();
  const pats = categoryPatterns(word);
  const where = pats.map(() => `LOWER(${CAT_SQL}) LIKE ?`).join(' OR ');
  return db.getAllAsync<{ category: string; total: number; cnt: number }>(
    `SELECT ${CAT_SQL} AS category, SUM(amount) AS total, COUNT(*) AS cnt
     FROM transactions WHERE date >= ? AND date < ? AND ${SPEND} AND (${where})
     GROUP BY 1 ORDER BY total DESC`,
    [period.start, period.end, ...pats],
  );
}

async function merchantRows(word: string, period: Period) {
  const db = await getDb();
  const pat = `%${word.toLowerCase()}%`;
  return db.getFirstAsync<{ total: number | null; cnt: number; name: string | null }>(
    `SELECT SUM(amount) AS total, COUNT(*) AS cnt, MAX(COALESCE(merchant_name, name)) AS name
     FROM transactions WHERE date >= ? AND date < ? AND ${SPEND}
       AND (LOWER(COALESCE(merchant_name,'')) LIKE ? OR LOWER(name) LIKE ?)`,
    [period.start, period.end, pat, pat],
  );
}

async function spendCategory(word: string, period: Period): Promise<LocalAnswer> {
  // "food" = groceries + dining together unless the ledger has a single Food category.
  if (/^food$/i.test(word)) {
    const rows = await categoryRows('food & dining', period);
    const merged = rows.length ? rows : [...(await categoryRows('groceries', period)), ...(await categoryRows('dining', period))];
    if (merged.length) {
      const total = merged.reduce((s, r) => s + r.total, 0);
      const detail = merged.map((r) => `${r.category} ${formatCurrency(r.total)}`).join(', ');
      return { answer: `${formatCurrency(total)} on food ${period.label} — ${detail}.`, basis: `${LOCAL} · transfers excluded, refunds netted` };
    }
  }
  const rows = await categoryRows(word, period);
  if (rows.length === 0) {
    // Not a category — maybe a store ("on Amazon").
    const m = await merchantRows(word, period);
    if (m && m.cnt) return spendMerchant(word, period, false, false);
    return { answer: `Nothing recorded for "${pretty(word)}" ${period.label} — no matching category or store.`, basis: LOCAL };
  }
  const total = rows.reduce((s, r) => s + r.total, 0);
  const cnt = rows.reduce((s, r) => s + r.cnt, 0);
  const name = rows.length === 1 ? rows[0].category : `${rows.length} matching categories`;
  return {
    answer: `${formatCurrency(total)} on ${name} ${period.label} across ${plural(cnt, 'purchase')}.`,
    basis: `${LOCAL} · transfers excluded, refunds netted`,
    rows: rows.length > 1 ? rows.map((r) => ({ label: r.category, value: formatCurrency(r.total) })) : undefined,
  };
}

async function spendMerchant(merchant: string, period: Period | null, lastOnly: boolean, visits: boolean): Promise<LocalAnswer> {
  const db = await getDb();
  const pat = `%${merchant.toLowerCase()}%`;
  if (lastOnly) {
    const row = await db.getFirstAsync<{ name: string; amount: number; date: string }>(
      `SELECT COALESCE(merchant_name, name) AS name, amount, date FROM transactions
       WHERE (LOWER(COALESCE(merchant_name,'')) LIKE ? OR LOWER(name) LIKE ?) AND ${SPEND}
       ORDER BY date DESC, id DESC LIMIT 1`,
      [pat, pat],
    );
    if (!row) return { answer: `No charges from "${pretty(merchant)}" in your local copy.`, basis: LOCAL };
    return { answer: `Last time at ${row.name} you spent ${formatCurrency(row.amount)}, on ${formatDate(row.date)}.`, basis: LOCAL };
  }
  const p = period!;
  const row = await merchantRows(merchant, p);
  if (!row || !row.cnt) {
    // Not a store — maybe a category ("at restaurants").
    const cats = await categoryRows(merchant, p);
    if (cats.length) return spendCategory(merchant, p);
    return { answer: `No charges from "${pretty(merchant)}" ${p.label}.`, basis: LOCAL };
  }
  const total = row.total ?? 0;
  const avg = total / row.cnt;
  const name = row.name ?? pretty(merchant);
  if (visits) {
    const days = Math.max(1, (new Date(p.end + 'T00:00:00').getTime() - new Date(p.start + 'T00:00:00').getTime()) / 86400000);
    const perWeek = Math.round((row.cnt / (days / 7)) * 10) / 10;
    return {
      answer: `${plural(row.cnt, 'visit')} to ${name} ${p.label} — about ${perWeek} a week, ${formatCurrency(total)} in total (${formatCurrency(avg)} a visit).`,
      basis: LOCAL,
    };
  }
  return {
    answer: `${formatCurrency(total)} at ${name} ${p.label} — ${plural(row.cnt, 'visit')}${row.cnt > 1 ? `, about ${formatCurrency(avg)} each` : ''}.`,
    basis: `${LOCAL} · refunds netted`,
  };
}

async function spendCompare(now: Date): Promise<LocalAnswer> {
  const db = await getDb();
  const y = now.getFullYear(), m = now.getMonth(), d = now.getDate();
  const iso = (dt: Date) => `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
  const mtdStart = iso(new Date(y, m, 1));
  const tomorrow = iso(new Date(y, m, d + 1));
  const prevStart = iso(new Date(y, m - 1, 1));
  const prevDays = new Date(y, m, 0).getDate();
  const prevSameEnd = iso(new Date(y, m - 1, Math.min(d, prevDays) + 1));
  const prevEnd = mtdStart;
  const sum = async (a: string, b: string) => (await db.getFirstAsync<{ t: number | null }>(
    `SELECT SUM(amount) AS t FROM transactions WHERE date >= ? AND date < ? AND ${SPEND}`, [a, b]))?.t ?? 0;
  const [cur, prevSame, prevFull] = await Promise.all([sum(mtdStart, tomorrow), sum(prevStart, prevSameEnd), sum(prevStart, prevEnd)]);
  if (!cur && !prevFull) return { answer: 'No spending in either month to compare.', basis: LOCAL };
  const chg = cur - prevSame;
  const dir = chg > 0 ? 'more' : chg < 0 ? 'less' : 'the same as';
  // category drivers
  const byCat = async (a: string, b: string) => db.getAllAsync<{ c: string; t: number }>(
    `SELECT ${CAT_SQL} AS c, SUM(amount) AS t FROM transactions WHERE date >= ? AND date < ? AND ${SPEND} GROUP BY 1`, [a, b]);
  const [cc, pc] = await Promise.all([byCat(mtdStart, tomorrow), byCat(prevStart, prevSameEnd)]);
  const prevMap = new Map<string, number>(pc.map((r) => [r.c, r.t] as [string, number]));
  const ups = cc.map((r) => ({ c: r.c, d: r.t - (prevMap.get(r.c) ?? 0) })).filter((r) => r.d > 0).sort((a, b) => b.d - a.d).slice(0, 3);
  let answer = `So far this month: ${formatCurrency(cur)}, ${formatCurrency(Math.abs(chg))} ${dir} than by day ${d} of last month (${formatCurrency(prevSame)}). Last month finished at ${formatCurrency(prevFull)}.`;
  if (ups.length && chg > 0) answer += ` Biggest increases: ${ups.map((u) => `${u.c} +${formatCurrency(u.d)}`).join(', ')}.`;
  return { answer, basis: `${LOCAL} · same days of each month compared` };
}

async function topCategories(period: Period): Promise<LocalAnswer> {
  const db = await getDb();
  const rows = await db.getAllAsync<{ category: string; total: number }>(
    `SELECT ${CAT_SQL} AS category, SUM(amount) AS total FROM transactions
     WHERE date >= ? AND date < ? AND ${SPEND} GROUP BY 1 HAVING SUM(amount) > 0 ORDER BY total DESC LIMIT 6`,
    [period.start, period.end],
  );
  if (!rows.length) return { answer: `No spending recorded ${period.label}.`, basis: LOCAL };
  const grand = rows.reduce((s, r) => s + r.total, 0);
  const top = rows[0];
  const share = Math.round((100 * top.total) / grand);
  let answer = `Most of your spending ${period.label} went to ${top.category} — ${formatCurrency(top.total)}, about ${share}% of the total.`;
  if (rows.length > 2) answer += ` Then ${rows[1].category} (${formatCurrency(rows[1].total)}) and ${rows[2].category} (${formatCurrency(rows[2].total)}).`;
  else if (rows.length > 1) answer += ` Then ${rows[1].category} (${formatCurrency(rows[1].total)}).`;
  return { answer, basis: `${LOCAL} · transfers excluded`, rows: rows.map((r) => ({ label: r.category, sub: `${Math.round((100 * r.total) / grand)}%`, value: formatCurrency(r.total) })) };
}

async function biggest(period: Period, limit: number): Promise<LocalAnswer> {
  const db = await getDb();
  const rows = await db.getAllAsync<{ name: string; amount: number; date: string; category: string }>(
    `SELECT COALESCE(merchant_name, name) AS name, amount, date, ${CAT_SQL} AS category FROM transactions
     WHERE date >= ? AND date < ? AND amount > 0 AND is_transfer = 0
       AND LOWER(${CAT_SQL}) NOT LIKE '%mortgage%' AND LOWER(${CAT_SQL}) NOT LIKE '%loan%'
     ORDER BY amount DESC LIMIT ?`,
    [period.start, period.end, limit],
  );
  if (!rows.length) return { answer: `No purchases recorded ${period.label}.`, basis: LOCAL };
  const answer = limit > 1
    ? `Your top ${rows.length} purchases ${period.label}: ${rows.map((r) => `${formatCurrency(r.amount)} at ${r.name} (${formatDate(r.date)})`).join('; ')}.`
    : `Your biggest purchase ${period.label}: ${rows[0].name}, ${formatCurrency(rows[0].amount)} on ${formatDate(rows[0].date)}.`;
  return { answer, basis: `${LOCAL} · transfers and loan payments excluded`, rows: rows.map((r) => ({ label: r.name, sub: formatDate(r.date), value: formatCurrency(r.amount) })) };
}

async function averageSpend(target: string | null, unit: 'purchase' | 'week' | 'month', now: Date): Promise<LocalAnswer> {
  const db = await getDb();
  const months = 6;
  const since = new Date(now); since.setDate(since.getDate() - months * 30);
  const iso = (dt: Date) => `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
  const tomorrow = new Date(now); tomorrow.setDate(tomorrow.getDate() + 1);
  const period: Period = { label: `the last ${months} months`, start: iso(since), end: iso(tomorrow) };
  let total = 0, cnt = 0, scope = '';
  if (target) {
    const cats = await categoryRows(target, period);
    if (cats.length) {
      total = cats.reduce((s, r) => s + r.total, 0); cnt = cats.reduce((s, r) => s + r.cnt, 0);
      scope = ` on ${cats.length === 1 ? cats[0].category : pretty(target)}`;
    } else {
      const m = await merchantRows(target, period);
      if (!m || !m.cnt) return { answer: `No spending on "${pretty(target)}" in the last ${months} months.`, basis: LOCAL };
      total = m.total ?? 0; cnt = m.cnt; scope = ` at ${m.name}`;
    }
  } else {
    const row = await db.getFirstAsync<{ t: number | null; c: number }>(
      `SELECT SUM(amount) AS t, COUNT(*) AS c FROM transactions WHERE date >= ? AND date < ? AND ${SPEND}`, [period.start, period.end]);
    total = row?.t ?? 0; cnt = row?.c ?? 0;
  }
  if (!cnt) return { answer: `Not enough history to average yet.`, basis: LOCAL };
  if (unit === 'purchase') {
    return { answer: `Your average purchase${scope} is about ${formatCurrency(total / cnt)}, across ${plural(cnt, 'transaction')} in the last ${months} months.`, basis: LOCAL };
  }
  const per = unit === 'week' ? total / ((months * 30) / 7) : total / months;
  return { answer: `You usually spend about ${formatCurrency(per)} a ${unit}${scope}, averaged over the last ${months} months (${formatCurrency(total)} total).`, basis: LOCAL };
}

async function recent(merchant: string | null, period: Period | null): Promise<LocalAnswer> {
  const db = await getDb();
  const params: (string | number)[] = [];
  let where = SPEND;
  if (merchant) { where += ' AND (LOWER(COALESCE(merchant_name,\'\')) LIKE ? OR LOWER(name) LIKE ?)'; params.push(`%${merchant.toLowerCase()}%`, `%${merchant.toLowerCase()}%`); }
  if (period) { where += ' AND date >= ? AND date < ?'; params.push(period.start, period.end); }
  params.push(period ? 12 : 6);
  const rows = await db.getAllAsync<{ name: string; amount: number; date: string }>(
    `SELECT COALESCE(merchant_name, name) AS name, amount, date FROM transactions WHERE ${where} ORDER BY date DESC, id DESC LIMIT ?`, params);
  const scope = merchant ? ` at ${pretty(merchant)}` : '';
  if (!rows.length) return { answer: period ? `No purchases${scope} ${period.label}.` : `No recent purchases${scope}.`, basis: LOCAL };
  const total = rows.reduce((s, r) => s + r.amount, 0);
  const lead = rows.slice(0, 4).map((r) => `${formatCurrency(r.amount)}${merchant ? '' : ` at ${r.name}`} (${formatDate(r.date)})`).join(', ');
  const answer = period
    ? `${plural(rows.length, 'purchase')}${scope} ${period.label} totaling ${formatCurrency(total)}: ${lead}${rows.length > 4 ? ` and ${rows.length - 4} more` : ''}.`
    : `Your most recent purchases${scope}: ${lead}.`;
  return { answer, basis: LOCAL, rows: rows.slice(0, 8).map((r) => ({ label: r.name, sub: formatDate(r.date), value: formatCurrency(r.amount) })) };
}

async function incomeTotal(period: Period): Promise<LocalAnswer> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ total: number | null; cnt: number }>(
    `SELECT SUM(-amount) AS total, COUNT(*) AS cnt FROM transactions WHERE date >= ? AND date < ? AND ${INCOME}`, [period.start, period.end]);
  const cnt = row?.cnt ?? 0;
  if (!cnt) return { answer: `No deposits recorded ${period.label}.`, basis: LOCAL };
  return { answer: `${formatCurrency(row?.total ?? 0)} came in ${period.label} across ${plural(cnt, 'deposit')} — bank-visible income only; transfers and refunds excluded.`, basis: LOCAL };
}

async function cashFlow(period: Period): Promise<LocalAnswer> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ inc: number | null; out: number | null }>(
    `SELECT SUM(CASE WHEN ${INCOME} THEN -amount ELSE 0 END) AS inc,
            SUM(CASE WHEN ${SPEND} THEN amount ELSE 0 END) AS out
     FROM transactions WHERE date >= ? AND date < ?`, [period.start, period.end]);
  const inc = row?.inc ?? 0, out = row?.out ?? 0;
  if (!inc && !out) return { answer: `No activity ${period.label}.`, basis: LOCAL };
  const net = inc - out;
  const lead = period.label[0].toUpperCase() + period.label.slice(1);
  return {
    answer: `${lead}: ${formatCurrency(inc)} came in and ${formatCurrency(out)} went out — net ${net >= 0 ? '+' : '−'}${formatCurrency(Math.abs(net))}, so you ${net > 0 ? 'saved money' : net < 0 ? 'spent more than came in' : 'broke even'}.`,
    basis: `${LOCAL} · transfers excluded, refunds netted`,
  };
}

async function balance(account: string | null): Promise<LocalAnswer> {
  const db = await getDb();
  const rows = await db.getAllAsync<{ name: string; type: string; subtype: string | null; bal: number | null; inst: string | null }>(
    `SELECT COALESCE(custom_name, name) AS name, type, subtype, current_balance AS bal, institution_name AS inst FROM accounts ORDER BY type, name`);
  let hits = rows;
  if (account) {
    const a = account.toLowerCase().replace(/\bcredit card\b/, 'credit');
    hits = rows.filter((r) => r.name.toLowerCase().includes(a) || (r.subtype || '').toLowerCase().includes(a)
      || (r.type || '').toLowerCase().includes(a) || (r.inst || '').toLowerCase().includes(a));
  } else {
    hits = rows.filter((r) => r.type === 'depository');
  }
  if (!hits.length) return { answer: `I don't see an account matching "${pretty(account ?? '')}" on this phone.`, basis: LOCAL };
  const total = hits.reduce((s, r) => s + (r.bal ?? 0), 0);
  const owed = hits.every((r) => r.type === 'credit' || r.type === 'loan');
  if (hits.length === 1) {
    return { answer: `${hits[0].name}: ${formatCurrency(hits[0].bal ?? 0)}${owed ? ' owed' : ''}.`, basis: 'Balance as of your last sync' };
  }
  return {
    answer: `${formatCurrency(total)}${owed ? ' owed' : ''} across ${hits.length} ${account ? 'matching' : 'cash'} accounts.`,
    basis: 'Balances as of your last sync',
    rows: hits.map((r) => ({ label: r.name, sub: r.inst ?? undefined, value: formatCurrency(r.bal ?? 0) })),
  };
}

async function debtTotal(): Promise<LocalAnswer> {
  const db = await getDb();
  const rows = await db.getAllAsync<{ name: string; bal: number | null }>(
    `SELECT COALESCE(custom_name, name) AS name, current_balance AS bal FROM accounts WHERE type IN ('credit','loan') ORDER BY current_balance DESC`);
  const manual = await db.getFirstAsync<{ t: number | null }>(`SELECT SUM(current_value) AS t FROM manual_assets WHERE side = 'liability'`);
  const total = rows.reduce((s, r) => s + (r.bal ?? 0), 0) + (manual?.t ?? 0);
  if (!total) return { answer: 'No balances owed on file.', basis: 'As of your last sync' };
  return {
    answer: `You owe ${formatCurrency(total)} in total${rows.length ? ` — largest: ${rows[0].name} at ${formatCurrency(rows[0].bal ?? 0)}` : ''}.`,
    basis: 'As of your last sync · includes manually tracked liabilities',
    rows: rows.map((r) => ({ label: r.name, value: formatCurrency(r.bal ?? 0) })),
  };
}

async function netWorthAnswer(): Promise<LocalAnswer> {
  const nw = await netWorth();
  return { answer: `Your net worth is ${formatCurrency(nw.net)} — ${formatCurrency(nw.assets)} in assets against ${formatCurrency(nw.liabilities)} owed.`, basis: 'As of your last sync · includes manually tracked assets' };
}

async function bills(name: string | null, biggestOnly: boolean, withinDays: number | null): Promise<LocalAnswer> {
  let list = await upcomingBills(20);
  if (name) {
    const n = name.toLowerCase();
    list = list.filter((b) => b.account_name.toLowerCase().includes(n) || b.kind.replace('_', ' ').includes(n) || (n === 'card' && b.kind === 'credit_card'));
  }
  if (withinDays != null) list = list.filter((b) => b.days_until <= withinDays);
  if (biggestOnly) list = list.filter((b) => b.amount != null).sort((a, b) => (b.amount ?? 0) - (a.amount ?? 0)).slice(0, 1);
  if (!list.length) {
    return {
      answer: withinDays === 7 ? 'Nothing is due in the next 7 days.' : name ? `No upcoming bill matching "${pretty(name)}".` : 'No bills coming up in the next 60 days.',
      basis: 'Mortgage and card due dates synced from your laptop',
    };
  }
  const when = (b: typeof list[number]) => b.days_until < 0 ? `${-b.days_until}d overdue` : b.days_until === 0 ? 'due today' : `due ${formatDate(b.due_date)} (in ${b.days_until}d)`;
  const amt = (b: typeof list[number]) => b.amount != null ? `${formatCurrency(b.amount)}${b.minimum && b.kind === 'credit_card' && b.minimum < b.amount ? `, minimum ${formatCurrency(b.minimum)}` : ''}` : 'amount unknown';
  const total = list.reduce((s, b) => s + (b.amount ?? 0), 0);
  return {
    answer: list.length === 1
      ? `${list[0].account_name}: ${amt(list[0])}, ${when(list[0])}.`
      : `${list.length} bills coming up totaling ${formatCurrency(total)}: ${list.slice(0, 4).map((b) => `${b.account_name} ${amt(b)} ${when(b)}`).join('; ')}.`,
    basis: 'Mortgage and card due dates synced from your laptop',
    rows: list.slice(0, 6).map((b) => ({ label: b.account_name, sub: b.days_until < 0 ? 'overdue' : formatDate(b.due_date), value: b.amount != null ? formatCurrency(b.amount) : '—' })),
  };
}

async function paymentMade(what: 'mortgage' | 'card' | 'rent' | 'payment', period: Period): Promise<LocalAnswer> {
  const db = await getDb();
  const pat = what === 'mortgage' ? '%mortgage%|%home loan%|%lender%' : what === 'card' ? '%payment%|%autopay%|%card%' : what === 'rent' ? '%rent%' : '%payment%|%autopay%|%loan%|%mortgage%';
  const pats = pat.split('|');
  const where = pats.map(() => `(LOWER(${CAT_SQL}) LIKE ? OR LOWER(COALESCE(merchant_name,'')) LIKE ? OR LOWER(name) LIKE ?)`).join(' OR ');
  const params = pats.flatMap((p) => [p, p, p]);
  const rows = await db.getAllAsync<{ name: string; amount: number; date: string; is_transfer: number }>(
    `SELECT COALESCE(merchant_name, name) AS name, amount, date, is_transfer FROM transactions
     WHERE date >= ? AND date < ? AND amount > 0 AND (${where}) ORDER BY date DESC`, [period.start, period.end, ...params]);
  const hits = what === 'card' ? rows.filter((r) => r.is_transfer || /payment|autopay/i.test(r.name)) : rows;
  const label = what === 'payment' ? 'payment' : `${what} payment`;
  if (!hits.length) return { answer: `I don't see a ${label} posted ${period.label} yet.`, basis: LOCAL };
  return { answer: `Yes — ${formatCurrency(hits[0].amount)} to ${hits[0].name} on ${formatDate(hits[0].date)}.`, basis: LOCAL };
}

async function budget(category: string | null): Promise<LocalAnswer> {
  const bp = await budgetProgress();
  if (!bp || bp.rows.length === 0) return { answer: "There's no budget set for this month.", basis: LOCAL };
  if (category) {
    const c = category.toLowerCase();
    const pats = categoryPatterns(c).map((p) => p.replace(/%/g, ''));
    const row = bp.rows.find((r) => r.category.toLowerCase().includes(c) || pats.some((p) => r.category.toLowerCase().includes(p)));
    if (!row) return { answer: `No budget line matching "${pretty(category)}" this month.`, basis: LOCAL };
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
  const totalLimit = bp.total_limit ?? bp.rows.reduce((s, r) => s + r.limit_amount, 0);
  const left = totalLimit - bp.total_spent;
  const status = over.length ? `Over on ${over.map((r) => r.category).join(', ')}.` : near.length ? `Close on ${near.map((r) => r.category).join(', ')}; the rest is on track.` : 'Every category is on track.';
  return {
    answer: `${formatCurrency(bp.total_spent)} of ${formatCurrency(totalLimit)} spent this month — ${formatCurrency(Math.abs(left))} ${left >= 0 ? 'left' : 'over'}. ${status}`,
    basis: 'Limits from your laptop · spending from your local copy',
    rows: bp.rows.slice(0, 8).map((r) => ({ label: r.category, sub: `${Math.round(r.pct * 100)}%`, value: `${formatCurrency(r.spent)} / ${formatCurrency(r.limit_amount)}` })),
  };
}

// ── answers from the cached insights (laptop-computed at last sync) ──────
const CACHED = 'From your last sync with the laptop';

function insights() {
  return useInsightsStore.getState().insights;
}

function affordability(amount: number | null): LocalAnswer {
  const sts = insights()?.safe_to_spend;
  if (!sts) return { answer: "I don't have a safe-to-spend estimate cached yet — it arrives with the next sync from your laptop.", basis: CACHED };
  const payday = formatDate(sts.next_paycheck_date);
  if (amount == null) {
    return { answer: `Your safe-to-spend estimate is ${formatCurrency(sts.safe_to_spend)} until ${payday} — checking cash minus bills due and your usual spending before then. Tell me an amount and I'll check it.`, basis: CACHED };
  }
  const remaining = sts.safe_to_spend - amount;
  const usual = Math.max(sts.budget_remaining_pro_rata, 0);
  const verdict = amount <= sts.safe_to_spend
    ? `Yes, comfortably — that leaves ${formatCurrency(remaining)} safe to spend until ${payday}.`
    : amount <= sts.safe_to_spend + usual
      ? `It's tight — it fits only if you spend ${formatCurrency(amount - sts.safe_to_spend)} less than usual on everything else before ${payday}.`
      : `Not without dipping into bill money or savings — it's ${formatCurrency(-remaining)} more than what's safe to spend before ${payday}.`;
  return { answer: `${verdict} (Safe to spend now: ${formatCurrency(sts.safe_to_spend)}; an estimate, not a guarantee.)`, basis: CACHED };
}

function nextPaycheck(now: Date): LocalAnswer {
  const sts = insights()?.safe_to_spend;
  if (!sts) return { answer: "I don't have a paycheck projection cached yet — it arrives with the next sync.", basis: CACHED };
  const d = new Date(sts.next_paycheck_date + 'T00:00:00');
  const days = Math.round((d.getTime() - new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()) / 86400000);
  const when = days <= 0 ? 'today' : days === 1 ? 'tomorrow' : `in ${days} days`;
  return {
    answer: sts.next_paycheck_source === 'recurring_income'
      ? `Your next paycheck should land around ${formatDate(sts.next_paycheck_date)} — ${when}, going by your usual deposit rhythm.`
      : `No regular paycheck pattern was detected, so the estimate assumes the 1st of next month (${formatDate(sts.next_paycheck_date)}, ${when}).`,
    basis: CACHED,
  };
}

function unusual(): LocalAnswer {
  const d = insights()?.weekly_digest;
  if (!d) return { answer: "I don't have this week's digest cached yet — it arrives with the next sync.", basis: CACHED };
  const large = d.notable.large_transactions, hikes = d.notable.price_hikes.filter((h) => !large.some((l) => l.merchant === h.merchant) && h.delta_pct <= 150), fresh = d.notable.new_merchants;
  if (!large.length && !hikes.length && !fresh.length) return { answer: `Nothing looks out of the ordinary for the week of ${formatDate(d.week_start)} — no unusually large charges, price hikes or first-time merchants.`, basis: CACHED };
  const parts: string[] = [];
  if (large[0]) parts.push(`${formatCurrency(large[0].amount)} at ${large[0].merchant} on ${formatDate(large[0].date)} is well above your usual ${formatCurrency(large[0].typical_amount)} there`);
  if (hikes[0]) parts.push(`${hikes[0].merchant} charged ${formatCurrency(hikes[0].latest_amount)}, up ${Math.round(hikes[0].delta_pct)}% from about ${formatCurrency(hikes[0].typical_amount)} — a possible price hike`);
  if (fresh.length) parts.push(`first-time merchant${fresh.length > 1 ? 's' : ''}: ${fresh.slice(0, 3).map((m) => m.merchant).join(', ')}`);
  return { answer: `Week of ${formatDate(d.week_start)}: ${parts.join('; ')}.`, basis: CACHED };
}

function briefing(): LocalAnswer {
  const d = insights()?.weekly_digest;
  if (!d) return { answer: "I don't have a summary cached yet — pull down to sync with your laptop.", basis: CACHED };
  const h = d.happened;
  const dir = h.spend_delta.amount > 0 ? 'up' : 'down';
  const parts = [`This week you spent ${formatCurrency(h.spend)}, ${dir} ${formatCurrency(Math.abs(h.spend_delta.amount))} from last week, and ${formatCurrency(h.income)} came in.`];
  if (d.net_worth?.delta != null) parts.push(`Net worth ${d.net_worth.delta >= 0 ? 'up' : 'down'} ${formatCurrency(Math.abs(d.net_worth.delta))} since ${formatDate(d.net_worth.prior_date ?? d.net_worth.date)}.`);
  if (d.coming.bills.length) parts.push(`Next up: ${d.coming.bills[0].name} due ${formatDate(d.coming.bills[0].date)}.`);
  if (d.budget_status) parts.push(`${d.budget_status.on_pace} of ${d.budget_status.lines} budget categories on pace.`);
  return { answer: parts.join(' '), basis: CACHED };
}

function help(): LocalAnswer {
  return {
    answer: "Ask me about your own numbers: what you spent this month or at a store, balances and net worth, what's due, how the budget is doing, or whether something fits before payday. I only read — I never change anything.",
    basis: 'Answered on this phone',
  };
}

export async function answerLocally(intent: LocalIntent, now: Date = new Date()): Promise<LocalAnswer> {
  switch (intent.kind) {
    case 'help': return help();
    case 'briefing': return briefing();
    case 'spend_total': return spendTotal(intent.period);
    case 'spend_category': return spendCategory(intent.category, intent.period);
    case 'spend_merchant': return spendMerchant(intent.merchant, intent.period, intent.lastOnly, intent.visits);
    case 'spend_compare': return spendCompare(now);
    case 'top_categories': return topCategories(intent.period);
    case 'biggest_expenses': return biggest(intent.period, intent.limit);
    case 'average_spend': return averageSpend(intent.target, intent.unit, now);
    case 'recent_transactions': return recent(intent.merchant, intent.period);
    case 'income_total': return incomeTotal(intent.period);
    case 'cash_flow': return cashFlow(intent.period);
    case 'balance': return balance(intent.account);
    case 'debt_total': return debtTotal();
    case 'net_worth': return netWorthAnswer();
    case 'upcoming_bills': return bills(intent.name, intent.biggest, intent.withinDays);
    case 'payment_made': return paymentMade(intent.what, intent.period);
    case 'budget_status': return budget(intent.category);
    case 'affordability': return affordability(intent.amount);
    case 'next_paycheck': return nextPaycheck(now);
    case 'unusual': return unusual();
  }
}
