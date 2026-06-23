"""Tile/metric-level coverage probe — does each NUMBER a user sees route to a retriever?

Unlike the L1/L2/L3 probe (which tests phrasing), this is keyed by the actual TILES/metrics shown in
the app, on the assumption that any number on screen will be asked about. The point is to catch
metrics that *route* but to the WRONG concept (e.g. 'total assets' → net_worth before it was fixed).
route() only gives the intent; the human verdict (covered/partial/mis-route/gap) is in the audit doc.

Run: PYTHONPATH=. python tests/_tile_probe.py
"""
from __future__ import annotations
from app.services import assistant_retrieval as ret

# tile → [(metric question, expected concept)]
TILES = {
    "Stat cards (Dashboard/NetWorth)": [
        ("what's my net worth", "net worth"),
        ("what are my total assets", "total assets (gross)"),
        ("what are my total liabilities", "total liabilities"),
        ("how much did I spend this month", "month spending"),
        ("how much income this month", "month income"),
    ],
    "Financial Pulse tile": [
        ("what's my financial health score", "0-100 pulse score"),
        ("what's my debt to assets ratio", "debt/asset %"),
        ("how's my financial health", "pulse"),
    ],
    "Cash Balances tile": [
        ("what's my cash balance", "total liquid cash"),
        ("how much cash do I have", "total liquid cash"),
        ("how many accounts are low on cash", "low-balance count"),
    ],
    "HSA / DCFSA tiles": [
        ("how much have I contributed to my HSA", "HSA contributed"),
        ("how much HSA room do I have left", "HSA headroom"),
        ("how much will I save in taxes if I max my HSA", "HSA tax savings"),
        ("how much is at risk in my DCFSA", "DCFSA forfeit risk"),
    ],
    "Portfolio snapshot tile": [
        ("what's my portfolio worth", "market value"),
        ("what's my unrealized gain", "unrealized G/L"),
        ("what's my asset allocation", "allocation"),
        ("what's my biggest holding", "top holding"),
        ("what's my cost basis", "total cost basis"),
    ],
    "Cash Flow Forecast tile": [
        ("how many months of runway do I have", "runway"),
        ("what's my projected balance in 90 days", "projected balance"),
        ("what's my lowest cash point", "forecast low point"),
        ("will my balance go negative", "negative alert"),
    ],
    "Loan payoff tile": [
        ("when will my mortgage be paid off", "payoff date"),
        ("how much total interest will I pay", "lifetime interest"),
        ("how much of my loan term is left", "progress %"),
    ],
    "Daily snapshot tile": [
        ("how much did I spend today", "today spend"),
        ("how much this week", "week spend"),
        ("what's my typical Monday spending", "day-of-week average"),
    ],
    "Accounts overview tile": [
        ("what accounts do I have", "account list"),
        ("how much is in my investment accounts", "investment subtotal"),
        ("how much do I owe on credit cards", "credit subtotal"),
    ],
    "Spending/Income page": [
        ("what's my savings rate", "savings rate"),
        ("what's my biggest spending category", "top category"),
        ("how does my dining spend compare to last month", "category MoM"),
        ("how does this month compare to last month", "spending MoM"),
        ("what are my income sources", "income sources"),
        ("what's my average income per month", "monthly average"),
    ],
    "Subscriptions": [
        ("what subscriptions am I paying for", "subs list"),
        ("how much could I save cancelling subscriptions", "potential savings"),
    ],
    "Investments page": [
        ("what's my best performer", "top mover"),
        ("how's my NVDA doing", "per-holding"),
        ("show my investment transactions", "buy/sell history"),
        ("what's my capital loss carryover", "carryover"),
    ],
    "Budgets page": [
        ("am I over budget", "over/under"),
        ("am I over on dining", "per-category budget"),
        ("how much budget do I have left in total", "total remaining"),
        ("how much rollover do I have", "rollover credit"),
    ],
    "Goals page": [
        ("am I on track for my house goal", "goal progress"),
        ("how much more do I need for my goal", "remaining"),
    ],
    "Loans page extras": [
        ("how much sooner if I pay $200 extra", "extra-payment what-if"),
        ("should I refinance", "refi (advice)"),
        ("how much equity do I have in my house", "home equity"),
    ],
    "Retirement page": [
        ("how much is in my retirement accounts", "retirement savings"),
        ("how much will I have at 65", "projection"),
        ("how much is in my pre-tax vs roth", "tax buckets"),
    ],
    "Trading tax page": [
        ("what are my realized gains this year", "net realized"),
        ("do I have any wash sales", "wash sales"),
        ("which lots should I harvest", "harvest candidates (advice)"),
    ],
    "Business page": [
        ("what's my business net income", "net profit"),
        ("what's my profit margin", "margin %"),
        ("what's my biggest business expense", "expense line"),
    ],
    "Insights page": [
        ("did I pay the same merchant twice", "duplicates"),
        ("what's the average size of my Amazon orders", "average"),
        ("any unusual spending this month", "anomalies"),
        ("when is my next Netflix charge", "merchant frequency"),
    ],
}

ALL = set(ret.RETRIEVERS.keys())


def main():
    miss, total = 0, 0
    for tile, qs in TILES.items():
        print(f"\n## {tile}")
        for q, concept in qs:
            total += 1
            intent = ret.route(q)
            covered = intent in ALL
            if not covered:
                miss += 1
            flag = "  " if covered else "MISS"
            print(f"  {flag}  {q!r:<52} [{concept}] -> {intent or '—'}")
    print(f"\nrouted to a retriever: {total - miss}/{total}  ·  no-route: {miss}")
    print("NOTE: routing ≠ correctness — see the audit doc for mis-route verdicts (right intent, wrong number).")


if __name__ == "__main__":
    main()
