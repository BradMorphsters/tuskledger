"""Demo-mode-only routes — switch which database the UI is talking to,
and wipe + re-seed the synthetic dataset on demand.

The mode toggle works via a `fintrack_mode` cookie set on the response of
`/api/demo/mode`. From that point forward, every request the browser makes
carries the cookie, and `app.database.get_db` reads it to pick which
SQLAlchemy engine to yield a session against.

`/api/demo/refresh` is special: it always uses `get_demo_db` (regardless of
the request's mode) so a wrong cookie value can't accidentally wipe the
real database. That's the single safety check between this endpoint and
data loss — DO NOT remove it.
"""
from __future__ import annotations

import time

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.config import settings
from app.database import get_demo_db, demo_engine, DemoSessionLocal, Base
from app.scripts.seed_demo import seed_database

router = APIRouter(prefix="/api/demo", tags=["demo"])


class ModeRequest(BaseModel):
    mode: str  # "real" or "demo"


def _require_demo_enabled() -> None:
    """Refuse demo-related routes when the feature is globally turned off."""
    if not settings.DEMO_ENABLED:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Demo mode is disabled (DEMO_ENABLED=false).",
        )


@router.post("/mode")
def set_mode(body: ModeRequest, response: Response):
    """Switch the current request's session between the real and demo
    databases. Sets a long-lived `fintrack_mode` cookie that future
    requests read to pick which DB engine to talk to.
    """
    _require_demo_enabled()
    if body.mode not in ("real", "demo"):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="mode must be 'real' or 'demo'",
        )
    # 30 days — the cookie is just a UI preference, not a security boundary.
    response.set_cookie(
        key="fintrack_mode",
        value=body.mode,
        max_age=60 * 60 * 24 * 30,
        httponly=False,         # frontend may want to read it for display
        samesite="lax",
        secure=False,           # local-only app served over http
    )
    return {"status": "ok", "mode": body.mode}


# drop_all + create_all + reseed is expensive; on the public demo this
# endpoint is reachable unauthenticated, so throttle it to one refresh
# per minute to keep it from being a free DoS lever.
_REFRESH_MIN_INTERVAL_SECONDS = 60
_last_refresh_at: float = 0.0


@router.post("/refresh")
def refresh_demo():
    """Drop and recreate the demo DB schema, then re-seed with a fresh
    synthetic dataset. Re-anchors transaction dates to today so the demo
    never feels stale.

    Why drop_all + create_all (not just wipe rows): Alembic migrations
    only run against the real DB. When a migration adds a column or
    table to the production schema, the demo DB doesn't get it on its
    own — and any new INSERT referencing that column fails with
    'no such column'. Rebuilding the schema from current models on
    every refresh keeps the demo DB structurally in sync without
    needing a separate migration pass.

    Safety: this only ever talks to `demo_engine` / `DemoSessionLocal`,
    never the real engine — even with a misconfigured request cookie,
    real data can't be touched here.
    """
    global _last_refresh_at
    _require_demo_enabled()
    now = time.time()
    if now - _last_refresh_at < _REFRESH_MIN_INTERVAL_SECONDS:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Demo was refreshed recently. Try again in a minute.",
        )
    _last_refresh_at = now
    if demo_engine is None or DemoSessionLocal is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Demo engine is not initialized.",
        )
    # 1) Schema rebuild — drops every table the ORM knows about and
    #    recreates them from current Base.metadata. Picks up any
    #    columns/tables added since the demo DB was first created.
    Base.metadata.drop_all(bind=demo_engine)
    Base.metadata.create_all(bind=demo_engine)
    # 2) Fresh session against the just-rebuilt schema.
    db = DemoSessionLocal()
    try:
        summary = seed_database(db)
    finally:
        db.close()
    return {"status": "ok", **summary}
