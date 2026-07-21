/**
 * Read helpers backing the screens.
 *
 * Convention: each function returns Plain Old JS Objects with the
 * exact shape the screen wants. SQL formatting / coercion (pending
 * INT 0/1 → boolean, etc.) happens here, not in the screen, so the
 * screens stay declarative.
 */
import { getDb } from './sqlite';
import { computePace, DailySpendRow, SpendingPace } from './pace';

export type { SpendingPace } from './pace';

/**
 * First day of the current month as a LOCAL YYYY-MM-DD string.
 *
 * `new Date(y, m, 1).toISOString()` converts to UTC first, so for any
 * user west of UTC (all of the Americas) the month-start rolls back to
 * the last day of the *previous* month — pulling an extra day of the
 * prior month into "this month" totals. Formatting the local Y/M/D
 * parts directly keeps the boundary in the user's own timezone, which
 * is how transaction `date` values (plain YYYY-MM-DD) are meant to be
 * compared.
 */
function localMonthStart(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  return `${y}-${m}-01`;
}

export interface AccountRow {
  id: number;
  name: string;
  custom_name: string | null;
  type: string;
  subtype: string | null;
  institution_name: string | null;
  mask: string | null;
  current_balance: number | null;
  available_balance: number | null;
  currency: string | null;
}

export interface TransactionRow {
  id: number;
  account_id: number;
  name: string;
  merchant_name: string | null;
  amount: number;
  date: string;
  pending: boolean;
  category: string | null;
  custom_category: string | null;
  is_transfer: boolean;
  notes: string | null;
  /** Resolved display name — coalesces custom_category over category. */
  effective_category: string;
  /** Resolved merchant — merchant_name over name. */
  effective_name: string;
  /** Joined account label (custom_name fallback to name). For list rows. */
  account_label: string;
}

export async function listAccounts(): Promise<AccountRow[]> {
  const db = await getDb();
  return db.getAllAsync<AccountRow>(
    `SELECT id, name, custom_name, type, subtype, institution_name, mask,
            current_balance, available_balance, currency
     FROM accounts
     ORDER BY type, COALESCE(custom_name, name)`,
  );
}

export async function listTransactions(opts: {
  limit?: number;
  offset?: number;
  search?: string;
  /** Inclusive YYYY-MM-DD lower bound — powers the date filter chips. */
  sinceDate?: string;
  /** EXCLUSIVE YYYY-MM-DD upper bound — with sinceDate this brackets a
   *  single month for the month stepper. */
  untilDate?: string;
  /** Exact effective-category match — powers the category chips and the
   *  Dashboard top-category drill-down. Compared against
   *  COALESCE(custom_category, category, 'Uncategorized'). */
  category?: string;
  /** Restrict to one account — powers the account filter chips. */
  accountId?: number;
} = {}): Promise<TransactionRow[]> {
  const db = await getDb();
  const { limit = 100, offset = 0, search, sinceDate, untilDate, category, accountId } = opts;
  const params: (string | number)[] = [];
  let where = '1=1';
  if (search && search.trim()) {
    where += ' AND (LOWER(t.name) LIKE ? OR LOWER(COALESCE(t.merchant_name, "")) LIKE ?)';
    const pat = `%${search.toLowerCase()}%`;
    params.push(pat, pat);
  }
  if (sinceDate) {
    // Uses ix_transactions_date. Note: no index is added for search —
    // the LIKE pattern has a leading wildcard ('%term%'), which a
    // B-tree index can't serve; FTS5 would, but that's a schema change
    // requiring a SCHEMA_VERSION bump (full wipe + re-pull). Not worth
    // it for a table this size.
    where += ' AND t.date >= ?';
    params.push(sinceDate);
  }
  if (untilDate) {
    where += ' AND t.date < ?';
    params.push(untilDate);
  }
  if (category) {
    where += " AND COALESCE(t.custom_category, t.category, 'Uncategorized') = ?";
    params.push(category);
  }
  if (accountId != null) {
    // Uses ix_transactions_account_id.
    where += ' AND t.account_id = ?';
    params.push(accountId);
  }
  params.push(limit, offset);
  return db.getAllAsync<TransactionRow>(
    `SELECT
        t.id, t.account_id, t.name, t.merchant_name, t.amount, t.date,
        t.pending, t.category, t.custom_category, t.is_transfer, t.notes,
        COALESCE(t.custom_category, t.category, 'Uncategorized') AS effective_category,
        COALESCE(t.merchant_name, t.name) AS effective_name,
        COALESCE(a.custom_name, a.name) AS account_label
     FROM transactions t
     LEFT JOIN accounts a ON a.id = t.account_id
     WHERE ${where}
     ORDER BY t.date DESC, t.id DESC
     LIMIT ? OFFSET ?`,
    params,
  );
}

export interface MonthSummary {
  income: number;
  spending: number;
  net: number;
  transactionCount: number;
}

export async function currentMonthSummary(): Promise<MonthSummary> {
  const db = await getDb();
  const start = localMonthStart();
  const row = await db.getFirstAsync<{
    income: number | null;
    spending: number | null;
    cnt: number;
  }>(
    `SELECT
        SUM(CASE WHEN amount < 0 THEN -amount ELSE 0 END) AS income,
        SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END) AS spending,
        COUNT(*) AS cnt
     FROM transactions
     WHERE date >= ? AND is_transfer = 0`,
    [start],
  );
  const income = row?.income ?? 0;
  const spending = row?.spending ?? 0;
  return {
    income,
    spending,
    net: income - spending,
    transactionCount: row?.cnt ?? 0,
  };
}

export interface CategoryTotal {
  category: string;
  total: number;
}

export async function topCategoriesThisMonth(
  limit = 5,
): Promise<CategoryTotal[]> {
  const db = await getDb();
  const start = localMonthStart();
  return db.getAllAsync<CategoryTotal>(
    `SELECT
        COALESCE(custom_category, category, 'Uncategorized') AS category,
        SUM(amount) AS total
     FROM transactions
     WHERE date >= ? AND amount > 0 AND is_transfer = 0
     GROUP BY COALESCE(custom_category, category, 'Uncategorized')
     ORDER BY total DESC
     LIMIT ?`,
    [start, limit],
  );
}

export interface AccountChip {
  id: number;
  label: string;
}

/** Accounts ordered by how much transaction activity they carry —
 *  powers the account filter chips on the Transactions screen. Accounts
 *  with no transactions at all (pure investment/loan balances) are
 *  omitted; filtering to them would always show an empty list. */
export async function accountsWithActivity(limit = 8): Promise<AccountChip[]> {
  const db = await getDb();
  return db.getAllAsync<AccountChip>(
    `SELECT a.id, COALESCE(a.custom_name, a.name) AS label
     FROM accounts a
     JOIN transactions t ON t.account_id = a.id
     GROUP BY a.id
     ORDER BY COUNT(t.id) DESC
     LIMIT ?`,
    [limit],
  );
}

/** Distinct effective categories with spend this month, largest first.
 *  Powers the category filter chips on the Transactions screen. */
export async function spendCategories(limit = 12): Promise<string[]> {
  const db = await getDb();
  const start = localMonthStart();
  const rows = await db.getAllAsync<{ category: string }>(
    `SELECT COALESCE(custom_category, category, 'Uncategorized') AS category
     FROM transactions
     WHERE date >= ? AND amount > 0 AND is_transfer = 0
     GROUP BY COALESCE(custom_category, category, 'Uncategorized')
     ORDER BY SUM(amount) DESC
     LIMIT ?`,
    [start, limit],
  );
  return rows.map((r) => r.category);
}

// ─── Spending pace ────────────────────────────────────────────────

/**
 * Month-to-date spending pace vs a trailing 4-month moving-average
 * baseline. Powers the "Spending pace" Dashboard tile. Computed entirely
 * from the local mirror (the phone syncs the full transaction history,
 * so a 4-month baseline is answerable offline) — no laptop API call.
 *
 * Spending definition matches the rest of the app: `amount > 0 AND
 * is_transfer = 0`, summed by local-time `date`. The SQL just produces
 * daily gross-spend sums for the window (earliest baseline month → now);
 * all calendar/cumulative/average math lives in computePace() so it can
 * be unit-tested without RN. Returns null (tile hidden) when fewer than 2
 * of the prior 4 months have spend rows.
 */
export async function spendingPace(): Promise<SpendingPace | null> {
  const db = await getDb();
  const now = new Date();
  // Earliest baseline month = 4 calendar months before the current one,
  // as a LOCAL YYYY-MM-01 string (same timezone discipline as
  // localMonthStart() — the `date` column is local-naive).
  let y = now.getFullYear();
  let m = now.getMonth() + 1;
  for (let i = 0; i < 4; i++) {
    m -= 1;
    if (m === 0) {
      m = 12;
      y -= 1;
    }
  }
  const earliest = `${y}-${String(m).padStart(2, '0')}-01`;
  const rows = await db.getAllAsync<DailySpendRow>(
    `SELECT date, SUM(amount) AS total
       FROM transactions
      WHERE date >= ? AND amount > 0 AND is_transfer = 0
      GROUP BY date`,
    [earliest],
  );
  return computePace(rows, now);
}

// ─── Budgets ──────────────────────────────────────────────────────

export interface BudgetProgressRow {
  category: string;
  limit_amount: number;
  /** Gross spend this month (amount > 0, transfers excluded) — same
   *  semantics as the web's budget page and topCategoriesThisMonth. */
  spent: number;
  /** spent / limit_amount (limit is NOT NULL in the schema). */
  pct: number;
}

export interface BudgetProgress {
  month: number;
  year: number;
  total_limit: number | null;
  total_spent: number;
  rows: BudgetProgressRow[];
}

/**
 * The CURRENT month's budget (by the phone's local calendar) joined
 * against locally-mirrored spending. Returns null when no budget is
 * defined for this month — the Dashboard hides the card entirely.
 * Limits come from sync; "spent" is computed here so the card stays
 * live between syncs as new transactions land.
 */
export async function budgetProgress(): Promise<BudgetProgress | null> {
  const db = await getDb();
  const now = new Date();
  const month = now.getMonth() + 1;
  const year = now.getFullYear();
  const budget = await db.getFirstAsync<{
    id: number;
    total_limit: number | null;
  }>(
    'SELECT id, total_limit FROM budgets WHERE month = ? AND year = ?',
    [month, year],
  );
  if (!budget) return null;
  const start = localMonthStart();
  const rows = await db.getAllAsync<{
    category: string;
    limit_amount: number;
    spent: number | null;
  }>(
    `SELECT
        bc.category,
        bc.limit_amount,
        (SELECT SUM(t.amount) FROM transactions t
          WHERE COALESCE(t.custom_category, t.category, 'Uncategorized') = bc.category
            AND t.date >= ? AND t.amount > 0 AND t.is_transfer = 0) AS spent
     FROM budget_categories bc
     WHERE bc.budget_id = ?
     ORDER BY bc.limit_amount DESC`,
    [start, budget.id],
  );
  const out: BudgetProgressRow[] = rows.map((r) => {
    const spent = r.spent ?? 0;
    return {
      category: r.category,
      limit_amount: r.limit_amount,
      spent,
      pct: r.limit_amount > 0 ? spent / r.limit_amount : 0,
    };
  });
  // Most-over-budget first so trouble is at the top of the card.
  out.sort((a, b) => b.pct - a.pct);
  const totalRow = await db.getFirstAsync<{ spending: number | null }>(
    `SELECT SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END) AS spending
     FROM transactions WHERE date >= ? AND is_transfer = 0`,
    [start],
  );
  return {
    month,
    year,
    total_limit: budget.total_limit,
    total_spent: totalRow?.spending ?? 0,
    rows: out,
  };
}

// ─── Upcoming bills ───────────────────────────────────────────────

export interface UpcomingBillRow {
  id: string;
  account_name: string;
  kind: string; // 'mortgage' | 'credit_card'
  due_date: string;
  /** Recomputed locally from due_date — the synced value goes stale
   *  between syncs (it was "days until" as of the laptop's clock). */
  days_until: number;
  amount: number | null;
  minimum: number | null;
  note: string | null;
}

export async function upcomingBills(limit = 5): Promise<UpcomingBillRow[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<Omit<UpcomingBillRow, 'days_until'>>(
    `SELECT id, account_name, kind, due_date, amount, minimum, note
     FROM upcoming_bills
     ORDER BY due_date ASC
     LIMIT ?`,
    [limit],
  );
  const todayMs = new Date(new Date().toDateString()).getTime();
  return rows.map((r) => ({
    ...r,
    days_until: Math.round(
      (new Date(`${r.due_date}T00:00:00`).getTime() - todayMs) / 86400000,
    ),
  }));
}

export interface NetWorthSnapshot {
  assets: number;
  liabilities: number;
  net: number;
}

// ─── Per-account breakdown ────────────────────────────────────────

export interface AccountBreakdownRow {
  id: number;
  name: string;          // resolved display name (custom_name → name)
  mask: string | null;
  type: string;
  current_balance: number;
  updated_at: string | null;
}

export interface AccountBreakdownGroup {
  /** 'cash' | 'investment' | 'credit' | 'loan' */
  key: string;
  /** Display label for the section header */
  label: string;
  /** Side of the balance sheet: 'asset' | 'liability' */
  side: string;
  items: AccountBreakdownRow[];
  /** Sum of current_balance for this group (unsigned). */
  subtotal: number;
}

/**
 * Per-account balances grouped by Plaid account type, plus the user's
 * manual_assets entries split by side. Mirrors the AccountsOverview
 * tile on the web Dashboard — the bottom Net Worth number now matches
 * the headline net-worth card at the top of the phone Dashboard, so
 * the user sees one consistent figure regardless of which card they
 * read first.
 *
 * Loans are folded in so the phone view is complete; the web tile
 * excludes them only because filtering txns to a mortgage isn't a
 * useful pill, which is a different concern.
 *
 * Manual entries (homes, vehicles, held-away investments, private
 * auto loans) appear as additional groups after the four Plaid groups.
 * Each manual entry maps to the same row shape — name, value — but
 * with `mask: null` (no account number) and `updated_at: null` (manual
 * entries follow the user's own update cadence, not a Plaid sync
 * cadence, so the screen suppresses the stale badge for them).
 */
export async function accountsBreakdown(): Promise<AccountBreakdownGroup[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<{
    id: number;
    name: string;
    custom_name: string | null;
    mask: string | null;
    type: string;
    current_balance: number | null;
    updated_at: string | null;
  }>(
    `SELECT id, name, custom_name, mask, type, current_balance, updated_at
     FROM accounts
     ORDER BY type, COALESCE(custom_name, name)`,
  );

  const groupDef: { key: string; label: string; side: string }[] = [
    { key: 'depository', label: 'Cash',       side: 'asset' },
    { key: 'investment', label: 'Investment', side: 'asset' },
    { key: 'credit',     label: 'Credit',     side: 'liability' },
    { key: 'loan',       label: 'Loans',      side: 'liability' },
  ];

  const plaidGroups: AccountBreakdownGroup[] = groupDef.map((g) => {
    const items: AccountBreakdownRow[] = rows
      .filter((r) => (r.type || '').toLowerCase() === g.key)
      .map((r) => ({
        id: r.id,
        name: r.custom_name || r.name || '(unnamed)',
        mask: r.mask,
        type: r.type,
        current_balance: r.current_balance ?? 0,
        updated_at: r.updated_at,
      }))
      // Highest absolute balance first so the most material accounts
      // are at the top of each group.
      .sort((a, b) => Math.abs(b.current_balance) - Math.abs(a.current_balance));
    const subtotal = items.reduce((s, a) => s + a.current_balance, 0);
    return { ...g, items, subtotal };
  });

  // Manual entries — split by side, surfaced as two additional groups.
  // Hidden when empty so a user with no manual entries sees a clean
  // four-card stack, not empty placeholder cards.
  const manualRows = await db.getAllAsync<{
    id: number;
    name: string;
    side: string | null;
    current_value: number | null;
  }>(
    `SELECT id, name, side, current_value
     FROM manual_assets
     ORDER BY side, name`,
  );

  const buildManualGroup = (
    side: 'asset' | 'liability',
    key: string,
    label: string,
  ): AccountBreakdownGroup | null => {
    const items: AccountBreakdownRow[] = manualRows
      .filter((m) => (m.side || 'asset') === side)
      .map((m) => ({
        id: m.id,
        name: m.name || '(unnamed)',
        // Manual entries don't have account numbers or sync timestamps;
        // the screen treats null on either as "don't render the chip".
        mask: null,
        type: 'manual',
        current_balance: m.current_value ?? 0,
        updated_at: null,
      }))
      .sort((a, b) => Math.abs(b.current_balance) - Math.abs(a.current_balance));
    if (items.length === 0) return null;
    const subtotal = items.reduce((s, a) => s + a.current_balance, 0);
    return { key, label, side, items, subtotal };
  };

  const manualAssetGroup = buildManualGroup(
    'asset',
    'manual-assets',
    'Manual assets',
  );
  const manualLiabilityGroup = buildManualGroup(
    'liability',
    'manual-liabilities',
    'Manual liabilities',
  );

  const allGroups = [
    ...plaidGroups.filter((g) => g.items.length > 0),
    ...(manualAssetGroup ? [manualAssetGroup] : []),
    ...(manualLiabilityGroup ? [manualLiabilityGroup] : []),
  ];

  return allGroups;
}

export async function netWorth(): Promise<NetWorthSnapshot> {
  const db = await getDb();
  // Mirror the laptop's account-type → side mapping AND fold in the
  // user's manual_assets table — homes, vehicles, manual liabilities.
  // Without manual_assets the phone's net worth was undercounting by
  // hundreds of thousands of dollars on accounts where the user tracks
  // real estate or vehicles outside of Plaid.
  //
  // depository / investment → assets
  // credit / loan           → liabilities  (Plaid balance is positive on a
  //                                          credit card; we subtract)
  // manual_assets.side='asset'      → assets
  // manual_assets.side='liability' → liabilities
  const accountsRow = await db.getFirstAsync<{
    assets: number | null;
    liabilities: number | null;
  }>(
    `SELECT
        SUM(CASE WHEN type IN ('depository','investment') THEN COALESCE(current_balance,0) ELSE 0 END) AS assets,
        SUM(CASE WHEN type IN ('credit','loan')           THEN COALESCE(current_balance,0) ELSE 0 END) AS liabilities
     FROM accounts`,
  );
  const manualRow = await db.getFirstAsync<{
    assets: number | null;
    liabilities: number | null;
  }>(
    `SELECT
        SUM(CASE WHEN side = 'asset'     THEN COALESCE(current_value,0) ELSE 0 END) AS assets,
        SUM(CASE WHEN side = 'liability' THEN COALESCE(current_value,0) ELSE 0 END) AS liabilities
     FROM manual_assets`,
  );
  const assets = (accountsRow?.assets ?? 0) + (manualRow?.assets ?? 0);
  const liabilities = (accountsRow?.liabilities ?? 0) + (manualRow?.liabilities ?? 0);
  return { assets, liabilities, net: assets - liabilities };
}

export async function transactionsSince(isoDate: string): Promise<number> {
  const db = await getDb();
  const r = await db.getFirstAsync<{ cnt: number }>(
    'SELECT COUNT(*) AS cnt FROM transactions WHERE date >= ?',
    [isoDate],
  );
  return r?.cnt ?? 0;
}

// ─── Investments ──────────────────────────────────────────────────

export interface HoldingRow {
  id: number;
  account_id: number;
  account_label: string;
  ticker: string;
  security_name: string;
  type: string | null;
  quantity: number;
  price: number | null;
  value: number;
  cost_basis: number | null;
  /** Unrealized gain (value - cost_basis), null if cost_basis unknown. */
  gain: number | null;
  /** gain / cost_basis, null if cost_basis unknown or zero. */
  gain_pct: number | null;
}

export async function listHoldings(): Promise<HoldingRow[]> {
  const db = await getDb();
  // Compute value / gain / gain_pct in SQL where we can — it's the
  // same shape the screen wants and avoids per-row JS work on a list
  // that can run into the hundreds.
  const rows = await db.getAllAsync<{
    id: number;
    account_id: number;
    account_label: string;
    ticker: string | null;
    security_name: string | null;
    type: string | null;
    quantity: number;
    price: number | null;
    value: number | null;
    cost_basis: number | null;
  }>(
    `SELECT
        h.id,
        h.account_id,
        COALESCE(a.custom_name, a.name) AS account_label,
        s.ticker_symbol AS ticker,
        s.name AS security_name,
        s.type,
        h.quantity,
        COALESCE(h.institution_price, s.close_price) AS price,
        COALESCE(
          h.institution_value,
          h.quantity * COALESCE(h.institution_price, s.close_price)
        ) AS value,
        h.cost_basis
     FROM holdings h
     LEFT JOIN securities s USING (plaid_security_id)
     LEFT JOIN accounts a ON a.id = h.account_id
     WHERE COALESCE(h.institution_value, h.quantity * COALESCE(h.institution_price, s.close_price), 0) <> 0
     ORDER BY value DESC NULLS LAST`,
  );
  return rows.map((r) => {
    const value = r.value ?? 0;
    const gain = r.cost_basis != null ? value - r.cost_basis : null;
    const gain_pct =
      r.cost_basis && r.cost_basis !== 0
        ? (gain ?? 0) / r.cost_basis
        : null;
    return {
      id: r.id,
      account_id: r.account_id,
      account_label: r.account_label || 'Unknown',
      ticker: r.ticker || '—',
      security_name: r.security_name || r.ticker || 'Unknown',
      type: r.type,
      quantity: r.quantity,
      price: r.price,
      value,
      cost_basis: r.cost_basis,
      gain,
      gain_pct,
    };
  });
}

export interface InvestmentsRollup {
  total_value: number;
  total_cost_basis: number; // 0 if no holdings have known basis
  total_gain: number;
  cash_value: number;
  positions: number;
}

export async function investmentsRollup(): Promise<InvestmentsRollup> {
  const db = await getDb();
  // Two sources of investment dollars:
  //
  //   1. Rows in `holdings` — Plaid pulls per-position detail for most
  //      brokerages (Robinhood, Fidelity taxable, etc.), and we sum
  //      institution_value across those.
  //
  //   2. Investment-type accounts that DON'T have holdings — common for
  //      HSAs, 457s, 403(b)s, and pension plans where the plan only
  //      reports a single balance, not the underlying positions. The
  //      laptop's `/api/investments/summary` adds these in via
  //      Account.current_balance (see investments.py lines 218-247);
  //      the phone needs the same logic or its portfolio-value will be
  //      the holdings-only number, which is what was happening — phone
  //      showed ~$517k while laptop showed ~$690k.
  //
  // Cash detection only applies to (1) — manual accounts don't expose a
  // cash-vs-invested split, so the laptop treats the whole balance as
  // invested, and we mirror that.
  const holdings = await db.getFirstAsync<{
    total_value: number | null;
    cash_value: number | null;
    total_cost_basis: number | null;
    positions: number;
  }>(
    // total_cost_basis EXCLUDES cash holdings — cash has no real basis
    // (Plaid often reports cost_basis == institution_value for the
    // CUR:USD-style settled-cash row, which would double-count cash into
    // the basis sum and crater the gain calculation). Mirror the
    // laptop's investments.py: only sum cost_basis for non-cash rows.
    `SELECT
        SUM(COALESCE(h.institution_value,
            h.quantity * COALESCE(h.institution_price, s.close_price), 0)) AS total_value,
        SUM(CASE WHEN s.is_cash_equivalent = 1
            THEN COALESCE(h.institution_value,
                h.quantity * COALESCE(h.institution_price, s.close_price), 0)
            ELSE 0 END) AS cash_value,
        SUM(CASE WHEN s.is_cash_equivalent = 1
            THEN 0
            ELSE COALESCE(h.cost_basis, 0) END) AS total_cost_basis,
        COUNT(*) AS positions
     FROM holdings h
     LEFT JOIN securities s USING (plaid_security_id)`,
  );
  const manual = await db.getFirstAsync<{ manual_total: number | null }>(
    // != 0 (not > 0): still skips zero-balance stubs, but a NEGATIVE
    // balance (margin call, plan fee clawback) must count against the
    // portfolio value, not be silently hidden from the hero number.
    `SELECT COALESCE(SUM(COALESCE(current_balance, 0)), 0) AS manual_total
     FROM accounts
     WHERE type = 'investment'
       AND id NOT IN (SELECT DISTINCT account_id FROM holdings)
       AND COALESCE(current_balance, 0) != 0`,
  );
  const holdings_total = holdings?.total_value ?? 0;
  const cash_value = holdings?.cash_value ?? 0;
  const manual_total = manual?.manual_total ?? 0;
  const total_value = holdings_total + manual_total;
  // total_invested = everything that isn't cash. Manual investment
  // accounts go in here too because we have no breakdown for them.
  const total_invested = total_value - cash_value;
  const total_cost_basis = holdings?.total_cost_basis ?? 0;
  return {
    total_value,
    total_cost_basis,
    // Gain math uses `total_invested - cost_basis`, matching the laptop.
    // Note this can look "inflated" relative to a strict per-position
    // accounting, because manual accounts contribute to total_invested
    // but not to cost_basis (the plan reports a balance only). That's
    // by design — same number the laptop shows.
    total_gain: total_cost_basis > 0 ? total_invested - total_cost_basis : 0,
    cash_value,
    positions: holdings?.positions ?? 0,
  };
}

// ─── Net worth history ────────────────────────────────────────────

export interface NetWorthPoint {
  date: string;   // YYYY-MM-DD
  net_worth: number;
}

export async function netWorthHistory(days = 90): Promise<NetWorthPoint[]> {
  const db = await getDb();
  const cutoff = new Date(Date.now() - days * 86400000)
    .toISOString()
    .slice(0, 10);
  return db.getAllAsync<NetWorthPoint>(
    `SELECT date, net_worth FROM net_worth_snapshots
     WHERE date >= ?
     ORDER BY date ASC`,
    [cutoff],
  );
}
