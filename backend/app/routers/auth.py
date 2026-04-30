"""Authentication routes: first-run setup, login, logout, status.

Session handling is delegated to Starlette's SessionMiddleware (signed cookies).
Successful authentication sets `request.session["user_id"]` and
`request.session["mfa_verified"] = True`. A route is considered authenticated
when both are present.
"""
from __future__ import annotations

import datetime
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.config import settings
from app.database import get_real_db as get_db
from app.models import User
from app.services import auth_service


router = APIRouter(prefix="/api/auth", tags=["auth"])


# ----- Schemas ------------------------------------------------------------
class StatusResponse(BaseModel):
    setup_required: bool
    authenticated: bool
    username: Optional[str] = None
    mfa_method: str = "TOTP"
    demo_mode: bool = False


class SetupStartRequest(BaseModel):
    username: str = Field(min_length=1, max_length=64, default="operator")
    password: str = Field(min_length=8, max_length=256)


class SetupStartResponse(BaseModel):
    otpauth_uri: str
    qr_code: str  # data URL (base64 PNG)
    secret: str   # base32 secret for manual entry


class SetupVerifyRequest(BaseModel):
    code: str = Field(min_length=6, max_length=10)


class LoginRequest(BaseModel):
    username: str = Field(min_length=1, max_length=64)
    password: str = Field(min_length=1, max_length=256)
    code: str = Field(min_length=6, max_length=10)


class OkResponse(BaseModel):
    ok: bool = True


# ----- Helpers ------------------------------------------------------------
def _set_session(request: Request, user: User) -> None:
    request.session["user_id"] = user.id
    request.session["mfa_verified"] = True


def _clear_session(request: Request) -> None:
    request.session.clear()


# ----- Routes -------------------------------------------------------------
@router.get("/status", response_model=StatusResponse)
def auth_status(request: Request, db: Session = Depends(get_db)):
    # Dev bypass: pretend we're fully authenticated so the frontend skips
    # the login/setup screens. The preserved user (if any) keeps their
    # username visible in the sidebar; otherwise we show "dev".
    # Per-request demo flag: read straight from the cookie so the toggle
    # in the sidebar can flip it without a server restart.
    in_demo = bool(
        settings.DEMO_ENABLED
        and request.cookies.get("fintrack_mode") == "demo"
    )

    # Demo mode bypasses auth entirely — the data is synthetic.
    if in_demo:
        return StatusResponse(
            setup_required=False,
            authenticated=True,
            username="demo",
            demo_mode=True,
        )

    if settings.DEV_BYPASS_AUTH:
        user = auth_service.get_user(db)
        return StatusResponse(
            setup_required=False,
            authenticated=True,
            username=(user.username if user else "dev"),
            demo_mode=False,
        )

    user = auth_service.get_user(db)
    if user is None or not user.totp_verified:
        return StatusResponse(setup_required=True, authenticated=False, demo_mode=False)
    authed = bool(
        request.session.get("user_id") == user.id
        and request.session.get("mfa_verified")
    )
    return StatusResponse(
        setup_required=False,
        authenticated=authed,
        username=user.username if authed else None,
        demo_mode=False,
    )


@router.post("/setup/start", response_model=SetupStartResponse)
def setup_start(body: SetupStartRequest, db: Session = Depends(get_db)):
    """Create the initial user (if none) and return a fresh TOTP secret + QR."""
    existing = auth_service.get_user(db)
    if existing and existing.totp_verified:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Setup already completed. Use /login.",
        )
    secret = auth_service.generate_totp_secret()
    pw_hash = auth_service.hash_password(body.password)
    if existing is None:
        user = User(
            username=body.username,
            password_hash=pw_hash,
            totp_secret=secret,
            totp_verified=False,
        )
        db.add(user)
    else:
        # Setup was started but never verified — update with fresh secret.
        existing.username = body.username
        existing.password_hash = pw_hash
        existing.totp_secret = secret
        existing.totp_verified = False
        user = existing
    db.commit()
    db.refresh(user)
    uri = auth_service.totp_uri(secret, user.username)
    qr = auth_service.qr_code_data_url(uri)
    return SetupStartResponse(otpauth_uri=uri, qr_code=qr, secret=secret)


@router.post("/setup/verify", response_model=OkResponse)
def setup_verify(
    body: SetupVerifyRequest, request: Request, db: Session = Depends(get_db)
):
    """Confirm the user can generate a valid TOTP code before locking in MFA."""
    user = auth_service.get_user(db)
    if user is None:
        raise HTTPException(status_code=400, detail="Setup has not been started.")
    if not auth_service.verify_totp(user.totp_secret, body.code):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid code. Check your authenticator app and try again.",
        )
    user.totp_verified = True
    user.last_login_at = datetime.datetime.utcnow()
    db.commit()
    _set_session(request, user)
    return OkResponse()


@router.post("/login", response_model=OkResponse)
def login(body: LoginRequest, request: Request, db: Session = Depends(get_db)):
    user = auth_service.get_user(db)
    if user is None or not user.totp_verified:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Setup required. Complete MFA setup before logging in.",
        )
    if user.username != body.username:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid username, password, or MFA code.",
        )
    if not auth_service.verify_password(body.password, user.password_hash):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid username, password, or MFA code.",
        )
    if not auth_service.verify_totp(user.totp_secret, body.code):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid username, password, or MFA code.",
        )
    user.last_login_at = datetime.datetime.utcnow()
    db.commit()
    _set_session(request, user)
    return OkResponse()


@router.post("/logout", response_model=OkResponse)
def logout(request: Request):
    _clear_session(request)
    return OkResponse()
