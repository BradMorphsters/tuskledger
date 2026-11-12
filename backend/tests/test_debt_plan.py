"""Debt plan: mortgage escrow split, payoff strategies and the Loans summary.

All numbers are fictional.
"""
from __future__ import annotations

import datetime as dt

import pytest
from fastapi.testclient import TestClient

from app.database import get_db, get_real_db
from app.main import app
from app.models import ManualAsset
from app.services.amortization import compute_pi_payment
from app.services.debt_plan import (
    _balance_after,
    infer_mortgage_pi,
    payment_steps,
    simulate,
    summarize,
)

START = dt.date(2026, 1, 1)


def _mortgage_balance(amount, rate, term, orig, today):
    pi = compute_pi_payment(amount, rate, term)
    months = (today.year - orig.year) * 12 + today.month - orig.month - 1
    return _balance_after(amount, rate, pi, months), pi


# ─── Mortgage term inference ──────────────────────────────────────────

@pytest.mark.parametrize("term", [180, 360])
def test_infers_standard_term_from_balance(term):
    orig, today = dt.date(2020, 3, 1), dt.date(2026, 1, 15)
    bal, pi = _mortgage_balance(200000.0, 0.03, term, orig, today)
    r = infer_mortgage_pi(200000.0, orig, 0.03, bal, today=today)
    assert r["term_months"] == term
    assert r["pi_payment"] == pytest.approx(pi, abs=0.01)
    assert r["source"] == "inferred from balance"


def test_reported_term_wins_when_it_fits():
    orig, today = dt.date(2021, 6, 1), dt.date(2026, 1, 15)
    bal, _ = _mortgage_balance(150000.0, 0.04, 240, orig, today)
    r = infer_mortgage_pi(150000.0, orig, 0.04, bal, today=today, loan_term="20 years")
    assert r["term_months"] == 240 and r["source"] == "reported term"


def test_no_confident_fit_returns_none():
    # Balance far above any standard schedule (e.g. a refinance not recorded).
    assert infer_mortgage_pi(155000.0, dt.date(2020, 1, 1), 0.03, 154000.0,
                             today=dt.date(2026, 1, 1)) is None
    assert infer_mortgage_pi(None, dt.date(2020, 1, 1), 0.03, 100.0) is None


# ─── Simulation ───────────────────────────────────────────────────────

DEBTS = [
    {"id": "a", "name": "Car", "escrow": 0, "pieces": [{"label": "", "balance": 3000.0, "rate": 0.04, "payment": 300.0}]},
    {"id": "b", "name": "Card", "escrow": 0, "pieces": [{"label": "", "balance": 5000.0, "rate": 0.20, "payment": 150.0}]},
    {"id": "c", "name": "Student", "escrow": 0, "pieces": [{"label": "", "balance": 8000.0, "rate": 0.06, "payment": 100.0}]},
]


def test_current_matches_each_loan_alone():
    together = simulate(DEBTS, "current", start_date=START)
    alone = [simulate([d], "current", start_date=START) for d in DEBTS]
    assert together["months"] == max(a["months"] for a in alone)
    assert together["total_interest"] == pytest.approx(sum(a["total_interest"] for a in alone), abs=0.05)


def test_extra_ignored_on_current_plan():
    assert simulate(DEBTS, "current", extra=500, start_date=START)["months"] == \
        simulate(DEBTS, "current", start_date=START)["months"]


def test_avalanche_beats_snowball_on_interest_and_both_beat_current():
    cur = simulate(DEBTS, "current", start_date=START)
    ava = simulate(DEBTS, "avalanche", extra=100, start_date=START)
    snow = simulate(DEBTS, "snowball", extra=100, start_date=START)
    assert ava["total_interest"] <= snow["total_interest"] < cur["total_interest"]
    assert ava["months"] < cur["months"]
    when = lambda plan, i: next(o["months"] for o in plan["payoff_order"] if o["id"] == i)
    # Avalanche sends the extra to the 20% card; snowball to the smallest balance.
    assert when(ava, "b") <= when(snow, "b")
    assert when(snow, "a") < when(ava, "a")


def test_rollover_alone_speeds_payoff():
    # No extra money: freed payments rolling into the next debt still help.
    cur = simulate(DEBTS, "current", start_date=START)
    ava = simulate(DEBTS, "avalanche", extra=0, start_date=START)
    assert ava["months"] < cur["months"]
    assert ava["total_interest"] < cur["total_interest"]


def test_payment_steps_include_escrow_once_loan_ends():
    debts = DEBTS[:1] + [{"id": "m", "name": "Home", "escrow": 250.0,
                          "pieces": [{"label": "", "balance": 20000.0, "rate": 0.03, "payment": 500.0}]}]
    steps = payment_steps(debts, START)
    assert [s["id"] for s in steps] == ["a", "m"]
    assert steps[0]["total_after"] == pytest.approx(750.0)
    assert steps[1]["frees_per_month"] == pytest.approx(750.0)
    assert steps[1]["escrow_continues"] == 250.0
    assert steps[1]["total_after"] == 0.0


def test_summarize_totals_and_exclusion():
    s = summarize(DEBTS, extra=100, monthly_income=5000.0, start_date=START)
    t = s["totals"]
    assert t["balance"] == 16000.0
    assert t["monthly_payment"] == 550.0
    assert t["payments_share_of_income"] == pytest.approx(0.11)
    assert t["weighted_rate"] == pytest.approx((3000 * .04 + 5000 * .2 + 8000 * .06) / 16000, abs=1e-4)
    assert s["next_payoff"]["id"] == "a"
    assert s["plans"]["avalanche"]["interest_saved"] > 0

    ex = summarize(DEBTS, extra=100, start_date=START, exclude_from_plan={"c"})
    assert ex["totals"]["balance"] == 16000.0               # totals still cover every loan
    assert ex["totals"]["interest_remaining"] == t["interest_remaining"]
    assert {o["id"] for o in ex["plans"]["avalanche"]["payoff_order"]} == {"a", "b"}
    assert next(l for l in ex["loans"] if l["id"] == "c")["in_plan"] is False


def test_servicer_balance_used_for_totals():
    d = [dict(DEBTS[2], balance=8123.45)]                   # includes accrued interest
    assert summarize(d, start_date=START)["totals"]["balance"] == 8123.45


# ─── API ──────────────────────────────────────────────────────────────

@pytest.fixture
def client(db):
    app.dependency_overrides[get_db] = lambda: db
    app.dependency_overrides[get_real_db] = lambda: db
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.clear()


def _liab(db, name, value, **kw):
    row = ManualAsset(name=name, side="liability", type="loan",
                      current_value=value, value_as_of=START, **kw)
    db.add(row)
    db.commit()
    return row


def test_summary_endpoint(client, db):
    car = _liab(db, "Car loan", 6000.0, interest_rate=0.05, monthly_payment=300.0)
    stu = _liab(db, "Student loans", 4000.0, loan_tranches=[
        {"label": "A", "balance": 2500.0, "rate": 0.06, "payment": 50.0},
        {"label": "B", "balance": 1500.0, "rate": 0.04, "payment": 30.0},
    ])
    unknown = _liab(db, "Family loan", 1000.0)
    _liab(db, "Paid off", 0.0, interest_rate=0.05, monthly_payment=100.0)

    d = client.get("/api/loans/summary", params={"extra": 50}).json()
    assert d["totals"]["balance"] == 10000.0
    assert d["totals"]["monthly_payment"] == 380.0
    assert d["totals"]["loan_count"] == 2
    assert [e["id"] for e in d["excluded"]] == [f"liab-{unknown.id}"]
    student = next(l for l in d["loans"] if l["id"] == f"liab-{stu.id}")
    assert student["pieces"] == 2
    assert d["plans"]["avalanche"]["interest_saved"] > 0

    # Overrides bring in a loan with no terms on file.
    import json
    d2 = client.get("/api/loans/summary", params={
        "overrides": json.dumps({f"liab-{unknown.id}": {"rate": 0.0, "payment": 100}})}).json()
    assert d2["totals"]["loan_count"] == 3 and d2["excluded"] == []

    # Exclude a loan from the plans only.
    d3 = client.get("/api/loans/summary", params={"extra": 50, "exclude": f"liab-{car.id}"}).json()
    assert d3["totals"]["balance"] == 10000.0
    assert f"liab-{car.id}" not in {o["id"] for o in d3["plans"]["avalanche"]["payoff_order"]}


def test_summary_rejects_bad_overrides(client):
    assert client.get("/api/loans/summary", params={"overrides": "{not json"}).status_code == 400
    assert client.get("/api/loans/summary", params={"overrides": "[1, 2]"}).status_code == 400
    # Junk values inside an override are ignored rather than crashing.
    assert client.get("/api/loans/summary", params={"overrides": '{"liab-1": {"rate": "x"}}'}).status_code == 200
