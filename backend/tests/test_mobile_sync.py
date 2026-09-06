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


def test_manifest_reports_schema_version_6(client):
    token = _pair(client)
    r = client.get("/api/mobile/manifest", headers=_hdr(token))
    assert r.status_code == 200
    assert r.json()["schema_version"] == 6


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


def test_sync_payload_carries_is_refund(client, db, factory):
    """The phone computes its own income/spend sums from the mirror, so it
    needs the refund flag to net refunds the way the laptop does."""
    import datetime
    from app.services.refund_detector import detect_refunds
    acct = factory.account(name="Checking")
    factory.transaction(account_id=acct.id, amount=-45.0, date=datetime.date(2026, 8, 3),
                        merchant_name="Store", category="Shopping")          # a return
    factory.transaction(account_id=acct.id, amount=-2000.0, date=datetime.date(2026, 8, 3),
                        merchant_name="Payroll", category="Income")          # a paycheck
    factory.commit()
    detect_refunds(db)
    token = _pair(client)
    body = client.get("/api/mobile/sync", headers=_hdr(token)).json()
    flags = {t["merchant_name"]: t["is_refund"] for t in body["transactions"]}
    assert flags == {"Store": True, "Payroll": False}


# ─── Insights (schema v5) ────────────────────────────────────────────────

def test_insights_requires_token(client):
    assert client.get("/api/mobile/insights").status_code == 401


def test_insights_empty_db_is_well_shaped(client):
    """A freshly paired phone against an empty laptop still gets a valid,
    zeroed payload — the phone renders "nothing yet", not an error."""
    token = _pair(client)
    r = client.get("/api/mobile/insights", headers=_hdr(token))
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["as_of"] == datetime.date.today().isoformat()
    sts = body["safe_to_spend"]
    assert sts["safe_to_spend"] == 0.0
    assert sts["spendable_cash"] == 0.0
    assert sts["next_paycheck_source"] == "month_end_fallback"
    assert isinstance(sts["bills"], list) and isinstance(sts["notes"], list)
    digest = body["weekly_digest"]
    assert digest["week_end"] == datetime.date.today().isoformat()
    assert digest["happened"]["spend"] == 0.0
    assert digest["coming"]["bills"] == []


def test_insights_mirrors_laptop_services(client, db, factory):
    """The phone must see the SAME numbers the laptop Dashboard shows —
    the endpoint is a pass-through of compute_safe_to_spend and
    compute_weekly_digest, so compare against them directly."""
    from app.services.safe_to_spend import compute_safe_to_spend
    from app.services.weekly_digest import compute_weekly_digest

    today = datetime.date.today()
    acct = factory.account(name="Checking", type="depository",
                           subtype="checking", current_balance=2500.0)
    factory.account(name="Rainy Day", type="depository",
                    subtype="savings", current_balance=9000.0)
    factory.commit()
    for i in range(4):
        factory.transaction(
            account_id=acct.id, amount=60.0, merchant_name="Grocer",
            date=today - datetime.timedelta(days=2 + i * 3),
            category="Groceries",
        )
    factory.commit()

    token = _pair(client)
    r = client.get("/api/mobile/insights", headers=_hdr(token))
    assert r.status_code == 200, r.text
    body = r.json()

    expected_sts = compute_safe_to_spend(db, today=today)
    expected_digest = compute_weekly_digest(db, week_ending=today)
    assert body["safe_to_spend"]["safe_to_spend"] == expected_sts["safe_to_spend"]
    assert body["safe_to_spend"]["spendable_cash"] == 2500.0
    assert body["safe_to_spend"]["savings_cash"] == 9000.0
    assert body["weekly_digest"]["happened"]["spend"] == expected_digest["happened"]["spend"]
    assert body["weekly_digest"]["happened"]["spend"] > 0


# ─── Ask Tusk from the phone (schema v6) ────────────────────────────────

def test_ask_requires_token(client):
    assert client.post("/api/mobile/ask", json={"question": "how much did I spend?"}).status_code == 401
    assert client.get("/api/mobile/briefing").status_code == 401


def test_ask_returns_grounded_answer_shape(client, db, factory):
    """The phone gets the same brain as the laptop's Ask panel: a string
    answer plus provenance (source/intent/grounded) and capped rows. With
    no local model in tests the source is the deterministic template path."""
    acct = factory.account(name="Checking", type="depository", current_balance=1200.0)
    factory.commit()
    today = datetime.date.today()
    for i in range(3):
        factory.transaction(account_id=acct.id, amount=40.0, merchant_name="Grocer",
                            date=today - datetime.timedelta(days=i), category="Groceries")
    factory.commit()

    token = _pair(client)
    r = client.post(
        "/api/mobile/ask",
        headers=_hdr(token),
        json={"question": "How much have I spent on groceries this month?",
              "history": [{"who": "you", "text": "hi"}, {"who": "tusk", "text": "hello"}]},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert isinstance(body["answer"], str) and body["answer"]
    assert body["source"] in {"ollama", "retrieval", "guarded", "refusal", "template"}
    assert isinstance(body["grounded"], bool)
    assert isinstance(body["rows"], list) and len(body["rows"]) <= 25
    assert "snapshot" not in body  # trimmed for the phone


def test_ask_rejects_unknown_fields_and_empty_question(client):
    token = _pair(client)
    assert client.post("/api/mobile/ask", headers=_hdr(token), json={"question": ""}).status_code == 422
    assert client.post("/api/mobile/ask", headers=_hdr(token),
                       json={"question": "x", "write": True}).status_code == 422


def test_briefing_is_short_text(client):
    token = _pair(client)
    r = client.get("/api/mobile/briefing", headers=_hdr(token))
    assert r.status_code == 200, r.text
    body = r.json()
    assert set(body) == {"briefing", "source"}
    assert isinstance(body["briefing"], str)


# ─── Flagged answers from the phone ──────────────────────────────────────

def test_ask_feedback_requires_token(client):
    r = client.post("/api/mobile/ask/feedback", json={"items": [{"question": "q", "answer": "a", "rating": "down"}]})
    assert r.status_code == 401


def test_ask_feedback_batch_lands_in_review_log(client, tmp_path, monkeypatch):
    from app.config import settings
    from app.services import assistant_feedback as fb
    monkeypatch.setattr(settings, "ASSISTANT_FEEDBACK_DIR", str(tmp_path))
    monkeypatch.setattr(settings, "LLM_ENABLED", False)
    fb.reset_cache()
    token = _pair(client)
    r = client.post("/api/mobile/ask/feedback", headers=_hdr(token), json={"items": [
        {"question": "how much at costco", "answer": "No charges from Costco.", "rating": "down",
         "origin": "phone", "intent": "spend_merchant", "comment": "wrong store name", "asked_at": 1700000000.0},
        {"question": "what's my net worth", "answer": "Your net worth is about $100.", "rating": "up",
         "origin": "laptop", "source": "retrieval"},
    ]})
    assert r.status_code == 200, r.text
    assert r.json()["recorded"] == 2 and len(r.json()["ids"]) == 2
    items = fb.review(days=36500, rating="all")
    assert len(items) == 2
    down = next(i for i in items if i["rating"] == "down")
    assert down["device"] == "phone" and down["origin"] == "phone" and down["comment"] == "wrong store name"
    assert down["asked_at"] == 1700000000.0
    assert len(fb.pending()) == 1            # the down-thumb opened a diagnosis, the up-thumb didn't


def test_ask_feedback_validates_items(client):
    token = _pair(client)
    assert client.post("/api/mobile/ask/feedback", headers=_hdr(token), json={"items": []}).status_code == 422
    assert client.post("/api/mobile/ask/feedback", headers=_hdr(token),
                       json={"items": [{"question": "q", "answer": "a", "rating": "meh"}]}).status_code == 422
