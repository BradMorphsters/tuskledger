"""HTTP-level security tests: read-only gate, login lockout/replay,
TOTP encryption at rest, CSV size cap, demo refresh throttle, schema limits.

Unlike some older TestClient tests, these install dependency_overrides for
BOTH get_db and get_real_db so every request hits the same hermetic
in-memory database as the test fixtures — no dependence on the contents
of the developer's real tuskledger.db.
"""
from __future__ import annotations

import pyotp
import pytest
from fastapi.testclient import TestClient

from app.config import settings
from app.database import get_db, get_real_db
from app.main import app
from app.models import User
from app.routers import auth as auth_router
from app.services import auth_service, crypto


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------
@pytest.fixture()
def client(db):
    """TestClient wired to the hermetic in-memory DB, with auth module
    state (lockout counters, replay cache) and settings restored after."""
    saved = {
        "DEMO_LOCKED": settings.DEMO_LOCKED,
        "DEMO_ENABLED": settings.DEMO_ENABLED,
        "DEV_BYPASS_AUTH": settings.DEV_BYPASS_AUTH,
    }
    app.dependency_overrides[get_db] = lambda: db
    app.dependency_overrides[get_real_db] = lambda: db
    auth_router._failed_logins.clear()
    auth_router._last_used_totp.clear()
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.clear()
        auth_router._failed_logins.clear()
        auth_router._last_used_totp.clear()
        for k, v in saved.items():
            setattr(settings, k, v)


def _make_user(db, *, plaintext_secret: bool = False) -> tuple[User, str]:
    """Create a verified user; returns (user, base32_totp_secret)."""
    secret = auth_service.generate_totp_secret()
    stored = secret if plaintext_secret else auth_service.encrypt_totp_secret(secret)
    user = User(
        username="operator",
        password_hash=auth_service.hash_password("correct horse battery"),
        totp_secret=stored,
        totp_verified=True,
    )
    db.add(user)
    db.commit()
    return user, secret


# ---------------------------------------------------------------------------
# Read-only gate (DEMO_LOCKED / readonly-device cookie)
# ---------------------------------------------------------------------------
def test_demo_locked_blocks_mutations(client):
    settings.DEMO_LOCKED = True
    r = client.post("/api/transactions/manual", json={})
    assert r.status_code == 403
    assert "read-only" in r.json()["detail"].lower()


def test_demo_locked_blocks_auth_setup(client):
    """Setup must NOT be allowlisted — visitors to the public demo must not
    be able to create a user + TOTP secret."""
    settings.DEMO_LOCKED = True
    r = client.post(
        "/api/auth/setup/start",
        json={"username": "intruder", "password": "longenough123"},
    )
    assert r.status_code == 403


def test_demo_locked_allows_login_path_through_gate(client):
    """Login is allowlisted: it must reach the route handler (401 — no user
    exists), not be swallowed by the read-only middleware (403)."""
    settings.DEMO_LOCKED = True
    settings.DEV_BYPASS_AUTH = False
    r = client.post(
        "/api/auth/login",
        json={"username": "x", "password": "y", "code": "000000"},
    )
    assert r.status_code == 401


def test_demo_locked_allows_reads(client):
    settings.DEMO_LOCKED = True
    settings.DEV_BYPASS_AUTH = True  # skip auth, exercise only the gate
    r = client.get("/api/accounts/")
    assert r.status_code == 200


def test_readonly_device_cookie_blocks_mutations(client):
    settings.DEMO_LOCKED = False
    client.cookies.set("tuskledger_view", "readonly")
    r = client.post("/api/transactions/manual", json={})
    assert r.status_code == 403


# ---------------------------------------------------------------------------
# Login brute-force lockout + TOTP replay
# ---------------------------------------------------------------------------
def test_login_lockout_after_failed_attempts(client, db):
    settings.DEMO_LOCKED = False
    _make_user(db)
    for _ in range(auth_router._MAX_FAILURES):
        r = client.post(
            "/api/auth/login",
            json={"username": "operator", "password": "correct horse battery", "code": "000000"},
        )
        assert r.status_code == 401
    # 6th attempt: locked out even with correct credentials
    r = client.post(
        "/api/auth/login",
        json={"username": "operator", "password": "correct horse battery", "code": "000000"},
    )
    assert r.status_code == 429


def test_login_totp_replay_rejected(client, db):
    settings.DEMO_LOCKED = False
    _, secret = _make_user(db)
    code = pyotp.TOTP(secret).now()
    body = {"username": "operator", "password": "correct horse battery", "code": code}
    assert client.post("/api/auth/login", json=body).status_code == 200
    # Same (still time-valid) code again -> replay rejected
    assert client.post("/api/auth/login", json=body).status_code == 401


# ---------------------------------------------------------------------------
# TOTP secret encryption at rest
# ---------------------------------------------------------------------------
def test_setup_stores_encrypted_totp_secret(client, db):
    settings.DEMO_LOCKED = False
    r = client.post(
        "/api/auth/setup/start",
        json={"username": "operator", "password": "longenough123"},
    )
    assert r.status_code == 200
    plain = r.json()["secret"]  # response carries plaintext for the QR
    user = db.query(User).first()
    assert crypto.is_encrypted(user.totp_secret)
    assert crypto.decrypt_token(user.totp_secret) == plain


def test_legacy_plaintext_secret_lazily_encrypted_and_still_works(client, db):
    settings.DEMO_LOCKED = False
    settings.DEV_BYPASS_AUTH = True
    user, secret = _make_user(db, plaintext_secret=True)
    assert not crypto.is_encrypted(user.totp_secret)
    # /status is hit on every app load and performs the lazy migration
    assert client.get("/api/auth/status").status_code == 200
    db.refresh(user)
    assert crypto.is_encrypted(user.totp_secret)
    # Login still verifies against the (now encrypted) secret
    settings.DEV_BYPASS_AUTH = False
    r = client.post(
        "/api/auth/login",
        json={
            "username": "operator",
            "password": "correct horse battery",
            "code": pyotp.TOTP(secret).now(),
        },
    )
    assert r.status_code == 200


# ---------------------------------------------------------------------------
# CSV import size cap
# ---------------------------------------------------------------------------
def test_csv_import_rejects_oversized_file(client, db, factory):
    settings.DEMO_LOCKED = False
    settings.DEV_BYPASS_AUTH = True
    acct = factory.account()
    factory.commit()
    big = b"Date,Amount,Description\n" + b"x" * (10 * 1024 * 1024)
    r = client.post(
        f"/api/csv-import/?account_id={acct.id}",
        files={"file": ("big.csv", big, "text/csv")},
    )
    assert r.status_code == 413


# ---------------------------------------------------------------------------
# Demo refresh throttle (no demo engine touched: monkeypatched to None)
# ---------------------------------------------------------------------------
def test_demo_refresh_is_throttled(client, monkeypatch):
    settings.DEMO_ENABLED = True
    settings.DEMO_LOCKED = False
    from app.routers import demo as demo_router

    monkeypatch.setattr(demo_router, "demo_engine", None)
    monkeypatch.setattr(demo_router, "DemoSessionLocal", None)
    monkeypatch.setattr(demo_router, "_last_refresh_at", 0.0)
    # First call passes the throttle (then 503s on the absent engine,
    # which still arms the timestamp) ...
    assert client.post("/api/demo/refresh").status_code == 503
    # ... so an immediate second call is rejected by the throttle.
    assert client.post("/api/demo/refresh").status_code == 429


# ---------------------------------------------------------------------------
# Schema validation limits
# ---------------------------------------------------------------------------
def test_budget_rejects_negative_limit(client):
    settings.DEMO_LOCKED = False
    settings.DEV_BYPASS_AUTH = True
    r = client.post(
        "/api/budgets/",
        json={
            "month": 6,
            "year": 2026,
            "categories": [{"category": "Groceries", "limit_amount": -500}],
        },
    )
    assert r.status_code == 422


def test_transaction_notes_length_capped(client, db, factory):
    settings.DEMO_LOCKED = False
    settings.DEV_BYPASS_AUTH = True
    acct = factory.account()
    txn = factory.transaction(account_id=acct.id)
    factory.commit()
    r = client.patch(f"/api/transactions/{txn.id}", json={"notes": "x" * 5000})
    assert r.status_code == 422
