"""Generate a fresh tuskledger_demo.db populated with realistic synthetic data
for the Alex Carter household persona.

12 months of transactions across multiple "connected" institutions, holdings,
mortgage detail, recurring subscriptions, budgets, categorization rules,
and a weekly net-worth history.

All data is synthetic. Merchant names are real public companies (Starbucks,
Costco, Netflix, etc.) — those are public information and add realism — but
amounts, dates, accounts, and the user are entirely fabricated.

Run from the backend/ directory:
    python -m app.scripts.seed_demo

Or with a custom output path:
    python -m app.scripts.seed_demo --output /tmp/foo.db

The output file is git-ignored. The script is the source of truth — re-running
it gives a fresh database with dates relative to "today", so the demo always
looks current regardless of when the repo was cloned.

Importable functions:
  - `seed_database(db)` — wipe + re-seed using an existing session. Used by
    the in-app "Refresh demo data" button.
  - `main(output_path)` — CLI entry point: build a fresh DB file from scratch.
"""
from __future__ import annotations

import argparse
import calendar
import random
import sys
from datetime import date, datetime, timedelta
from pathlib import Path

# Allow `python app/scripts/seed_demo.py` invocation in addition to the
# preferred `python -m app.scripts.seed_demo`. The package import works
# either way.
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from app.database import Base
from app.models import (
    Account,
    Budget,
    BudgetCategory,
    Business,
    CategoryRule,
    BusinessRule,
    SavingsGoal,
    CreditCardDetail,
    Holding,
    InvestmentTransaction,
    ManualAsset,
    MortgageDetail,
    NetWorthSnapshot,
    PlaidItem,
    Security,
    SubscriptionRule,
    Transaction,
    User,
)
from app.models.subscription_rule import KIND_FORCE_SUB, KIND_FORCE_NOT_SUB
from app.services.auth_service import generate_totp_secret, hash_password
from app.utils import utcnow


# ─── Seed configuration ──────────────────────────────────────────────
TODAY = date.today()
RNG = random.Random(20260425)  # Deterministic-ish across runs


def jitter(base: float, spread: float = 0.15) -> float:
    """Add ±spread% noise to an amount to make repeated charges look real."""
    return round(base * (1 + RNG.uniform(-spread, spread)), 2)


def random_day_in_month(y: int, m: int, weekday_bias: bool = False) -> date:
    """Random day of month. weekday_bias=True biases toward Mon-Fri."""
    last = calendar.monthrange(y, m)[1]
    for _ in range(20):
        d = RNG.randint(1, last)
        candidate = date(y, m, d)
        if not weekday_bias or candidate.weekday() < 5:
            return candidate
    return date(y, m, RNG.randint(1, last))


def months_back_iter(n: int):
    """Yield (year, month) tuples for the last n months including current."""
    y, m = TODAY.year, TODAY.month
    out = []
    for _ in range(n):
        out.append((y, m))
        m -= 1
        if m == 0:
            m = 12
            y -= 1
    return list(reversed(out))


# ═════════════════════════════════════════════════════════════════════
#   Static catalog of merchants used during synthetic txn generation.
# ═════════════════════════════════════════════════════════════════════

# Recurring monthly debits (mortgage and auto loan are special-cased).
# Optional `active_months` makes a merchant seasonal — TruGreen lawn care
# only posts April–October in Michigan.
RECURRING_BILLS = [
    # (day, name, amount, category, account_pref, active_months_or_None)
    (5,  "Apple Music",        10.99, "Subscriptions",      "chase_cc",    None),
    (10, "Adobe Creative Cloud", 59.99, "Subscriptions",     "chase_cc",    None),
    (12, "Comcast Internet",   89.99, "Bills & Utilities",  "wf_checking", None),
    (15, "Verizon Wireless",  120.00, "Bills & Utilities",  "wf_checking", None),
    (16, "Consumers Energy",  175.00, "Bills & Utilities",  "wf_checking", None),
    (18, "Netflix",            15.99, "Subscriptions",      "chase_cc",    None),
    (20, "Spotify",            11.99, "Subscriptions",      "chase_cc",    None),
    (22, "TruGreen",           87.99, "Home",               "wf_checking", [4, 5, 6, 7, 8, 9, 10]),
    (25, "Planet Fitness",     35.00, "Personal Care",      "chase_cc",    None),
    (27, "Disney Plus",        13.99, "Subscriptions",      "chase_cc",    None),
]

# Variable spending — pulled from these distributions each month
COSTCO_TRIPS_PER_MONTH = (3, 5)        # min, max
WHOLE_FOODS_TRIPS = (3, 5)
STARBUCKS_TRIPS = (8, 14)
RESTAURANT_TRIPS = (8, 12)
AMAZON_ORDERS = (5, 9)
TARGET_TRIPS = (2, 4)
GAS_FILLUPS = (3, 5)
RIDESHARE_TRIPS = (1, 4)

RESTAURANTS = [
    ("Chipotle", 14, 22, "Restaurants"),
    ("Panera Bread", 11, 19, "Restaurants"),
    ("Olive Garden", 38, 78, "Restaurants"),
    ("Buffalo Wild Wings", 28, 65, "Restaurants"),
    ("Local Cantina", 45, 110, "Restaurants"),
    ("Texas Roadhouse", 48, 95, "Restaurants"),
    ("DoorDash", 22, 65, "Restaurants"),
    ("Pizza Hut", 22, 48, "Restaurants"),
    ("Five Guys", 18, 35, "Restaurants"),
    ("Sushi Sasa", 55, 130, "Restaurants"),
]

GAS_STATIONS = [
    ("Shell", 38, 62, "Gas & Fuel"),
    ("Marathon", 35, 58, "Gas & Fuel"),
    ("BP", 40, 60, "Gas & Fuel"),
    ("Speedway", 36, 56, "Gas & Fuel"),
]

AMAZON_RANGES = [
    (15, 45, "Shopping"),
    (45, 95, "Shopping"),
    (95, 220, "Shopping"),
]

TARGET_RANGES = [(40, 120, "Shopping"), (60, 180, "Shopping")]

ENTERTAINMENT_OCCASIONAL = [
    ("AMC Theatres", 24, 48, "Entertainment"),
    ("Steam", 19, 60, "Entertainment"),
    ("Spotify", 11.99, 11.99, "Subscriptions"),  # extra family-plan upgrade
    ("Topgolf", 45, 110, "Entertainment"),
]

TRAVEL_TRIPS = [
    # Spread across the 12-month window — only fire for these months
    # (offset from TODAY in months back, list of (merchant, amount, category))
    (10, [  # ~10 months ago
        ("Delta Air Lines", 412.40, "Travel"),
        ("Airbnb", 845.00, "Travel"),
        ("Uber *Trip", 38.50, "Transportation"),
    ]),
    (4, [   # ~4 months ago
        ("SpringHill Suites by Marriott", 287.00, "Travel"),
        ("Delta Air Lines", 198.50, "Travel"),
    ]),
    (1, [   # last month
        ("Airbnb", 1836.93, "Travel"),
        ("SpringHill Suites by Marriott", 29.00, "Travel"),
    ]),
]

# December gift bump
HOLIDAY_GIFTS = [
    ("Best Buy", 245.00, "Shopping"),
    ("Etsy", 89.50, "Shopping"),
    ("Amazon.com", 178.99, "Shopping"),
    ("Target", 134.20, "Shopping"),
    ("Macy's", 215.00, "Shopping"),
]


# ═════════════════════════════════════════════════════════════════════
#   Top-level seeding orchestration
# ═════════════════════════════════════════════════════════════════════
def wipe_all_rows(db: Session) -> None:
    """Delete every row from every table, in FK-respecting reverse order.

    Schema is left intact — this is what we want for the in-app "Refresh
    demo data" button: same database file, same tables, just emptied and
    re-populated. Faster and safer than dropping/recreating tables.
    """
    for table in reversed(Base.metadata.sorted_tables):
        db.execute(table.delete())
    db.commit()


def seed_database(db: Session) -> dict:
    """Populate `db` with a fresh demo dataset. Wipes existing rows first.

    Returns a small summary dict the caller can log or surface to the UI.
    """
    wipe_all_rows(db)

    seed_user(db)
    businesses = seed_businesses(db)
    items = seed_plaid_items(db)
    accounts = seed_accounts(db, items)
    seed_mortgage_detail(db, accounts)
    seed_credit_card_details(db, accounts)
    manual_assets = seed_manual_assets(db, accounts)
    securities = seed_securities(db)
    seed_holdings(db, accounts, securities)
    # Investment buy/sell history — feeds the Trading Tax page (FIFO
    # matcher, wash-sale calculator, harvest finder, Form 8949 export).
    # Without this seed the page renders all the chrome but every
    # section says '0 closed positions'.
    inv_txn_count = seed_investment_transactions(db, accounts, securities)
    seed_category_rules(db)
    seed_business_rules(db, businesses)
    # Subscription-rule overrides — manual force-tag / force-not-tag
    # examples so the Subscriptions tab demos both auto-detection and
    # the user-override layer.
    seed_subscription_rules(db)
    seed_budgets(db)
    seed_savings_goals(db, accounts)
    txn_count = seed_transactions(db, accounts, businesses)
    # Anomaly-triggering recent transactions: a brand-new merchant + a
    # large transaction at an existing one. Inserted after the main seed
    # so they land within the last 14 days regardless of the month
    # generator's loop boundaries.
    seed_anomaly_demo_transactions(db, accounts)
    # Annual / one-time predictable expenses (property tax, auto reg,
    # car maintenance) so the Cash Flow Forecast surfaces something
    # beyond the monthly recurring bill set.
    seed_annual_one_time_expenses(db, accounts)
    # Sprinkle a handful of free-text notes on existing transactions so
    # the new TransactionDrawer notes field has examples to show.
    seed_transaction_notes(db)
    seed_net_worth_snapshots(db, accounts, manual_assets)
    db.commit()

    return {
        "accounts": len(accounts),
        "manual_assets": len(manual_assets),
        "transactions": txn_count,
        "holdings": 7,  # 4 Robinhood + 3 Fidelity, fixed in seed_holdings
        "investment_transactions": inv_txn_count,
        "securities": len(securities),
        "category_rules": 10,        # see seed_category_rules
        "business_rules": 5,         # see seed_business_rules
        "subscription_rules": 2,     # see seed_subscription_rules
        "savings_goals": 3,          # see seed_savings_goals
    }


def main(output_path: str) -> None:
    """CLI entry point. Builds a fresh DB file from scratch."""
    db_path = Path(output_path).resolve()
    if db_path.exists():
        db_path.unlink()
        print(f"Removed existing {db_path}")

    url = f"sqlite:///{db_path}"
    engine = create_engine(url, future=True)
    Base.metadata.create_all(engine)
    SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)

    db = SessionLocal()
    try:
        result = seed_database(db)
        print(f"\n✅ Seeded demo database at {db_path}")
        print(f"   {result['accounts']} accounts · {result['transactions']} transactions · "
              f"{result['holdings']} holdings · {result['manual_assets']} manual assets")
        print("   Login: demo / demo123 (auth bypassed when DEV_BYPASS_AUTH=true)")
    finally:
        db.close()


# ─── Users ────────────────────────────────────────────────────────────
def seed_user(db) -> User:
    user = User(
        username="demo",
        password_hash=hash_password("demo123"),
        totp_secret=generate_totp_secret(),
        totp_verified=True,
    )
    db.add(user)
    db.flush()
    print(f"User: demo / demo123")
    return user


# ─── Businesses ───────────────────────────────────────────────────────
def seed_businesses(db) -> dict:
    biz = Business(
        name="Carter Consulting LLC",
        color="#22d3ee",
        icon="briefcase",
        description="Side gig — freelance UX consulting",
        is_active=1,
    )
    db.add(biz)
    db.flush()
    return {"consulting": biz}


# ─── Plaid items ──────────────────────────────────────────────────────
def seed_plaid_items(db) -> dict:
    items = {}
    for key, item_id, inst_id, inst_name in [
        ("wf",       "demo_item_wf",       "ins_127989", "Wells Fargo"),
        ("chase",    "demo_item_chase",    "ins_56",     "Chase"),
        ("robinhood","demo_item_robinhood","ins_115617", "Robinhood"),
    ]:
        item = PlaidItem(
            item_id=item_id,
            access_token=f"demo-access-token-{key}",
            institution_id=inst_id,
            institution_name=inst_name,
            cursor=None,
        )
        db.add(item)
        items[key] = item
    db.flush()
    return items


# ─── Accounts ─────────────────────────────────────────────────────────
def seed_accounts(db, items: dict) -> dict:
    """Create the realistic mix:
      - Wells Fargo: checking, savings, mortgage
      - Chase: Sapphire credit card
      - Robinhood: brokerage
      - Manual: Apple Card, Fidelity 401(k)
    Returns dict keyed by short name.
    """
    accts = {}

    accts["wf_checking"] = Account(
        plaid_account_id="demo_acct_wf_chk",
        plaid_item_id=items["wf"].id,
        name="Everyday Checking",
        custom_name="Everyday Checking",
        type="depository",
        subtype="checking",
        institution_name="Wells Fargo",
        mask="4521",
        current_balance=8420.55,
        available_balance=8420.55,
        balance_as_of=TODAY,
    )

    accts["wf_savings"] = Account(
        plaid_account_id="demo_acct_wf_sav",
        plaid_item_id=items["wf"].id,
        name="Way2Save Savings",
        custom_name="Emergency Savings",
        type="depository",
        subtype="savings",
        institution_name="Wells Fargo",
        mask="7733",
        current_balance=22810.13,
        available_balance=22810.13,
        balance_as_of=TODAY,
    )

    # Mortgage: Plaid models loans as positive balances representing what's owed.
    accts["wf_mortgage"] = Account(
        plaid_account_id="demo_acct_wf_mtg",
        plaid_item_id=items["wf"].id,
        name="Home Mortgage",
        custom_name="Mortgage",
        type="loan",
        subtype="mortgage",
        institution_name="Wells Fargo",
        mask="3584",
        current_balance=285420.00,
        available_balance=None,
        balance_as_of=TODAY,
    )

    accts["chase_cc"] = Account(
        plaid_account_id="demo_acct_chase_sapphire",
        plaid_item_id=items["chase"].id,
        name="Sapphire Preferred",
        custom_name="Chase Sapphire",
        type="credit",
        subtype="credit card",
        institution_name="Chase",
        mask="9012",
        current_balance=1847.30,
        available_balance=13152.70,
        balance_as_of=TODAY,
    )

    # Apple Card is manual — updated via monthly statement. Seed its
    # balance_as_of to ~2 months ago so the new monthly-cadence stale
    # check correctly flags it as "previous month statement overdue"
    # — useful for demoing StaleBalanceAlert on the manual cadence.
    apple_card_as_of = TODAY.replace(day=1) - timedelta(days=20)
    accts["apple_card"] = Account(
        plaid_account_id=None,
        plaid_item_id=None,  # manual
        name="Apple Card",
        custom_name="Apple Card",
        type="credit",
        subtype="credit card",
        institution_name="Goldman Sachs",
        mask="0007",
        current_balance=642.18,
        available_balance=None,
        balance_as_of=apple_card_as_of,
    )

    accts["robinhood"] = Account(
        plaid_account_id="demo_acct_rh_brokerage",
        plaid_item_id=items["robinhood"].id,
        name="Robinhood Individual",
        custom_name="Robinhood",
        type="investment",
        subtype="brokerage",
        institution_name="Robinhood",
        mask="2244",
        current_balance=18250.40,
        available_balance=613.20,
        balance_as_of=TODAY,
    )

    accts["fidelity_401k"] = Account(
        plaid_account_id=None,
        plaid_item_id=None,  # manual investment account
        name="Fidelity NetBenefits 401(k)",
        custom_name="401(k)",
        type="investment",
        subtype="401k",
        institution_name="Fidelity",
        mask="9988",
        current_balance=94800.00,
        available_balance=3575.00,
        balance_as_of=TODAY,
        tax_bucket="tax_deferred",
    )

    # HELOC — exercises the new HELOC-specific UI on the Loans page:
    # interest-only draw period, payment-shock callout, two-phase
    # amortization. Plaid emits this as type="loan" with a
    # subtype variant ("home equity"); the Loans page detects it via
    # isHelocSubtype() and renders the HelocPanel.
    accts["wf_heloc"] = Account(
        plaid_account_id="demo_acct_wf_heloc",
        plaid_item_id=items["wf"].id,
        name="Home Equity Line of Credit",
        custom_name="HELOC",
        type="loan",
        subtype="home equity",
        institution_name="Wells Fargo",
        mask="6612",
        current_balance=42500.00,
        available_balance=57500.00,  # $100k line, $42.5k drawn
        balance_as_of=TODAY,
    )

    # HSA — exercises the HSA contribution tracker tile + the 4th
    # tax bucket in the retirement simulator + the Tax Prep Pack page.
    # Without this, the HSA tracker on the dashboard shows the empty
    # state and the retirement simulator's HSA bucket is $0.
    accts["healthequity_hsa"] = Account(
        plaid_account_id=None,
        plaid_item_id=None,  # manual — HealthEquity doesn't have a clean Plaid feed
        name="HealthEquity HSA",
        custom_name="HSA",
        type="investment",
        subtype="hsa",
        institution_name="HealthEquity",
        mask="0042",
        current_balance=14250.00,
        available_balance=14250.00,
        balance_as_of=TODAY,
        tax_bucket="hsa",
    )

    # Roth IRA — gives the retirement simulator's Roth bucket a
    # non-zero starting balance so the bucket-color stack on the
    # projection chart isn't dominated entirely by tax_deferred. Also
    # demonstrates per-account tax_bucket assignment (#37).
    accts["fidelity_roth"] = Account(
        plaid_account_id=None,
        plaid_item_id=None,
        name="Fidelity Roth IRA",
        custom_name="Roth IRA",
        type="investment",
        subtype="ira",
        institution_name="Fidelity",
        mask="7711",
        current_balance=38400.00,
        available_balance=38400.00,
        balance_as_of=TODAY,
        tax_bucket="roth",
    )

    for a in accts.values():
        db.add(a)
    db.flush()
    print(f"Accounts: {len(accts)}")
    return accts


# ─── Liability detail ────────────────────────────────────────────────
def seed_mortgage_detail(db, accounts: dict) -> None:
    mtg = accounts["wf_mortgage"]
    detail = MortgageDetail(
        account_id=mtg.id,
        account_number="****3584",
        interest_rate_percentage=6.125,
        interest_rate_type="fixed",
        loan_term="30y",
        loan_type_description="Conventional",
        origination_date=TODAY - timedelta(days=730),
        origination_principal_amount=315000.00,
        maturity_date=TODAY + timedelta(days=365 * 28),
        next_monthly_payment=1399.57,
        next_payment_due_date=date(TODAY.year, TODAY.month, 1) + timedelta(days=32),
        last_payment_amount=1399.57,
        last_payment_date=date(TODAY.year, TODAY.month, 1),
        ytd_interest_paid=4820.10,
        ytd_principal_paid=2156.80,
        escrow_balance=2415.00,
        has_pmi=False,
        has_prepayment_penalty=False,
        property_street="1428 Maple Hollow Lane",
        property_city="Kalamazoo",
        property_region="MI",
        property_postal_code="49006",
        property_country="US",
    )
    db.add(detail)


def seed_credit_card_details(db, accounts: dict) -> None:
    chase = accounts["chase_cc"]
    apple = accounts["apple_card"]

    db.add(CreditCardDetail(
        account_id=chase.id,
        aprs=[{"apr_percentage": 22.99, "apr_type": "purchase_apr", "balance_subject_to_apr": 0.0}],
        is_overdue=False,
        last_statement_balance=1847.30,
        last_statement_issue_date=TODAY - timedelta(days=12),
        last_payment_amount=2150.00,
        last_payment_date=TODAY - timedelta(days=18),
        minimum_payment_amount=35.00,
        next_payment_due_date=TODAY + timedelta(days=8),
    ))

    db.add(CreditCardDetail(
        account_id=apple.id,
        aprs=[{"apr_percentage": 19.24, "apr_type": "purchase_apr", "balance_subject_to_apr": 0.0}],
        is_overdue=False,
        last_statement_balance=642.18,
        last_statement_issue_date=TODAY - timedelta(days=6),
        last_payment_amount=412.00,
        last_payment_date=TODAY - timedelta(days=14),
        minimum_payment_amount=25.00,
        next_payment_due_date=TODAY + timedelta(days=15),
    ))


# ─── Manual assets/liabilities ───────────────────────────────────────
def seed_manual_assets(db, accounts: dict) -> dict:
    home = ManualAsset(
        name="Maple Hollow home",
        side="asset",
        type="real_estate",
        current_value=425000.00,
        value_as_of=TODAY - timedelta(days=10),
        notes="Zestimate as of last check",
        address_street="1428 Maple Hollow Lane",
        address_city="Kalamazoo",
        address_region="MI",
        address_postal_code="49006",
        address_country="US",
        plaid_mortgage_account_id=accounts["wf_mortgage"].id,
    )
    auto_loan = ManualAsset(
        name="Hyundai Tucson auto loan",
        side="liability",
        type="auto_loan",
        current_value=21500.00,
        value_as_of=TODAY - timedelta(days=4),
        notes="Hyundai Motor Finance · 32 months remaining · matures 2028-12",
    )
    # Student loan — a third loan on the Loans page so the multi-loan
    # stacked-timeline view (task #118) actually has 3+ tiers worth of
    # signal. Also exercises the GraduationCap icon and the
    # "subtype=student" override branch in iconFor().
    student_loan = ManualAsset(
        name="Nelnet student loans",
        side="liability",
        type="student_loan",
        current_value=18750.00,
        value_as_of=TODAY - timedelta(days=2),
        notes="Federal Direct Unsubsidized · 5.50% · ~$240/mo · 8 yrs remaining",
    )
    db.add_all([home, auto_loan, student_loan])
    db.flush()
    return {"home": home, "auto_loan": auto_loan, "student_loan": student_loan}


# ─── Securities & holdings ───────────────────────────────────────────
def seed_securities(db) -> dict:
    """Create Security rows for the holdings we'll attach. A few real index
    funds and a handful of stocks — fake CUSIPs but realistic tickers."""
    secs = {}
    catalog = [
        # (key, ticker, name, type, price)
        ("FXAIX", "FXAIX", "Fidelity 500 Index", "mutual fund", 185.50),
        ("FZROX", "FZROX", "Fidelity ZERO Total Market Index", "mutual fund", 21.80),
        ("VBTLX", "VBTLX", "Vanguard Total Bond Market Index", "mutual fund", 9.85),
        ("VOO",   "VOO",   "Vanguard S&P 500 ETF", "etf", 487.50),
        ("AAPL",  "AAPL",  "Apple Inc.", "equity", 238.40),
        ("MSFT",  "MSFT",  "Microsoft Corp.", "equity", 452.10),
        ("NVDA",  "NVDA",  "NVIDIA Corp.", "equity", 145.20),
    ]
    for key, ticker, name, type_, price in catalog:
        sec = Security(
            plaid_security_id=f"demo_sec_{key.lower()}",
            ticker_symbol=ticker,
            name=name,
            type=type_,
            iso_currency_code="USD",
            close_price=price,
            close_price_as_of=utcnow(),
            is_cash_equivalent=False,
        )
        db.add(sec)
        secs[key] = sec
    db.flush()
    return secs


def seed_holdings(db, accounts: dict, securities: dict) -> None:
    rh = accounts["robinhood"]
    fid = accounts["fidelity_401k"]

    # Robinhood — small individual stock account
    for key, qty in [("VOO", 18), ("AAPL", 22), ("MSFT", 8), ("NVDA", 22)]:
        sec = securities[key]
        db.add(Holding(
            account_id=rh.id,
            plaid_security_id=sec.plaid_security_id,
            quantity=qty,
            institution_price=sec.close_price,
            institution_price_as_of=utcnow(),
            institution_value=round(qty * sec.close_price, 2),
            cost_basis=round(qty * sec.close_price * RNG.uniform(0.78, 0.95), 2),
            iso_currency_code="USD",
        ))

    # Fidelity 401(k) — index-fund heavy
    for key, qty in [("FXAIX", 95.234), ("FZROX", 1480.891), ("VBTLX", 380.234)]:
        sec = securities[key]
        db.add(Holding(
            account_id=fid.id,
            plaid_security_id=sec.plaid_security_id,
            quantity=qty,
            institution_price=sec.close_price,
            institution_price_as_of=utcnow(),
            institution_value=round(qty * sec.close_price, 2),
            cost_basis=round(qty * sec.close_price * RNG.uniform(0.65, 0.88), 2),
            iso_currency_code="USD",
        ))

    # HSA — invested in a single S&P index fund. Most HealthEquity
    # users invest the portion above the cash sweep minimum; modeled
    # here as a single FXAIX position so the Investments page surfaces
    # the HSA's allocation under the asset-class breakdown.
    hsa = accounts.get("healthequity_hsa")
    if hsa is not None:
        sec = securities["FXAIX"]
        # ~$12k invested out of $14.25k (rest in cash sweep at the brokerage)
        qty = round(12000 / sec.close_price, 3)
        db.add(Holding(
            account_id=hsa.id,
            plaid_security_id=sec.plaid_security_id,
            quantity=qty,
            institution_price=sec.close_price,
            institution_price_as_of=utcnow(),
            institution_value=round(qty * sec.close_price, 2),
            cost_basis=round(qty * sec.close_price * RNG.uniform(0.7, 0.9), 2),
            iso_currency_code="USD",
        ))

    # Roth IRA — also a couple of broad index positions so the bucket
    # isn't empty and the Investments page allocation chart includes it.
    roth = accounts.get("fidelity_roth")
    if roth is not None:
        for key, dollars in [("VOO", 25000), ("FXAIX", 13400)]:
            sec = securities[key]
            qty = round(dollars / sec.close_price, 3)
            db.add(Holding(
                account_id=roth.id,
                plaid_security_id=sec.plaid_security_id,
                quantity=qty,
                institution_price=sec.close_price,
                institution_price_as_of=utcnow(),
                institution_value=round(qty * sec.close_price, 2),
                cost_basis=round(qty * sec.close_price * RNG.uniform(0.7, 0.92), 2),
                iso_currency_code="USD",
            ))


# ─── Business tagging rules ──────────────────────────────────────────
def seed_business_rules(db, businesses: dict) -> None:
    """Pattern-based business tagging — same shape as CategoryRule but for
    business_id. Demo seeds a handful so the Rules page has rows AND so
    new transactions matching these patterns auto-tag on sync.
    """
    biz_id = businesses["consulting"].id
    for pattern, priority in [
        ("adobe", 100),         # Adobe Creative Cloud — work tool
        ("github", 100),
        ("digitalocean", 100),
        ("stripe", 50),         # Stripe payouts — high priority, distinct merchant
        ("intuit", 100),        # QuickBooks
    ]:
        db.add(BusinessRule(pattern=pattern, business_id=biz_id, priority=priority))
    db.flush()


# ─── Savings goals ───────────────────────────────────────────────────
def seed_savings_goals(db, accounts: dict) -> None:
    """Three goals exercising different shapes:
      - Emergency fund: tracks the savings account balance directly.
      - Vacation fund: manually tracked dollar amount (not tied to an
        account — user enters progress by hand).
      - House down payment: long-horizon, multi-account.
    """
    db.add(SavingsGoal(
        name="Emergency Fund",
        target_amount=20000.00,
        target_date=TODAY + timedelta(days=180),
        goal_type="emergency",
        notes="3-month expenses cushion",
        source_account_ids=[accounts["wf_savings"].id],
        manual_current_amount=None,
        is_active=1,
    ))
    db.add(SavingsGoal(
        name="Hawaii 2027",
        target_amount=6500.00,
        target_date=date(2027, 6, 1),
        goal_type="custom",
        notes="Flights + Airbnb + activities",
        source_account_ids=[],
        manual_current_amount=1850.00,   # user-entered, not from any account
        is_active=1,
    ))
    db.add(SavingsGoal(
        name="House Down Payment",
        target_amount=80000.00,
        target_date=date(2028, 12, 31),
        goal_type="custom",
        notes="20% down on a $400k place",
        source_account_ids=[
            accounts["wf_savings"].id,
            accounts["robinhood"].id,
        ],
        manual_current_amount=None,
        is_active=1,
    ))
    db.flush()


# ─── Categorization rules ────────────────────────────────────────────
def seed_category_rules(db) -> None:
    rules = [
        ("starbucks", "Food & Dining"),
        ("costco", "Groceries"),
        ("whole foods", "Groceries"),
        ("amazon", "Shopping"),
        ("netflix", "Entertainment"),
        ("spotify", "Subscriptions"),
        ("uber", "Transportation"),
        ("shell", "Gas & Fuel"),
        ("marathon", "Gas & Fuel"),
        ("trugreen", "Home"),
    ]
    for pattern, cat in rules:
        db.add(CategoryRule(pattern=pattern, category=cat))
    db.flush()


# ─── Budgets ─────────────────────────────────────────────────────────
def seed_budgets(db) -> None:
    """Budgets for the current month + previous month. Realistic-looking
    limits for a household with ~$8k monthly spend."""
    for offset in (0, 1):  # current and previous
        y, m = TODAY.year, TODAY.month - offset
        if m <= 0:
            m += 12
            y -= 1
        budget = Budget(month=m, year=y, total_limit=4500.00)
        db.add(budget)
        db.flush()
        for cat, amt in [
            ("Groceries", 800.00),
            ("Restaurants", 350.00),
            ("Shopping", 500.00),
            ("Entertainment", 150.00),
            ("Gas & Fuel", 300.00),
            ("Subscriptions", 250.00),
        ]:
            db.add(BudgetCategory(budget_id=budget.id, category=cat, limit_amount=amt))


# ─── Transactions ────────────────────────────────────────────────────
def seed_transactions(db, accounts: dict, businesses: dict) -> int:
    """Generate ~12 months of realistic transaction history.

    Conventions:
      - Expenses: positive amounts (this is the Tusk Ledger convention,
        matching Plaid's "outflow=positive" sign)
      - Income/credits: negative amounts

    Returns the total number of transactions inserted.
    """
    txns_added = 0

    for (y, m) in months_back_iter(12):
        txns_added += _seed_month(db, y, m, accounts, businesses)

    db.flush()
    return txns_added


def _seed_month(db, y: int, m: int, accounts: dict, businesses: dict) -> int:
    """All the recurring + variable transactions for a single month."""
    last_day = calendar.monthrange(y, m)[1]
    month_start = date(y, m, 1)
    cur_month = (y == TODAY.year and m == TODAY.month)
    today_in_month = TODAY if cur_month else date(y, m, last_day)
    n = 0

    def add(account, name, amount, day, category, *,
            merchant_name=None, is_transfer=False, business_id=None):
        nonlocal n
        # Clamp day to month length, then skip if this would land in the future
        # (only matters for the current month — for prior months, today_in_month
        # is the last day of that month so this is a no-op).
        day = min(day, last_day)
        if day > today_in_month.day:
            return
        db.add(Transaction(
            plaid_transaction_id=f"demo_txn_{y}{m:02d}{n:04d}",
            account_id=account.id,
            name=name,
            merchant_name=merchant_name or name.split(" *")[0],
            amount=round(amount, 2),
            date=date(y, m, day),
            category=category,
            custom_category=None,
            is_transfer=is_transfer,
            business_id=business_id,
        ))
        n += 1

    chk = accounts["wf_checking"]
    sav = accounts["wf_savings"]
    chase = accounts["chase_cc"]
    apple = accounts["apple_card"]

    # ── Income ─────────────────────────────────────────────
    # Two paychecks per month for Alex, two for partner
    for pay_day, payer, amt in [
        (1,  "Acme Corp Payroll",      -3825.00),
        (15, "Acme Corp Payroll",      -3825.00),
        (5,  "Brightline Health Inc",  -2148.50),
        (20, "Brightline Health Inc",  -2148.50),
    ]:
        if pay_day <= last_day:
            add(chk, payer, jitter(amt, 0.02), pay_day, "Income",
                merchant_name=payer.split(" Payroll")[0])

    # Occasional consulting income (every other month)
    if m % 2 == 0:
        add(chk, "Wire Transfer · Carter Consulting LLC", -1850.00,
            18, "Income", merchant_name="Carter Consulting",
            business_id=businesses["consulting"].id)

    # ── Loan / mortgage ────────────────────────────────────
    add(chk, "WF HOME MTG AUTO PAY", 1399.57, 1, "Loan Payments",
        merchant_name="Wells Fargo Mortgage", is_transfer=True)
    add(chk, "Hyundai Motor Finance", 419.62, 7, "Loan Payments",
        is_transfer=True)

    # ── Internal transfer checking → savings ──────────────
    add(chk, "Online Transfer to Way2Save", 500.00, 25, "Transfer",
        merchant_name="Internal Transfer", is_transfer=True)
    add(sav, "Online Transfer from Everyday Checking", -500.00, 25, "Transfer",
        merchant_name="Internal Transfer", is_transfer=True)

    # ── Recurring bills/subscriptions ──────────────────────
    for day, name, amt, cat, acct_key, active in RECURRING_BILLS:
        if day > last_day:
            continue
        if active is not None and m not in active:
            continue  # off-season for this merchant
        acct = accounts[acct_key]
        add(acct, name, jitter(amt, 0.03 if "Energy" in name else 0.0),
            day, cat)

    # ── Apple Card monthly statement payment ──────────────
    add(chk, "Apple Card Payment", 425.00 + RNG.uniform(-90, 130),
        20, "Loan Payments", merchant_name="Apple Card", is_transfer=True)

    # ── Costco runs ────────────────────────────────────────
    for _ in range(RNG.randint(*COSTCO_TRIPS_PER_MONTH)):
        amt = RNG.uniform(82, 215)
        add(chase, "Costco Wholesale", amt, RNG.randint(2, 28), "Groceries",
            merchant_name="Costco")

    # ── Whole Foods ───────────────────────────────────────
    for _ in range(RNG.randint(*WHOLE_FOODS_TRIPS)):
        amt = RNG.uniform(45, 110)
        add(chase, "Whole Foods Market", amt, RNG.randint(2, 28), "Groceries",
            merchant_name="Whole Foods")

    # ── Starbucks ─────────────────────────────────────────
    for _ in range(RNG.randint(*STARBUCKS_TRIPS)):
        amt = RNG.uniform(4.50, 9.50)
        add(chase, "Starbucks", amt, RNG.randint(1, 28), "Food & Dining",
            merchant_name="Starbucks")

    # ── Restaurants ───────────────────────────────────────
    for _ in range(RNG.randint(*RESTAURANT_TRIPS)):
        merchant, lo, hi, cat = RNG.choice(RESTAURANTS)
        add(chase, merchant, RNG.uniform(lo, hi), RNG.randint(1, 28), cat)

    # ── Amazon / Target / shopping ────────────────────────
    for _ in range(RNG.randint(*AMAZON_ORDERS)):
        lo, hi, cat = RNG.choice(AMAZON_RANGES)
        add(apple, "Amazon.com", RNG.uniform(lo, hi), RNG.randint(1, 28),
            cat, merchant_name="Amazon")
    for _ in range(RNG.randint(*TARGET_TRIPS)):
        lo, hi, cat = RNG.choice(TARGET_RANGES)
        add(chase, "Target", RNG.uniform(lo, hi), RNG.randint(1, 28), cat)

    # ── Gas ───────────────────────────────────────────────
    for _ in range(RNG.randint(*GAS_FILLUPS)):
        merchant, lo, hi, cat = RNG.choice(GAS_STATIONS)
        add(chase, merchant, RNG.uniform(lo, hi), RNG.randint(1, 28), cat)

    # ── Rideshare ─────────────────────────────────────────
    for _ in range(RNG.randint(*RIDESHARE_TRIPS)):
        add(apple, "UBER *TRIP", RNG.uniform(11, 38),
            RNG.randint(1, 28), "Transportation", merchant_name="Uber")

    # ── Occasional entertainment ──────────────────────────
    if RNG.random() < 0.7:
        merchant, lo, hi, cat = RNG.choice(ENTERTAINMENT_OCCASIONAL)
        add(chase, merchant, RNG.uniform(lo, hi), RNG.randint(2, 27), cat)

    # ── Travel (sparse) ───────────────────────────────────
    months_back = (TODAY.year - y) * 12 + (TODAY.month - m)
    for offset, trip in TRAVEL_TRIPS:
        if months_back == offset:
            for merchant, amt, cat in trip:
                add(chase, merchant, amt, RNG.randint(2, 25), cat)

    # ── Holiday gift bump in December ─────────────────────
    if m == 12:
        for merchant, amt, cat in HOLIDAY_GIFTS:
            add(chase, merchant, amt, RNG.randint(8, 22), cat)

    return n


# ─── Net worth snapshots ─────────────────────────────────────────────
def seed_net_worth_snapshots(db, accounts: dict, manual_assets: dict) -> None:
    """Weekly snapshots for the past year. Net worth grows roughly linearly
    with some noise — close enough to look real on the chart."""
    home_value = manual_assets["home"].current_value
    auto_loan = manual_assets["auto_loan"].current_value

    end_assets = (
        accounts["wf_checking"].current_balance
        + accounts["wf_savings"].current_balance
        + accounts["robinhood"].current_balance
        + accounts["fidelity_401k"].current_balance
        + home_value
    )
    end_liabilities = (
        accounts["wf_mortgage"].current_balance
        + accounts["chase_cc"].current_balance
        + accounts["apple_card"].current_balance
        + auto_loan
    )

    # Build a unified set of dates: weekly granularity for the deep
    # historical view (52-mo trend chart, year-over-year overlay) plus
    # daily granularity for the last 30 days so the Dashboard's
    # DailySnapshot tile (which queries the most recent daily delta)
    # has something to show. Without the daily slice the snapshot tile
    # silently returns null and the dashboard drops it from the grid.
    weeks = 52
    snapshot_dates = set()
    for i in range(weeks + 1):
        snapshot_dates.add(TODAY - timedelta(weeks=(weeks - i)))
    # Last 30 days, every day. Set semantics dedupes any overlap with
    # the weekly grid above.
    for i in range(30):
        snapshot_dates.add(TODAY - timedelta(days=i))

    # Sort oldest-first so the progress ratio (used to ramp the
    # baseline) is monotonic.
    sorted_dates = sorted(snapshot_dates)
    oldest = sorted_dates[0]
    span_days = max(1, (TODAY - oldest).days)

    for d in sorted_dates:
        # progress: 0.0 at the oldest snapshot, 1.0 today. Replaces
        # the old i/weeks calculation so daily snapshots in the
        # densified recent window get a smooth ramp rather than the
        # weekly-step jumps.
        progress = (d - oldest).days / span_days

        # Older snapshots: ~$50k less in investments, ~$8k less savings,
        # ~$10k more in mortgage/loan. Then ramp linearly with noise.
        invest = (accounts["robinhood"].current_balance
                  + accounts["fidelity_401k"].current_balance) - (1 - progress) * 50000
        sav = accounts["wf_savings"].current_balance - (1 - progress) * 8000
        chk = accounts["wf_checking"].current_balance + RNG.uniform(-1500, 1500)
        mtg = accounts["wf_mortgage"].current_balance + (1 - progress) * 9500
        cc = accounts["chase_cc"].current_balance * RNG.uniform(0.4, 1.4)
        apple_cc = accounts["apple_card"].current_balance * RNG.uniform(0.3, 1.6)
        auto = auto_loan + (1 - progress) * 10500
        home_now = home_value * (0.96 + 0.04 * progress)  # mild appreciation

        assets = chk + sav + invest + home_now
        liabilities = mtg + cc + apple_cc + auto
        nw = assets - liabilities

        db.add(NetWorthSnapshot(
            date=d,
            total_assets=round(assets, 2),
            total_liabilities=round(liabilities, 2),
            net_worth=round(nw, 2),
            account_balances={
                "checking": round(chk, 2),
                "savings": round(sav, 2),
                "investments": round(invest, 2),
                "home": round(home_now, 2),
                "mortgage": round(mtg, 2),
                "chase_cc": round(cc, 2),
                "apple_card": round(apple_cc, 2),
                "auto_loan": round(auto, 2),
            },
        ))
    db.flush()


# ─── Insight-anomaly demo transactions ──────────────────────────────
def seed_anomaly_demo_transactions(db, accounts: dict) -> None:
    """Insert recent transactions deliberately shaped to trip the anomaly
    detector so the InsightsBar always has at least 2-3 cards to show.

    Three signals to demo:
      - first-time merchant (Patagonia $187, > $50, last 14 days)
      - large-transaction (Costco $612.40, ~3x typical Costco visit)
      - implicit category-up via a flurry of recent Travel charges that
        wouldn't normally appear at this point in the month
    """
    chase_cc = accounts["chase_cc"]
    wf_chk = accounts["wf_checking"]

    # Brand-new merchant — never appeared in any prior month
    db.add(Transaction(
        plaid_transaction_id="demo_anomaly_patagonia",
        account_id=chase_cc.id,
        name="PATAGONIA #4521",
        merchant_name="Patagonia",
        amount=187.43,
        currency="USD",
        date=TODAY - timedelta(days=2),
        pending=False,
        category="Shopping",
    ))

    # Unusually large at an existing merchant (Costco's typical range is
    # $80–$220, see VARIABLE generators above)
    db.add(Transaction(
        plaid_transaction_id="demo_anomaly_costco_big",
        account_id=chase_cc.id,
        name="COSTCO WHSE #0744",
        merchant_name="Costco",
        amount=612.40,
        currency="USD",
        date=TODAY - timedelta(days=1),
        pending=False,
        category="Groceries",
        notes="Bulk shop — included new mattress + airfryer",
    ))

    # Travel category bump — a couple of unexpected last-week charges
    for offset, merchant, amt in [
        (3, "Delta Air Lines", 348.20),
        (5, "Hyatt Place", 412.00),
        (1, "Uber *Trip", 47.85),
    ]:
        db.add(Transaction(
            plaid_transaction_id=f"demo_anomaly_travel_{offset}",
            account_id=chase_cc.id,
            name=merchant.upper(),
            merchant_name=merchant,
            amount=amt,
            currency="USD",
            date=TODAY - timedelta(days=offset),
            pending=False,
            category="Travel",
        ))

    db.flush()


# ─── Transaction notes ───────────────────────────────────────────────
def seed_transaction_notes(db) -> None:
    """Attach free-text notes to a handful of existing transactions so
    the new TransactionDrawer notes field has examples. Pattern-matches
    on merchant_name so it's robust to id changes between seed runs.

    Picks one per merchant (the most recent matching txn) so the demo
    isn't drowned in repetitive notes.
    """
    notes_to_attach = [
        ("Costco",       "Reimbursable — split with neighbor for joint Costco run"),
        ("Delta Air Lines", "Conference travel — keep for Carter Consulting expense report"),
        ("Comcast Internet", "Plan upgraded to gigabit on 03/15"),
        ("Best Buy",     "Gift for Sarah — birthday"),
        ("TruGreen",     "Spring application — pre-emergent"),
    ]
    for merchant, note in notes_to_attach:
        txn = (
            db.query(Transaction)
            .filter(Transaction.merchant_name == merchant)
            .order_by(Transaction.date.desc())
            .first()
        )
        if txn is not None:
            txn.notes = note
    db.flush()


# ─── Investment transactions (Trading Tax page) ──────────────────────
def seed_investment_transactions(db, accounts: dict, securities: dict) -> int:
    """Buy/sell history for the Robinhood account so the Trading Tax
    page renders meaningful content instead of empty sections.

    Designed to exercise every major Trading-Tax feature in one demo:
      * FIFO lot matching — multiple buys per ticker so a sell pulls
        from the oldest lot first.
      * Realized P&L — at least one sell at a gain and one at a loss.
      * Wash-sale calculator — a sell at a loss followed by a buy of
        the same security inside the 30-day replacement window. The
        chain-correct wash-sale detector should highlight the
        disallowed loss.
      * Tax-loss harvest finder — at least one open position with an
        unrealized loss large enough to surface as a candidate.
      * Form 8949 CSV export — closed positions need full date / cost
        basis / proceeds so the row is complete.
      * Quarterly pacing — closed positions distributed across the
        year so the YTD vs prior-quarter chart isn't flat.

    All transactions land on the Robinhood account (the only one with
    a brokerage subtype). The 401(k), HSA, and Roth accounts are
    intentionally NOT given investment transactions — those are
    accumulation-only buckets in the demo persona's mental model and
    showing realized P&L there would be confusing.

    Returns the count of inserted rows so seed_database can include
    it in the summary.
    """
    rh = accounts["robinhood"]
    txns = []

    def _add(date_, type_, sec_key, qty, price, name=None, fees=0.0, subtype=None):
        sec = securities[sec_key]
        # amount = positive = cash OUT of account (buy), negative = cash IN
        # (sell) — matches Plaid's sign convention so the trading-tax
        # service doesn't need to special-case the demo data.
        cash = qty * price
        amount = round(cash if type_ == "buy" else -cash, 2)
        txns.append(InvestmentTransaction(
            plaid_investment_transaction_id=f"demo_inv_{len(txns):04d}_{type_}_{sec_key.lower()}",
            account_id=rh.id,
            plaid_security_id=sec.plaid_security_id,
            date=date_,
            name=name or f"{type_.upper()} {sec.ticker_symbol or sec_key}",
            type=type_,
            subtype=subtype,
            quantity=round(qty if type_ == "buy" else -qty, 4),
            price=round(price, 4),
            amount=amount,
            fees=fees,
            iso_currency_code="USD",
        ))

    # Helper: return a date N months back from TODAY, on a weekday.
    def _months_ago(n: int, day: int = 15) -> date:
        m = TODAY.month - n
        y = TODAY.year
        while m <= 0:
            m += 12
            y -= 1
        d = date(y, m, min(day, 28))
        # Bump to weekday — markets are closed on weekends.
        while d.weekday() >= 5:
            d += timedelta(days=1)
        return d

    # ── VOO accumulation: 4 buys building a cost basis (FIFO matters) ─
    _add(_months_ago(11, 8),  "buy", "VOO", 4, 412.50, name="BUY VANGUARD S&P 500")
    _add(_months_ago(8, 12),  "buy", "VOO", 5, 438.20, name="BUY VANGUARD S&P 500")
    _add(_months_ago(5, 17),  "buy", "VOO", 6, 471.40, name="BUY VANGUARD S&P 500")
    _add(_months_ago(2, 9),   "buy", "VOO", 3, 502.10, name="BUY VANGUARD S&P 500")

    # ── AAPL: bought, sold partial at a gain (Q2-ish) ─────────────────
    _add(_months_ago(10, 14), "buy",  "AAPL", 12, 178.20)
    _add(_months_ago(7, 22),  "buy",  "AAPL", 10, 191.80)
    _add(_months_ago(3, 11),  "sell", "AAPL", 6,  225.40, name="SELL APPLE INC")
    # Long-term gain: oldest 6 of 12 from -10mo @ 178.20 → ~$283 gain

    # ── MSFT: classic wash-sale setup ─────────────────────────────────
    # Buy → sell at LOSS → buy back within 30 days = washed.
    _add(_months_ago(6, 5),   "buy",  "MSFT", 5,  428.10)
    _add(_months_ago(2, 3),   "sell", "MSFT", 5,  389.40, name="SELL MICROSOFT (LOSS)")
    # Replacement buy 18 days after the loss sale — INSIDE the 30-day
    # wash-sale window. The chain-correct detector should flag the
    # full $193.50 loss as disallowed and roll into the replacement
    # lot's adjusted basis.
    _add(_months_ago(2, 3) + timedelta(days=18), "buy", "MSFT", 3, 401.20,
         name="BUY MICROSOFT (replacement, washed)")

    # ── NVDA: pure unrealized loss — feeds the harvest finder ─────────
    # Bought near a peak, current price below cost basis — show up as
    # a 'tax-loss harvesting candidate' on the Trading Tax page.
    _add(_months_ago(4, 19),  "buy",  "NVDA", 8,  138.90)
    # No sell — the open position carries the unrealized loss vs the
    # current institution_price set in seed_holdings (which is set
    # below cost basis via the cost_basis multiplier).

    # ── A small dividend, just to show the type filter works ──────────
    _add(_months_ago(1, 27),  "cash", "VOO", 0, 0,
         name="CASH DIVIDEND VOO",
         subtype="dividend")
    # Override amount/quantity for the dividend row so it doesn't show
    # as a $0 row. Negative amount = cash IN.
    txns[-1].quantity = 0
    txns[-1].price = 0
    txns[-1].amount = -47.50  # ~$0.40/share × 18 shares — quarterly distribution

    for t in txns:
        db.add(t)
    db.flush()
    print(f"Investment transactions: {len(txns)}")
    return len(txns)


# ─── Subscription rule overrides ─────────────────────────────────────
def seed_subscription_rules(db) -> None:
    """Manual force-tag / force-not-tag examples so the Subscriptions
    tab demos the override layer alongside the auto-detector.

    Without these, every demoed subscription is auto-detected, which
    leaves the SubscriptionRule feature invisible — it looks like the
    app has no manual control. Two seeded rows:

      1. force_subscription on a brand-new SaaS (Linear) that's only
         been charged once — too new for the auto-detector to flag,
         but the user knows it's an annual sub.
      2. force_not_subscription on Apple (the user's Apple Card hits
         a similar amount monthly by coincidence — appears recurring
         but isn't actually a subscription cycle).
    """
    db.add(SubscriptionRule(
        pattern="linear",
        kind=KIND_FORCE_SUB,
        priority=100,
        notes="Annual sub, only charged once so far — demo of the manual force-tag feature.",
    ))
    db.add(SubscriptionRule(
        pattern="apple.com/bill",
        kind=KIND_FORCE_NOT_SUB,
        priority=100,
        notes="Apple iCloud + App Store charges hit the same amount most months by coincidence; "
              "not a real subscription cycle. Force-untagged to keep the Subscriptions list clean.",
    ))
    db.flush()


# ─── Annual / one-time predictable expenses ──────────────────────────
def seed_annual_one_time_expenses(db, accounts: dict) -> None:
    """One-shot expenses that recur annually or semi-annually so the
    Cash Flow Forecast surfaces context-aware bumps beyond the monthly
    recurring bill set. Seeded as historical Transactions (in past
    months) so the recurrence detector sees them and predicts the next
    occurrence in its forward window.

    Each expense gets two occurrences (this year and prior year, same
    month) so the detector treats it as 'annual' rather than 'one-off'.
    Without two occurrences, /api/analytics/cash-flow-forecast doesn't
    project them forward.
    """
    chk = accounts["wf_checking"]
    chase_cc = accounts["chase_cc"]

    # Each tuple: (anchor_month_offset_from_current, amount, merchant,
    #              category, account, descriptor)
    annual_expenses = [
        # Property tax — typically Nov / May for many counties (one cycle
        # to keep it simple). $4,500 paid via checking.
        (-6,  4500.00, "Maricopa County Treasurer", "Taxes", chk,
         "PROPERTY TAX 2ND HALF"),
        (-18, 4500.00, "Maricopa County Treasurer", "Taxes", chk,
         "PROPERTY TAX 2ND HALF"),

        # Auto registration / emissions — annual, typically in birth
        # month. $382 via Chase CC for points.
        (-7, 382.00, "AZ MVD", "Government", chase_cc,
         "AZ MVD VEHICLE REGISTRATION"),
        (-19, 365.00, "AZ MVD", "Government", chase_cc,
         "AZ MVD VEHICLE REGISTRATION"),

        # Major car maintenance every ~6 months — alternates between
        # tire rotation and a more substantial 30k/60k service.
        (-3,  240.00, "Discount Tire", "Auto", chase_cc,
         "DISCOUNT TIRE — ROTATION"),
        (-9,  890.00, "Toyota Service", "Auto", chase_cc,
         "TOYOTA SERVICE 60K SCHEDULED"),
        (-15, 215.00, "Discount Tire", "Auto", chase_cc,
         "DISCOUNT TIRE — ROTATION"),
        (-21, 740.00, "Toyota Service", "Auto", chase_cc,
         "TOYOTA SERVICE 30K SCHEDULED"),

        # Annual insurance premium — auto + home bundled.
        (-4,  1820.00, "State Farm", "Insurance", chk,
         "STATE FARM AUTO+HOME RENEWAL"),
        (-16, 1750.00, "State Farm", "Insurance", chk,
         "STATE FARM AUTO+HOME RENEWAL"),
    ]

    today_anchor = TODAY.replace(day=15)  # mid-month for stable date math
    for offset_months, amt, merchant, category, account, name in annual_expenses:
        # Compute target date = today_anchor + offset_months
        m = today_anchor.month + offset_months
        y = today_anchor.year
        while m <= 0:
            m += 12
            y -= 1
        while m > 12:
            m -= 12
            y += 1
        txn_date = date(y, m, min(today_anchor.day, 28))
        db.add(Transaction(
            plaid_transaction_id=f"demo_annual_{merchant.lower().replace(' ', '_')}_{y}_{m:02d}",
            account_id=account.id,
            name=name,
            merchant_name=merchant,
            amount=amt,
            currency="USD",
            date=txn_date,
            pending=False,
            category=category,
        ))
    db.flush()


# ═════════════════════════════════════════════════════════════════════
if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--output", "-o",
        default="./tuskledger_demo.db",
        help="Path for the demo SQLite database (default: ./tuskledger_demo.db)",
    )
    args = parser.parse_args()
    main(args.output)
