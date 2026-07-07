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
  has_more: boolean;
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
