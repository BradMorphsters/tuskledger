"""Tests for the mobile companion router — pairing, token auth, /sync.

First coverage for routers/mobile.py (flagged in audit Pass 4: the router
had NO tests). Exercises the full pairing handshake, token enforcement,
the cursor-based delta sync, and the complete-set contracts for budgets
(schema v3) and upcoming_bills (schema v4).
"""
import datetime

import pytest
from fastapi.testclient import TestClient

from app.database import get_db, get_real_db
from app.dependencies import require_auth
from app.main import app
from app.models import Account, MortgageDetail
from app.models.budget import Budget, BudgetCategory
from app.utils import utcnow


@pytest.fixture()
def client(db):
    """TestClient on the hermetic in-memory DB.

    Overrides get_real_db too — require_device_token reads through it by
    design (demo cookie must not bypass device auth) — and require_auth,
    which gates the laptop-side pairing/device endpoints.
    """
    app.dependency_overrides[get_db] = lambda: db
    app.dependency_overrides[get_real_db] = lambda: db
    app.dependency_overrides[require_auth] = lambda: None
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.clear()


def _pair(client) -> str:
    """Run the full pairing handshake, return the device token."""
    start = client.post("/api/mobile/pair/start")
    assert start.status_code == 200, start.text
    code = start.json()["code"]
    claim = client.post(
        "/api/mobile/pair/claim", json={"code": code, "label": "pytest phone"}
    )
    assert claim.status_code == 200, claim.text
    token = claim.json()["token"]
    assert token
    return token


def _hdr(token: str) -> dict:
    return {"X-Device-Token": token}


# ─── Pairing ─────────────────────────────────────────────────────────────

def test_pair_claim_flow_and_single_use(client):
    start = client.post("/api/mobile/pair/start")
    assert start.status_code == 200
    code = start.json()["code"]

    first = client.post("/api/mobile/pair/claim", json={"code": code, "label": "phone"})
    assert first.status_code == 200
    assert first.json()["token"]

    # The code is single-use: a second claim must not mint another token.
    second = client.post("/api/mobile/pair/claim", json={"code": code, "label": "evil"})
    assert second.status_code in (404, 410)


def test_unknown_code_rejected(client):
    r = client.post("/api/mobile/pair/claim", json={"code": "WRONGCODE", "label": "x"})
    assert r.status_code in (404, 410)


# ─── Token enforcement ───────────────────────────────────────────────────

def test_sync_requires_token(client):
    assert client.get("/api/mobile/sync").status_code == 401


def test_garbage_token_rejected(client):
    r = client.get("/api/mobile/sync", headers=_hdr("not-a-real-token"))
    assert r.status_code == 401


def test_manifest_reports_schema_version_4(client):
    token = _pair(client)
    r = client.get("/api/mobile/manifest", headers=_hdr(token))
    assert r.status_code == 200
    assert r.json()["schema_version"] == 4


def test_revoked_device_gets_401(client):
    token = _pair(client)
    assert client.get("/api/mobile/manifest", headers=_hdr(token)).status_code == 200

    devices = client.get("/api/mobile/devices").json()
    assert len(devices) == 1
    rid = devices[0]["id"]
    assert client.post(f"/api/mobile/devices/{rid}/revoke").status_code == 200

    assert client.get("/api/mobile/manifest", headers=_hdr(token)).status_code == 401


# ─── Sync payload ────────────────────────────────────────────────────────

def _seed_finances(db, factory):
    acct = factory.account(name="Checking", type="depository")
    factory.commit()
    for i in range(3):
        factory.transaction(
            account_id=acct.id,
            name=f"COFFEE {i}",
            merchant_name="Coffee Shop",
            amount=4.50 + i,
            date=datetime.date(2026, 7, 1 + i),
        )
    factory.commit()

    today = datetime.date.today()
    bud = Budget(month=today.month, year=today.year, total_limit=3000.0)
    bud.categories = [
        BudgetCategory(category="Groceries", limit_amount=800.0),
        BudgetCategory(category="Dining", limit_amount=300.0),
    ]
    db.add(bud)

    mort_acct = factory.account(name="Home Loan", type="loan")
    factory.commit()
    db.add(MortgageDetail(
        account_id=mort_acct.id,
        next_payment_due_date=today + datetime.timedelta(days=10),
        next_monthly_payment=2100.0,
    ))
    db.commit()
    return acct


def test_full_sync_includes_all_tables(client, db, factory):
    acct = _seed_finances(db, factory)
    token = _pair(client)

    r = client.get("/api/mobile/sync", headers=_hdr(token))
    assert r.status_code == 200, r.text
    body = r.json()

    assert body["full"] is True
    assert body["has_more"] is False
    assert {a["id"] for a in body["accounts"]} >= {acct.id}
    assert len(body["transactions"]) == 3

    # schema v3: budgets ride along as the COMPLETE set.
    assert len(body["budgets"]) == 1
    cats = {c["category"]: c["limit_amount"] for c in body["budgets"][0]["categories"]}
    assert cats == {"Groceries": 800.0, "Dining": 300.0}

    # schema v4: upcoming bills derived from the mortgage detail.
    bills = body["upcoming_bills"]
    assert len(bills) == 1
    assert bills[0]["kind"] == "mortgage"
    assert bills[0]["amount"] == 2100.0
    assert 0 <= bills[0]["days_until"] <= 10


def test_incremental_sync_filters_by_cursor(client, db, factory):
    acct = _seed_finances(db, factory)
    token = _pair(client)

    first = client.get("/api/mobile/sync", headers=_hdr(token)).json()
    cursor = first["server_time"]

    # A new transaction lands after the cursor.
    late = factory.transaction(
        account_id=acct.id,
        name="NEW BURRITO",
        merchant_name="Burrito Bar",
        amount=12.0,
        date=datetime.date.today(),
    )
    late.updated_at = utcnow() + datetime.timedelta(seconds=1)
    factory.commit()

    second = client.get(
        "/api/mobile/sync", params={"since": cursor}, headers=_hdr(token)
    ).json()
    assert second["full"] is False
    names = [t["name"] for t in second["transactions"]]
    assert "NEW BURRITO" in names
    # The three old transactions (updated well before the cursor) are absent.
    assert all(not n.startswith("COFFEE") for n in names)
    # Complete-set contracts hold on incrementals too — the phone wipes and
    # reinserts these tables every sync, so they must never come back empty
    # just because nothing changed.
    assert len(second["budgets"]) == 1
    assert len(second["upcoming_bills"]) == 1


def test_transaction_pagination_has_more(client, db, factory):
    acct = factory.account(name="Checking", type="depository")
    factory.commit()
    for i in range(5):
        t = factory.transaction(
            account_id=acct.id,
            name=f"TX {i}",
            amount=10.0 + i,
            date=datetime.date(2026, 6, 1 + i),
        )
        # Distinct updated_at values so the ASC cursor walk is deterministic.
        t.updated_at = utcnow() - datetime.timedelta(minutes=5 - i)
    factory.commit()
    token = _pair(client)

    r = client.get(
        "/api/mobile/sync", params={"transaction_limit": 2}, headers=_hdr(token)
    ).json()
    assert r["has_more"] is True
    assert len(r["transactions"]) == 2
    # Resume from the last row's updated_at (>= semantics re-serve the
    # boundary row — the phone upserts, so duplicates are fine).
    follow = client.get(
        "/api/mobile/sync",
        params={"transaction_limit": 100, "since": r["transactions"][-1]["updated_at"]},
        headers=_hdr(token),
    ).json()
    got = {t["name"] for t in r["transactions"]} | {t["name"] for t in follow["transactions"]}
    assert got == {f"TX {i}" for i in range(5)}
