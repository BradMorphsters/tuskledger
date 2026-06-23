"""Ad-hoc 3-level coverage probe for the Ask Tusk router (not a pytest test).

Runs a primary/secondary/tertiary question battery through assistant_retrieval.route() and reports
which intent each maps to (or MISS = open-ended/refusal). The point is to find where the
deterministic single-intent router runs out of road — mostly level-3 comparisons / conditionals /
multi-part questions that no single retriever can answer.

Run:  python tests/_coverage_probe.py
"""
from __future__ import annotations

from app.services import assistant_retrieval as ret

# domain -> {1: [...primary...], 2: [...secondary...], 3: [...tertiary...]}
BATTERY = {
    "net worth / accounts": {
        1: ["what's my net worth", "how much am I worth"],
        2: ["how has my net worth changed this year", "what's the biggest piece of my net worth",
            "how much debt do I have", "what accounts do I have"],
        3: ["what percent of my net worth is my house", "how much did my net worth grow last quarter vs this one",
            "is my net worth higher than a year ago", "what's my net worth minus my mortgage"],
    },
    "spending": {
        1: ["how much did I spend this month", "what's my biggest expense"],
        2: ["how much did I spend on groceries", "how much at Costco last week", "what's my top category"],
        3: ["how does my dining spend compare to last month", "am I spending more on gas than usual",
            "what's my average daily spend", "how much more did I spend this month than last month",
            "which category grew the most this month"],
    },
    "income / cash flow": {
        1: ["how much did I make last month", "what's my cash flow"],
        2: ["where does my income come from", "what's my savings rate", "how many months of runway do I have"],
        3: ["is my income keeping up with my spending", "what's my projected balance after rent and the car payment",
            "how much could I save if I cut subscriptions", "did I save more this month than last"],
    },
    "transactions": {
        1: ["what's the most expensive thing I bought", "show me my recent transactions"],
        2: ["what was my biggest purchase last week", "what did I buy at Amazon yesterday"],
        3: ["show me every transaction over $500 this month", "did I pay the same merchant twice this week",
            "what's the average size of my Amazon orders", "find duplicate charges"],
    },
    "budgets": {
        1: ["am I over budget"],
        2: ["am I over budget on dining", "how much is left in my groceries budget"],
        3: ["which budget am I closest to maxing out", "how much do I have left across all budgets",
            "will I go over my dining budget at this pace"],
    },
    "goals": {
        1: ["how am I doing on my goals"],
        2: ["am I on track for my house goal", "how much do I have toward my emergency fund"],
        3: ["how much more do I need for my house goal", "when will I reach my vacation goal at this pace",
            "if I save $500 a month when do I hit my goal"],
    },
    "subscriptions": {
        1: ["what subscriptions am I paying for"],
        2: ["what's my most expensive subscription", "how much do my subscriptions cost a month"],
        3: ["which subscriptions went up recently", "what could I cancel to save the most",
            "how much would I save dropping my two priciest subscriptions"],
    },
    "investments / holdings": {
        1: ["how are my holdings", "what's my portfolio worth"],
        2: ["what's my biggest holding", "how's my NVDA doing", "what's my best performer",
            "how much have I gained", "how much is in ETFs"],
        3: ["what percent of my portfolio is tech", "which holding has the biggest unrealized gain and how much",
            "how much would I owe in taxes if I sold NVDA", "is my portfolio more concentrated than last quarter",
            "how does my AAPL gain compare to my VTI gain", "do I spend more on dining or groceries",
            "what's the average size of my Amazon orders", "did I pay the same merchant twice this week"],
    },
    "retirement": {
        1: ["how much is in my 401k"],
        2: ["how much do I have for retirement", "am I on track to retire"],
        3: ["how much will I have at 65", "can I retire at 60", "how much should I save monthly to retire on time"],
    },
    "loans": {
        1: ["what's my mortgage balance"],
        2: ["when will my mortgage be paid off", "what's my interest rate", "how much do I owe on my car"],
        3: ["how much sooner is my mortgage paid off if I pay $200 extra", "how much total interest will I pay",
            "should I refinance", "how much equity do I have in my house"],
    },
    "taxes": {
        1: ["what are my realized gains this year"],
        2: ["do I have any wash sales", "how much capital loss carries forward", "short vs long term gains"],
        3: ["how much will I owe in capital gains tax", "which lots should I sell to harvest losses",
            "how much HSA room do I have left", "what's my Schedule C net income"],
    },
    "bills": {
        1: ["what bills are due"],
        2: ["when's my next mortgage payment due", "how much is due this week"],
        3: ["can I cover my bills with my current balance", "what's my biggest bill next month"],
    },
    "agent / trading": {
        1: ["what's pending my approval"],
        2: ["what are my agent positions", "is the trading agent armed", "how much can the agent deploy"],
        3: ["why did the agent veto that trade", "what would the agent buy next", "how is the agent performing vs the market"],
    },
    "market / research": {
        1: ["what's the rotation temperature"],
        2: ["any congressional buying in my names", "any insider activity"],
        3: ["which of my holdings has the strongest signal", "is the sector heating up or cooling",
            "what's the latest research on USAR"],
    },
    "business": {
        1: ["what's my business net income"],
        2: ["how are my business expenses", "what's my business revenue"],
        3: ["how does this year's business profit compare to last year", "what's my biggest business expense category"],
    },
}

ALL_INTENTS = set(ret.RETRIEVERS.keys())


def main():
    rows = []
    by_level = {1: [0, 0], 2: [0, 0], 3: [0, 0]}   # [covered, total]
    misses = {1: [], 2: [], 3: []}
    for domain, levels in BATTERY.items():
        for lvl, qs in levels.items():
            for q in qs:
                intent = ret.route(q)
                covered = intent in ALL_INTENTS
                by_level[lvl][1] += 1
                if covered:
                    by_level[lvl][0] += 1
                else:
                    misses[lvl].append((domain, q))
                rows.append((domain, lvl, q, intent or "—MISS (open-ended/refuse)"))

    print("=" * 78)
    print("ASK TUSK — 3-LEVEL ROUTER COVERAGE PROBE")
    print("=" * 78)
    cur = None
    for domain, lvl, q, intent in rows:
        if domain != cur:
            print(f"\n## {domain}")
            cur = domain
        flag = "  " if intent in ALL_INTENTS else "❌"
        print(f"  {flag} L{lvl}  {q!r:<62} -> {intent}")

    print("\n" + "=" * 78)
    print("SUMMARY (router-level coverage)")
    for lvl in (1, 2, 3):
        cov, tot = by_level[lvl]
        pct = round(cov / tot * 100) if tot else 0
        print(f"  Level {lvl}: {cov}/{tot} routed to a retriever ({pct}%)")
    tot_c = sum(by_level[l][0] for l in (1, 2, 3))
    tot_t = sum(by_level[l][1] for l in (1, 2, 3))
    print(f"  Overall: {tot_c}/{tot_t} ({round(tot_c / tot_t * 100)}%)")

    print("\nMISSES (no single retriever — open-ended/refuse):")
    for lvl in (1, 2, 3):
        if misses[lvl]:
            print(f"  Level {lvl}:")
            for domain, q in misses[lvl]:
                print(f"    - [{domain}] {q}")


if __name__ == "__main__":
    main()
