"""Golden routing set for Ask Tusk — the curated 'common questions per tile' that close the loop.

This file is the single place to record common questions and the retriever each should hit. It does
two jobs:

  1. MEASURE — `report()` runs every question through the deterministic keyword `route()` and tells
     you the per-tile pass rate and the exact misses. That replaces back-and-forth manual testing.
  2. GUARANTEE — `seed_overrides()` writes every golden pair into the learned-routing override store
     (the same store the 👎-correction loop writes to). `answer()` consults overrides FIRST, so every
     curated common question routes correctly *immediately*, even before its keyword rule is perfect.

The training loop:  add a question here  →  it works at runtime (override)  →  the report flags it if
the keyword router still misses it  →  tighten the rule  →  re-run the report. Numbers always come
from the retrievers; this only affects WHICH retriever a known question maps to.

CLI:  python -m app.services.assistant_golden            # print the coverage report
      python -m app.services.assistant_golden --seed     # write the golden overrides
"""
from __future__ import annotations

from typing import Optional

# tile -> [(question, expected_intent)]
GOLDEN: dict[str, list[tuple[str, str]]] = {
    "net worth / assets / liabilities": [
        ("what's my net worth", "net_worth"),
        ("how much am I worth", "net_worth"),
        ("what are my total assets", "net_worth"),
        ("what's the value of all my assets", "net_worth"),
        ("what are my total liabilities", "net_worth"),
        ("how much do I owe in total", "net_worth"),
        ("how much debt do I have", "net_worth"),
        ("how has my net worth changed this year", "net_worth_change"),
        ("is my net worth up or down", "net_worth_change"),
        ("what's my biggest asset", "largest_assets"),
        ("what's the largest piece of my net worth", "largest_assets"),
        ("what's my biggest debt", "loan_detail"),
        ("what do I owe the most on", "loan_detail"),
        ("how much equity do I have in my house", "home_equity"),
    ],
    "cash & accounts": [
        ("what's my cash balance", "cash_balance"),
        ("how much cash do I have", "cash_balance"),
        ("cash on hand", "cash_balance"),
        ("what's my checking balance", "account_balance"),
        ("what's in my personal checking", "account_balance"),
        ("how much is in my savings", "account_balance"),
        ("how much is in my business checking account", "account_balance"),
        ("what's in my brokerage", "account_balance"),
        ("what accounts do I have", "accounts_overview"),
        ("how many accounts do I have", "accounts_overview"),
        ("which accounts are out of date", "stale_accounts"),
    ],
    "spending": [
        ("how much did I spend this month", "spending_total"),
        ("how much have I spent", "spending_total"),
        ("what did I spend last month", "spending_total"),
        ("how much did I spend on groceries", "category_spend"),
        ("how much did I spend at Costco", "merchant_spend"),
        ("what's my biggest spending category", "top_categories"),
        ("who's my top merchant", "top_merchant"),
        ("what's the most expensive thing I bought", "largest_transactions"),
        ("what was my biggest purchase last week", "largest_transactions"),
        ("show me my recent transactions", "recent_transactions"),
        ("show me every purchase over $500", "transaction_search"),
        ("what's my typical Monday spending", "day_of_week"),
        ("what's my average monthly spending", "monthly_average"),
        ("did I pay the same merchant twice", "duplicate_charges"),
        ("what's the average size of my Amazon orders", "average_spend"),
        ("do I spend more on dining or groceries", "compare"),
        ("how does this month compare to last month", "spending_compare"),
    ],
    "income & cash flow": [
        ("how much did I make this month", "income_total"),
        ("where does my income come from", "income_sources"),
        ("what's my savings rate", "savings_rate"),
        ("what's my cash flow", "cash_flow"),
        ("how many months of runway do I have", "cash_flow_forecast"),
        ("what's my projected balance in 90 days", "cash_flow_forecast"),
        ("what's my lowest cash point", "cash_flow_forecast"),
    ],
    "budgets & goals": [
        ("am I over budget", "budget_status"),
        ("am I over on dining", "budget_category"),
        ("how much budget do I have left", "budget_status"),
        ("am I on track for my goal", "goals"),
        ("how much more do I need for my house goal", "goals"),
    ],
    "investments": [
        ("what's my portfolio worth", "portfolio"),
        ("what's my biggest holding", "holdings"),
        ("what's my best performer", "holdings"),
        ("how much have I gained", "holdings"),
        ("what's my asset allocation", "holdings"),
        ("what's my cost basis", "holdings"),
        ("show my investment transactions", "investment_transactions"),
    ],
    "loans": [
        ("what's my mortgage balance", "loan_detail"),
        ("when will my mortgage be paid off", "loan_detail"),
        ("what's my interest rate", "loan_detail"),
        ("how much total interest will I pay", "loan_detail"),
        ("how much do I owe on my car", "loan_detail"),
    ],
    "retirement & tax": [
        ("how much is in my 401k", "retirement"),
        ("am I on track to retire", "retirement"),
        ("what are my realized gains this year", "trading_tax"),
        ("do I have any wash sales", "trading_tax"),
        ("how much capital loss carries forward", "trading_tax"),
        ("how much HSA room do I have left", "hsa"),
    ],
    "bills & subscriptions": [
        ("what bills are due", "upcoming_bills"),
        ("what subscriptions am I paying for", "subscriptions"),
        ("what's my most expensive subscription", "subscriptions"),
        ("when's my next Netflix charge", "subscriptions"),
    ],
    "business": [
        ("what's my business net income", "business"),
        ("how are my business expenses", "business"),
        ("what's my profit margin", "business"),
    ],
    "health & agent & market": [
        ("what's my financial health score", "financial_pulse"),
        ("what's my debt to assets ratio", "financial_pulse"),
        ("what's pending my approval", "agent_status"),
        ("what are my agent positions", "agent_status"),
        ("what's the rotation temperature", "market_signals"),
        ("any congressional buying in my names", "market_signals"),
    ],
}


def flat() -> list[tuple[str, str]]:
    return [(q, intent) for items in GOLDEN.values() for (q, intent) in items]


def report() -> dict:
    """Run the golden set through the deterministic keyword router. Returns + prints per-tile pass
    rates and the exact misses (so you know which keyword rules still need work)."""
    from app.services import assistant_retrieval as R
    total, passed, misses = 0, 0, []
    print("=" * 76)
    print("ASK TUSK — GOLDEN ROUTING COVERAGE (deterministic keyword router)")
    print("=" * 76)
    for tile, items in GOLDEN.items():
        tp = tt = 0
        rows = []
        for q, want in items:
            got = R.route(q)
            ok = got == want
            tp += int(ok); tt += 1
            if not ok:
                misses.append((tile, q, want, got))
            rows.append((ok, q, want, got))
        total += tt; passed += tp
        print(f"\n## {tile}   {tp}/{tt}")
        for ok, q, want, got in rows:
            if not ok:
                print(f"   MISS  {q!r:52} want {want} got {got or '—'}")
    pct = round(passed / total * 100) if total else 0
    print(f"\nOVERALL: {passed}/{total} routed correctly ({pct}%)  ·  misses degrade to the LLM router / override seed at runtime")
    return {"total": total, "passed": passed, "pct": pct, "misses": misses}


def seed_overrides() -> int:
    """Write every golden pair into the learned-routing override store, so each curated common
    question routes correctly at runtime regardless of the keyword router. Idempotent. Returns the
    number of overrides in the store afterward."""
    from app.services import assistant_feedback as fb
    from app.services import assistant_retrieval as R
    ov = fb._load_overrides()
    for q, intent in flat():
        if intent in R.RETRIEVERS:
            ov[fb._normalize(q)] = intent
    fb._save_overrides(ov)
    return len(ov)


def main(argv: Optional[list] = None) -> None:
    import sys
    argv = sys.argv[1:] if argv is None else argv
    if "--seed" in argv:
        print(f"Seeded golden routing overrides — store now has {seed_overrides()} entries.")
    else:
        report()


if __name__ == "__main__":
    main()
