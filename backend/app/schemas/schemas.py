"""Pydantic schemas for API request/response models."""
from datetime import date, datetime
from typing import Dict, List, Optional
from pydantic import BaseModel, ConfigDict, Field


# --- Plaid / Link ---
class LinkTokenResponse(BaseModel):
    link_token: str


class PublicTokenExchange(BaseModel):
    public_token: str
    institution_id: Optional[str] = None
    institution_name: Optional[str] = None


# --- Accounts ---
class AccountOut(BaseModel):
    id: int
    name: str
    custom_name: Optional[str] = None
    official_name: Optional[str] = None
    type: str
    subtype: Optional[str] = None
    institution_name: Optional[str] = None
    mask: Optional[str] = None
    current_balance: float
    available_balance: Optional[float] = None
    currency: str
    plaid_item_id: Optional[int] = None                # raw FK — lets the frontend group accounts under their PlaidItem
    is_manual: bool = False                            # plaid_item_id IS NULL — derived in the route
    balance_as_of: Optional[date] = None               # snapshot date for manual accounts; null otherwise
    transactions_through: Optional[date] = None        # MAX(transaction.date) for this account; null when no txns
    tax_bucket: Optional[str] = None                   # 'tax_deferred' | 'roth' | 'taxable' | 'hsa' | 'excluded' | None
    roth_split_pct: Optional[float] = None             # 0.0-1.0 fraction of balance treated as Roth (mixed 401k accounts)

    model_config = ConfigDict(from_attributes=True)


class AccountUpdate(BaseModel):
    # PATCH payload. All fields optional; only provided fields are updated.
    # Empty string clears the alias; None leaves it unchanged.
    custom_name: Optional[str] = None
    current_balance: Optional[float] = None
    balance_as_of: Optional[date] = None                # explicit override; auto-set to today if balance changes
    tax_bucket: Optional[str] = None                    # one of: 'tax_deferred', 'roth', 'taxable', 'hsa', 'excluded'
    roth_split_pct: Optional[float] = None              # 0.0-1.0; splits balance between roth and tax_bucket


class ManualAccountCreate(BaseModel):
    """Create an Account that doesn't have a Plaid backing.

    Used for credit cards / loans / accounts where Plaid integration
    isn't available (e.g. Apple Card). The resulting Account behaves
    like a Plaid-synced one — it can hold transactions, flow into Net
    Worth, and be referenced by manual_assets — except its balance and
    transactions are user-entered, not auto-synced.
    """
    name: str
    type: str                                          # depository | credit | loan | investment | other
    subtype: Optional[str] = None
    institution_name: Optional[str] = None
    custom_name: Optional[str] = None
    current_balance: float = 0.0
    mask: Optional[str] = None
    currency: str = "USD"
    balance_as_of: Optional[date] = None               # statement-period end date; defaults to today on the server


# --- Transactions ---
class TransactionSplitIn(BaseModel):
    amount: float
    category: str = Field(max_length=128)
    note: Optional[str] = Field(None, max_length=2000)
    business_id: Optional[int] = None


class TransactionSplitOut(BaseModel):
    id: int
    transaction_id: int
    amount: float
    category: str
    note: Optional[str] = None
    business_id: Optional[int] = None

    model_config = ConfigDict(from_attributes=True)


class TransactionOut(BaseModel):
    id: int
    account_id: int
    name: str
    merchant_name: Optional[str] = None
    display_name: Optional[str] = None          # normalized merchant name (model @property)
    amount: float
    currency: str
    date: date
    pending: bool
    category: Optional[str] = None
    subcategory: Optional[str] = None
    custom_category: Optional[str] = None
    business_id: Optional[int] = None
    is_transfer: bool = False
    notes: Optional[str] = None                 # user-entered free-text, editable via PATCH
    splits: List[TransactionSplitOut] = []

    model_config = ConfigDict(from_attributes=True)


class TransactionUpdate(BaseModel):
    custom_category: Optional[str] = Field(None, max_length=128)
    business_id: Optional[int] = None
    is_transfer: Optional[bool] = None        # bulk reclassify: flip to/from transfer without rerunning the detector
    notes: Optional[str] = Field(None, max_length=2000)  # empty string clears; null leaves unchanged


class TransactionSplitsReplace(BaseModel):
    splits: List[TransactionSplitIn]


# --- Budgets ---
class BudgetCategoryIn(BaseModel):
    category: str = Field(max_length=128)
    limit_amount: float = Field(ge=0)


class BudgetIn(BaseModel):
    month: int = Field(ge=1, le=12)
    year: int = Field(ge=2000, le=2100)
    total_limit: Optional[float] = Field(None, ge=0)
    categories: List[BudgetCategoryIn] = []


class BudgetCategoryOut(BaseModel):
    id: int
    category: str
    limit_amount: float

    model_config = ConfigDict(from_attributes=True)


class BudgetOut(BaseModel):
    id: int
    month: int
    year: int
    total_limit: Optional[float] = None
    categories: List[BudgetCategoryOut] = []

    model_config = ConfigDict(from_attributes=True)


# --- Net Worth ---
class NetWorthSnapshotOut(BaseModel):
    date: date
    total_assets: float
    total_liabilities: float
    net_worth: float
    account_balances: Optional[Dict] = None

    model_config = ConfigDict(from_attributes=True)


# --- Investments ---
class SecurityOut(BaseModel):
    plaid_security_id: str
    ticker_symbol: Optional[str] = None
    name: Optional[str] = None
    type: Optional[str] = None
    close_price: Optional[float] = None
    is_cash_equivalent: bool = False

    model_config = ConfigDict(from_attributes=True)


class HoldingOut(BaseModel):
    id: int
    account_id: int
    account_name: str                    # from a join: custom_name or name
    plaid_security_id: str
    security: SecurityOut
    quantity: float
    institution_price: Optional[float] = None
    institution_value: Optional[float] = None
    cost_basis: Optional[float] = None
    gain_loss: Optional[float] = None    # institution_value - cost_basis when both present
    iso_currency_code: Optional[str] = None


class InvestmentTransactionOut(BaseModel):
    id: int
    account_id: int
    account_name: str
    date: date
    name: Optional[str] = None
    type: Optional[str] = None
    subtype: Optional[str] = None
    ticker_symbol: Optional[str] = None
    security_name: Optional[str] = None
    quantity: Optional[float] = None
    price: Optional[float] = None
    amount: Optional[float] = None
    fees: Optional[float] = None
    pending: bool = False


class AccountValueOut(BaseModel):
    """Per-account roll-up used by the Investments page Value-by-account table."""
    account_id: int
    name: str                                       # custom_name or Plaid name
    institution: Optional[str] = None
    subtype: Optional[str] = None                   # 401k, brokerage, ira, ...
    cash_value: float                               # holdings flagged is_cash_equivalent
    invested_value: float                           # everything else
    total_value: float                              # cash + invested (matches account_balance)
    cost_basis: Optional[float] = None              # sum where known across non-cash holdings
    gain_loss: Optional[float] = None               # invested_value - cost_basis when known
    holding_count: int                              # number of distinct positions (cash counted as one)
    pct_of_portfolio: float                         # 0..100, share of total_value across all accounts
    is_manual: bool = False                         # plaid_item_id IS NULL — drives the MANUAL pill
    balance_as_of: Optional[date] = None            # statement-period end date for manual accounts


class HoldingAllocationRow(BaseModel):
    type: str                                       # equity, etf, mutual_fund, bond, cash, etc.
    label: str                                      # display name (e.g., "Cash" for cash bucket)
    value: float                                    # market value in this category
    pct: float                                      # percentage of total portfolio


class TopHoldingRow(BaseModel):
    security_name: Optional[str] = None
    ticker: Optional[str] = None
    value: float
    pct_of_portfolio: float
    gain_loss: Optional[float] = None
    gain_loss_pct: Optional[float] = None


class InvestmentsSummary(BaseModel):
    total_value: float                              # sum of institution_value across all holdings
    total_cash: float                               # sum of cash-equivalent holdings only
    total_invested: float                           # total_value - total_cash
    total_cost_basis: Optional[float] = None        # sum where known (non-cash only)
    total_gain_loss: Optional[float] = None
    total_gain_loss_pct: Optional[float] = None     # total_gain_loss / total_cost_basis * 100
    allocation: List[HoldingAllocationRow] = []     # asset allocation by type
    top_holdings: List[TopHoldingRow] = []          # top 5 holdings by value
    accounts: List[AccountValueOut]                 # per-account breakdown, sorted by total desc
    # Kept for backwards compat with anything still iterating these maps:
    by_account: Dict[str, float]                    # account display name -> market value
    by_security_type: Dict[str, float]              # equity/etf/mutual fund/... -> market value


# --- Liabilities (mortgages + credit cards) ---
class MortgageDetailOut(BaseModel):
    account_id: int
    account_number: Optional[str] = None
    interest_rate_percentage: Optional[float] = None
    interest_rate_type: Optional[str] = None
    loan_term: Optional[str] = None
    loan_type_description: Optional[str] = None
    origination_date: Optional[date] = None
    origination_principal_amount: Optional[float] = None
    maturity_date: Optional[date] = None
    next_monthly_payment: Optional[float] = None
    next_payment_due_date: Optional[date] = None
    last_payment_amount: Optional[float] = None
    last_payment_date: Optional[date] = None
    past_due_amount: Optional[float] = None
    current_late_fee: Optional[float] = None
    ytd_interest_paid: Optional[float] = None
    ytd_principal_paid: Optional[float] = None
    escrow_balance: Optional[float] = None
    has_pmi: Optional[bool] = None
    has_prepayment_penalty: Optional[bool] = None
    property_street: Optional[str] = None
    property_city: Optional[str] = None
    property_region: Optional[str] = None
    property_postal_code: Optional[str] = None
    property_country: Optional[str] = None

    model_config = ConfigDict(from_attributes=True)


class APREntry(BaseModel):
    apr_percentage: Optional[float] = None
    apr_type: Optional[str] = None
    balance_subject_to_apr: Optional[float] = None
    interest_charge_amount: Optional[float] = None


class CreditCardDetailOut(BaseModel):
    account_id: int
    aprs: Optional[List[APREntry]] = None
    is_overdue: Optional[bool] = None
    last_statement_balance: Optional[float] = None
    last_statement_issue_date: Optional[date] = None
    last_payment_amount: Optional[float] = None
    last_payment_date: Optional[date] = None
    minimum_payment_amount: Optional[float] = None
    next_payment_due_date: Optional[date] = None

    model_config = ConfigDict(from_attributes=True)


# --- Manual Assets (homes, vehicles, etc.) ---
class ManualAssetBase(BaseModel):
    name: str
    side: str = "asset"                                # "asset" | "liability"
    type: str                                          # real_estate | vehicle | student_loan | personal_loan | ...
    current_value: float
    value_as_of: Optional[date] = None                 # defaults to today on create if omitted
    notes: Optional[str] = None
    address_street: Optional[str] = None
    address_city: Optional[str] = None
    address_region: Optional[str] = None
    address_postal_code: Optional[str] = None
    address_country: Optional[str] = None
    plaid_mortgage_account_id: Optional[int] = None
    paired_manual_liability_id: Optional[int] = None


class ManualAssetCreate(ManualAssetBase):
    pass


class ManualAssetUpdate(BaseModel):
    # All fields optional. Server treats unset fields as "no change".
    name: Optional[str] = None
    side: Optional[str] = None
    type: Optional[str] = None
    current_value: Optional[float] = None
    value_as_of: Optional[date] = None
    notes: Optional[str] = None
    address_street: Optional[str] = None
    address_city: Optional[str] = None
    address_region: Optional[str] = None
    address_postal_code: Optional[str] = None
    address_country: Optional[str] = None
    plaid_mortgage_account_id: Optional[int] = None
    paired_manual_liability_id: Optional[int] = None


class ManualAssetOut(ManualAssetBase):
    id: int
    value_as_of: date

    model_config = ConfigDict(from_attributes=True)


# --- Spending Summary ---
class CategorySpending(BaseModel):
    category: str
    total: float
    budget_limit: Optional[float] = None
    percentage_used: Optional[float] = None


class SpendingSummary(BaseModel):
    month: int
    year: int
    total_spent: float
    categories: List[CategorySpending]
    # Total of business-tagged spending (any business_id set) for the
    # selected month. Always populated regardless of the business_filter
    # query param so the UI can show a "Business" rollup tile even when
    # the categories list is filtered to personal-only. Defaults to 0
    # for back-compat with older clients reading this response.
    business_total: float = 0.0
    # Budget limit assigned to the synthetic "Business" category, if the
    # user has set one for the selected month. Lets the Budgets UI
    # render a progress bar for business spend without merging
    # business_total into the categories list.
    business_budget_limit: Optional[float] = None


# --- Stale Accounts ---
class StaleAccountOut(BaseModel):
    id: int
    name: str
    institution_name: Optional[str] = None
    last_seen: date                     # balance_as_of or max(transaction.date)
    days_stale: int
    # 'plaid' = synced via Plaid, alerted on a days threshold.
    # 'manual' = user-uploaded statements; alerted only when a full prior
    #            calendar month has elapsed without coverage.
    cadence: str = "plaid"
    # Plain-English explanation, e.g. "March statement overdue" or
    # "12 days since last sync". The UI shows this verbatim so the
    # backend owns the messaging.
    reason: str = ""


class StaleAccountsResponse(BaseModel):
    stale_count: int
    threshold_days: int                 # Plaid-cadence threshold; manual uses calendar-month rule
    as_of: date
    accounts: List[StaleAccountOut]


# --- Insight Cards ---
class InsightCard(BaseModel):
    """An anomaly insight card — one of category_up, new_merchant, or large_transaction."""
    type: str  # "category_up" | "new_merchant" | "large_transaction"
    title: str
    subtitle: str
    severity: str  # "info" | "warning" | "alert"
    merchant: Optional[str] = None
    category: Optional[str] = None
    amount: Optional[float] = None


class InsightsResponse(BaseModel):
    """Batch of insight cards generated from recent spending anomalies."""
    cards: List[InsightCard] = []
    generated_at: datetime


# --- Business tagging rules (pattern → business_id) ---
class BusinessRuleIn(BaseModel):
    pattern: str                       # case-insensitive substring; matched against merchant + name
    business_id: int
    priority: Optional[int] = 100      # lower = matched first


class BusinessRuleOut(BaseModel):
    id: int
    pattern: str
    business_id: int
    priority: int
    business_name: Optional[str] = None        # joined for display

    model_config = ConfigDict(from_attributes=True)


class BusinessRuleApplyResult(BaseModel):
    """Returned after applying a rule retroactively across existing transactions."""
    rule_id: int
    matched: int
    updated: int                       # subset of matched that weren't already tagged this way
    skipped_already_tagged: int


# --- Retroactive category-rule application ---
class RuleApplyResult(BaseModel):
    rule_id: int
    pattern: str
    category: str
    matched: int
    updated: int                       # transactions whose custom_category actually changed
