"""Retrieve-then-narrate brain — routing, window parsing, deterministic retrieval, grounding gate.

The headline test (`test_largest_is_single_transaction_not_merchant_total`) pins the exact bug that
motivated the re-architecture: the old assistant reported a *merchant total* as the "most expensive
single purchase". The retriever must return the largest individual TRANSACTION instead.
"""
from __future__ import annotations

import datetime
import re

import pytest

from app.config import settings
from app.services import assistant_retrieval as ret

TODAY = datetime.date(2026, 6, 18)


@pytest.fixture(autouse=True)
def _no_llm():
    """Keep these hermetic + fast: force the local model off so the rephrase/open-ended paths take
    their deterministic branches without reaching for Ollama."""
    from app.config import settings
    saved = settings.LLM_ENABLED
    settings.LLM_ENABLED = False
    yield
    settings.LLM_ENABLED = saved


# ── window parsing ───────────────────────────────────────────────────────
def test_parse_window_phrases():
    assert ret.parse_window("most expensive thing last week", TODAY)[:2] == (TODAY - datetime.timedelta(days=7), TODAY)
    assert ret.parse_window("what did I buy today", TODAY)[:2] == (TODAY, TODAY)
    assert ret.parse_window("spending yesterday", TODAY)[:2] == (TODAY - datetime.timedelta(days=1), TODAY - datetime.timedelta(days=1))
    # CALENDAR periods are real boundaries, not rolling windows
    assert ret.parse_window("how much did I spend this month", TODAY)[:2] == (datetime.date(2026, 6, 1), TODAY)
    assert ret.parse_window("spending last month", TODAY)[:2] == (datetime.date(2026, 5, 1), datetime.date(2026, 5, 31))
    assert ret.parse_window("spend this year", TODAY)[:2] == (datetime.date(2026, 1, 1), TODAY)
    assert ret.parse_window("last year spending", TODAY)[:2] == (datetime.date(2025, 1, 1), datetime.date(2025, 12, 31))
    assert ret.parse_window("how much did I spend", TODAY)[2] == "the last 30 days"   # default


# ── intent routing ───────────────────────────────────────────────────────
def test_route_single_purchase_vs_merchant_vs_spend():
    assert ret.route("what's the single most expensive thing I bought") == "largest_transactions"
    assert ret.route("most expensive purchase last week") == "largest_transactions"
    assert ret.route("who is my top merchant") == "top_merchant"
    assert ret.route("where do I spend the most") == "top_merchant"
    assert ret.route("how much did I spend last month") == "spending_total"
    assert ret.route("what's my net worth") == "net_worth"
    assert ret.route("how are my holdings") == "holdings"   # dedicated holding-level retriever
    assert ret.route("how's my portfolio") == "portfolio"   # portfolio overview stays portfolio
    assert ret.route("biggest spending category") == "top_categories"
    assert ret.route("what's the weather") is None


def test_route_asset_questions_dont_become_transactions():
    # The reported bug: a net-worth COMPONENT question must NOT route to purchases.
    assert ret.route("what is the single largest piece of my net worth") == "largest_assets"
    assert ret.route("biggest asset") == "largest_assets"
    assert ret.route("largest account") == "largest_assets"
    assert ret.route("my net worth") == "net_worth"
    # bare superlative is resolved by conversation context
    assert ret.route("what is the single largest?", context="your net worth is about $851,274") == "largest_assets"
    assert ret.route("what is the single largest?", context="most expensive purchase was $412 at Costco") == "largest_transactions"
    assert ret.route("what is the single largest?") is None   # no object, no context → don't guess


def test_account_balance_resolves_qualifier(factory):
    factory.account(name="Personal Checking", type="depository", subtype="checking", current_balance=3200.0)
    factory.account(name="Business Checking", type="depository", subtype="checking", current_balance=8800.0)
    factory.commit()
    r = ret.account_balance(factory.db, None, None, "now", "what's in my personal checking")
    assert "$3,200" in r["answer"] and "Personal Checking" in r["answer"]
    r2 = ret.account_balance(factory.db, None, None, "now", "what's in my business checking")
    assert "$8,800" in r2["answer"]


def test_llm_route_is_noop_without_model(monkeypatch):
    # The safety-net router must be a clean no-op when the local model is off (deterministic path only).
    monkeypatch.setattr(settings, "LLM_ENABLED", False)
    assert ret._llm_route("what's the meaning of life") is None
    assert len(ret._catalog_text().splitlines()) == len(ret.RETRIEVERS)


def test_net_worth_distinguishes_assets_liabilities(db):
    import datetime as _dt
    from app.models.net_worth_snapshot import NetWorthSnapshot
    db.add(NetWorthSnapshot(date=_dt.date(2026, 6, 18), total_assets=500000.0,
                            total_liabilities=150000.0, net_worth=350000.0))
    db.commit()
    assets = ret.net_worth(db, None, None, "now", "what are my total assets")
    assert "$500,000" in assets["answer"] and "350,000" in assets["answer"]   # assets, with net-worth context
    nw = ret.net_worth(db, None, None, "now", "what's my net worth")
    assert "$350,000" in nw["answer"] and "500,000" not in nw["answer"]        # the net figure only
    liab = ret.net_worth(db, None, None, "now", "how much do I owe")
    assert "$150,000" in liab["answer"]


def test_cash_balance_sums_depository_only(factory):
    factory.account(name="Checking", type="depository", subtype="checking", current_balance=4000.0)
    factory.account(name="Savings", type="depository", subtype="savings", current_balance=6000.0)
    factory.account(name="Visa", type="credit", subtype="credit card", current_balance=2000.0)   # excluded
    factory.commit()
    r = ret.cash_balance(factory.db, None, None, "now", "what's my cash balance")
    assert r["facts"][0] == 10000.0 and "$10,000" in r["answer"]
    assert "Visa" not in r["answer"]


def test_largest_assets_ranks_components_excludes_liabilities(factory):
    factory.account(name="Checking", type="depository", current_balance=5000.0)
    factory.account(name="Brokerage", type="investment", current_balance=400000.0)
    factory.account(name="Visa", type="credit", current_balance=2000.0)   # liability — not a positive piece
    factory.commit()
    r = ret.largest_assets(factory.db, None, None, "now")
    assert r["found"] is True
    assert r["rows"][0]["name"] == "Brokerage" and r["rows"][0]["value"] == 400000.0
    assert all(p["name"] != "Visa" for p in r["rows"])
    assert "$400,000" in r["answer"]


def test_answer_largest_piece_of_net_worth(factory):
    factory.account(name="401k", type="investment", current_balance=300000.0)
    factory.account(name="Checking", type="depository", current_balance=8000.0)
    factory.commit()
    out = ret.answer(factory.db, "what is the single largest piece of my net worth", today=TODAY)
    assert out["intent"] == "largest_assets"
    assert "401k" in out["answer"]


# ── the regression: single transaction, not a per-merchant aggregate ─────
def test_largest_is_single_transaction_not_merchant_total(factory):
    acct = factory.account()
    # Merchant A: two purchases summing to $1,800 (the old code would call this the "biggest").
    factory.transaction(account_id=acct.id, amount=900.0, merchant_name="Education Station", date=TODAY)
    factory.transaction(account_id=acct.id, amount=900.0, merchant_name="Education Station", date=TODAY)
    # Merchant B: ONE purchase of $1,200 — the true largest single transaction.
    factory.transaction(account_id=acct.id, amount=1200.0, merchant_name="Apple Store", date=TODAY)
    # A transfer that's larger than everything — must be excluded from "spending".
    factory.transaction(account_id=acct.id, amount=5000.0, merchant_name="Brokerage", date=TODAY, is_transfer=True)
    factory.commit()

    r = ret.largest_transactions(factory.db, TODAY - datetime.timedelta(days=7), TODAY, "the last 7 days")
    assert r["found"] is True
    assert r["rows"][0]["amount"] == 1200.0
    assert r["rows"][0]["merchant"] == "Apple Store"
    assert "$1,200" in r["answer"]
    assert "5,000" not in r["answer"]              # transfer excluded
    # the merchant aggregate ($1,800) is NOT presented as a single purchase
    assert "1,800" not in r["answer"]


def test_top_merchant_aggregates(factory):
    acct = factory.account()
    factory.transaction(account_id=acct.id, amount=900.0, merchant_name="Education Station", date=TODAY)
    factory.transaction(account_id=acct.id, amount=900.0, merchant_name="Education Station", date=TODAY)
    factory.transaction(account_id=acct.id, amount=1200.0, merchant_name="Apple Store", date=TODAY)
    factory.commit()
    r = ret.top_merchant(factory.db, TODAY - datetime.timedelta(days=7), TODAY, "the last 7 days")
    # by TOTAL, Education Station ($1,800) outranks Apple ($1,200)
    assert r["rows"][0]["merchant"] == "Education Station"
    assert r["rows"][0]["total"] == 1800.0


def test_spending_total_excludes_transfers(factory):
    acct = factory.account()
    factory.transaction(account_id=acct.id, amount=100.0, date=TODAY)
    factory.transaction(account_id=acct.id, amount=50.0, date=TODAY)
    factory.transaction(account_id=acct.id, amount=9999.0, date=TODAY, is_transfer=True)
    factory.transaction(account_id=acct.id, amount=-200.0, date=TODAY)   # income (money in)
    factory.commit()
    r = ret.spending_total(factory.db, TODAY - datetime.timedelta(days=7), TODAY, "the last 7 days")
    assert r["rows"][0]["total"] == 150.0
    assert r["rows"][0]["count"] == 2


def test_empty_window_is_honest(factory):
    acct = factory.account()
    factory.commit()
    r = ret.largest_transactions(factory.db, TODAY - datetime.timedelta(days=7), TODAY, "the last 7 days")
    assert r["found"] is False
    assert "don't see any purchases" in r["answer"]


# ── grounding gate ───────────────────────────────────────────────────────
def test_grounding_blocks_fabricated_figure():
    ok, bad = ret.grounding_ok("The biggest purchase was $1,737.00.", allowed=[1200.0, 900.0])
    assert ok is False and bad == 1737.0


def test_grounding_allows_grounded_and_small_ints():
    # $1,200 is in the allowed set; 2026/6/17 (a date) and small counts are permitted.
    ok, _ = ret.grounding_ok("Your top buy was $1,200.00 at Apple on 2026-06-17, 1 of 8.", allowed=[1200.0])
    assert ok is True


def test_grounding_tolerates_rounding():
    ok, _ = ret.grounding_ok("about $851,274", allowed=[851273.51])
    assert ok is True


# ── expanded coverage: routing eval table (regression guard as coverage grows) ──
ROUTING_CASES = [
    ("what's the most expensive thing I bought", "largest_transactions"),
    ("how much did I spend at Costco last week", "merchant_spend"),
    ("how much did I spend on groceries this month", "category_spend"),
    ("how much did I make last month", "income_total"),
    ("what's my net cash flow", "cash_flow"),
    ("show me my recent transactions", "recent_transactions"),
    ("what's my checking balance", "account_balance"),
    ("what accounts do I have", "accounts_overview"),
    ("how much debt do I have", "net_worth"),          # total debt → authoritative snapshot
    ("what are my total assets", "net_worth"),         # total assets ≠ net worth
    ("what's the value of all my assets", "net_worth"),
    ("total liabilities", "net_worth"),
    ("what's my cash balance", "cash_balance"),
    ("how much cash do I have", "cash_balance"),
    ("how has my net worth changed this year", "net_worth_change"),
    ("what's my net worth", "net_worth"),
    ("what is the single largest piece of my net worth", "largest_assets"),
    ("what bills are due", "upcoming_bills"),
    ("am I over budget", "budget_status"),
    ("who is my top merchant", "top_merchant"),
    ("biggest spending category", "top_categories"),
    ("how much did I spend last month", "spending_total"),
    ("how's my portfolio", "portfolio"),
    # ── expanded batch + secondary phrasings ──
    ("how's my NVDA position", "holdings"),
    ("what's my biggest holding", "holdings"),
    ("what's my best performing stock", "holdings"),
    ("how much have I gained on my investments", "holdings"),
    ("how much is in ETFs", "holdings"),
    ("what subscriptions am I paying for", "subscriptions"),
    ("what's my most expensive subscription", "subscriptions"),
    ("did any of my recurring charges go up", "subscriptions"),
    ("what's my savings rate", "savings_rate"),
    ("how much am I saving each month", "savings_rate"),
    ("am I on track for my house goal", "goals"),
    ("how am I doing on my goals", "goals"),
    ("am I over budget on dining", "budget_category"),
    ("how much is left in my groceries budget", "budget_category"),
    ("am I over budget", "budget_status"),
    ("how many months of runway do I have", "cash_flow_forecast"),
    ("am I going to run out of money", "cash_flow_forecast"),
    ("which accounts are out of date", "stale_accounts"),
    ("where does my income come from", "income_sources"),
    # ── Tier 2 + secondary phrasings ──
    ("what are my realized gains this year", "trading_tax"),
    ("do I have any wash sales", "trading_tax"),
    ("how much HSA room do I have left", "hsa"),
    ("how much is in my 401k", "retirement"),
    ("am I on track to retire", "retirement"),
    ("when will my mortgage be paid off", "loan_detail"),
    ("what's my mortgage balance", "loan_detail"),
    ("what's my interest rate", "loan_detail"),
    ("how much do I owe on my car", "loan_detail"),
    ("what's my business net income", "business"),
    ("how are my business expenses", "business"),
    # ── Tier 3 read-only surfaces + secondary phrasings ──
    ("what's pending my approval", "agent_status"),
    ("what are my agent positions", "agent_status"),
    ("is the trading agent armed", "agent_status"),
    ("how much can the agent deploy", "agent_status"),
    ("what's the rotation temperature", "market_signals"),
    ("any congressional buying in my names", "market_signals"),
    ("how much capital loss carries forward", "trading_tax"),
    # ── Round-2 tile fixes (mis-routes killed + new retrievers) ──
    ("what's my projected balance in 90 days", "cash_flow_forecast"),
    ("will my balance go negative", "cash_flow_forecast"),
    ("what's my lowest cash point", "cash_flow_forecast"),
    ("how much is at risk in my DCFSA", None),     # no DCFSA service → honest refuse, never fabricate
    ("how much rollover do I have", None),         # no rollover service → honest refuse
    ("what's my typical Monday spending", "day_of_week"),
    ("show my investment transactions", "investment_transactions"),
    ("what's my asset allocation", "holdings"),
    ("what's my unrealized gain", "holdings"),
    ("what's my cost basis", "holdings"),
    ("am I over on dining", "budget_category"),
    ("how does this month compare to last month", "spending_compare"),
    ("what's my financial health score", "financial_pulse"),
    ("what's my debt to assets ratio", "financial_pulse"),
    ("what's my average income per month", "monthly_average"),
    ("when is my next Netflix charge", "subscriptions"),
    ("what's my profit margin", "business"),
    ("what's my checking balance", "account_balance"),     # balance guard didn't over-fire
    ("what's in my personal checking", "account_balance"),
    ("how much do I have in my brokerage", "account_balance"),
    ("what's in my portfolio", "portfolio"),               # not stolen by account_balance
    ("how much is in my business checking account", "account_balance"),  # acct named 'Business…' ≠ business P&L
    ("what's my business net income", "business"),
    ("what's the largest piece of debt I own", "loan_detail"),   # debt ≠ asset
    ("what's my biggest debt", "loan_detail"),
    ("what do I owe the most on", "loan_detail"),
    ("what's the largest piece of my net worth", "largest_assets"),  # still assets
    # ── L2/L3 probe fixes ──
    ("show me every transaction over $500 this month", "transaction_search"),
    ("what did I buy at Amazon yesterday", "transaction_search"),
    ("show me my recent transactions", "recent_transactions"),     # not stolen by transaction_search
    ("how much at Costco last week", "merchant_spend"),
    ("did I spend more this month than last", "spending_compare"),
    ("what's my best performer", "holdings"),
    ("short vs long term gains", "trading_tax"),
    ("how much total interest will I pay", "loan_detail"),
    ("how much do I have left across all budgets", "budget_status"),
    ("how much equity do I have in my house", "home_equity"),      # computed (real estate − mortgage)
    # ── composition + aggregation ──
    ("how does my AAPL gain compare to my VTI gain", "compare"),
    ("do I spend more on dining or groceries", "compare"),
    ("what's the average size of my Amazon orders", "average_spend"),
    ("did I pay the same merchant twice this week", "duplicate_charges"),
    ("how much have I gained", "holdings"),
    ("what could I cancel to save money", "subscriptions"),
    ("what's the weather", None),
]


@pytest.mark.parametrize("q,expected", ROUTING_CASES)
def test_routing_table(q, expected):
    assert ret.route(q) == expected


def test_category_spend_extracts_and_sums(factory):
    acct = factory.account()
    factory.transaction(account_id=acct.id, amount=80.0, category="Groceries", merchant_name="Kroger", date=TODAY)
    factory.transaction(account_id=acct.id, amount=40.0, category="Groceries", merchant_name="Aldi", date=TODAY)
    factory.transaction(account_id=acct.id, amount=200.0, category="Travel", merchant_name="Delta", date=TODAY)
    factory.commit()
    r = ret.answer(factory.db, "how much did I spend on groceries this week", today=TODAY)
    assert r["intent"] == "category_spend"
    assert "$120" in r["answer"] and "Groceries" in r["answer"]
    assert "$200" not in r["answer"]   # Travel excluded


def test_merchant_spend_extracts_and_sums(factory):
    acct = factory.account()
    factory.transaction(account_id=acct.id, amount=150.0, merchant_name="Costco", date=TODAY)
    factory.transaction(account_id=acct.id, amount=90.0, merchant_name="Costco", date=TODAY)
    factory.transaction(account_id=acct.id, amount=300.0, merchant_name="Apple Store", date=TODAY)
    factory.commit()
    r = ret.answer(factory.db, "how much did I spend at Costco this week", today=TODAY)
    assert r["intent"] == "merchant_spend"
    assert "$240" in r["answer"] and "Costco" in r["answer"]


def test_income_and_cashflow(factory):
    acct = factory.account()
    factory.transaction(account_id=acct.id, amount=-3000.0, merchant_name="Employer", date=TODAY)  # income
    factory.transaction(account_id=acct.id, amount=500.0, merchant_name="Rent", date=TODAY)         # spend
    factory.commit()
    inc = ret.income_total(factory.db, TODAY - datetime.timedelta(days=7), TODAY, "the last 7 days")
    assert "$3,000" in inc["answer"]
    cf = ret.cash_flow(factory.db, TODAY - datetime.timedelta(days=7), TODAY, "the last 7 days")
    assert cf["rows"][0]["inflow"] == 3000.0 and cf["rows"][0]["outflow"] == 500.0
    assert cf["rows"][0]["net"] == 2500.0


def test_account_balance_and_overview(factory):
    factory.account(name="Everyday Checking", type="depository", subtype="checking", current_balance=4200.0)
    factory.account(name="Visa", type="credit", subtype="credit card", current_balance=1500.0)
    factory.commit()
    bal = ret.account_balance(factory.db, None, None, "now", "what's my checking balance")
    assert "$4,200" in bal["answer"]
    ov = ret.accounts_overview(factory.db, None, None, "now")
    assert ov["facts"][0] == 4200.0 and ov["facts"][1] == 1500.0   # assets, liabilities


def test_reuse_builders_dont_crash_on_empty(factory):
    factory.commit()
    for intent in ("net_worth_change", "upcoming_bills", "budget_status"):
        r = ret.RETRIEVERS[intent](factory.db, None, None, "now")
        assert isinstance(r.get("answer"), str) and r["answer"].strip()
        assert r["grounded"] is True


# ── holdings retriever sub-modes (the secondary questions) ──
def _seed_holdings(factory):
    acct = factory.account(name="Brokerage", type="investment")
    factory.security(plaid_security_id="s_nvda", ticker_symbol="NVDA", name="NVIDIA Corp", type="equity")
    factory.security(plaid_security_id="s_aapl", ticker_symbol="AAPL", name="Apple Inc", type="equity")
    factory.security(plaid_security_id="s_vti", ticker_symbol="VTI", name="Vanguard Total Market", type="etf")
    factory.holding(account_id=acct.id, plaid_security_id="s_nvda", quantity=10, institution_value=20000.0, cost_basis=8000.0)   # +150%
    factory.holding(account_id=acct.id, plaid_security_id="s_aapl", quantity=20, institution_value=4000.0, cost_basis=5000.0)   # -20%
    factory.holding(account_id=acct.id, plaid_security_id="s_vti", quantity=30, institution_value=9000.0, cost_basis=7000.0)
    factory.commit()


def test_holdings_specific_ticker(factory):
    _seed_holdings(factory)
    r = ret.answer(factory.db, "how's my NVDA doing", today=TODAY)
    assert r["intent"] == "holdings"
    assert "NVDA" in r["answer"] and "$20,000" in r["answer"]


def test_holdings_best_and_worst(factory):
    _seed_holdings(factory)
    best = ret.holdings(factory.db, None, None, "now", "what's my best performing stock")
    assert "NVDA" in best["answer"]
    worst = ret.holdings(factory.db, None, None, "now", "what's my worst performer")
    assert "AAPL" in worst["answer"]


def test_holdings_largest_and_total_gain(factory):
    _seed_holdings(factory)
    big = ret.holdings(factory.db, None, None, "now", "what's my biggest holding")
    assert "NVDA" in big["answer"] and "$20,000" in big["answer"]
    gl = ret.holdings(factory.db, None, None, "now", "how much have I gained")
    # +12000 (NVDA) -1000 (AAPL) +2000 (VTI) = +13000
    assert "$13,000" in gl["answer"]


def test_holdings_bare_ticker_fallback(factory):
    _seed_holdings(factory)
    # No investment keyword at all — only the ticker name. The DB ticker fallback should catch it.
    r = ret.answer(factory.db, "how is apple doing", today=TODAY)
    assert r["intent"] == "holdings" and "AAPL" in r["answer"]


def test_budget_category(factory, db):
    import datetime as _dt
    from app.models.budget import Budget, BudgetCategory
    acct = factory.account()
    factory.transaction(account_id=acct.id, amount=120.0, category="Dining", date=TODAY)
    today = _dt.date.today()
    b = Budget(month=today.month, year=today.year)
    db.add(b); db.flush()
    db.add(BudgetCategory(budget_id=b.id, category="Dining", limit_amount=300.0))
    db.commit()
    r = ret.budget_category(db, None, None, "this month", "am I over budget on dining")
    # spent depends on TODAY vs real today; assert the structure + limit are right
    assert r["intent"] == "budget_category"
    assert "$300" in r["answer"] and "Dining" in r["answer"]


def test_goals_progress(factory, db):
    from app.models.savings_goal import SavingsGoal
    db.add(SavingsGoal(name="Emergency Fund", target_amount=10000.0, manual_current_amount=4000.0,
                       goal_type="custom", source_account_ids=[], is_active=1))
    db.commit()
    r = ret.goals(db, None, None, "now", "how am I doing on my emergency fund")
    assert r["intent"] == "goals"
    assert "40" in r["answer"]               # 40% funded
    assert "$4,000" in r["answer"] and "$10,000" in r["answer"]


def test_empty_paths_are_graceful(factory):
    factory.commit()
    for intent in ("holdings", "subscriptions", "savings_rate", "goals", "budget_category",
                   "cash_flow_forecast", "stale_accounts", "income_sources",
                   "loan_detail", "retirement", "trading_tax", "business", "hsa",
                   "agent_status", "market_signals", "transaction_search", "spending_compare",
                   "compare", "average_spend", "duplicate_charges", "home_equity",
                   "investment_transactions", "day_of_week", "financial_pulse", "monthly_average"):
        r = ret.RETRIEVERS[intent](factory.db, datetime.date(2026, 6, 1), TODAY, "now", "")
        assert isinstance(r.get("answer"), str) and r["answer"].strip()
        assert r["grounded"] is True


def test_investment_transactions_uses_investment_table(factory, db):
    from app.models.investment_transaction import InvestmentTransaction
    acct = factory.account(name="Brokerage", type="investment")
    factory.security(plaid_security_id="s_x", ticker_symbol="VOO", name="Vanguard 500")
    db.add(InvestmentTransaction(plaid_investment_transaction_id="itx_1", account_id=acct.id,
                                 plaid_security_id="s_x", type="buy", quantity=5, price=400.0,
                                 amount=2000.0, date=TODAY))
    db.commit()
    r = ret.investment_transactions(db, None, None, "recent", "show my investment transactions")
    assert r["found"] and "VOO" in r["answer"] and "$2,000" in r["answer"]


def test_day_of_week_average(factory):
    acct = factory.account()
    # two Mondays of $50 each → average ~$50/Monday
    factory.transaction(account_id=acct.id, amount=50.0, date=datetime.date(2026, 6, 1), merchant_name="A")   # Mon
    factory.transaction(account_id=acct.id, amount=50.0, date=datetime.date(2026, 6, 8), merchant_name="B")   # Mon
    factory.commit()
    r = ret.day_of_week(factory.db, None, None, "now", "what's my typical Monday spending")
    assert "Monday" in r["answer"] and "$50" in r["answer"]


def test_compare_two_tickers(factory):
    _seed_holdings(factory)   # NVDA +$12k, AAPL -$1k, VTI +$2k
    r = ret.compare(factory.db, None, None, "now", "how does my NVDA gain compare to my AAPL gain")
    assert "NVDA" in r["answer"] and "AAPL" in r["answer"]
    assert "$12,000" in r["answer"] and "$1,000" in r["answer"]


def test_compare_two_categories(factory):
    acct = factory.account()
    factory.transaction(account_id=acct.id, amount=300.0, category="Dining", date=TODAY)
    factory.transaction(account_id=acct.id, amount=120.0, category="Groceries", date=TODAY)
    factory.commit()
    r = ret.compare(factory.db, TODAY - datetime.timedelta(days=7), TODAY, "the last 7 days",
                    "do I spend more on dining or groceries")
    assert "$300" in r["answer"] and "$120" in r["answer"] and "more on Dining" in r["answer"]


def test_average_and_duplicates(factory):
    acct = factory.account()
    factory.transaction(account_id=acct.id, amount=40.0, merchant_name="Amazon", date=TODAY)
    factory.transaction(account_id=acct.id, amount=60.0, merchant_name="Amazon", date=TODAY)
    factory.transaction(account_id=acct.id, amount=40.0, merchant_name="Amazon", date=TODAY)  # dup of the $40
    factory.commit()
    win = (TODAY - datetime.timedelta(days=7), TODAY, "the last 7 days")
    avg = ret.average_spend(factory.db, *win, "average size of my Amazon orders")
    assert "$46.67" in avg["answer"]   # (40+60+40)/3
    dup = ret.duplicate_charges(factory.db, *win, "did I pay Amazon twice")
    assert "duplicate" in dup["answer"].lower() and "$40" in dup["answer"]


def test_capital_loss_carryover_math(db, monkeypatch):
    # $5,000 realized loss → $3,000 deductible this year, $2,000 carries forward.
    monkeypatch.setattr("app.services.trading_tax.compute_realized_pnl",
                        lambda *a, **k: {"net_realized": -5000.0, "wash_sale_disallowed": 0.0})
    r = ret.trading_tax(db, None, None, "this year", "how much capital loss carries forward")
    assert "$2,000" in r["answer"] and "$3,000" in r["answer"]


def test_agent_status_read_only_no_action_words(factory):
    # Read-only by construction — the answer must never imply it placed/approved anything.
    r = ret.agent_status(factory.db, None, None, "now", "what's pending approval")
    assert isinstance(r["answer"], str) and r["answer"].strip()
    assert not re.search(r"\b(I (placed|approved|bought|sold|submitted|executed))\b", r["answer"], re.I)


# ── Tier 2 retrievers ──
def test_loan_detail_reports_balance(factory):
    factory.account(name="Home Mortgage", type="loan", current_balance=250000.0)
    factory.commit()
    r = ret.answer(factory.db, "what's my mortgage balance", today=TODAY)
    assert r["intent"] == "loan_detail"
    assert "$250,000" in r["answer"]


def test_retirement_reports_savings_and_defers_projection(factory):
    factory.account(name="Fidelity 401k", type="investment", subtype="401k", current_balance=300000.0)
    factory.account(name="Checking", type="depository", subtype="checking", current_balance=5000.0)
    factory.commit()
    r = ret.retirement(factory.db, None, None, "now", "am I on track to retire")
    assert "$300,000" in r["answer"]            # only the retirement account
    assert "5,000" not in r["answer"]           # checking excluded
    assert "Retirement tab" in r["answer"]      # projection deferred, not fabricated


def test_business_summary_routes(factory, db):
    biz = factory.business()
    acct = factory.account()
    factory.transaction(account_id=acct.id, amount=-5000.0, business_id=biz.id, date=TODAY)  # business income
    factory.transaction(account_id=acct.id, amount=1200.0, business_id=biz.id, date=TODAY)   # business expense
    factory.commit()
    r = ret.answer(db, "what's my business net income", today=TODAY)
    assert r["intent"] == "business"
    assert isinstance(r["answer"], str) and r["answer"].strip()


def test_rephrase_keeps_deterministic_when_llm_off():
    # LLM off (autouse) → rephrase is a no-op, exact text preserved.
    assert ret._maybe_rephrase("q", "You spent $1,234.56 at Costco.", [1234.56]) == "You spent $1,234.56 at Costco."


def test_answer_routes_to_largest(factory):
    acct = factory.account()
    factory.transaction(account_id=acct.id, amount=1200.0, merchant_name="Apple Store", date=TODAY)
    factory.commit()
    out = ret.answer(factory.db, "what's the most expensive thing I bought this week", today=TODAY)
    assert out["source"] == "retrieval"
    assert out["intent"] == "largest_transactions"
    assert "$1,200" in out["answer"]
    assert out["rows"][0]["merchant"] == "Apple Store"
