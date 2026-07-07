"""Retrieve-then-narrate brain for 'Ask Tusk' — the trustworthy replacement for the old
narrate-a-fixed-blob design.

Why this exists: the previous assistant handed the model a FIXED snapshot (four aggregates) built
blind to the question, then asked it to narrate. When a question fell outside those aggregates
("single most expensive purchase", "last week"), the model had no grounded data and improvised —
it passed off a *merchant total* as a single transaction and even fabricated a date. The guardrail
("never invent a number") was only requested in the prompt, never enforced.

This module flips the order:

  1. ROUTE the question to a specific intent + time window (deterministic keyword router).
  2. RETRIEVE the exact rows that answer it with a deterministic DB query.
  3. ANSWER from those rows with a deterministic template — so the figure selection never touches
     the LLM. For the open-ended path (no intent matched) the model may narrate, but ONLY if every
     number it speaks is present in the retrieved data (``grounding_ok``); otherwise it refuses.

Net effect: a fabricated figure can't reach the user. Every answer also carries ``rows`` so the UI
can show the receipts. Read-only by construction — only SELECTs, never a write.
"""
from __future__ import annotations

import re
from datetime import date, timedelta
from typing import Optional

from sqlalchemy import func

from app.config import settings
from app.models.transaction import Transaction


# ── formatting ───────────────────────────────────────────────────────────
def _money(n) -> str:
    try:
        return "${:,.2f}".format(float(n)) if float(n) % 1 else "${:,.0f}".format(float(n))
    except (TypeError, ValueError):
        return "$?"


# ── time-window parsing ──────────────────────────────────────────────────
def parse_window(question: str, today: Optional[date] = None) -> tuple[date, date, str]:
    """Map natural-language time phrases to (start, end, label). CALENDAR periods ('this month',
    'last year') are real calendar boundaries — NOT rolling windows; 'this month' = the 1st to today,
    not the last 30 days. Default = last 30 days."""
    today = today or date.today()
    q = (question or "").lower()
    if "yesterday" in q:
        d = today - timedelta(days=1)
        return d, d, "yesterday"
    if "today" in q:
        return today, today, "today"
    # calendar month-to-date / last calendar month
    if re.search(r"\b(this month|month[ -]to[ -]date|\bmtd\b|so far this month)\b", q):
        return today.replace(day=1), today, "this month"
    if re.search(r"\blast month\b", q):
        last_end = today.replace(day=1) - timedelta(days=1)
        return last_end.replace(day=1), last_end, "last month"
    if re.search(r"\b(this|last|past|recent|the)\s+week\b|\bpast 7 days\b|\blast 7 days\b|\b7 days\b", q):
        return today - timedelta(days=7), today, "the last 7 days"
    if re.search(r"\b(quarter|past 90 days|last 90 days|3 months|three months|last quarter)\b", q):
        return today - timedelta(days=90), today, "the last 90 days"
    # calendar year-to-date / last calendar year
    if re.search(r"\b(this year|year[ -]to[ -]date|\bytd\b|so far this year)\b", q):
        return date(today.year, 1, 1), today, "this year"
    if re.search(r"\blast year\b", q):
        return date(today.year - 1, 1, 1), date(today.year - 1, 12, 31), "last year"
    if re.search(r"\b(past year|past 12 months|12 months)\b", q):
        return today - timedelta(days=365), today, "the last 12 months"
    return today - timedelta(days=30), today, "the last 30 days"


# ── intent routing (deterministic keyword router) ────────────────────────
_SUPERLATIVE = re.compile(r"\b(most expensive|priciest|biggest|largest|highest|dearest|costliest|single largest|single biggest)\b")
_MERCHANT = re.compile(r"\b(merchant|store|vendor|retailer|where (do|did) i (spend|shop))\b")
# "asset" cues — a question about an ACCOUNT-level component of net worth (which account/asset is
# biggest). Critical: "largest piece of my net worth" is an asset question. NOTE: holding/position/
# stock are intentionally NOT here — those route to the holding-level `holdings` retriever instead.
_ASSET = re.compile(r"\b(net ?worth|asset|account|piece|chunk|portion|component|stake)\b")
_HOLDING = re.compile(r"\b(holdings?|positions?|stocks?|shares?|equit(y|ies)|etfs?|ticker)\b")
_NETWORTH_TOTAL = re.compile(r"\b(net ?worth|how much (am i|i'm) worth)\b")
# Total ASSETS (gross) and total LIABILITIES — distinct from net worth; all answered by net_worth().
_ASSETS_TOTAL = re.compile(r"\b(total assets|gross assets|all (of )?my assets|value of (all |my )?assets|how much .*\bin assets\b|what('?s| is| are) (the value of )?(all )?my assets|my total assets)\b")
_LIABS_TOTAL = re.compile(r"\b(total liabilities|my liabilities|total debt|how much (do i owe|debt do i)|how much debt)\b")
# Liquid cash across checking/savings (NOT a single account, NOT cash flow).
_CASH = re.compile(r"\b(cash balance|how much cash|cash on hand|total cash|liquid cash|cash position|in cash\b|cash do i have)\b")
_SPEND = re.compile(r"\b(purchase|transaction|charge|buy|bought|expense|item|thing|spent|spend|paid|payment)\b")


def _intent_for(q: str) -> Optional[str]:
    superl = bool(_SUPERLATIVE.search(q))
    has_spend_verb = bool(re.search(r"\b(spend|spent|spending|paid?|pay)\b", q))
    spend_ctx = has_spend_verb or "how much" in q          # "how much at Costco" has no spend verb
    invest_ctx = bool(_HOLDING.search(q) or re.search(r"\b(invest(ed|ment|ments)?|portfolio)\b", q))
    # Home equity = real-estate value − mortgage. Route to its own retriever (and keep the word
    # "equity" from mis-routing into the stock-holdings retriever).
    if re.search(r"\bequity\b", q) and re.search(r"\b(house|home|property|real estate)\b", q):
        return "home_equity"
    # agent-trading status (read-only) — BEFORE holdings so "agent positions" doesn't become a
    # holdings query; "pending approval / proposals" route here too.
    if re.search(r"\b(agent|auto-?trad|trading bot|the bot|sleeve)\b", q) \
            or re.search(r"\bpending\b.*\bapprov|\bto approve\b|\bproposals?\b|\bwaiting (for )?approval\b", q):
        return "agent_status"
    # market signals (sector rotation + congressional/insider activity)
    if re.search(r"\b(rotation|sector (heat\w*|rotat\w*)|heating up|cooling (down|off)?|warming up|congress(ional)?|insider|political (flow|trade|activity)|government contract|lobby(ing)?)\b", q):
        return "market_signals"
    # trading tax — realized gains, wash sales, loss carryover, short/long term (before holdings)
    if re.search(r"\b(realized (gain|loss|p&?l)|capital gains?|wash sales?|trading tax|tax[- ]loss|gains? this year)\b", q) \
            or re.search(r"\bcarr(y|ies|ied) (over|forward)\b|\bcarry(over|forward)\b|\bloss carr", q) \
            or re.search(r"\b(short|long)[- ]?term (gain|loss|capital)", q):
        return "trading_tax"
    # holding-level investment questions (one ticker, mover, biggest holding, gain/loss, allocation)
    if (_HOLDING.search(q)
            or re.search(r"\b(best|worst|top)\b.*\b(perform\w*|mover|gainer|loser|winner|up the most|down the most)\b", q)
            or (invest_ctx and re.search(r"\b(gain|loss|gained|lost|return|allocat|cost basis|how am i doing)\b", q))
            or re.search(r"\bhow much have i (gained|lost|made)\b", q)        # gain/return default → investments
            or re.search(r"\b(asset allocation|unrealized (gain|loss|p&?l)|cost basis|portfolio allocation)\b", q)):
        return "holdings"
    # 1c) HSA
    if re.search(r"\bhsa\b|health savings", q):
        return "hsa"
    # 1d) retirement savings (NOT a specific-account balance — let account_balance handle "roth balance")
    if re.search(r"\b(retirement|retire|401\(?k\)?|403b|\bira\b|\broth\b|pension)\b", q) and not re.search(r"\bbalance\b", q):
        return "retirement"
    # 1e) loan / mortgage detail
    if re.search(r"\b(mortgage|loan|payoff|paid off|amortiz|interest rate|total interest|how much interest|lifetime interest|owe on|car payment|heloc|student loan)\b", q):
        return "loan_detail"
    # 1f) business P&L — but NOT when it's actually an ACCOUNT question (e.g. an account literally
    #     named "Business Checking"). "business checking/savings/balance" → account_balance instead.
    if (re.search(r"\bbusiness\b", q) and not re.search(r"\b(checking|savings|account|balance|brokerage|debit|card|money market)\b", q)) \
            or re.search(r"schedule ?c|profit margin", q):
        return "business"
    # 2a) largest DEBT / biggest loan ('largest piece of debt') — before largest_assets, which would
    #     grab "piece" and answer with the biggest ASSET.
    if (superl and re.search(r"\b(debt|liabilit|loan|owe|mortgage)\b", q)) or re.search(r"\bowe (the )?most\b", q):
        return "loan_detail"
    # 2) largest ACCOUNT-level component of net worth (asset wins over spend) — but NOT a debt question
    if superl and _ASSET.search(q) and not re.search(r"\b(debt|liabilit|loan|owe)\b", q):
        return "largest_assets"
    # 3) net-worth CHANGE over time
    if _NETWORTH_TOTAL.search(q) and re.search(r"\b(change|changed|trend|grow|grew|growth|over time|progress|gone (up|down)|up or down|since|this (year|month))\b", q):
        return "net_worth_change"
    # 4) net worth / total assets / total liabilities — all from the authoritative snapshot
    #    ('total assets' ≠ net worth, so it must NOT just return the net-worth figure)
    if not superl and (_NETWORTH_TOTAL.search(q) or _ASSETS_TOTAL.search(q) or _LIABS_TOTAL.search(q)):
        return "net_worth"
    # 4b) liquid cash balance (before account_balance, which would treat "cash" as a named account)
    if _CASH.search(q):
        return "cash_balance"
    # 4c) financial health score / debt-to-assets
    if re.search(r"\b(financial (health|pulse)|health score|how healthy.*financ|debt.to.assets?|debt ratio)\b", q):
        return "financial_pulse"
    # 4d) day-of-week spending ('typical Monday spending') — before spending_total grabs it
    if re.search(r"\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|day of (the )?week|which day)\b", q) \
            and re.search(r"\bspend|spending|spent\b", q):
        return "day_of_week"
    # 4e) investment transactions (buys/sells/dividends) — NOT spending transactions
    if re.search(r"\b(investment (transactions?|activity|history)|my (dividends?|trades?)|what (stocks?|shares?) did i (buy|sell)|buys and sells)\b", q):
        return "investment_transactions"
    # 4f) average per month (before income/spending totals)
    if re.search(r"\b(average|avg|typical|on average).{0,20}\b(per month|a month|monthly|each month)\b|\bmonthly average\b", q):
        return "monthly_average"
    # 5) savings rate
    if re.search(r"\b(savings? rate|how much (am i|i'm) saving|am i saving enough|save each month|saving per month)\b", q):
        return "savings_rate"
    # 6) goals
    if re.search(r"\b(goals?|on track (for|to)|saving (up )?for|toward(s)? my|how close am i)\b", q):
        return "goals"
    # 7) accounts overview / list (totals come from net_worth; this is the per-account list)
    if re.search(r"\b(my accounts|what accounts|how many accounts|list .*accounts|all my accounts|account balances)\b", q):
        return "accounts_overview"
    # 8) stale accounts
    if re.search(r"\b(stale|out of date|outdated|need(s)? (updating|a refresh|to sync)|last updated|not synced)\b", q):
        return "stale_accounts"
    # 9) one account's balance — but NOT 'projected balance' / 'balance go negative' (→ forecast).
    #    Catches "what's in my [personal] checking", "how much in my savings", "<type> balance".
    if (re.search(r"\bbalance\b", q) and not re.search(r"projected|forecast|go(ing)? negative|in \d+ days|run out", q)) \
            or re.search(r"\b(how much (is |')?(in|s in)|what('?s| is) (in|the balance of)|how much.*\bhave in)\b.*\b(checking|savings|account|brokerage|money market|cash management)\b", q) \
            or re.search(r"\b(checking|savings|brokerage|money market|credit card) (account )?balance\b", q):
        return "account_balance"
    # 10) per-category budget ("am I over on dining", "how much left in my X budget")
    if re.search(r"\bbudgets?\b", q) and (re.search(r"\b(on|for|in|my)\b", q) and _HAS_CATEGORY_HINT.search(q)):
        return "budget_category"
    if re.search(r"\b(left in|remaining in|over on|under on|how much of my)\b.*\bbudgets?\b", q):
        return "budget_category"
    # "am I over on dining" — over/under on a category, even without the word 'budget'
    if re.search(r"\b(over|under) on\b", q) and _HAS_CATEGORY_HINT.search(q):
        return "budget_category"
    # 11) budget status (general; "budgets?" so "all budgets" matches too)
    if re.search(r"\b(budgets?|over ?budget|on ?track|overspend(ing)?)\b", q):
        return "budget_status"
    # 12) cash-flow forecast / runway / lowest point (forward-looking)
    if re.search(r"\b(runway|forecast|projected (balance|cash)|run out of (money|cash)|how long (will|can) my (money|cash)|months of (cash|expenses)|emergency fund last|go(ing)? negative|balance .*negative|low(est)? (point|balance|cash)|cash .*low point|when.*lowest)\b", q):
        return "cash_flow_forecast"
    # 13) upcoming bills
    if re.search(r"\b(bills?|due|upcoming|owe soon|payments? due)\b", q):
        return "upcoming_bills"
    # 14) subscriptions / recurring (+ "what can I cancel", "when's my next X charge")
    if re.search(r"\b(subscriptions?|recurring|memberships?|streaming|monthly charges?|cancel)\b", q) \
            or re.search(r"\bnext\b.*\b(charge|renewal)\b", q):
        return "subscriptions"
    # 15) income SOURCES ("where does my income come from")
    if re.search(r"\bincome sources?\b|\bwhere (does|do) my (income|money|paychecks?) come from\b|\bbiggest (income |)source\b", q):
        return "income_sources"
    # 16) income / deposits total
    if re.search(r"\b(income|earn(ed|ings)?|paycheck|salary|deposits?|get paid|got paid|take[- ]?home|how much did i (make|earn|bring))\b", q):
        return "income_total"
    # 17) cash flow (historical in/out)
    if re.search(r"\bcash ?flow\b|\bin (and|vs\.?) out\b|money (coming|going)", q):
        return "cash_flow"
    # 17a0) duplicate charges
    if re.search(r"\b(duplicate|charged twice|billed twice|double[- ]charg|same (merchant|charge|amount) twice|pay\w* (the )?same .* twice)\b", q):
        return "duplicate_charges"
    # 17a1) average / typical purchase size
    if re.search(r"\b(average|avg|typical|mean)\b.{0,25}\b(purchase|order|transaction|charge|spend|run|size|amount)\b", q):
        return "average_spend"
    # 17a) recent transactions — checked BEFORE the broad transaction-search rule so
    # "show me my recent transactions" isn't captured as a filtered search.
    if re.search(r"\b(recent|latest|last few|most recent)\b.*\b(transactions?|purchases?|charges?|buys?|spending|bought)\b", q):
        return "recent_transactions"
    # 17a2) compare two entities (tickers / categories / merchants) — NOT a period comparison
    if (re.search(r"\bcompare\b", q) or re.search(r"\bversus\b|\bvs\.?\b", q) or re.search(r"\bmore (on|at|in)\b.*\bor\b", q)) \
            and not re.search(r"\b(last|prior|previous) (month|year|quarter|week|period)\b", q):
        return "compare"
    # 17b) spending vs prior period ("did I spend more this month than last", "how does this month compare to last month")
    if (re.search(r"\b(compare|compared to|vs\.?|versus|more than|less than|than last)\b", q) and re.search(r"\bspend|spent|spending\b", q)) \
            or (re.search(r"\bthis (month|year)\b", q) and re.search(r"\b(compare|compared to|vs\.?|versus|to last|than last)\b", q)):
        return "spending_compare"
    # 17c) transaction search / filter (list or aggregate matching txns)
    if (re.search(r"\b(show|list|find|every|all (of )?my)\b.{0,30}\b(transactions?|purchases?|charges?|bought|spent)\b", q)
            or re.search(r"\b(transactions?|purchases?|charges?)\b.{0,20}\b(over|above|more than|greater than|under|below)\b", q)
            or re.search(r"\bwhat did i (buy|purchase|get)\b", q)
            or re.search(r"\b(over|above|more than|greater than)\s*\$?\s*\d", q)):
        return "transaction_search"
    # 19) category breakdown ("biggest category")
    if re.search(r"\bcategor", q):
        return "top_categories"
    # 20) spend at ONE merchant ("how much at Costco") — but not "at <age>" / DCFSA / retirement
    if spend_ctx and re.search(r"\bat\b", q) and not re.search(r"\bat \d|\bat age|\bdcfsa\b|\bretire", q):
        return "merchant_spend"
    # 21) spend on ONE category ("how much on groceries")
    if spend_ctx and re.search(r"\bon\b", q):
        return "category_spend"
    # 22) top merchant / where I spend the most
    if (superl and _MERCHANT.search(q)) or "top merchant" in q or re.search(r"\bwhere (do|did) i spend\b", q):
        return "top_merchant"
    # 23) largest single purchase / transaction
    if superl and _SPEND.search(q):
        return "largest_transactions"
    # 24) portfolio overview
    if re.search(r"\b(portfolio|invest(ed|ments?)?)\b", q):
        return "portfolio"
    # 25) spending total
    if re.search(r"\b(spend|spent|spending|how much did i (spend|pay)|outflow|expenses?)\b", q):
        return "spending_total"
    # 26) bare superlative with no object ("what's the single largest?") — needs conversation context
    if superl:
        return "_ambiguous_superlative"
    return None


# Category-ish words that signal a per-category budget question (kept loose; the retriever does the
# real category match against the user's actual budget rows).
_HAS_CATEGORY_HINT = re.compile(
    r"\b(dining|food|grocer|gas|fuel|shopping|travel|entertainment|health|utilit|rent|coffee|"
    r"transport|restaurant|subscription|category)\b")


def route(question: str, context: str = "") -> Optional[str]:
    """Pick the retriever for a question, or None for the open-ended path. A bare superlative with
    no object is resolved against recent conversation `context` (so 'what's the single largest?'
    after 'my net worth' means assets, not purchases)."""
    intent = _intent_for((question or "").lower())
    if intent == "_ambiguous_superlative":
        ctx = (context or "").lower()
        if _HOLDING.search(ctx):
            return "holdings"
        if _ASSET.search(ctx):
            return "largest_assets"
        if _SPEND.search(ctx) or _MERCHANT.search(ctx):
            return "largest_transactions"
        return None
    return intent


# ── deterministic retrievers ─────────────────────────────────────────────
def _spend_q(db):
    """Base query for real spending: money out (amount > 0), excluding transfers/cc-payments."""
    return db.query(Transaction).filter(Transaction.amount > 0, Transaction.is_transfer.is_(False))


def _result(intent, label, answer, *, rows=None, facts=None, found=True):
    return {"intent": intent, "window": label, "answer": answer,
            "rows": rows or [], "facts": facts or [], "found": found, "grounded": True}


def largest_transactions(db, start, end, label, question: str = "", *, limit: int = 8) -> dict:
    """The biggest INDIVIDUAL purchases in the window — the answer to 'most expensive thing'.
    This is a single-transaction query, deliberately NOT a per-merchant aggregate."""
    txns = (_spend_q(db)
            .filter(Transaction.date >= start, Transaction.date <= end)
            .order_by(Transaction.amount.desc()).limit(limit).all())
    rows = [{"date": t.date.isoformat(), "merchant": t.display_name,
             "amount": round(float(t.amount), 2), "category": t.display_category} for t in txns]
    if not rows:
        return _result("largest_transactions", label, f"I don't see any purchases in {label}.",
                       found=False)
    top = rows[0]
    ans = (f"Your most expensive single purchase in {label} was {_money(top['amount'])} "
           f"at {top['merchant']} on {top['date']}.")
    if len(rows) > 1:
        ans += f" The next was {_money(rows[1]['amount'])} at {rows[1]['merchant']}."
    return _result("largest_transactions", label, ans, rows=rows, facts=[r["amount"] for r in rows])


def spending_total(db, start, end, label, question: str = "") -> dict:
    txns = (_spend_q(db).filter(Transaction.date >= start, Transaction.date <= end)
            .with_entities(Transaction.amount).all())
    if not txns:
        return _result("spending_total", label, f"I don't see any spending in {label}.", found=False)
    total = round(sum(float(a) for (a,) in txns), 2)
    n = len(txns)
    ans = f"You spent about {_money(total)} across {n} purchases in {label}."
    return _result("spending_total", label, ans,
                   rows=[{"total": total, "count": n}], facts=[total, n])


def top_merchant(db, start, end, label, question: str = "", *, limit: int = 5) -> dict:
    txns = (_spend_q(db).filter(Transaction.date >= start, Transaction.date <= end).all())
    if not txns:
        return _result("top_merchant", label, f"I don't see any spending in {label}.", found=False)
    agg: dict[str, list] = {}
    for t in txns:
        m = t.display_name or "Unknown"
        slot = agg.setdefault(m, [0.0, 0])
        slot[0] += float(t.amount); slot[1] += 1
    ranked = sorted(agg.items(), key=lambda kv: -kv[1][0])[:limit]
    rows = [{"merchant": m, "total": round(v[0], 2), "count": v[1]} for m, v in ranked]
    top = rows[0]
    ans = (f"Your top merchant by total spend in {label} was {top['merchant']} at "
           f"{_money(top['total'])} across {top['count']} purchase(s).")
    return _result("top_merchant", label, ans, rows=rows,
                   facts=[r["total"] for r in rows] + [r["count"] for r in rows])


def top_categories(db, start, end, label, question: str = "", *, limit: int = 6) -> dict:
    txns = (_spend_q(db).filter(Transaction.date >= start, Transaction.date <= end).all())
    if not txns:
        return _result("top_categories", label, f"I don't see any spending in {label}.", found=False)
    agg: dict[str, float] = {}
    for t in txns:
        agg[t.display_category] = agg.get(t.display_category, 0.0) + float(t.amount)
    ranked = sorted(agg.items(), key=lambda kv: -kv[1])[:limit]
    rows = [{"category": c, "total": round(v, 2)} for c, v in ranked]
    top = rows[0]
    ans = f"Your biggest spending category in {label} was {top['category']} at {_money(top['total'])}."
    if len(rows) > 1:
        ans += f" Then {rows[1]['category']} at {_money(rows[1]['total'])}."
    return _result("top_categories", label, ans, rows=rows, facts=[r["total"] for r in rows])


def net_worth(db, start, end, label, question: str = "") -> dict:
    """Net worth, TOTAL ASSETS, or total liabilities — three distinct figures from the latest
    snapshot. Critical: 'total assets' is the gross asset value, NOT the net-worth figure (which is
    assets minus liabilities)."""
    from app.models.net_worth_snapshot import NetWorthSnapshot
    snap = db.query(NetWorthSnapshot).order_by(NetWorthSnapshot.date.desc()).first()
    if not snap:
        return _result("net_worth", label, "I don't have a net-worth snapshot recorded yet.", found=False)
    asof = snap.date.isoformat()
    nw = round(float(snap.net_worth or 0), 2)
    assets = round(float(snap.total_assets or 0), 2)
    liab = round(float(snap.total_liabilities or 0), 2)
    rows = [{"date": asof, "total_assets": assets, "total_liabilities": liab, "net_worth": nw}]
    q = (question or "").lower()
    if re.search(r"\bassets\b", q) and not re.search(r"\bnet ?worth\b", q):
        ans = (f"Your total assets are about {_money(assets)} as of {asof}"
               + (f", against {_money(liab)} in liabilities (net worth {_money(nw)})." if liab else "."))
        return _result("net_worth", "latest", ans, rows=rows, facts=[assets, liab, nw])
    if re.search(r"\b(liabilit|owe|debt)\b", q) and not re.search(r"\bnet ?worth\b", q):
        return _result("net_worth", "latest", f"Your total liabilities are about {_money(liab)} as of {asof}.",
                       rows=rows, facts=[liab])
    return _result("net_worth", "latest", f"Your net worth is about {_money(nw)} as of {asof}.",
                   rows=rows, facts=[nw])


def cash_balance(db, start, end, label, question: str = "") -> dict:
    """Total liquid CASH across checking / savings / money-market accounts — 'what's my cash balance',
    'how much cash do I have'. Distinct from a single named account's balance and from net worth."""
    from app.models.account import Account
    cash = [a for a in db.query(Account).all()
            if ((a.subtype or "").lower() in ("checking", "savings", "money market", "cash management", "cd")
                or (a.type or "").lower() == "depository")
            and float(a.current_balance or 0) != 0]
    if not cash:
        return _result("cash_balance", "now", "I don't see any cash, checking, or savings accounts on file.", found=False)
    total = round(sum(float(a.current_balance or 0) for a in cash), 2)
    rows = sorted(({"account": a.custom_name or a.name, "balance": round(float(a.current_balance or 0), 2),
                    "kind": a.subtype or a.type} for a in cash), key=lambda r: -r["balance"])
    ans = f"You have about {_money(total)} in cash across {len(cash)} account(s)."
    if len(rows) > 1:
        ans += f" Largest: {rows[0]['account']} at {_money(rows[0]['balance'])}."
    return _result("cash_balance", "now", ans, rows=rows, facts=[total, len(cash)])


def largest_assets(db, start, end, label, question: str = "", *, limit: int = 8) -> dict:
    """The biggest single COMPONENTS of net worth — asset accounts + manual assets, ranked by value.
    Answers 'what's the largest piece of my net worth'. Liability accounts (credit/loan) are not
    positive pieces, so they're excluded. We rank at the account level (not individual holdings) so
    an investment account isn't double-counted with the positions inside it."""
    from app.models.account import Account
    pieces: list[dict] = []
    for a in db.query(Account).all():
        if (a.type or "").lower() in ("credit", "loan"):
            continue
        val = float(a.current_balance or 0)
        if val <= 0:
            continue
        pieces.append({"name": a.custom_name or a.name, "value": round(val, 2),
                       "kind": a.subtype or a.type})
    try:
        from app.models.manual_asset import ManualAsset
        for m in db.query(ManualAsset).all():
            if (m.side or "asset") != "asset":
                continue
            val = float(m.current_value or 0)
            if val > 0:
                pieces.append({"name": m.name, "value": round(val, 2), "kind": m.type})
    except Exception:  # noqa: BLE001
        pass
    if not pieces:
        return _result("largest_assets", "now", "I don't have any accounts or assets recorded yet.",
                       found=False)
    pieces.sort(key=lambda p: -p["value"])
    rows = pieces[:limit]
    top = rows[0]
    ans = f"The single largest piece of your net worth is {top['name']} at {_money(top['value'])}."
    if len(rows) > 1:
        ans += f" The next is {rows[1]['name']} at {_money(rows[1]['value'])}."
    return _result("largest_assets", "now", ans, rows=rows, facts=[p["value"] for p in rows])


def portfolio(db, start, end, label, question: str = "") -> dict:
    """Reuse the existing portfolio_status builder (already deterministic) for the value/gain."""
    try:
        from app.services import chat_prompts as cp
        hs = cp.known_horizon_ids("portfolio_status")
        hz = sorted(hs)[0] if hs else None
        b = cp.build_bundle(db, "portfolio_status", hz) if hz else None
    except Exception:  # noqa: BLE001
        b = None
    if not b or b.get("no_data"):
        return _result("portfolio", label, "I don't have portfolio holdings recorded yet.", found=False)
    val = b.get("total_portfolio_value_dollars")
    ans = f"Your portfolio is worth about {_money(val)}."
    facts = [val] if val is not None else []
    gl = b.get("unrealized_gain_loss_dollars")
    if gl is not None:
        ans += f" Unrealized gain/loss on the invested portion is {_money(gl)}."
        facts.append(gl)
    return _result("portfolio", "now", ans, rows=[b], facts=facts)


# ── entity extraction (which category / merchant / account the question names) ──
_CATEGORY_SYNONYMS = {
    "groceries": "groceries", "grocery": "groceries", "dining": "dining", "restaurants": "dining",
    "eating out": "dining", "gas": "gas", "fuel": "gas", "transport": "transport",
    "shopping": "shopping", "travel": "travel", "entertainment": "entertainment",
    "health": "health", "utilities": "utilities", "rent": "rent", "mortgage": "mortgage",
    "subscriptions": "subscription", "coffee": "coffee",
}


def _known_categories(db) -> set[str]:
    out: set[str] = set()
    for c, cc in db.query(Transaction.category, Transaction.custom_category).distinct().all():
        v = cc or c
        if v:
            out.add(v)
    return out


def _match_category(question: str, known: set[str]) -> Optional[str]:
    q = (question or "").lower()
    # exact-ish: a known category name (or a meaningful token of it) appears in the question
    best = None
    for cat in known:
        cl = cat.lower()
        toks = [t for t in re.split(r"[^a-z]+", cl) if len(t) > 3]
        if cl in q or any(t in q for t in toks):
            if best is None or len(cl) > len(best.lower()):
                best = cat
    if best:
        return best
    # synonyms → find a known category whose name contains the canonical word
    for syn, canon in _CATEGORY_SYNONYMS.items():
        if syn in q:
            for cat in known:
                if canon in cat.lower():
                    return cat
            return canon.title()   # name it even if no exact category row matches
    return None


def _known_merchants(db, *, scan: int = 2000) -> list[str]:
    seen: dict[str, bool] = {}
    for t in _spend_q(db).order_by(Transaction.date.desc()).limit(scan).all():
        nm = t.display_name
        if nm:
            seen.setdefault(nm, True)
    return list(seen.keys())


def _match_merchant(question: str, names: list[str]) -> Optional[str]:
    q = (question or "").lower()
    best = None
    for n in names:
        nl = (n or "").lower()
        if not nl:
            continue
        if nl in q:                                    # full merchant name present
            if best is None or len(nl) > len(best.lower()):
                best = n
        elif best is None:                             # a distinctive single token ("costco")
            toks = [t for t in re.split(r"\W+", nl) if len(t) > 3]
            if toks and any(t in q for t in toks):
                best = n
    return best


def category_spend(db, start, end, label, question: str = "") -> dict:
    """Spend in ONE category over the window — 'how much did I spend on groceries this month'."""
    cat = _match_category(question, _known_categories(db))
    if not cat:
        return _result("category_spend", label,
                       "I couldn't tell which category you meant — try the exact name from your Categories tab.",
                       found=False)
    # display_category is a Python property (custom_category or category or
    # "Uncategorized"), so express the same precedence in SQL instead of
    # loading every spend row in the window and filtering in a loop.
    # nullif('') mirrors Python `or`, which also skips EMPTY strings — plain
    # coalesce would stop at a '' custom_category and mismatch the property.
    cat_l = cat.lower()
    txns = (
        _spend_q(db)
        .filter(Transaction.date >= start, Transaction.date <= end)
        .filter(func.lower(func.coalesce(func.nullif(Transaction.custom_category, ""),
                                         func.nullif(Transaction.category, ""),
                                         "Uncategorized")) == cat_l)
        .all()
    )
    total = round(sum(float(t.amount) for t in txns), 2)
    n = len(txns)
    if n == 0:
        return _result("category_spend", label, f"I don't see any {cat} spending in {label}.", found=False)
    ans = f"You spent about {_money(total)} on {cat} in {label} across {n} purchase(s)."
    return _result("category_spend", label, ans,
                   rows=[{"category": cat, "total": total, "count": n}], facts=[total, n])


def merchant_spend(db, start, end, label, question: str = "") -> dict:
    """Spend at ONE merchant over the window — 'how much did I spend at Costco'."""
    m = _match_merchant(question, _known_merchants(db))
    if not m:
        return _result("merchant_spend", label,
                       "I couldn't tell which merchant you meant — try the name as it appears in Transactions.",
                       found=False)
    txns = [t for t in _spend_q(db).filter(Transaction.date >= start, Transaction.date <= end).all()
            if t.display_name == m]
    total = round(sum(float(t.amount) for t in txns), 2)
    n = len(txns)
    if n == 0:
        return _result("merchant_spend", label, f"I don't see any spending at {m} in {label}.", found=False)
    ans = f"You spent about {_money(total)} at {m} in {label} across {n} purchase(s)."
    return _result("merchant_spend", label, ans,
                   rows=[{"merchant": m, "total": total, "count": n}], facts=[total, n])


def recent_transactions(db, start, end, label, question: str = "", *, limit: int = 8) -> dict:
    """The most recent purchases (by date) — 'what are my recent transactions'."""
    txns = (_spend_q(db).order_by(Transaction.date.desc(), Transaction.id.desc()).limit(limit).all())
    rows = [{"date": t.date.isoformat(), "merchant": t.display_name,
             "amount": round(float(t.amount), 2), "category": t.display_category} for t in txns]
    if not rows:
        return _result("recent_transactions", "recent", "I don't see any recent purchases.", found=False)
    lead = ", ".join(f"{_money(r['amount'])} at {r['merchant']}" for r in rows[:3])
    ans = f"Your most recent purchases: {lead}."
    return _result("recent_transactions", "recent", ans, rows=rows, facts=[r["amount"] for r in rows])


def income_total(db, start, end, label, question: str = "") -> dict:
    """Deposits (money in, non-transfer) over the window — 'how much did I make/earn'."""
    rows = (db.query(Transaction)
            .filter(Transaction.amount < 0, Transaction.is_transfer.is_(False),
                    Transaction.date >= start, Transaction.date <= end)
            .with_entities(Transaction.amount).all())
    if not rows:
        return _result("income_total", label, f"I don't see any deposits in {label}.", found=False)
    total = round(sum(-float(a) for (a,) in rows), 2)
    n = len(rows)
    ans = (f"About {_money(total)} in deposits hit your accounts in {label} across {n}. "
           "That's bank-visible income only — pre-tax 401(k) isn't included.")
    return _result("income_total", label, ans,
                   rows=[{"total": total, "count": n}], facts=[total, n])


def cash_flow(db, start, end, label, question: str = "") -> dict:
    """In vs out over the window — 'what's my net cash flow this month'."""
    out_rows = (_spend_q(db).filter(Transaction.date >= start, Transaction.date <= end)
                .with_entities(Transaction.amount).all())
    in_rows = (db.query(Transaction)
               .filter(Transaction.amount < 0, Transaction.is_transfer.is_(False),
                       Transaction.date >= start, Transaction.date <= end)
               .with_entities(Transaction.amount).all())
    outflow = round(sum(float(a) for (a,) in out_rows), 2)
    inflow = round(sum(-float(a) for (a,) in in_rows), 2)
    if not out_rows and not in_rows:
        return _result("cash_flow", label, f"I don't see any activity in {label}.", found=False)
    net = round(inflow - outflow, 2)
    ans = (f"In {label}, about {_money(inflow)} came in and {_money(outflow)} went out — "
           f"net {'+' if net >= 0 else '-'}{_money(abs(net))}.")
    return _result("cash_flow", label, ans,
                   rows=[{"inflow": inflow, "outflow": outflow, "net": net}],
                   facts=[inflow, outflow, abs(net)])


_ACCT_TYPEWORDS = ("checking", "savings", "brokerage", "credit", "money market", "401k", "roth",
                   "ira", "hsa", "cash management", "cd", "loan", "mortgage")
_ACCT_QUALIFIERS = ("personal", "business", "joint", "primary", "main", "everyday", "shared",
                    "emergency", "kids", "household")


def account_balance(db, start, end, label, question: str = "") -> dict:
    """Balance of ONE named account — 'what's in my personal checking', 'my brokerage balance'.
    Matches by overlap of the account's name/subtype/type tokens (and qualifiers like 'personal')
    with the question, so it resolves the right account even with several of the same type."""
    from app.models.account import Account
    accts = db.query(Account).all()
    if not accts:
        return _result("account_balance", "now", "I don't see any accounts on file.", found=False)
    q = (question or "").lower()

    def score(a) -> int:
        blob = " ".join([a.custom_name or "", a.name or "", a.subtype or "", a.type or ""]).lower()
        toks = {t for t in re.split(r"[^a-z0-9]+", blob) if len(t) > 2}
        s = sum(1 for t in toks if re.search(r"\b" + re.escape(t) + r"\b", q))
        for kw in _ACCT_TYPEWORDS:
            if kw.replace(" ", "") in blob.replace(" ", "") and kw.replace(" ", "") in q.replace(" ", ""):
                s += 1
        for ql in _ACCT_QUALIFIERS:        # 'personal'/'business'/'joint' are strong disambiguators
            if ql in blob and ql in q:
                s += 2
        return s

    ranked = sorted(accts, key=score, reverse=True)
    if score(ranked[0]) <= 0:
        return _result("account_balance", "now",
                       "Which account? Name it (e.g. 'checking', 'brokerage') and I'll pull the balance.",
                       found=False)
    a = ranked[0]
    val = round(float(a.current_balance or 0), 2)
    return _result("account_balance", "now", f"Your {a.custom_name or a.name} balance is {_money(val)}.",
                   rows=[{"account": a.custom_name or a.name, "balance": val, "kind": a.subtype or a.type}],
                   facts=[val])


def accounts_overview(db, start, end, label, question: str = "") -> dict:
    """Assets vs liabilities across accounts + how many — 'what accounts do I have / how much debt'."""
    from app.models.account import Account
    accts = db.query(Account).all()
    if not accts:
        return _result("accounts_overview", "now", "I don't have any accounts recorded yet.", found=False)
    assets = round(sum(float(a.current_balance or 0) for a in accts
                       if (a.type or "").lower() not in ("credit", "loan") and float(a.current_balance or 0) > 0), 2)
    liab = round(sum(float(a.current_balance or 0) for a in accts
                     if (a.type or "").lower() in ("credit", "loan")), 2)
    rows = sorted(({"account": a.custom_name or a.name, "balance": round(float(a.current_balance or 0), 2),
                    "kind": a.subtype or a.type} for a in accts), key=lambda r: -abs(r["balance"]))[:10]
    ans = (f"You have {len(accts)} accounts: about {_money(assets)} in assets and "
           f"{_money(liab)} in liabilities across them.")
    return _result("accounts_overview", "now", ans, rows=rows, facts=[assets, liab, len(accts)])


# ── reuse of existing deterministic builders (chat_prompts) ──────────────
def _reuse_bundle(db, pid: str):
    from app.services import chat_prompts as cp
    try:
        hs = cp.known_horizon_ids(pid)
        hz = sorted(hs)[0] if hs else None
        return cp.build_bundle(db, pid, hz) if hz else None
    except Exception:  # noqa: BLE001
        return None


def net_worth_change(db, start, end, label, question: str = "") -> dict:
    b = _reuse_bundle(db, "net_worth_change")
    if not b or b.get("no_data"):
        return _result("net_worth_change", label, "I don't have enough net-worth history recorded yet.", found=False)
    latest = b.get("latest_net_worth_dollars")
    chg = b.get("change_dollars")
    lbl = b.get("horizon_label", "recently")
    ans = f"Your net worth is {_money(latest)}"
    facts = [latest] if latest is not None else []
    if chg is not None and not b.get("baseline_truncated"):
        ans += f", {'up' if chg >= 0 else 'down'} {_money(abs(chg))} {lbl}"
        facts.append(abs(chg))
    ans += "."
    rows = [{k: b.get(k) for k in ("latest_net_worth_dollars", "change_dollars", "change_percent", "horizon_label")}]
    return _result("net_worth_change", lbl, ans, rows=rows, facts=facts)


def upcoming_bills(db, start, end, label, question: str = "") -> dict:
    b = _reuse_bundle(db, "upcoming_bills")
    if not b or b.get("no_data"):
        return _result("upcoming_bills", label,
                       "No mortgage or credit-card bills with due-date data are scheduled. "
                       "(Manual liabilities like Apple Card aren't tracked here.)", found=False)
    cnt = b.get("bill_count")
    tot = b.get("total_due_dollars")
    lbl = b.get("horizon_label", "soon")
    ans = f"{cnt} bill(s) totaling {_money(tot)} due {lbl} (mortgage + credit cards only)."
    return _result("upcoming_bills", lbl, ans, rows=b.get("bills") or [], facts=[tot, cnt])


def budget_status(db, start, end, label, question: str = "") -> dict:
    # "how much do I have left across all budgets" → total limits − total spent (dollars, not a count)
    if re.search(r"\b(left|remaining)\b", (question or "").lower()):
        from datetime import date as _date
        from app.models.budget import Budget
        today = _date.today()
        bud = db.query(Budget).filter_by(month=today.month, year=today.year).first()
        if bud and bud.categories:
            cats = {c.category.lower() for c in bud.categories}
            total_limit = round(sum(float(c.limit_amount or 0) for c in bud.categories), 2)
            spent = round(sum(float(t.amount) for t in
                              _spend_q(db).filter(Transaction.date >= today.replace(day=1), Transaction.date <= today).all()
                              if (t.display_category or "").lower() in cats), 2)
            rem = round(total_limit - spent, 2)
            return _result("budget_status", "this month",
                           f"Across your budgets you've spent {_money(spent)} of {_money(total_limit)} — "
                           f"{_money(abs(rem))} {'left' if rem >= 0 else 'over'}.",
                           rows=[{"total_limit": total_limit, "spent": spent, "remaining": rem}],
                           facts=[spent, total_limit, abs(rem)])
    b = _reuse_bundle(db, "overspending")
    if not b:
        return _result("budget_status", label, "I don't have budgets set up to check.", found=False)
    if b.get("no_data") and b.get("reason"):
        return _result("budget_status", label, b["reason"], found=False)
    if b.get("nothing_to_flag"):
        cnt = b.get("budget_categories_count")
        return _result("budget_status", "this month",
                       f"All {cnt} budget categories are on track this month — nothing over.",
                       rows=[{"on_track": cnt}], facts=[cnt] if cnt is not None else [])
    over = b.get("categories_over_count")
    tot = b.get("total_over_dollars")
    worst = (b.get("categories_over_budget") or [{}])[0]
    ans = f"{over} category(ies) over budget this month, {_money(tot)} over in total."
    facts = [tot] if tot is not None else []
    if worst.get("category"):
        ans += f" Worst: {worst['category']} by {_money(worst.get('over_dollars'))}."
        if worst.get("over_dollars") is not None:
            facts.append(worst["over_dollars"])
    return _result("budget_status", "this month", ans,
                   rows=b.get("categories_over_budget") or [], facts=facts)


# ── investments at the holding level (rich: per-ticker, movers, allocation, gain/loss) ──
def _held(db) -> list[dict]:
    from app.models.holding import Holding
    from app.models.security import Security
    rows: list[dict] = []
    for h, s in (db.query(Holding, Security)
                 .join(Security, Holding.plaid_security_id == Security.plaid_security_id).all()):
        if s and s.is_cash_equivalent:
            continue
        val = round(float(h.institution_value or 0), 2)
        cost = round(float(h.cost_basis), 2) if h.cost_basis is not None else None
        gain = round(val - cost, 2) if cost is not None else None
        gain_pct = round((val / cost - 1) * 100, 1) if cost else None
        rows.append({"ticker": (s.ticker_symbol or s.name or "?"), "name": s.name, "type": s.type or "other",
                     "value": val, "cost": cost, "gain": gain, "gain_pct": gain_pct,
                     "shares": round(float(h.quantity or 0), 4)})
    return rows


def _names_held_security(db, question: str) -> bool:
    """Does the question name a security the user holds (ticker, full name, or a distinctive name
    token like 'apple')? Used only as a last-resort routing fallback for bare-ticker questions."""
    q = (question or "").lower()
    for r in _held(db):
        t = (r["ticker"] or "").lower()
        nm = (r["name"] or "").lower()
        if (t and re.search(r"\b" + re.escape(t) + r"\b", q)) or (nm and nm in q) \
                or (nm and any(re.search(r"\b" + re.escape(tok) + r"\b", q) for tok in nm.split() if len(tok) >= 4)):
            return True
    return False


def holdings(db, start, end, label, question: str = "") -> dict:
    """Investments at the holding level — one ticker, best/worst mover, largest position, total
    gain/loss, allocation, or count. Answers the follow-ups 'how's my NVDA', 'best performer',
    'biggest holding', 'how much have I gained', 'how much is in ETFs'."""
    rows = _held(db)
    if not rows:
        return _result("holdings", "now", "I don't see any investment holdings recorded yet.", found=False)
    q = (question or "").lower()
    total_val = round(sum(r["value"] for r in rows), 2)

    named = None
    for r in rows:
        t = (r["ticker"] or "").lower()
        nm = (r["name"] or "").lower()
        if (t and re.search(r"\b" + re.escape(t) + r"\b", q)) or (nm and nm in q) \
                or (nm and any(tok in q for tok in nm.split() if len(tok) > 3)):
            named = r
            break
    if named:
        a = f"Your {named['ticker']} position is worth {_money(named['value'])} ({named['shares']:g} shares)"
        facts = [named["value"], named["shares"]]
        if named["gain"] is not None:
            a += f", {'up' if named['gain'] >= 0 else 'down'} {_money(abs(named['gain']))}" + \
                 (f" ({named['gain_pct']}%)" if named["gain_pct"] is not None else "")
            facts.append(abs(named["gain"]))
        return _result("holdings", "now", a + ".", rows=[named], facts=facts)

    withpct = [r for r in rows if r["gain_pct"] is not None]
    if re.search(r"\b(best|top)\b.*\b(perform|mover|gainer|winner)\b|\bbiggest (gain|winner)\b", q) and withpct:
        top = max(withpct, key=lambda r: r["gain_pct"])
        return _result("holdings", "now",
                       f"Your best performer is {top['ticker']}, up {top['gain_pct']}% ({_money(top['gain'])}).",
                       rows=[top], facts=[abs(top["gain"])])
    if re.search(r"\b(worst|biggest los(er|s)|down the most)\b", q) and withpct:
        bot = min(withpct, key=lambda r: r["gain_pct"])
        word = f"down {abs(bot['gain_pct'])}%" if bot["gain_pct"] < 0 else f"up {bot['gain_pct']}%"
        return _result("holdings", "now",
                       f"Your worst performer is {bot['ticker']}, {word} ({_money(bot['gain'])}).",
                       rows=[bot], facts=[abs(bot["gain"])])
    if re.search(r"\b(biggest|largest|top|most)\b", q) and re.search(r"\b(holding|position|stock|share|invest|own)\b", q):
        top = max(rows, key=lambda r: r["value"])
        pct = round(top["value"] / total_val * 100, 1) if total_val else 0
        return _result("holdings", "now",
                       f"Your largest holding is {top['ticker']} at {_money(top['value'])} — about {pct}% of your {_money(total_val)} portfolio.",
                       rows=sorted(rows, key=lambda r: -r["value"])[:10], facts=[top["value"], total_val])
    if re.search(r"\bcost basis\b", q):
        wc = [r for r in rows if r["cost"] is not None]
        tc = round(sum(r["cost"] for r in wc), 2)
        return _result("holdings", "now", f"Your total cost basis is about {_money(tc)} across {len(wc)} positions.",
                       rows=sorted(wc, key=lambda r: -(r["cost"] or 0))[:10], facts=[tc, len(wc)])
    if re.search(r"\b(gain|loss|gained|lost|up or down|return|made|how am i doing|profit|unrealized)\b", q):
        wc = [r for r in rows if r["gain"] is not None]
        tg = round(sum(r["gain"] for r in wc), 2)
        return _result("holdings", "now",
                       f"Across your holdings you're {'up' if tg >= 0 else 'down'} about {_money(abs(tg))} unrealized.",
                       rows=sorted(wc, key=lambda r: -(r["gain"] or 0))[:10], facts=[abs(tg)])
    if re.search(r"\b(allocat|how much (in|is in)|breakdown|mix|exposure)\b", q):
        agg: dict[str, float] = {}
        for r in rows:
            agg[r["type"]] = agg.get(r["type"], 0.0) + r["value"]
        ranked = sorted(agg.items(), key=lambda kv: -kv[1])
        top = ranked[0]
        pct = round(top[1] / total_val * 100, 1) if total_val else 0
        return _result("holdings", "now",
                       f"Your biggest allocation is {top[0]} at {_money(round(top[1], 2))} ({pct}% of {_money(total_val)}).",
                       rows=[{"type": k, "value": round(v, 2)} for k, v in ranked], facts=[round(top[1], 2), total_val])
    if re.search(r"\bhow many (holdings|positions|stocks|shares)\b", q):
        return _result("holdings", "now", f"You hold {len(rows)} positions worth {_money(total_val)} in total.",
                       rows=sorted(rows, key=lambda r: -r["value"])[:10], facts=[len(rows), total_val])
    # default
    top = max(rows, key=lambda r: r["value"])
    return _result("holdings", "now",
                   f"You hold {len(rows)} positions worth {_money(total_val)}; your biggest is {top['ticker']} at {_money(top['value'])}.",
                   rows=sorted(rows, key=lambda r: -r["value"])[:10], facts=[len(rows), total_val, top["value"]])


# ── recurring / subscriptions (reuse detect_recurring) ──
def subscriptions(db, start, end, label, question: str = "") -> dict:
    try:
        from app.routers.analytics import detect_recurring
        res = detect_recurring(db)
    except Exception:  # noqa: BLE001
        res = None
    items = res.get("recurring") if isinstance(res, dict) else (res or [])
    subs = [r for r in (items or []) if not r.get("is_income") and r.get("kind") in ("subscription", "bill")]
    if not subs:
        return _result("subscriptions", "now", "I don't see any recurring subscriptions or bills detected yet.", found=False)
    ranked = sorted(subs, key=lambda r: -(r.get("annual_cost") or 0))
    monthly = round(sum((r.get("annual_cost") or 0) for r in subs) / 12, 2)
    rows = [{"name": r.get("merchant"), "monthly": round((r.get("annual_cost") or 0) / 12, 2),
             "kind": r.get("kind"), "next_due": r.get("next_expected")} for r in ranked[:12]]
    q = (question or "").lower()
    if re.search(r"\bnext\b.*\b(charge|payment|bill|due|renew)\b|when('?s| is| does)\b.*\bnext\b", q):
        tgt = next((r for r in ranked if (r.get("merchant") or "").lower()
                    and ((r["merchant"].lower() in q) or any(t in q for t in re.split(r"\W+", r["merchant"].lower()) if len(t) > 3))), None)
        if tgt is None and len(ranked) == 1:
            tgt = ranked[0]
        if tgt is None:
            up = sorted([r for r in subs if r.get("next_expected")], key=lambda r: r.get("next_expected"))
            tgt = up[0] if up else None
        if tgt:
            amt = tgt.get("avg_amount") or tgt.get("latest_amount")
            return _result("subscriptions", "now",
                           f"Your next {tgt.get('merchant')} charge (~{_money(amt)}) is expected around {tgt.get('next_expected')}.",
                           rows=rows, facts=[amt] if amt else [])
    if re.search(r"\b(most expensive|biggest|priciest|largest)\b", q):
        top = ranked[0]
        return _result("subscriptions", "now",
                       f"Your most expensive recurring charge is {top.get('merchant')} at about {_money((top.get('annual_cost') or 0) / 12)}/month.",
                       rows=rows, facts=[round((top.get("annual_cost") or 0) / 12, 2)])
    if re.search(r"\b(anomal|went up|increase|changed|jump|higher)\b", q):
        anom = [r for r in subs if r.get("is_anomalous")]
        msg = (f"{len(anom)} recurring charge(s) look unusually high lately, e.g. {anom[0].get('merchant')}."
               if anom else "None of your recurring charges look unusually high right now.")
        return _result("subscriptions", "now", msg, rows=rows, facts=[len(anom)] if anom else [])
    if re.search(r"\b(overdue|late|missed)\b", q):
        od = [r for r in subs if r.get("is_overdue")]
        return _result("subscriptions", "now",
                       (f"{len(od)} recurring charge(s) look overdue." if od else "Nothing recurring looks overdue."),
                       rows=rows, facts=[len(od)] if od else [])
    if re.search(r"\bhow many\b", q):
        return _result("subscriptions", "now",
                       f"You have about {len(subs)} recurring subscriptions and bills, totaling roughly {_money(monthly)}/month.",
                       rows=rows, facts=[len(subs), monthly])
    return _result("subscriptions", "now",
                   f"You have about {len(subs)} recurring charges costing roughly {_money(monthly)}/month. "
                   f"Biggest: {ranked[0].get('merchant')} (~{_money((ranked[0].get('annual_cost') or 0) / 12)}/mo).",
                   rows=rows, facts=[len(subs), monthly, round((ranked[0].get("annual_cost") or 0) / 12, 2)])


# ── savings rate / income sources / stale accounts (reuse builders) ──
def savings_rate(db, start, end, label, question: str = "") -> dict:
    b = _reuse_bundle(db, "savings_rate")
    if not b or b.get("no_data"):
        return _result("savings_rate", "now", "I can't compute a savings rate yet — I don't see enough bank-visible income.", found=False)
    rate = b.get("visible_savings_rate_percent")
    save = b.get("monthly_savings_dollars")
    ans = f"Your bank-visible savings rate is about {rate}%"
    facts = []
    if rate is not None:
        facts.append(rate)
    if save is not None:
        ans += f", roughly {_money(save)} saved per month"
        facts.append(abs(save))
    ans += ". Pre-tax 401(k) deferrals would push the true rate higher."
    return _result("savings_rate", "trailing 90 days", ans,
                   rows=[{k: b.get(k) for k in ("visible_savings_rate_percent", "monthly_inflow_dollars", "monthly_outflow_dollars", "monthly_savings_dollars")}],
                   facts=facts)


def income_sources(db, start, end, label, question: str = "") -> dict:
    b = _reuse_bundle(db, "income_total")
    srcs = (b or {}).get("top_sources") or []
    if not b or b.get("no_data") or not srcs:
        return _result("income_sources", label, "I don't see distinct income sources in the window yet.", found=False)
    def _nm(s):
        return s.get("source") or s.get("merchant") or s.get("name") or "your main source"
    def _amt(s):
        return s.get("amount_dollars") or s.get("total_dollars") or s.get("amount")
    top = srcs[0]
    amt = _amt(top)
    ans = f"Your largest income source is {_nm(top)}" + (f" at {_money(amt)}" if amt else "") + f" {b.get('horizon_label', '')}.".rstrip()
    rows = [{"source": _nm(s), "amount": _amt(s)} for s in srcs[:8]]
    return _result("income_sources", b.get("horizon_label", label), ans, rows=rows, facts=[amt] if amt else [])


def stale_accounts(db, start, end, label, question: str = "") -> dict:
    b = _reuse_bundle(db, "stale_accounts")
    if not b or b.get("no_data"):
        tot = (b or {}).get("total_accounts")
        return _result("stale_accounts", "now",
                       f"All{f' {tot}' if tot else ''} of your accounts look up to date.", rows=[], facts=[])
    cnt = b.get("stale_count")
    tot = b.get("total_accounts")
    worst = (b.get("stale_accounts") or [{}])[0]
    ans = f"{cnt} of {tot} accounts are overdue for a refresh."
    if worst.get("account"):
        ans += f" Oldest: {worst['account']}."
    return _result("stale_accounts", "now", ans, rows=b.get("stale_accounts") or [], facts=[])


# ── per-category budget, goals, cash-flow runway (direct queries) ──
def budget_category(db, start, end, label, question: str = "") -> dict:
    from datetime import date as _date
    from app.models.budget import Budget
    today = _date.today()
    budget = db.query(Budget).filter_by(month=today.month, year=today.year).first()
    if not budget or not budget.categories:
        return _result("budget_category", "this month", "No category budgets are set for this month.", found=False)
    cat = _match_category(question, {bc.category for bc in budget.categories})
    if not cat:
        return _result("budget_category", "this month",
                       "Which budget category? Name it (e.g. 'dining') and I'll check it.", found=False)
    bc = next((x for x in budget.categories if x.category.lower() == cat.lower()), None)
    if not bc:
        return _result("budget_category", "this month", f"You don't have a budget set for {cat}.", found=False)
    spent = round(sum(float(t.amount) for t in
                      _spend_q(db).filter(Transaction.date >= today.replace(day=1), Transaction.date <= today).all()
                      if (t.display_category or "").lower() == cat.lower()), 2)
    limit = round(float(bc.limit_amount), 2)
    remaining = round(limit - spent, 2)
    ans = (f"You've spent {_money(spent)} of your {_money(limit)} {cat} budget this month — "
           f"{_money(abs(remaining))} {'left' if remaining >= 0 else 'over'}.")
    return _result("budget_category", "this month", ans,
                   rows=[{"category": cat, "spent": spent, "limit": limit, "remaining": remaining}],
                   facts=[spent, limit, abs(remaining)])


def goals(db, start, end, label, question: str = "") -> dict:
    from datetime import date as _date
    from app.models.savings_goal import SavingsGoal
    from app.models.account import Account
    gs = db.query(SavingsGoal).filter(SavingsGoal.is_active == 1).all()
    if not gs:
        return _result("goals", "now", "You don't have any active savings goals set up.", found=False)

    def cur(g):
        if g.manual_current_amount is not None:
            return float(g.manual_current_amount)
        ids = g.source_account_ids or []
        if not ids:
            return 0.0
        return sum(float(a.current_balance or 0) for a in db.query(Account).filter(Account.id.in_(ids)).all())

    q = (question or "").lower()
    target = next((g for g in gs if g.name and g.name.lower() in q), None)
    if target is None and len(gs) == 1:
        target = gs[0]
    if target is None:
        rows = [{"goal": g.name, "current": round(cur(g), 2), "target": round(float(g.target_amount), 2)} for g in gs]
        return _result("goals", "now",
                       f"You have {len(gs)} active goals: {', '.join(g.name for g in gs[:4])}. Ask about one by name for its progress.",
                       rows=rows, facts=[len(gs)])
    c = round(cur(target), 2)
    tgt = round(float(target.target_amount), 2)
    rem = round(tgt - c, 2)
    pct = round(c / tgt * 100, 1) if tgt else 0
    ans = (f"Your {target.name} goal is {pct}% funded — {_money(c)} of {_money(tgt)}, "
           f"{_money(abs(rem))} {'to go' if rem > 0 else 'over target'}.")
    facts = [c, tgt, abs(rem), pct]
    if target.target_date and rem > 0:
        months = max(1.0, (target.target_date - _date.today()).days / 30.0)
        need = round(rem / months, 2)
        ans += f" To reach it by {target.target_date.isoformat()}, save about {_money(need)}/month."
        facts.append(need)
    return _result("goals", "now", ans,
                   rows=[{"goal": target.name, "current": c, "target": tgt, "remaining": rem, "percent": pct}],
                   facts=facts)


def cash_flow_forecast(db, start, end, label, question: str = "") -> dict:
    """Forward-looking runway / projected balance / lowest point from current liquid cash + recent
    net burn. The low-point uses the analytics daily simulation (which knows upcoming bills)."""
    from datetime import date as _date, timedelta as _td
    from app.models.account import Account
    q0 = (question or "").lower()
    if re.search(r"\b(low(est)? (point|balance|cash)|trough|dip|when.*(lowest|negative)|go(ing)? negative)\b", q0):
        try:
            from app.routers.analytics import cash_flow_forecast as _cff
            res = _cff(days=90, db=db)
        except Exception:  # noqa: BLE001
            res = None
        lp = (res or {}).get("low_point")
        if lp and lp.get("date"):
            bal = round(float(lp.get("balance") or 0), 2)
            ans = (f"Over the next 90 days your projected low point is about {_money(bal)} around {lp['date']}"
                   + (" — that dips below zero, so plan ahead." if bal < 0 else "."))
            return _result("cash_flow_forecast", "next 90 days", ans, rows=[lp], facts=[abs(bal)])
        # no clean low point → fall through to the runway/projected answer below
    cash = round(sum(float(a.current_balance or 0) for a in db.query(Account).all()
                     if (a.subtype or "").lower() in ("checking", "savings", "money market", "cash management")
                     or (a.type or "").lower() == "depository"), 2)
    today = _date.today()
    since = today - _td(days=90)
    out = sum(float(a) for (a,) in _spend_q(db).filter(Transaction.date >= since).with_entities(Transaction.amount).all())
    inc = sum(-float(a) for (a,) in db.query(Transaction)
              .filter(Transaction.amount < 0, Transaction.is_transfer.is_(False), Transaction.date >= since)
              .with_entities(Transaction.amount).all())
    monthly_net = round((inc - out) / 3.0, 2)
    if cash <= 0 and not out and not inc:
        return _result("cash_flow_forecast", "now", "I don't have enough cash-account history to project a runway yet.", found=False)
    q = (question or "").lower()
    days = 30
    m = re.search(r"(\d{2,3})\s*days", q)
    if m:
        days = min(180, max(7, int(m.group(1))))
    if monthly_net < 0:
        runway = round(cash / abs(monthly_net), 1)
        ans = (f"You have about {_money(cash)} in cash. At your recent net burn of about "
               f"{_money(abs(monthly_net))}/month, that's roughly {runway} months of runway.")
        return _result("cash_flow_forecast", "now", ans,
                       rows=[{"cash": cash, "monthly_net": monthly_net, "runway_months": runway}],
                       facts=[cash, abs(monthly_net), runway])
    proj = round(cash + monthly_net * (days / 30.0), 2)
    ans = (f"You have about {_money(cash)} in cash and you're roughly cash-flow positive "
           f"(~{_money(abs(monthly_net))}/month), so your projected balance in {days} days is about {_money(proj)}.")
    return _result("cash_flow_forecast", f"{days} days", ans,
                   rows=[{"cash": cash, "monthly_net": monthly_net, "projected": proj, "days": days}],
                   facts=[cash, abs(monthly_net), proj])


# ── Tier 2: loans, retirement, trading-tax, business, HSA (wrap existing services) ──
def loan_detail(db, start, end, label, question: str = "") -> dict:
    """Loan terms — balance, rate, monthly payment, projected payoff, or total owed. Reuses the
    debt_payoff amortization. Answers 'mortgage balance', 'when's it paid off', 'what's my rate',
    'monthly payment', 'how much do I owe on my car'."""
    try:
        from app.routers.analytics import debt_payoff
        res = debt_payoff(db)
    except Exception:  # noqa: BLE001
        res = None
    debts = res.get("debts") if isinstance(res, dict) else (res or [])
    debts = [d for d in (debts or []) if (d.get("balance") or 0) > 0]
    if not debts:
        return _result("loan_detail", "now", "I don't see any loans or balances owed.", found=False)
    q = (question or "").lower()
    named = None
    for d in debts:
        nm = (d.get("name") or "").lower()
        if nm and (nm in q or any(tok in q for tok in nm.split() if len(tok) > 3)):
            named = d
            break
    if re.search(r"\b(largest|biggest|highest|most)\b.*\b(debt|loan|owe|liabilit)\b|biggest (debt|loan)|owe (the )?most", q):
        t = max(debts, key=lambda d: d.get("balance") or 0)
        bal = round(float(t.get("balance") or 0), 2)
        return _result("loan_detail", "now", f"Your largest debt is {t.get('name')} at {_money(bal)}.",
                       rows=debts, facts=[bal])
    if re.search(r"\b(total debt|how much (do i owe|debt)|all my (loans|debt))\b", q):
        tot = round(sum(float(d.get("balance") or 0) for d in debts), 2)
        return _result("loan_detail", "now", f"You owe about {_money(tot)} across {len(debts)} loans/balances.",
                       rows=debts, facts=[tot, len(debts)])
    t = named or max(debts, key=lambda d: d.get("balance") or 0)
    nm = t.get("name") or "your loan"
    bal = round(float(t.get("balance") or 0), 2)
    rate, pay, payoff = t.get("annual_rate_pct"), t.get("monthly_payment"), t.get("payoff_date")
    if re.search(r"\b(total interest|how much interest|lifetime interest|interest (i'?ll|will i) pay)\b", q):
        ti = t.get("total_remaining_interest", t.get("total_interest", t.get("remaining_interest")))
        if ti is not None:
            return _result("loan_detail", "now",
                           f"You're projected to pay about {_money(ti)} in remaining interest on your {nm}.",
                           rows=[t], facts=[round(float(ti), 2)])
        return _result("loan_detail", "now",
                       f"I can't project total interest on your {nm} without its rate and payment on file.", found=False)
    if re.search(r"\b(rate|apr|interest rate)\b", q) and rate is not None:
        return _result("loan_detail", "now", f"Your {nm} interest rate is {rate}%.", rows=[t], facts=[rate])
    if re.search(r"\b(payment|monthly|per month)\b", q) and pay:
        return _result("loan_detail", "now", f"Your {nm} monthly payment is {_money(pay)}.", rows=[t], facts=[pay])
    if re.search(r"\b(paid off|payoff|pay off|when|how long)\b", q) and payoff:
        return _result("loan_detail", "now", f"At the current payment, your {nm} is projected paid off by {payoff}.",
                       rows=[t], facts=[bal])
    ans = f"Your {nm} balance is {_money(bal)}"
    facts = [bal]
    if rate is not None:
        ans += f" at {rate}%"
        facts.append(rate)
    if payoff:
        ans += f", projected paid off by {payoff}"
    return _result("loan_detail", "now", ans + ".", rows=[t], facts=facts)


def retirement(db, start, end, label, question: str = "") -> dict:
    """Current retirement SAVINGS (grounded). The forward projection is assumption-laden and lives on
    the Retirement tab, so we report the real balance and defer the projection — never speak a made-up
    projected number as if it were a fact."""
    from app.models.account import Account
    kw = ("401k", "401(k)", "403b", "457", "ira", "roth", "retirement", "pension", "sep", "simple")
    accts = []
    for a in db.query(Account).all():
        blob = " ".join([a.subtype or "", a.name or "", a.custom_name or "", a.type or ""]).lower()
        if any(k in blob for k in kw) and float(a.current_balance or 0) > 0:
            accts.append(a)
    if not accts:
        return _result("retirement", "now", "I don't see any retirement accounts recorded.", found=False)
    total = round(sum(float(a.current_balance or 0) for a in accts), 2)
    rows = [{"account": a.custom_name or a.name, "balance": round(float(a.current_balance or 0), 2),
             "kind": a.subtype or a.type} for a in sorted(accts, key=lambda a: -(a.current_balance or 0))]
    ql = (question or "").lower()
    if re.search(r"\b(pre.?tax|roth|traditional|tax bucket|taxable)\b", ql):
        roth = round(sum(float(a.current_balance or 0) for a in accts
                         if "roth" in (" ".join([a.subtype or "", a.name or "", a.custom_name or ""]).lower())), 2)
        pretax = round(total - roth, 2)
        return _result("retirement", "now",
                       f"Of your {_money(total)} in retirement, about {_money(pretax)} is pre-tax and {_money(roth)} is Roth (tax-free).",
                       rows=rows, facts=[pretax, roth, total])
    ans = f"You have about {_money(total)} across {len(accts)} retirement account(s)."
    if re.search(r"\b(on track|retire|projection|enough|when can i)\b", ql):
        ans += " A full on-track projection depends on the assumptions you set — open the Retirement tab for that."
    return _result("retirement", "now", ans, rows=rows, facts=[total, len(accts)])


def trading_tax(db, start, end, label, question: str = "") -> dict:
    """Realized capital gains this year — net, short vs long term, and wash-sale disallowed. Reuses
    the trading_tax service. Answers 'realized gains this year', 'short vs long term', 'any wash sales'."""
    from datetime import date as _date
    try:
        from app.services.trading_tax import compute_realized_pnl
        try:
            res = compute_realized_pnl(db)
        except TypeError:
            res = compute_realized_pnl(db, _date.today().year)
    except Exception:  # noqa: BLE001
        res = None
    if not isinstance(res, dict):
        return _result("trading_tax", "this year", "I can't compute realized gains yet — I don't see closed lots.", found=False)
    net = res.get("net_realized")
    st = res.get("short_term", res.get("short_term_realized"))
    lt = res.get("long_term", res.get("long_term_realized"))
    wash = res.get("wash_sale_disallowed")
    if net is None and st is None and lt is None:
        return _result("trading_tax", "this year", "I don't see any realized gains or losses this year.", found=False)
    q = (question or "").lower()
    if re.search(r"\bwash\b", q):
        w = round(float(wash or 0), 2)
        return _result("trading_tax", "this year",
                       (f"You have about {_money(w)} in wash-sale disallowed losses this year." if w else "No wash-sale issues are flagged this year."),
                       facts=[w] if w else [])
    if re.search(r"\bcarr(y|ies|ied) (over|forward)\b|\bcarry(over|forward)\b|\bloss carr", q):
        n = float(net or 0)
        if n >= 0:
            return _result("trading_tax", "this year",
                           "You don't have a capital-loss carryover — your realized total this year isn't a net loss.", facts=[])
        deductible = max(n, -3000.0)            # IRS caps the annual deduction at $3,000
        carry = round(n - deductible, 2)        # the portion beyond $3k carries to next year
        if carry == 0:
            return _result("trading_tax", "this year",
                           f"Your realized loss is about {_money(abs(n))}, all deductible this year — nothing carries forward.",
                           facts=[abs(n)])
        return _result("trading_tax", "this year",
                       f"Your realized loss is about {_money(abs(n))}; about {_money(3000)} is deductible this year and "
                       f"roughly {_money(abs(carry))} carries forward to next year.",
                       facts=[abs(n), 3000, abs(carry)])
    if re.search(r"\b(short|long)[- ]?term\b", q) and (st is not None or lt is not None):
        return _result("trading_tax", "this year",
                       f"Realized so far: {_money(st or 0)} short-term and {_money(lt or 0)} long-term.",
                       facts=[abs(st or 0), abs(lt or 0)])
    n = round(float(net or 0), 2)
    ans = f"Your net realized gain/loss this year is about {_money(n)}"
    facts = [abs(n)]
    if st is not None and lt is not None:
        ans += f" ({_money(st)} short-term, {_money(lt)} long-term)"
        facts += [abs(st), abs(lt)]
    return _result("trading_tax", "this year", ans + ".", facts=facts)


def business_summary(db, start, end, label, question: str = "") -> dict:
    """Business income / expenses / net over the trailing year (Schedule-C-ish). Reuses
    businesses_overview. Answers 'business income', 'business expenses', 'business net'."""
    try:
        from app.routers.business import businesses_overview
        res = businesses_overview(months=12, db=db)
    except Exception:  # noqa: BLE001
        res = None
    totals = (res or {}).get("totals") or {}
    biz = (res or {}).get("businesses") or []
    inc, exp, net = totals.get("income"), totals.get("expenses"), totals.get("net")
    if not biz and inc is None:
        return _result("business", "the past 12 months", "I don't see any business-tagged activity yet.", found=False)
    q = (question or "").lower()
    if re.search(r"\b(margin|profit margin)\b", q) and inc:
        m = round((net or 0) / inc * 100, 1) if inc else 0
        return _result("business", "the past 12 months",
                       f"Your business profit margin is about {m}% (net {_money(net or 0)} on {_money(inc)} revenue).",
                       rows=biz, facts=[m])
    if re.search(r"\bexpenses?\b", q) and exp is not None:
        return _result("business", "the past 12 months",
                       f"Your business expenses over the past 12 months are about {_money(exp)}.", rows=biz, facts=[abs(exp)])
    if re.search(r"\b(income|revenue|gross)\b", q) and inc is not None:
        return _result("business", "the past 12 months",
                       f"Your business income over the past 12 months is about {_money(inc)}.", rows=biz, facts=[abs(inc)])
    ans = (f"Over the past 12 months your business shows about {_money(inc or 0)} income and "
           f"{_money(exp or 0)} expenses — net {_money(net or 0)}.")
    return _result("business", "the past 12 months", ans, rows=biz,
                   facts=[abs(inc or 0), abs(exp or 0), abs(net or 0)])


def hsa(db, start, end, label, question: str = "") -> dict:
    """HSA contributions vs the IRS limit (room left) or balance. Reuses hsa_status."""
    from datetime import date as _date
    try:
        from app.routers.analytics import hsa_status
        res = hsa_status(year=_date.today().year, db=db)
    except Exception:  # noqa: BLE001
        res = None
    if not isinstance(res, dict):
        return _result("hsa", "this year", "I don't see HSA data yet.", found=False)
    accts = res.get("accounts") or []
    limits = res.get("limits") or {}
    contributed = res.get("contributed", res.get("contributions_ytd", res.get("ytd_contributions")))
    fam = limits.get("family")
    bal = round(sum(float(a.get("current_balance") or 0) for a in accts), 2) if accts else 0.0
    if not accts and contributed is None:
        return _result("hsa", "this year", "I don't see an HSA on file.", found=False)
    q = (question or "").lower()
    if contributed is not None and fam and re.search(r"\b(room|left|remaining|how much more|can i (still )?contribute|limit)\b", q):
        rem = round(float(fam) - float(contributed), 2)
        return _result("hsa", "this year",
                       f"You've contributed about {_money(contributed)} to your HSA this year; the family limit is "
                       f"{_money(fam)}, so about {_money(rem)} of room is left.", facts=[contributed, fam, abs(rem)])
    if contributed is not None:
        ans = f"You've contributed about {_money(contributed)} to your HSA this year"
        facts = [contributed]
        if fam:
            ans += f" (family limit {_money(fam)})"
            facts.append(fam)
        return _result("hsa", "this year", ans + ".", facts=facts)
    return _result("hsa", "now", f"Your HSA balance is about {_money(bal)}.", facts=[bal])


# ── Tier 3 (read-only insight surfaces): agent status + market signals ──
def _safe_call(fn, *a, **k):
    try:
        return fn(*a, **k)
    except Exception:  # noqa: BLE001
        return None


def agent_status(db, start, end, label, question: str = "") -> dict:
    """READ-ONLY status of the trading agent — what it holds, what's pending YOUR approval, cash/
    deployable, and whether it's armed. Insight only: this never places, approves, or changes
    anything (placement stays your in-app Approve)."""
    from app.routers import agent_trading as at
    status = _safe_call(at.agent_trading_status) or {}
    q = (question or "").lower()

    def _pending():
        props = _safe_call(at.agent_trading_proposals, status="pending")
        return (props.get("proposals") if isinstance(props, dict) else props) or []

    def _positions():
        pos = _safe_call(at.agent_trading_positions) or {}
        return (pos.get("positions") if isinstance(pos, dict) else pos) or []

    if re.search(r"\b(pending|approv|to approve|waiting|queue|review|proposal)\b", q):
        pend = _pending()
        if not pend:
            return _result("agent_status", "now", "Nothing is waiting for your approval right now.", facts=[])
        tickers = ", ".join(p.get("ticker") for p in pend[:5] if p.get("ticker"))
        return _result("agent_status", "now",
                       f"You have {len(pend)} agent proposal(s) waiting for your approval" + (f": {tickers}." if tickers else "."),
                       rows=pend[:10], facts=[len(pend)])
    if re.search(r"\b(positions?|holding|own|sleeve)\b", q):
        pos = _positions()
        if not pos:
            return _result("agent_status", "now", "The agent isn't holding any positions right now.", facts=[])
        names = ", ".join((p.get("ticker") or p.get("symbol")) for p in pos[:5] if (p.get("ticker") or p.get("symbol")))
        return _result("agent_status", "now",
                       f"The agent holds {len(pos)} position(s)" + (f": {names}." if names else "."),
                       rows=pos[:10], facts=[len(pos)])
    if re.search(r"\b(cash|deployable|deploy|buying power|to trade)\b", q):
        if not status.get("connected"):
            return _result("agent_status", "now", "The trading agent isn't connected right now.")
        cash, dep = status.get("cash"), status.get("deployable")
        ans = (f"The agent has {_money(cash)} in cash, about {_money(dep)} deployable right now."
               if dep is not None else f"The agent has {_money(cash)} in cash.")
        return _result("agent_status", "now", ans, facts=[v for v in [cash, dep] if v is not None])
    if re.search(r"\b(mode|armed|on|running|active|paused|live|enabled|status)\b", q):
        return _result("agent_status", "now",
                       "The trading agent is armed (live)." if status.get("armed")
                       else "The trading agent is read-only / not armed right now.", facts=[])
    # default summary
    if not status.get("connected"):
        return _result("agent_status", "now", "The trading agent isn't connected right now.")
    pos, pend = _positions(), _pending()
    return _result("agent_status", "now",
                   f"The agent is {'armed' if status.get('armed') else 'read-only'}, holds {len(pos)} position(s), "
                   f"with {len(pend)} proposal(s) pending your approval.",
                   rows=pos[:10], facts=[len(pos), len(pend)])


def market_signals(db, start, end, label, question: str = "") -> dict:
    """READ-ONLY read on the active research domain — sector rotation temperature and
    congressional/insider activity. Insight only; conviction stays hand-curated."""
    try:
        from app.services import research_store as rs
        dom = rs.get_active_domain() or (rs.list_domains() or [None])[0]
    except Exception:  # noqa: BLE001
        dom = None
    if not dom:
        return _result("market_signals", "now", "I don't have a research domain set up yet.", found=False)
    q = (question or "").lower()
    if re.search(r"\b(rotation|temperature|sector (heat|rotation)|how hot)\b", q):
        agg = _safe_call(lambda: __import__("app.routers.rotation", fromlist=["rotation_overview"]).rotation_overview(dom))
        if isinstance(agg, dict):
            ov = agg.get("overview") if isinstance(agg.get("overview"), dict) else agg
            temp = ov.get("temperature", ov.get("score"))
            stage = ov.get("stage", ov.get("label"))
            if temp is not None:
                return _result("market_signals", "now",
                               f"The {dom} rotation reads about {temp}/100" + (f" — {stage}." if stage else "."),
                               facts=[temp] if isinstance(temp, (int, float)) else [])
        return _result("market_signals", "now", "I don't have a rotation reading for your research domain yet.", found=False)
    if re.search(r"\b(congress|insider|political|government contract|buying|lobby)\b", q):
        pf = _safe_call(lambda: __import__("app.services.research_join", fromlist=["get_political_flow"]).get_political_flow(dom))
        rows = (pf or {}).get("rows") or []
        if not rows:
            return _result("market_signals", "now",
                           "I don't see notable congressional or insider activity in your research set right now.")
        lead = rows[0]
        buyers = lead.get("buyers_90d")
        ans = (f"In your {dom} research set, the standout is {lead.get('ticker')}"
               + (f" with {buyers} congressional buyer(s) in the last 90 days." if buyers else "."))
        return _result("market_signals", "now", ans, rows=rows[:10], facts=[buyers] if buyers else [])
    return _result("market_signals", "now",
                   f"Your active research domain is {dom}. Ask about the rotation temperature, or congressional/insider activity.")


# ── transaction search (filter by merchant / category / min amount + window) ──
def transaction_search(db, start, end, label, question: str = "") -> dict:
    """List/aggregate transactions matching filters — 'what did I buy at Amazon yesterday',
    'every purchase over $500 this month', 'transactions on dining over $100'."""
    q = (question or "").lower()
    m = _match_merchant(q, _known_merchants(db))
    cat = _match_category(q, _known_categories(db))
    minamt = None
    mm = re.search(r"(?:over|above|more than|greater than|>)\s*\$?\s*([\d,]+(?:\.\d+)?)", q)
    if mm:
        try:
            minamt = float(mm.group(1).replace(",", ""))
        except ValueError:
            minamt = None
    if not (m or cat or minamt is not None):
        return _result("transaction_search", label,
                       "Tell me a merchant, category, or amount to filter by (e.g. 'purchases over $200 at Costco').",
                       found=False)
    txns = _spend_q(db).filter(Transaction.date >= start, Transaction.date <= end).all()
    filt = txns
    if m:
        filt = [t for t in filt if t.display_name == m]
    if cat:
        filt = [t for t in filt if (t.display_category or "").lower() == cat.lower()]
    if minamt is not None:
        filt = [t for t in filt if float(t.amount) >= minamt]
    crit = []
    if m:
        crit.append(f"at {m}")
    if cat:
        crit.append(f"in {cat}")
    if minamt is not None:
        crit.append(f"over {_money(minamt)}")
    crit_s = (" " + " ".join(crit)) if crit else ""
    if not filt:
        return _result("transaction_search", label, f"I don't see any purchases{crit_s} in {label}.", found=False)
    filt.sort(key=lambda t: -float(t.amount))
    total = round(sum(float(t.amount) for t in filt), 2)
    n = len(filt)
    rows = [{"date": t.date.isoformat(), "merchant": t.display_name, "amount": round(float(t.amount), 2),
             "category": t.display_category} for t in filt[:12]]
    ans = (f"I found {n} purchase(s){crit_s} in {label} totaling {_money(total)}; "
           f"the largest was {_money(filt[0].amount)} at {filt[0].display_name}.")
    return _result("transaction_search", label, ans, rows=rows, facts=[n, total, round(float(filt[0].amount), 2)])


def spending_compare(db, start, end, label, question: str = "") -> dict:
    """This-period vs prior-period spending — 'did I spend more this month than last', 'how does my
    spending compare to last month'. Reuses the spending_total bundle's built-in comparison."""
    b = _reuse_bundle(db, "spending_total")
    comp = (b or {}).get("comparison")
    if not b or b.get("no_data") or not comp:
        return _result("spending_compare", label, "I don't have a clean prior period to compare against yet.", found=False)
    if comp.get("prior_period_unreliable"):
        return _result("spending_compare", b.get("horizon_label", label),
                       "There isn't enough synced history before this period to compare against.", found=False)
    cur = b.get("total_spent_dollars")
    chg = comp.get("change_dollars")
    lbl = b.get("horizon_label", label)
    if cur is None or chg is None:
        return _result("spending_compare", lbl, "I can't compare spending periods right now.", found=False)
    direction = "up" if chg >= 0 else "down"
    ans = (f"You've spent {_money(cur)} {lbl}, {direction} {_money(abs(chg))} vs the prior period "
           f"({_money(comp.get('prior_total_dollars'))}).")
    return _result("spending_compare", lbl, ans,
                   rows=[{k: comp.get(k) for k in ("prior_total_dollars", "change_dollars", "change_percent")}],
                   facts=[v for v in [cur, abs(chg), comp.get("prior_total_dollars")] if v is not None])


# ── composition: compare two entities (the L3 comparison ceiling) ──
def compare(db, start, end, label, question: str = "") -> dict:
    """Compose two retrievals into a grounded comparison — two tickers ('AAPL gain vs VTI gain'),
    two categories ('more on dining or groceries'), or two merchants ('Costco vs Amazon'). Still
    deterministic: each side is a real query; we only juxtapose the two facts."""
    q = (question or "").lower()

    # two tickers (by symbol or distinctive name token)
    held = _held(db)
    picks = []
    for r in held:
        t = (r["ticker"] or "").lower()
        nm = (r["name"] or "").lower()
        if (t and re.search(r"\b" + re.escape(t) + r"\b", q)) or (nm and nm in q) \
                or (nm and any(tok in q for tok in nm.split() if len(tok) > 3)):
            if r["ticker"] not in {p["ticker"] for p in picks}:
                picks.append(r)
    if len(picks) >= 2:
        a, b = picks[0], picks[1]

        def g(x):
            d = x["gain"] or 0
            return (f"{x['ticker']} is {'up' if d >= 0 else 'down'} {_money(abs(d))}"
                    + (f" ({x['gain_pct']}%)" if x["gain_pct"] is not None else ""))
        return _result("compare", "now", f"{g(a)}, while {g(b)}.", rows=[a, b],
                       facts=[abs(a["gain"] or 0), abs(b["gain"] or 0)])

    txns = _spend_q(db).filter(Transaction.date >= start, Transaction.date <= end).all()

    # two categories
    cats = []
    for c in _known_categories(db):
        cl = c.lower()
        if (cl in q or any(t in q for t in re.split(r"[^a-z]+", cl) if len(t) > 3)) and c not in cats:
            cats.append(c)
    if len(cats) >= 2:
        a, b = cats[0], cats[1]
        av = round(sum(float(t.amount) for t in txns if (t.display_category or "").lower() == a.lower()), 2)
        bv = round(sum(float(t.amount) for t in txns if (t.display_category or "").lower() == b.lower()), 2)
        more = a if av >= bv else b
        return _result("compare", label, f"In {label} you spent {_money(av)} on {a} and {_money(bv)} on {b} — more on {more}.",
                       rows=[{"category": a, "total": av}, {"category": b, "total": bv}], facts=[av, bv])

    # two merchants
    merch = []
    for n in _known_merchants(db):
        nl = (n or "").lower()
        if nl and (nl in q or any(t in q for t in re.split(r"\W+", nl) if len(t) > 3)) and n not in merch:
            merch.append(n)
    if len(merch) >= 2:
        a, b = merch[0], merch[1]
        av = round(sum(float(t.amount) for t in txns if t.display_name == a), 2)
        bv = round(sum(float(t.amount) for t in txns if t.display_name == b), 2)
        more = a if av >= bv else b
        return _result("compare", label, f"In {label} you spent {_money(av)} at {a} and {_money(bv)} at {b} — more at {more}.",
                       rows=[{"merchant": a, "total": av}, {"merchant": b, "total": bv}], facts=[av, bv])

    return _result("compare", label, "Tell me two specific things to compare — two tickers, two categories, or two merchants.",
                   found=False)


def average_spend(db, start, end, label, question: str = "") -> dict:
    """Average purchase size, optionally scoped to a merchant or category — 'average size of my
    Amazon orders', 'what's my typical grocery run'."""
    q = (question or "").lower()
    m = _match_merchant(q, _known_merchants(db))
    cat = None if m else _match_category(q, _known_categories(db))
    txns = _spend_q(db).filter(Transaction.date >= start, Transaction.date <= end).all()
    scope = ""
    if m:
        txns = [t for t in txns if t.display_name == m]
        scope = f" at {m}"
    elif cat:
        txns = [t for t in txns if (t.display_category or "").lower() == cat.lower()]
        scope = f" on {cat}"
    if not txns:
        return _result("average_spend", label, f"I don't see any purchases{scope} in {label}.", found=False)
    avg = round(sum(float(t.amount) for t in txns) / len(txns), 2)
    return _result("average_spend", label,
                   f"Your average purchase{scope} in {label} is about {_money(avg)} across {len(txns)} transaction(s).",
                   facts=[avg, len(txns)])


def duplicate_charges(db, start, end, label, question: str = "") -> dict:
    """Possible duplicate charges — same merchant + same amount more than once in the window."""
    txns = _spend_q(db).filter(Transaction.date >= start, Transaction.date <= end).all()
    groups: dict = {}
    for t in txns:
        groups.setdefault((t.display_name, round(float(t.amount), 2)), []).append(t)
    dups = sorted([(k, v) for k, v in groups.items() if len(v) > 1], key=lambda kv: -kv[0][1])
    if not dups:
        return _result("duplicate_charges", label, f"I don't see any obvious duplicate charges in {label}.")
    (nm, amt), v = dups[0]
    rows = [{"merchant": k[0], "amount": k[1], "count": len(vv)} for k, vv in dups[:8]]
    return _result("duplicate_charges", label,
                   f"I found {len(dups)} possible duplicate(s) in {label} — e.g. {len(v)} charges of {_money(amt)} at {nm}.",
                   rows=rows, facts=[len(dups)])


def home_equity(db, start, end, label, question: str = "") -> dict:
    """Home equity = real-estate asset value − mortgage owed. A real grounded number, so we compute
    it rather than refusing."""
    from app.models.manual_asset import ManualAsset
    from app.models.account import Account
    homes = [m for m in db.query(ManualAsset).all()
             if (m.side or "asset") == "asset"
             and (m.type or "").lower().replace(" ", "_") in ("real_estate", "property", "home", "house")
             and float(m.current_value or 0) > 0]
    if not homes:
        return _result("home_equity", "now", "I don't see a home or real-estate asset on file to compute equity.", found=False)
    val = round(sum(float(m.current_value or 0) for m in homes), 2)
    loans = db.query(Account).all()
    mort = round(sum(float(a.current_balance or 0) for a in loans
                     if (a.type or "").lower() == "loan"
                     and re.search(r"mortgage|home", ((a.name or "") + " " + (a.subtype or "")).lower())), 2)
    if mort == 0:   # no clearly-mortgage loan tagged → fall back to all loan balances
        mort = round(sum(float(a.current_balance or 0) for a in loans if (a.type or "").lower() == "loan"), 2)
    eq = round(val - mort, 2)
    return _result("home_equity", "now",
                   f"Your home is valued at about {_money(val)} with roughly {_money(mort)} in mortgage debt — "
                   f"about {_money(eq)} in equity.",
                   rows=[{"home_value": val, "mortgage": mort, "equity": eq}], facts=[val, mort, abs(eq)])


def investment_transactions(db, start, end, label, question: str = "", *, limit: int = 12) -> dict:
    """Investment buys / sells / dividends from the InvestmentTransaction table — distinct from
    spending transactions. 'show my investment transactions', 'what did I buy/sell', 'my dividends'."""
    from app.models.investment_transaction import InvestmentTransaction
    from app.models.security import Security
    q = (question or "").lower()
    txns = db.query(InvestmentTransaction).order_by(InvestmentTransaction.date.desc()).limit(80).all()
    if re.search(r"\bdividend", q):
        txns = [t for t in txns if "dividend" in ((t.type or "") + (t.subtype or "")).lower()]
    elif re.search(r"\b(bought|buy|purchas)", q):
        txns = [t for t in txns if (t.type or "").lower() == "buy"]
    elif re.search(r"\b(sold|sell|sale)", q):
        txns = [t for t in txns if (t.type or "").lower() == "sell"]
    txns = txns[:limit]
    if not txns:
        return _result("investment_transactions", "recent", "I don't see any investment transactions recorded.", found=False)
    secmap = {s.plaid_security_id: (s.ticker_symbol or s.name) for s in db.query(Security).all()}
    rows = [{"date": t.date.isoformat(), "type": t.type, "ticker": secmap.get(t.plaid_security_id, "—"),
             "shares": round(float(t.quantity or 0), 4), "amount": round(float(t.amount or 0), 2)} for t in txns]
    lead = rows[0]
    ans = f"Your most recent investment activity: {lead['type'] or 'trade'} {lead['ticker']} for {_money(abs(lead['amount']))} on {lead['date']}."
    return _result("investment_transactions", "recent", ans, rows=rows, facts=[abs(lead["amount"])])


_DOW = {"monday": 0, "tuesday": 1, "wednesday": 2, "thursday": 3, "friday": 4, "saturday": 5, "sunday": 6}


def day_of_week(db, start, end, label, question: str = "") -> dict:
    """Average spend for a weekday — 'what's my typical Monday spending', 'which day do I spend most'."""
    from datetime import date as _date, timedelta as _td
    from collections import defaultdict
    q = (question or "").lower()
    target = next(((n, i) for n, i in _DOW.items() if n in q), None)
    since = _date.today() - _td(days=84)
    txns = _spend_q(db).filter(Transaction.date >= since).all()
    if not txns:
        return _result("day_of_week", "~12 weeks", "I don't see enough spending history to average by day yet.", found=False)
    agg = defaultdict(lambda: [0.0, set()])
    for t in txns:
        agg[t.date.weekday()][0] += float(t.amount)
        agg[t.date.weekday()][1].add(t.date)

    def avg(idx):
        tot, dates = agg[idx]
        return round(tot / (len(dates) or 1), 2)

    if target:
        a = avg(target[1])
        return _result("day_of_week", "~12 weeks",
                       f"You spend about {_money(a)} on a typical {target[0].title()} (last ~12 weeks).", facts=[a])
    ranked = sorted(((n, avg(i)) for n, i in _DOW.items()), key=lambda x: -x[1])
    top, low = ranked[0], ranked[-1]
    return _result("day_of_week", "~12 weeks",
                   f"Your priciest day is {top[0].title()} (~{_money(top[1])} on average); lowest is {low[0].title()} (~{_money(low[1])}).",
                   rows=[{"day": n, "avg": v} for n, v in ranked], facts=[top[1]])


def financial_pulse(db, start, end, label, question: str = "") -> dict:
    """The 0–100 financial-health score (and its debt-to-assets component) from the analytics
    financial-pulse model. 'what's my financial health score', 'what's my debt-to-assets ratio'."""
    try:
        from app.routers.analytics import financial_pulse as _fp
        res = _fp(monthly_payroll_deferral=0, db=db)
    except Exception:  # noqa: BLE001
        res = None
    if not isinstance(res, dict):
        return _result("financial_pulse", "now", "I can't compute your financial health score right now.", found=False)
    q = (question or "").lower()
    debt_ratio = res.get("debt_ratio", res.get("debt_to_assets"))
    if re.search(r"debt.to.asset|debt ratio|debt.to.income", q) and debt_ratio is not None:
        pct = round(float(debt_ratio) * 100, 1)
        return _result("financial_pulse", "now", f"Your debt-to-assets ratio is about {pct}%.", facts=[pct])
    score = res.get("score", res.get("pulse_score", res.get("overall_score")))
    if score is None:
        return _result("financial_pulse", "now", "I can't compute your financial health score right now.", found=False)
    status = res.get("status") or res.get("label") or res.get("rating")
    return _result("financial_pulse", "now",
                   f"Your financial health score is {round(float(score))}/100" + (f" — {status}." if status else "."),
                   rows=[{k: v for k, v in res.items() if not isinstance(v, (dict, list))}], facts=[round(float(score))])


def monthly_average(db, start, end, label, question: str = "", *, months: int = 6) -> dict:
    """Average monthly spending or income over the last ~6 months — 'what do I spend on average per
    month', 'average monthly income'."""
    from datetime import date as _date, timedelta as _td
    q = (question or "").lower()
    since = _date.today() - _td(days=months * 30)
    income = bool(re.search(r"\b(income|earn|made|paycheck|deposit)\b", q)) and not re.search(r"\bspend", q)
    if income:
        rows = (db.query(Transaction).filter(Transaction.amount < 0, Transaction.is_transfer.is_(False),
                                             Transaction.date >= since).with_entities(Transaction.amount).all())
        tot = sum(-float(a) for (a,) in rows)
        kind = "income"
    else:
        rows = _spend_q(db).filter(Transaction.date >= since).with_entities(Transaction.amount).all()
        tot = sum(float(a) for (a,) in rows)
        kind = "spending"
    if not rows:
        return _result("monthly_average", f"{months} months", f"I don't see enough history to average your {kind}.", found=False)
    avg = round(tot / months, 2)
    return _result("monthly_average", f"{months} months",
                   f"Your average monthly {kind} over the last {months} months is about {_money(avg)}.", facts=[avg])


RETRIEVERS = {
    "largest_transactions": largest_transactions,
    "transaction_search": transaction_search,
    "spending_compare": spending_compare,
    "compare": compare,
    "average_spend": average_spend,
    "duplicate_charges": duplicate_charges,
    "home_equity": home_equity,
    "investment_transactions": investment_transactions,
    "day_of_week": day_of_week,
    "financial_pulse": financial_pulse,
    "monthly_average": monthly_average,
    "spending_total": spending_total,
    "top_merchant": top_merchant,
    "top_categories": top_categories,
    "category_spend": category_spend,
    "merchant_spend": merchant_spend,
    "recent_transactions": recent_transactions,
    "income_total": income_total,
    "income_sources": income_sources,
    "cash_flow": cash_flow,
    "cash_flow_forecast": cash_flow_forecast,
    "net_worth": net_worth,
    "net_worth_change": net_worth_change,
    "cash_balance": cash_balance,
    "largest_assets": largest_assets,
    "account_balance": account_balance,
    "accounts_overview": accounts_overview,
    "stale_accounts": stale_accounts,
    "portfolio": portfolio,
    "holdings": holdings,
    "upcoming_bills": upcoming_bills,
    "budget_status": budget_status,
    "budget_category": budget_category,
    "savings_rate": savings_rate,
    "goals": goals,
    "subscriptions": subscriptions,
    "loan_detail": loan_detail,
    "retirement": retirement,
    "trading_tax": trading_tax,
    "business": business_summary,
    "hsa": hsa,
    "agent_status": agent_status,
    "market_signals": market_signals,
}


# ── in-code grounding check ──────────────────────────────────────────────
_NUM_RE = re.compile(r"-?\$?\d[\d,]*(?:\.\d+)?")


def _numbers_in(text: str) -> set[float]:
    out: set[float] = set()
    for m in _NUM_RE.findall(text or ""):
        try:
            out.add(round(abs(float(m.replace("$", "").replace(",", ""))), 2))
        except ValueError:
            pass
    return out


def grounding_ok(text: str, allowed) -> tuple[bool, Optional[float]]:
    """True iff every dollar-ish figure in `text` matches a retrieved value (within 1% / $1).
    Small integers (counts, day spans, calendar years) are permitted — they're not invented
    figures. Returns (ok, first_offending_number)."""
    allowed_set: set[float] = set()
    for a in allowed:
        try:
            allowed_set.add(round(abs(float(a)), 2))
        except (TypeError, ValueError):
            pass
    for n in _numbers_in(text):
        if any(abs(n - a) <= max(1.0, a * 0.01) for a in allowed_set):
            continue
        # Permit only obvious non-figures: a 4-digit calendar year, or a small whole number
        # (day-of-month, day span, or a small count like "1 of 8"). A dollar amount like 1737 is
        # NOT exempt — it must be grounded. Window labels we emit ("the last 30/90 days",
        # "12 months", "7 days") all fall under 99, so they pass without opening a fabrication hole.
        if n == int(n) and (1900 <= n <= 2100 or n <= 99):
            continue
        return False, n
    return True, None


# ── snapshot numbers (for the open-ended grounding gate) ─────────────────
def _all_numbers(obj) -> list:
    out: list = []
    if isinstance(obj, dict):
        for v in obj.values():
            out += _all_numbers(v)
    elif isinstance(obj, (list, tuple)):
        for v in obj:
            out += _all_numbers(v)
    elif isinstance(obj, (int, float)) and not isinstance(obj, bool):
        out.append(obj)
    return out


_REFUSAL = ("I can give you exact reads on your net worth, spending, largest purchases, top "
            "merchants, categories, and holdings. I don't have that particular figure in view — "
            "the matching tab will have the detail.")

from app.services import assistant_persona as persona

_OPEN_SYSTEM = persona.system("""You are given a JSON snapshot of PRE-COMPUTED facts. Answer using
ONLY numbers and names present in the snapshot. If the snapshot doesn't contain what's needed, say
so plainly and name the tab to open.""")


def _open_ended(db, question: str, history: Optional[list]) -> dict:
    """No intent matched. If the local model is on, let it narrate the snapshot — but only accept
    the answer if every figure it states is grounded; otherwise refuse. Never fabricates."""
    from app.services import assistant as A
    from app.services.llm_ollama import LLMUnavailable, OllamaClient

    snap = A.gather_snapshot(db)
    allowed = _all_numbers(snap)
    if not settings.LLM_ENABLED:
        return {"intent": None, "window": None, "answer": _REFUSAL, "rows": [],
                "found": False, "grounded": True, "source": "refusal"}
    try:
        client = OllamaClient(base_url=settings.LLM_URL, model=settings.LLM_MODEL)
        if not client.health():
            return {"intent": None, "window": None, "answer": _REFUSAL, "rows": [],
                    "found": False, "grounded": True, "source": "refusal"}
        text = client.complete(_OPEN_SYSTEM, A._user_prompt(question, snap, history))
    except (LLMUnavailable, Exception):  # noqa: BLE001
        return {"intent": None, "window": None, "answer": _REFUSAL, "rows": [],
                "found": False, "grounded": True, "source": "refusal"}
    ok, _bad = grounding_ok(text, allowed)
    if not ok:
        # the model cited a number it wasn't handed → don't show it, refuse instead
        return {"intent": None, "window": None, "answer": _REFUSAL, "rows": [],
                "found": False, "grounded": False, "source": "guarded"}
    return {"intent": None, "window": None, "answer": text, "rows": [],
            "found": True, "grounded": True, "source": "ollama"}


_ROUTER_SYSTEM = """You route a personal-finance question to ONE retriever that can answer it. You are
given the QUESTION and a CATALOG of retrievers ("name: what it answers"). Reply with EXACTLY the single
best retriever name from the catalog, or the word NONE if nothing fits. Output only the name."""


def _catalog_text() -> str:
    lines = []
    for name, fn in RETRIEVERS.items():
        doc = (fn.__doc__ or "").strip().split("\n")[0].strip()
        lines.append(f"- {name}: {(doc or name.replace('_', ' '))[:90]}")
    return "\n".join(lines)


def _llm_route(question: str) -> Optional[str]:
    """Safety-net router: when the deterministic keyword router misses, the local model picks the best
    retriever from the catalog. It only chooses WHICH retriever; the numbers still come from that
    retriever deterministically. Returns a valid intent name or None. Never raises; no-op if LLM off."""
    if not settings.LLM_ENABLED:
        return None
    try:
        from app.services.llm_ollama import OllamaClient
        client = OllamaClient(base_url=settings.LLM_URL, model=settings.LLM_MODEL)
        if not client.health():
            return None
        out = client.complete(_ROUTER_SYSTEM, f"QUESTION: {question}\n\nCATALOG:\n{_catalog_text()}")
        tok = (out or "").strip().split()
        cand = tok[0].strip(".,:'\"`") if tok else ""
        return cand if cand in RETRIEVERS else None
    except Exception:  # noqa: BLE001
        return None


def answer(db, question: str, history: Optional[list] = None, *, today: Optional[date] = None) -> dict:
    """Top-level: route → retrieve → grounded answer. Returns
    ``{source, intent, window, answer, rows, found, grounded}``. Never raises on data gaps."""
    context = " ".join((t or {}).get("text", "") for t in (history or [])[-4:]) if history else ""
    intent = route(question, context)
    # Learned routing override from an APPROVED thumbs-down correction wins over the keyword router,
    # so a question the user previously corrected routes to the right retriever from then on.
    try:
        from app.services import assistant_feedback as _fb
        _ov = _fb.learned_override(question)
        if _ov and _ov in RETRIEVERS:
            intent = _ov
    except Exception:  # noqa: BLE001
        pass
    # Last deterministic attempt before giving up: does the question name a security the user holds?
    # Catches bare-ticker questions ("how's NVDA doing") that have no other investment keyword.
    if not intent:
        try:
            if _names_held_security(db, question):
                intent = "holdings"
        except Exception:  # noqa: BLE001
            pass
    # SAFETY-NET ROUTER: the keyword ladder can't anticipate every phrasing. When it misses, let the
    # local model pick a retriever from the catalog. It only chooses WHICH retriever — every number
    # still comes from that retriever deterministically. (No-op when the model is off.)
    if not intent:
        intent = _llm_route(question)
    if intent and intent in RETRIEVERS:
        start, end, label = parse_window(question, today)
        r = RETRIEVERS[intent](db, start, end, label, question)
        r["source"] = "retrieval"
        if r.get("found"):
            r["answer"] = _maybe_rephrase(question, r["answer"], r.get("facts") or [])
        return r
    return _open_ended(db, question, history)


_REPHRASE_SYSTEM = persona.system("""TASK: rephrase the given finance answer in your voice, for being
read ALOUD. Keep EVERY number, name, ticker, and date EXACTLY as given; add no new figures; don't
change the meaning; 1–2 short sentences. Return only the rephrased sentence.""")


def _maybe_rephrase(question: str, deterministic: str, facts: list) -> str:
    """Optionally have the LLM make the deterministic answer more natural — but ACCEPT it only if it
    stays grounded (every figure still matches the retrieved facts). On any doubt, keep the exact
    deterministic answer. Natural phrasing must never cost accuracy."""
    if not settings.LLM_ENABLED:
        return deterministic
    try:
        from app.services.llm_ollama import LLMUnavailable, OllamaClient
        client = OllamaClient(base_url=settings.LLM_URL, model=settings.LLM_MODEL)
        if not client.health():
            return deterministic
        cand = client.complete(_REPHRASE_SYSTEM, f"Rephrase this, keeping all numbers/names/dates exactly:\n{deterministic}")
    except (Exception,):  # noqa: BLE001
        return deterministic
    cand = (cand or "").strip()
    if not cand:
        return deterministic
    # the rephrase may only use figures that were in the deterministic answer (its own numbers)
    ok, _bad = grounding_ok(cand, _numbers_in(deterministic) | set(float(f) for f in facts if _is_num(f)))
    return cand if ok else deterministic


def _is_num(x) -> bool:
    return isinstance(x, (int, float)) and not isinstance(x, bool)
