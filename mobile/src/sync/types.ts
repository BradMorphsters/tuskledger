/**
 * Shared types — the wire format from /api/mobile/sync.
 *
 * Kept in this single file so any drift between backend (mobile.py)
 * and the phone shows up as a TypeScript error rather than a silent
 * field becoming `undefined` somewhere downstream. Keep in lock-step
 * with the Pydantic schemas in backend/app/routers/mobile.py.
 */

export interface AccountWire {
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
  updated_at: string | null; // ISO8601
}

export interface TransactionWire {
  id: number;
  account_id: number;
  name: string;
  merchant_name: string | null;
  amount: number;
  date: string; // YYYY-MM-DD
  pending: boolean;
  category: string | null;
  custom_category: string | null;
  is_transfer: boolean;
  /** Inflow that nets against its category's spend (a return, a statement
   *  credit) rather than counting as income. Optional: laptops running a
   *  backend before 0021 don't send it. */
  is_refund?: boolean;
  notes: string | null;
  updated_at: string | null;
}

export interface SecurityWire {
  plaid_security_id: string;
  ticker_symbol: string | null;
  name: string | null;
  type: string | null;
  close_price: number | null;
  close_price_as_of: string | null;
  is_cash_equivalent: boolean;
  updated_at: string | null;
}

export interface HoldingWire {
  id: number;
  account_id: number;
  plaid_security_id: string;
  quantity: number;
  institution_price: number | null;
  institution_value: number | null;
  cost_basis: number | null;
  iso_currency_code: string | null;
  updated_at: string | null;
}

export interface NetWorthSnapshotWire {
  id: number;
  date: string;
  total_assets: number;
  total_liabilities: number;
  net_worth: number;
  created_at: string | null;
}

export interface ManualAssetWire {
  id: number;
  name: string;
  side: string; // 'asset' | 'liability'
  type: string;
  current_value: number;
  value_as_of: string | null;
  notes: string | null;
  plaid_mortgage_account_id: number | null;
  updated_at: string | null;
}

export interface BudgetCategoryWire {
  id: number;
  budget_id: number;
  category: string;
  limit_amount: number;
}

export interface BudgetWire {
  id: number;
  month: number; // 1-12
  year: number;
  total_limit: number | null;
  categories: BudgetCategoryWire[];
  updated_at: string | null;
}

export interface UpcomingBillWire {
  /** Synthetic key: `${account_id}:${kind}`. */
  id: string;
  account_id: number;
  account_name: string;
  kind: string; // 'mortgage' | 'credit_card'
  due_date: string; // YYYY-MM-DD
  days_until: number; // negative = overdue
  amount: number | null;
  minimum: number | null;
  note: string | null;
}

export interface SyncResponse {
  server_time: string;
  full: boolean;
  accounts: AccountWire[];
  transactions: TransactionWire[];
  /** Optional — present iff the server's manifest reports schema_version >= 2. */
  securities?: SecurityWire[];
  holdings?: HoldingWire[];
  net_worth_snapshots?: NetWorthSnapshotWire[];
  manual_assets?: ManualAssetWire[];
  /**
   * Optional — schema_version >= 3. ALWAYS the complete set (not a
   * delta): the phone wipes + reinserts its budget tables each sync so
   * laptop-side deletions propagate. Limits only — "spent" is computed
   * locally from the transactions mirror.
   */
  budgets?: BudgetWire[];
  /**
   * Optional — schema_version >= 4. Derived server-side (mortgage +
   * credit-card due dates, next 60 days incl. overdue); complete set
   * every sync, phone wipes + reinserts.
   */
  upcoming_bills?: UpcomingBillWire[];
  has_more: boolean;
}

// ─── Insights (schema_version >= 5) ──────────────────────────────────
// Derived server-side by services/safe_to_spend.py and
// services/weekly_digest.py — the same functions the laptop Dashboard
// calls. The phone never recomputes these; it fetches them once per sync
// cycle (GET /api/mobile/insights) and caches the JSON in the SQLite meta
// table so the cards render offline. Field names mirror the Python dicts.

export interface SafeToSpendBillWire {
  name: string;
  date: string; // YYYY-MM-DD
  amount: number;
  source: string; // 'mortgage' | 'credit_card' | 'recurring'
}

export interface SafeToSpendWire {
  as_of: string;
  safe_to_spend: number;
  spendable_cash: number;
  savings_cash: number;
  bills_due: number;
  budget_remaining_pro_rata: number;
  spending_overlap_adjustment?: number;
  next_paycheck_date: string;
  days_until_paycheck: number;
  next_paycheck_source: string; // 'recurring_income' | 'month_end_fallback'
  budget_source: string; // 'budget' | 'trailing_average' | 'mixed' | 'none'
  bills: SafeToSpendBillWire[];
  notes: string[];
}

export interface DigestDeltaWire {
  amount: number;
  pct: number | null;
}

export interface DigestCategoryWire {
  category: string;
  amount: number;
  prior_amount: number;
  delta: number;
}

export interface DigestMerchantAmountWire {
  merchant: string;
  amount: number;
}

export interface DigestLargeTxnWire {
  merchant: string;
  date: string;
  amount: number;
  typical_amount: number;
}

export interface DigestPriceHikeWire {
  merchant: string;
  latest_amount: number;
  typical_amount: number;
  delta_pct: number;
}

export interface DigestBillWire {
  name: string;
  date: string;
  days_until: number;
  amount: number | null;
  kind: string;
}

export interface WeeklyDigestWire {
  week_start: string;
  week_end: string;
  happened: {
    spend: number;
    spend_delta: DigestDeltaWire;
    income: number;
    income_delta: DigestDeltaWire;
    top_categories: DigestCategoryWire[];
    top_merchants: DigestMerchantAmountWire[];
    transaction_count: number;
    refund_count: number;
  };
  notable: {
    new_merchants: DigestMerchantAmountWire[];
    large_transactions: DigestLargeTxnWire[];
    price_hikes: DigestPriceHikeWire[];
  };
  coming: {
    bills: DigestBillWire[];
    next_paycheck_date: string;
    next_paycheck_source: string;
  };
  budget_status: {
    month: number;
    year: number;
    score: number;
    on_pace: number;
    lines: number;
    over_pace: { category: string; spent: number; limit: number; score: number }[];
  } | null;
  net_worth: {
    date: string;
    net_worth: number;
    prior_date: string | null;
    prior_net_worth: number | null;
    delta: number | null;
  } | null;
  action_items: {
    unpaired_transfers: { count: number; url: string };
    uncategorized: { count: number; url: string };
  };
}

export interface InsightsResponse {
  generated_at: string;
  as_of: string; // YYYY-MM-DD
  safe_to_spend: SafeToSpendWire;
  weekly_digest: WeeklyDigestWire;
}

// ─── Ask Tusk (schema_version >= 6) ──────────────────────────────────

export interface AskTurnWire {
  who: 'you' | 'tusk';
  text: string;
}

export interface AskResponse {
  answer: string;
  /** ollama | retrieval | guarded | refusal | template — see routers/mobile.py. */
  source: string;
  intent: string | null;
  window: string | null;
  grounded: boolean;
  found: boolean;
  rows: unknown[];
}

export interface BriefingResponse {
  briefing: string;
  source: string;
}

export interface ManifestResponse {
  host_id: string;
  hostname: string;
  app_name: string;
  server_time: string;
  schema_version: number;
  /** True if the laptop has DEMO_ENABLED=true and can serve synthetic data. */
  demo_available?: boolean;
}

export interface PairClaimResponse {
  token: string;
  label: string | null;
  server_time: string;
}

export interface PairedHost {
  /** http://192.168.1.42:8000 etc — no trailing slash */
  baseUrl: string;
  /** From the manifest. Identifies the specific Tusk Ledger install. */
  hostId: string;
  /** Friendly label, e.g. the laptop's hostname. From the manifest. */
  hostname: string;
}
