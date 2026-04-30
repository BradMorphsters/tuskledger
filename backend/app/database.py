"""SQLAlchemy plumbing — two engines (real + demo) with per-request routing.

Most of the app touches the database through the `get_db` dependency, which
reads the `fintrack_mode` cookie on the incoming request and yields a session
against the matching engine. That's how a user can flip between real and
demo data without restarting the backend.

Background work (the APScheduler-driven Plaid sync) doesn't have a request
context, so it always uses the real session via `RealSessionLocal`.

`SessionLocal` (the legacy module-level alias) points at the real engine so
existing imports keep working.
"""
from __future__ import annotations

from typing import Optional

from fastapi import Request
from sqlalchemy import create_engine
from sqlalchemy.orm import declarative_base, sessionmaker

from app.config import settings


Base = declarative_base()


def _make_engine(url: str):
    return create_engine(
        url,
        connect_args={"check_same_thread": False},  # SQLite-specific
    )


# ─── Real database (always present) ───────────────────────────────────
real_engine = _make_engine(settings.DATABASE_URL)
RealSessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=real_engine)

# ─── Demo database (optional) ─────────────────────────────────────────
demo_engine = None
DemoSessionLocal: Optional[sessionmaker] = None
if settings.DEMO_ENABLED:
    demo_engine = _make_engine(settings.DEMO_DATABASE_URL)
    DemoSessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=demo_engine)


# ─── Backward-compat alias ────────────────────────────────────────────
# Pre-toggle code expected `SessionLocal` to be the one engine. Keep the
# name as an alias for the real engine so background jobs and any direct
# importers continue to work.
engine = real_engine
SessionLocal = RealSessionLocal


# ─── Request-scoped DB selection ──────────────────────────────────────
def _is_demo_request(request: Optional[Request]) -> bool:
    """Returns True if this request should hit the demo database.

    Selection rules:
      - Demo must be globally enabled (`DEMO_ENABLED=true`)
      - The request must carry a `fintrack_mode=demo` cookie
    """
    if not settings.DEMO_ENABLED or DemoSessionLocal is None:
        return False
    if request is None:
        return False
    return request.cookies.get("fintrack_mode") == "demo"


def get_db(request: Request):
    """FastAPI dependency yielding a session against the right database.

    Reads the `fintrack_mode` cookie. Defaults to the real database if the
    cookie is missing, set to `real`, or demo mode is disabled globally.
    """
    factory = DemoSessionLocal if _is_demo_request(request) else RealSessionLocal
    db = factory()
    try:
        yield db
    finally:
        db.close()


def get_real_db():
    """Yield a session against the real DB, ignoring the request cookie.

    Use this for routes that must always operate on real data (e.g. the
    auth setup flow, where bouncing between modes during login would be
    nonsensical) and for non-request callers like the background scheduler.
    """
    db = RealSessionLocal()
    try:
        yield db
    finally:
        db.close()


def get_demo_db():
    """Yield a session against the demo DB, ignoring the request cookie.

    Use this for routes that must always operate on demo data — namely
    `/api/demo/refresh`, where a wrong cookie value could otherwise cause
    a real-DB wipe. Returns None if demo mode is globally disabled.
    """
    if DemoSessionLocal is None:
        raise RuntimeError("Demo database is not enabled (DEMO_ENABLED=false).")
    db = DemoSessionLocal()
    try:
        yield db
    finally:
        db.close()
