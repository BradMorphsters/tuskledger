"""Ask Tusk — the everyday-question corpus.

A regression net for the deterministic brain (assistant_retrieval): the ~90 ways people actually
phrase the common questions, each pinned to the retriever that should answer it, plus content checks
on the answers that used to come back wrong or clumsy (2026-09-06 quality pass):

  * "top 3 expenses" routed to a total; "where does my money go" refused; "how much on coffee"
    refused because coffee is a merchant, not a category; "last time at X" summed 30 days;
    "when is the mortgage due" answered the payoff year; "did I pay the mortgage" and "can I afford
    $500" and "hi" all refused; "in this month" grammar; ISO dates read aloud.

All data here is fictional (round numbers, made-up merchants). LLM is off so every answer comes from
the deterministic template path — that's the path the phone shows when the model is unavailable and
the path the model must stay grounded to.
"""
from __future__ import annotations

import datetime as dt

import pytest

from app.config import settings
from app.models import Account, Budget, MortgageDetail, NetWorthSnapshot, Transaction
from app.models.budget import BudgetCategory
from app.models.credit_card_detail import CreditCardDetail
from app.services import assistant_retrieval as ret

TODAY = dt.date(2026, 9, 15)   # a Tuesday


@pytest.fixture()
def household(db):
    """A plausible fictional household: 5 accounts, 8 months of ledger, a budget, two bills."""
    settings.LLM_ENABLED = False
    checking = Account(name="Everyday Checking", type="depository", subtype="checking", current_balance=4200.0,
                       institution_name="North Bank", mask="1001", balance_as_of=TODAY)
    savings = Account(name="Rainy Day Savings", type="depository", subtype="savings", current_balance=15000.0,
                      institution_name="North Bank", mask="2002", balance_as_of=TODAY)
    card = Account(name="Travel Rewards Card", type="credit", subtype="credit card", current_balance=1350.0,
                   institution_name="Card Co", mask="3003", balance_as_of=TODAY)
    mortgage = Account(name="Home Loan", type="loan", subtype="mortgage", current_balance=240000.0,
                       institution_name="Home Lender", mask="4004", balance_as_of=TODAY)
    brokerage = Account(name="Brokerage", type="investment", subtype="brokerage", current_balance=62000.0,
                        institution_name="Invest Co", mask="5005", balance_as_of=TODAY)
    db.add_all([checking, savings, card, mortgage, brokerage])
    db.flush()

    def tx(acct, amount, day, name, cat, **kw):
        db.add(Transaction(account_id=acct.id, amount=amount, date=day, name=name.upper(), merchant_name=name,
                           category=cat, is_transfer=kw.get("is_transfer", False), is_refund=kw.get("is_refund", False)))

    d = dt.date(2026, 1, 1)
    while d <= TODAY:
        if d.day in (3, 10, 17, 24):
            tx(checking, 85.0, d, "Grocer Mart", "Groceries")
        if d.day in (5, 12, 19, 26):
            tx(checking, 48.0, d, "Fuel Stop", "Transportation")
        if d.day % 3 == 0:
            tx(card, 6.0, d, "Coffee Corner", "Dining")
        if d.day in (8, 22):
            tx(card, 24.0, d, "Taco Spot", "Dining")
        if d.day == 14:
            tx(checking, 140.0, d, "City Power", "Utilities")
            tx(checking, 80.0, d, "Fiber Net", "Utilities")
        if d.day == 15:
            tx(card, 15.99, d, "StreamBox", "Entertainment")
        if d.day in (6, 21):
            tx(card, 110.0, d, "Mega Mart", "Shopping")
        if d.weekday() == 4 and (d - dt.date(2026, 1, 1)).days // 7 % 2 == 0:
            tx(checking, -2600.0, d, "Acme Payroll", "Income")
        if d.day == 1:
            tx(checking, 1800.0, d, "Home Lender", "Mortgage")
        if d.day == 20:
            tx(checking, 900.0, d, "Card Co", "Transfer", is_transfer=True)
            tx(card, -900.0, d, "Card Co", "Transfer", is_transfer=True)
        d += dt.timedelta(days=1)
    tx(card, 640.0, TODAY - dt.timedelta(days=5), "Hardware Barn", "Shopping")
    tx(card, -45.0, TODAY - dt.timedelta(days=3), "Mega Mart", "Shopping", is_refund=True)
    # a genuine same-day duplicate
    tx(card, 39.99, TODAY - dt.timedelta(days=2), "Gadget Hub", "Shopping")
    tx(card, 39.99, TODAY - dt.timedelta(days=2), "Gadget Hub", "Shopping")

    b = Budget(month=TODAY.month, year=TODAY.year, total_limit=3200.0)
    b.categories = [BudgetCategory(category="Groceries", limit_amount=800.0),
                    BudgetCategory(category="Dining", limit_amount=250.0),
                    BudgetCategory(category="Shopping", limit_amount=400.0)]
    db.add(b)
    db.add(MortgageDetail(account_id=mortgage.id, next_payment_due_date=dt.date(2026, 10, 1),
                          next_monthly_payment=1800.0, interest_rate_percentage=6.1,
                          origination_principal_amount=280000.0, loan_term="30 year"))
    db.add(CreditCardDetail(account_id=card.id, next_payment_due_date=dt.date(2026, 9, 20),
                            minimum_payment_amount=35.0, last_statement_balance=1350.0))
    nw = 60000.0
    for i in range(52, -1, -1):
        nw += 250.0
        day = TODAY - dt.timedelta(days=7 * i)
        db.add(NetWorthSnapshot(date=day, total_assets=nw + 241350, total_liabilities=241350, net_worth=nw))
    db.commit()
    return db


def ask(db, q):
    return ret.answer(db, q, None, today=TODAY)


# ── routing: phrasing → retriever ────────────────────────────────────────
ROUTES = [
    # spending totals / windows
    ("How much have I spent this month?", "spending_total"),
    ("What did I spend last month?", "spending_total"),
    ("How much did I spend this week?", "spending_total"),
    ("spending this weekend", "spending_total"),
    ("how many transactions this month", "spending_total"),
    # categories
    ("How much have I spent on groceries this month?", "category_spend"),
    ("what did I spend on food this month", "category_spend"),
    ("how much have I spent eating out", "category_spend"),
    ("how much did I spend at restaurants in august", "category_spend"),
    ("how much did I spend on gas", "category_spend"),
    ("how much did I spend on entertainment this year", "category_spend"),
    # merchants
    ("How much have I spent at Grocer Mart this month?", "merchant_spend"),
    ("How much do I spend on coffee?", "merchant_spend"),          # coffee is a store here, not a category
    ("What did I spend at Hardware Barn last time?", "merchant_spend"),
    ("how often do I go to Coffee Corner", "merchant_spend"),
    ("recent purchases at Mega Mart", "recent_transactions"),
    # rankings
    ("What was my biggest purchase this month?", "largest_transactions"),
    ("Top 3 expenses last month", "largest_transactions"),
    ("Where does most of my money go?", "top_categories"),
    ("what did I spend the most on last month", "top_categories"),
    ("What are my top categories this month?", "top_categories"),
    # comparisons / averages
    ("Am I spending more than last month?", "spending_compare"),
    ("How does this month compare to last month?", "spending_compare"),
    ("why is my spending up", "spending_compare"),
    ("What's my average monthly spending?", "monthly_average"),
    ("How much do I spend on utilities a month?", "monthly_average"),
    ("how much do I spend on groceries a month", "monthly_average"),
    ("how much do I usually spend per week", "monthly_average"),
    ("what's my average grocery bill", "average_spend"),
    # anomalies
    ("Any unusual charges this week?", "unusual_charges"),
    ("did anything get more expensive", "unusual_charges"),
    ("Did I get charged twice for anything?", "duplicate_charges"),
    ("What subscriptions am I paying for?", "subscriptions"),
    # lists
    ("What did I buy yesterday?", "transaction_search"),
    ("list my transactions over $100 this month", "transaction_search"),
    ("Show me my recent transactions", "recent_transactions"),
    # income / cash flow
    ("How much did I make this month?", "income_total"),
    ("What's my income this year?", "income_total"),
    ("did I get paid this week", "income_total"),
    ("When is my next paycheck?", "next_paycheck"),
    ("Am I saving money this month?", "cash_flow"),
    ("how much did I save last month", "cash_flow"),
    ("how much have I saved this year", "cash_flow"),
    ("what's my income vs spending", "cash_flow"),
    ("What's my cash flow this month?", "cash_flow"),
    ("What's my savings rate?", "savings_rate"),
    ("how much am I saving each month", "savings_rate"),
    # balances / net worth
    ("What's my checking balance?", "account_balance"),
    ("How much is in savings?", "account_balance"),
    ("what's my savings balance", "account_balance"),
    ("what's my credit card balance", "account_balance"),
    ("What do I owe on the credit card?", "account_balance"),
    ("How much cash do I have?", "cash_balance"),
    ("how much money do I have", "cash_balance"),
    ("what's my balance", "cash_balance"),
    ("how much do I have in checking and savings", "cash_balance"),
    ("What's my net worth?", "net_worth"),
    ("How has my net worth changed this year?", "net_worth_change"),
    ("what's my net worth change since January", "net_worth_change"),
    ("How much do I owe in total?", "net_worth"),
    ("what's my total debt", "net_worth"),
    ("What are my account balances?", "accounts_overview"),
    # bills / payments / budget
    ("What bills are due?", "upcoming_bills"),
    ("When is the mortgage due?", "upcoming_bills"),
    ("what's due this week", "upcoming_bills"),
    ("what's my biggest bill", "upcoming_bills"),
    ("did I pay the mortgage this month", "payment_made"),
    ("is my card payment made", "payment_made"),
    ("How am I doing on my budget?", "budget_status"),
    ("am I on track this month", "budget_status"),
    ("how much is left this month", "budget_status"),
    ("Am I over budget on dining?", "budget_category"),
    ("How much is left in my grocery budget?", "budget_category"),
    ("what's my budget for groceries", "budget_category"),
    # loans / investments
    ("What's my mortgage interest rate?", "loan_detail"),
    ("When will my mortgage be paid off?", "loan_detail"),
    ("how much is my mortgage payment", "loan_detail"),
    ("How are my investments doing?", "portfolio"),
    # meta
    ("Can I afford a $500 purchase?", "affordability"),
    ("how much cash after bills", "affordability"),
    ("Should I pay off my card or invest?", "advice"),
    ("Hi", "help"),
    ("what can you do", "help"),
    ("how am I doing", "briefing"),
    ("what's new", "briefing"),
    ("give me a rundown", "briefing"),
]


@pytest.mark.parametrize("question,intent", ROUTES, ids=[q for q, _ in ROUTES])
def test_common_question_routes(household, question, intent):
    r = ask(household, question)
    assert r["intent"] == intent, f"{question!r} → {r['intent']} (answer: {r['answer']})"
    assert r["found"], f"{question!r} routed right but found nothing: {r['answer']}"


# ── answer content: the fixes that used to be wrong ─────────────────────
def test_top_n_lists_individual_purchases_not_a_total(household):
    r = ask(household, "Top 3 expenses this month")
    assert r["answer"].startswith("Your top 3 purchases this month:")
    assert "Hardware Barn" in r["answer"] and "$640" in r["answer"]
    assert "Home Lender" not in r["answer"]          # mortgage payments aren't "purchases"


def test_biggest_purchase_skips_loan_payments(household):
    r = ask(household, "What was my biggest purchase this month?")
    assert "$640" in r["answer"] and "Home Lender" not in r["answer"]
    assert "Sep 10" in r["answer"]                    # read-aloud date, not 2026-09-10


def test_calendar_labels_read_naturally(household):
    assert "spent about" in ask(household, "How much have I spent this month?")["answer"]
    assert " in this month" not in ask(household, "How much have I spent this month?")["answer"]
    assert "last month" in ask(household, "What did I spend last month?")["answer"]
    assert "in the last 7 days" in ask(household, "How much did I spend this week?")["answer"]


def test_coffee_resolves_to_the_merchant(household):
    r = ask(household, "How much do I spend on coffee?")
    assert "Coffee Corner" in r["answer"] and "each" in r["answer"]


def test_last_time_at_merchant_is_one_charge(household):
    r = ask(household, "What did I spend at Hardware Barn last time?")
    assert r["answer"].startswith("Last time at Hardware Barn you spent $640")


def test_how_often_counts_visits(household):
    r = ask(household, "how often do I go to Coffee Corner")
    assert "times at Coffee Corner" in r["answer"] and "a week" in r["answer"]


def test_unknown_merchant_is_named_back(household):
    r = ask(household, "How much do I spend at Costco?")
    assert not r["found"] and "Costco" in r["answer"]


def test_food_spans_groceries_and_dining(household):
    r = ask(household, "what did I spend on food this month")
    assert "Groceries" in r["answer"] and "Dining" in r["answer"] and "on food" in r["answer"]


def test_gas_maps_to_transportation_family(household):
    r = ask(household, "how much did I spend on gas")
    assert r["found"] and "Transportation" in r["answer"]


def test_where_does_money_go_gives_share(household):
    r = ask(household, "Where does most of my money go?")
    assert "% of the total" in r["answer"] and "Then" in r["answer"]


def test_month_compare_is_same_day_pace(household):
    r = ask(household, "How does this month compare to last month?")
    assert "by day 15 of last month" in r["answer"] and "Last month finished at" in r["answer"]


def test_why_spending_up_names_drivers(household):
    r = ask(household, "why is my spending up")
    assert "biggest increases" in r["answer"] and "Shopping" in r["answer"]


def test_per_month_category_average(household):
    r = ask(household, "How much do I spend on utilities a month?")
    assert "a month on Utilities" in r["answer"] and "6 months" in r["answer"]


def test_yesterday_lists_purchases(household):
    r = ask(household, "What did I buy yesterday?")
    assert r["found"] and "yesterday" in r["answer"]


def test_income_wording(household):
    r = ask(household, "How much did I make this month?")
    assert "came in this month across 1 deposit." in r["answer"]


def test_next_paycheck_from_cadence(household):
    r = ask(household, "When is my next paycheck?")
    assert "next paycheck should land around Sep 25" in r["answer"]


def test_saving_this_month_is_in_vs_out(household):
    r = ask(household, "Am I saving money this month?")
    assert "came in" in r["answer"] and ("saved money" in r["answer"] or "spent more than came in" in r["answer"])


def test_net_worth_change_honours_window(household):
    r = ask(household, "How has my net worth changed this year?")
    assert "this year" in r["answer"] and "from $" in r["answer"] and "%" in r["answer"]
    assert "today" not in r["answer"]


def test_card_balance_not_payoff_projection(household):
    r = ask(household, "What do I owe on the credit card?")
    assert r["answer"] == "Your Travel Rewards Card balance is $1,350."


def test_bills_are_listed_with_dates(household):
    r = ask(household, "What bills are due?")
    assert "Travel Rewards Card" in r["answer"] and "Home Loan" in r["answer"]
    assert "Sep 20" in r["answer"] and "Oct 1" in r["answer"] and "minimum $35" in r["answer"]


def test_mortgage_due_is_the_next_payment(household):
    r = ask(household, "When is the mortgage due?")
    assert r["answer"].startswith("Home Loan: $1,800, due Oct 1")


def test_due_this_week_filters_horizon(household):
    assert ask(household, "what's due this week")["answer"] == "Nothing is due in the next 7 days."


def test_payment_made_finds_the_payment(household):
    r = ask(household, "did I pay the mortgage this month")
    assert r["answer"].startswith("Yes — $1,800 to Home Lender on Sep 1")
    r2 = ask(household, "is my card payment made")
    assert "don't see a card payment posted this month" in r2["answer"]   # autopay is on the 20th


def test_duplicate_detection_is_same_place_same_amount_within_days(household):
    r = ask(household, "Did I get charged twice for anything?")
    assert "Gadget Hub" in r["answer"] and "$39.99" in r["answer"]
    assert "Coffee Corner" not in r["answer"]         # a habit, not a billing error


def test_unusual_charges_dedupes_one_offs(household):
    r = ask(household, "Any unusual charges this week?")
    assert "Hardware Barn" in r["answer"] and r["answer"].count("Hardware Barn") == 1
    assert "price hike" not in r["answer"]


def test_subscriptions_exclude_mortgage_and_groceries(household):
    r = ask(household, "What subscriptions am I paying for?")
    assert "Home Lender" not in r["answer"] and "Grocer Mart" not in r["answer"]


def test_affordability_uses_safe_to_spend(household):
    r = ask(household, "Can I afford a $500 purchase?")
    assert r["found"] and "Safe to spend right now" in r["answer"] and "estimate" in r["answer"]


def test_advice_is_declined_with_facts(household):
    r = ask(household, "Should I pay off my card or invest?")
    assert "I report, I don't advise" in r["answer"] and "$19,200" in r["answer"]


def test_greeting_and_briefing(household):
    assert ask(household, "Hi")["answer"].startswith("Hi.")
    assert "Net worth" in ask(household, "how am I doing")["answer"]


def test_dates_are_read_aloud(household):
    assert "as of Sep 15" in ask(household, "What's my net worth?")["answer"]
    assert "January 2045" in ask(household, "When will my mortgage be paid off?")["answer"]


def test_accounts_overview_names_accounts(household):
    r = ask(household, "What are my account balances?")
    assert "Everyday Checking $4,200" in r["answer"] and "Owed:" in r["answer"]


def test_refusal_is_helpful(household):
    r = ask(household, "what's the weather like")
    assert not r["found"] and "try one of those" in r["answer"]
