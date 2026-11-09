"""Manual loans with stored terms and multi-piece ("tranche") amortization.

Federal student loans are usually several loans with different rates and
payments. Amortizing them under one blended rate misstates the payoff
date, so a manual liability can store each piece and the Loans page
amortizes them separately, summing month by month.
"""
from __future__ import annotations

import datetime as dt

import pytest
from fastapi.testclient import TestClient

from app.database import get_db, get_real_db
from app.main import app
from app.models import ManualAsset
from app.services.amortization import (
    compute_schedule,
    compute_summary,
    compute_tranche_schedule,
    compare_extra_payment_tranches,
    tranche_totals,
)

START = dt.date(2026, 1, 1)
PIECES = [
    {"label": "A", "balance": 4000.0, "rate": 0.065, "payment": 60.0},
    {"label": "B", "balance": 3000.0, "rate": 0.035, "payment": 45.0},
    {"label": "C", "balance": 1000.0, "rate": 0.05, "payment": 40.0},
]


# ─── Service ──────────────────────────────────────────────────────────

def test_single_piece_matches_plain_schedule():
    one = [{"label": "only", "balance": 5000.0, "rate": 0.06, "payment": 100.0}]
    a = compute_summary(compute_tranche_schedule(one, start_date=START))
    b = compute_summary(compute_schedule(5000.0, 0.06, 100.0, start_date=START))
    assert a == b


def test_pieces_pay_off_independently_and_payment_steps_down():
    rows = compute_tranche_schedule(PIECES, start_date=START)
    assert rows[0]["beginning_balance"] == 8000.0
    assert rows[0]["payment"] == pytest.approx(145.0, abs=0.01)
    # The small piece C ends first, so the total payment drops after it does.
    c_alone = len(compute_tranche_schedule([PIECES[2]], start_date=START))
    assert rows[c_alone + 1]["payment"] == pytest.approx(105.0, abs=0.01)
    # Overall payoff = the longest piece's payoff.
    longest = max(len(compute_tranche_schedule([p], start_date=START)) for p in PIECES)
    assert len(rows) == longest
    assert rows[-1]["ending_balance"] == 0.0


def test_blended_rate_would_misstate_the_payoff():
    totals = tranche_totals(PIECES)
    blended = compute_schedule(totals["balance"], totals["rate"], totals["payment"], start_date=START)
    by_piece = compute_tranche_schedule(PIECES, start_date=START)
    assert len(blended) != len(by_piece)


def test_extra_goes_to_highest_rate_piece_first():
    rows = compute_tranche_schedule(PIECES, extra_principal=100.0, start_date=START)
    assert rows[0]["extra_principal"] == 100.0
    cmp = compare_extra_payment_tranches(PIECES, 100.0, start_date=START)
    assert cmp["months_saved"] > 0 and cmp["interest_saved"] > 0
    # Avalanche beats putting the same extra on the lowest-rate piece.
    snapshot = [dict(p) for p in PIECES]
    avalanche_interest = compute_summary(rows)["total_interest"]
    worst = compute_summary(compute_tranche_schedule(
        [dict(PIECES[0]), dict(PIECES[2]), dict(PIECES[1], payment=PIECES[1]["payment"] + 100.0)],
        start_date=START))["total_interest"]
    assert avalanche_interest < worst
    assert snapshot == PIECES  # inputs are not mutated


def test_totals_weight_rate_by_balance():
    t = tranche_totals(PIECES)
    assert t["balance"] == 8000.0 and t["payment"] == 145.0
    assert t["rate"] == pytest.approx((4000 * 0.065 + 3000 * 0.035 + 1000 * 0.05) / 8000)


# ─── API ──────────────────────────────────────────────────────────────

@pytest.fixture
def client(db):
    app.dependency_overrides[get_db] = lambda: db
    app.dependency_overrides[get_real_db] = lambda: db
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.clear()


def _liab(db, **kw):
    row = ManualAsset(name="Student loans", side="liability", type="student_loan",
                      current_value=8000.0, value_as_of=START, **kw)
    db.add(row)
    db.commit()
    return row


def test_list_loans_shows_stored_terms_for_manual_liability(client, db):
    row = _liab(db, loan_tranches=PIECES)
    loan = next(l for l in client.get("/api/loans/").json()["loans"] if l["id"] == f"liab-{row.id}")
    assert loan["monthly_payment"] == 145.0
    assert loan["interest_rate"] == pytest.approx(tranche_totals(PIECES)["rate"])
    assert loan["tranche_count"] == 3
    assert loan["months_remaining"] == len(compute_tranche_schedule(PIECES))
    assert loan["maturity_date"]


def test_list_loans_with_rate_and_payment_but_no_pieces(client, db):
    row = _liab(db, interest_rate=0.05, monthly_payment=200.0)
    loan = next(l for l in client.get("/api/loans/").json()["loans"] if l["id"] == f"liab-{row.id}")
    assert loan["months_remaining"] and loan["months_remaining"] < 60
    assert loan["tranche_count"] == 0


def test_manual_liability_without_terms_still_asks_for_overrides(client, db):
    row = _liab(db)
    res = client.get(f"/api/loans/liab-{row.id}/amortization")
    assert res.status_code == 400
    loan = next(l for l in client.get("/api/loans/").json()["loans"] if l["id"] == f"liab-{row.id}")
    assert loan["interest_rate"] is None and loan["monthly_payment"] is None


def test_amortization_uses_pieces_and_returns_them(client, db):
    row = _liab(db, loan_tranches=PIECES)
    d = client.get(f"/api/loans/liab-{row.id}/amortization").json()
    assert d["summary"]["months"] == len(compute_tranche_schedule(PIECES))
    assert [t["label"] for t in d["loan"]["tranches"]] == ["A", "B", "C"]
    d2 = client.get(f"/api/loans/liab-{row.id}/amortization", params={"extra_principal": 100}).json()
    assert d2["comparison"]["months_saved"] > 0


def test_overrides_replace_the_pieces(client, db):
    row = _liab(db, loan_tranches=PIECES)
    d = client.get(f"/api/loans/liab-{row.id}/amortization",
                   params={"rate_override": 0.04, "payment_override": 500}).json()
    assert d["summary"]["months"] == len(compute_schedule(8000.0, 0.04, 500.0))


def test_patch_and_create_accept_loan_terms(client, db):
    created = client.post("/api/manual-assets/", json={
        "name": "Car loan", "side": "liability", "type": "auto_loan", "current_value": 9000,
        "interest_rate": 0.049, "monthly_payment": 300,
    }).json()
    assert created["interest_rate"] == 0.049 and created["monthly_payment"] == 300
    patched = client.patch(f"/api/manual-assets/{created['id']}", json={"loan_tranches": PIECES}).json()
    assert len(patched["loan_tranches"]) == 3
    bad = client.patch(f"/api/manual-assets/{created['id']}", json={"interest_rate": 7})
    assert bad.status_code == 422
