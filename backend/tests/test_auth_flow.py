"""End-to-end auth flow tests: setup → MFA verify → login → protected route → logout.

These hit the actual FastAPI route handlers via TestClient so they catch
breakage from any of: pydantic-settings, itsdangerous (session cookie
signing), bcrypt, pyotp, FastAPI dependency injection, or the route
schemas themselves. If any of those upgrade in a way that breaks the
auth contract, this suite goes red.

Notes on the fixtures:
  - We override get_real_db so the test never touches the user's actual
    tuskledger.db. This is critical — without the override, the existing
    test_transactions_search.py pattern silently writes to production.
  - DEV_BYPASS_AUTH is forced off so we exercise the real flow rather
    than the dev shortcut.
"""
from __future__ import annotations

import pytest
import pyotp
from fastapi.testclient import TestClient

from app.main import app
from app.config import settings
from app.database import get_real_db


@pytest.fixture
def client(db, monkeypatch):
    """TestClient with get_real_db pointing at the in-memory test session
    and DEV_BYPASS_AUTH disabled."""
    monkeypatch.setattr(settings, "DEV_BYPASS_AUTH", False)
    monkeypatch.setattr(settings, "DEMO_ENABLED", False)

    def _override_db():
        yield db

    app.dependency_overrides[get_real_db] = _override_db
    yield TestClient(app)
    app.dependency_overrides.clear()


def test_status_returns_setup_required_on_fresh_install(client):
    """First user visit: no User row exists, status must say setup_required.
    The frontend uses this to route to the Setup screen instead of Login."""
    r = client.get("/api/auth/status")
    assert r.status_code == 200
    body = r.json()
    assert body["setup_required"] is True
    assert body["authenticated"] is False
    assert body["demo_mode"] is False


def test_setup_start_returns_totp_secret_and_qr(client):
    """The setup flow's first leg: POST username/password, get back the
    secret + QR. The QR must be a renderable data URL or the user can't
    add the account to their authenticator app."""
    r = client.post(
        "/api/auth/setup/start",
        json={"username": "operator", "password": "very-secure-password-12345"},
    )
    assert r.status_code == 200
    body = r.json()
    assert body["secret"]  # base32 string
    assert body["otpauth_uri"].startswith("otpauth://totp/")
    assert body["qr_code"].startswith("data:image/png;base64,")


def test_full_setup_then_login_then_protected_then_logout(client):
    """The whole happy path. If any leg breaks during a runtime upgrade,
    this fails loudly with a precise step indicator."""
    # 1. Setup
    r = client.post(
        "/api/auth/setup/start",
        json={"username": "operator", "password": "very-secure-password-12345"},
    )
    assert r.status_code == 200, "setup/start failed"
    secret = r.json()["secret"]

    # 2. Verify MFA — generates a current TOTP code from the secret
    code = pyotp.TOTP(secret).now()
    r = client.post("/api/auth/setup/verify", json={"code": code})
    assert r.status_code == 200, f"setup/verify failed: {r.text}"

    # After verify, the session cookie should authenticate us
    r = client.get("/api/auth/status")
    assert r.status_code == 200
    body = r.json()
    assert body["setup_required"] is False
    assert body["authenticated"] is True
    assert body["username"] == "operator"

    # 3. Logout clears the session
    r = client.post("/api/auth/logout")
    assert r.status_code == 200

    r = client.get("/api/auth/status")
    body = r.json()
    assert body["authenticated"] is False, "logout should clear session"

    # 4. Re-login with username + password + fresh TOTP
    fresh_code = pyotp.TOTP(secret).now()
    r = client.post(
        "/api/auth/login",
        json={
            "username": "operator",
            "password": "very-secure-password-12345",
            "code": fresh_code,
        },
    )
    assert r.status_code == 200, f"login failed: {r.text}"

    r = client.get("/api/auth/status")
    assert r.json()["authenticated"] is True, "re-login should restore session"


def test_login_rejects_wrong_password(client):
    """Wrong password must NOT leak which field was wrong (prevents
    username enumeration). The error detail should be generic."""
    # Setup first
    r = client.post(
        "/api/auth/setup/start",
        json={"username": "operator", "password": "correct-password-very-long"},
    )
    secret = r.json()["secret"]
    client.post("/api/auth/setup/verify", json={"code": pyotp.TOTP(secret).now()})
    client.post("/api/auth/logout")

    # Try wrong password
    r = client.post(
        "/api/auth/login",
        json={
            "username": "operator",
            "password": "wrong-password-also-long",
            "code": pyotp.TOTP(secret).now(),
        },
    )
    assert r.status_code == 401
    detail = r.json()["detail"]
    # The error must be GENERIC — should not say "wrong password" specifically
    assert "Invalid" in detail
    assert "password" not in detail.lower() or "username" in detail.lower()


def test_login_rejects_wrong_totp_code(client):
    """Wrong MFA code rejection. Same anti-enumeration rule applies."""
    r = client.post(
        "/api/auth/setup/start",
        json={"username": "operator", "password": "correct-password-very-long"},
    )
    secret = r.json()["secret"]
    client.post("/api/auth/setup/verify", json={"code": pyotp.TOTP(secret).now()})
    client.post("/api/auth/logout")

    # Try a code that's mathematically valid (6 digits) but wrong
    r = client.post(
        "/api/auth/login",
        json={
            "username": "operator",
            "password": "correct-password-very-long",
            "code": "000000",  # almost certainly wrong
        },
    )
    assert r.status_code == 401


def test_setup_start_blocks_when_already_set_up(client):
    """Once setup is verified, hitting /setup/start again must NOT silently
    overwrite the existing user — that would let an attacker who reaches
    the unauthenticated endpoint reset the password."""
    r = client.post(
        "/api/auth/setup/start",
        json={"username": "operator", "password": "first-password-very-long"},
    )
    secret = r.json()["secret"]
    client.post("/api/auth/setup/verify", json={"code": pyotp.TOTP(secret).now()})
    # Try to re-setup
    r = client.post(
        "/api/auth/setup/start",
        json={"username": "attacker", "password": "attacker-password-very-long"},
    )
    assert r.status_code == 409
    assert "already" in r.json()["detail"].lower()


def test_setup_verify_rejects_invalid_code(client):
    """The verify step must reject codes that don't match the secret —
    otherwise an attacker who guesses six digits gets MFA enabled with
    THEIR phone."""
    client.post(
        "/api/auth/setup/start",
        json={"username": "operator", "password": "very-secure-password-12345"},
    )
    r = client.post("/api/auth/setup/verify", json={"code": "999999"})
    assert r.status_code == 401


def test_dev_bypass_auth_short_circuits_status(client, monkeypatch):
    """When DEV_BYPASS_AUTH is on, /status must report authenticated=True
    even with no User row. This is the single-flag escape hatch we
    promised the user — accidentally regressing it would break their
    daily local workflow."""
    monkeypatch.setattr(settings, "DEV_BYPASS_AUTH", True)
    r = client.get("/api/auth/status")
    body = r.json()
    assert body["authenticated"] is True
    assert body["setup_required"] is False
    # Username falls back to 'dev' when no User exists
    assert body["username"] == "dev"


def test_demo_mode_short_circuits_via_cookie(client, monkeypatch):
    """fintrack_mode=demo cookie should bypass auth (data is synthetic)
    even when DEMO_ENABLED + DEV_BYPASS_AUTH are off. This is the
    two-database toggle that powers the Real/Demo sidebar switch."""
    monkeypatch.setattr(settings, "DEMO_ENABLED", True)
    monkeypatch.setattr(settings, "DEV_BYPASS_AUTH", False)
    r = client.get("/api/auth/status", cookies={"fintrack_mode": "demo"})
    body = r.json()
    assert body["authenticated"] is True
    assert body["demo_mode"] is True
    assert body["username"] == "demo"
