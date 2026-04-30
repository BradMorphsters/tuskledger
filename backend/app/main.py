"""Tusk Ledger — Personal Finance Dashboard API."""
from __future__ import annotations

from contextlib import asynccontextmanager
from fastapi import Depends, FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from starlette.middleware.sessions import SessionMiddleware
from apscheduler.schedulers.background import BackgroundScheduler
import os

from pathlib import Path

from app.database import engine, Base, SessionLocal, demo_engine, DemoSessionLocal
from app.config import settings
from app.dependencies import require_auth
from app.migrations import run_startup_migrations
from app.services.auth_service import generate_session_secret
from app.services.db_backup import run_startup_backup
from app.routers import (
    plaid_routes,
    accounts,
    transactions,
    budgets,
    net_worth,
    analytics,
    retirement,
    business,
    business_rules,
    subscription_rules,
    csv_import,
    auth,
    webhooks,
    investments,
    manual_assets,
    bills,
    demo,
    goals,
    loans,
)


def scheduled_sync():
    """Background job to auto-sync all Plaid items."""
    from app.services.sync_service import sync_all_items
    db = SessionLocal()
    try:
        sync_all_items(db)
    finally:
        db.close()


scheduler = BackgroundScheduler()


def _ensure_demo_db_seeded() -> None:
    """Make sure the demo DB exists AND has the current schema.

    Two cases handled:
      1. File doesn't exist → create + seed.
      2. File exists but is missing columns/tables we now expect (because
         a migration added them after this demo file was first created)
         → drop + recreate + re-seed.

    Case (2) is what makes 'restart the backend' a self-healing workflow
    after schema changes. Without it, an old demo file from before a
    migration would silently stay broken until the user hits the Refresh
    button.
    """
    if not settings.DEMO_ENABLED or DemoSessionLocal is None or demo_engine is None:
        return
    # Resolve path from the engine URL. Works for sqlite:///./foo.db.
    url = str(demo_engine.url)
    if not url.startswith("sqlite"):
        return  # bail on non-SQLite — manual setup required
    db_file_str = url.split("///", 1)[-1]
    db_path = Path(db_file_str).resolve()

    needs_seed = False
    if not db_path.exists():
        needs_seed = True
        print(f"\n[demo] {db_path} doesn't exist — seeding fresh dataset…", flush=True)
    else:
        # Schema-drift check: scan every table the ORM knows about and
        # compare its columns against what's actually in the file. If
        # anything's missing, the demo DB predates a migration and we
        # need to rebuild from current models.
        from sqlalchemy import inspect
        try:
            insp = inspect(demo_engine)
            existing_tables = set(insp.get_table_names())
            for table in Base.metadata.sorted_tables:
                if table.name not in existing_tables:
                    needs_seed = True
                    print(f"\n[demo] table '{table.name}' missing — rebuilding demo DB.", flush=True)
                    break
                cols_in_db = {c["name"] for c in insp.get_columns(table.name)}
                missing = {c.name for c in table.columns} - cols_in_db
                if missing:
                    needs_seed = True
                    print(f"\n[demo] table '{table.name}' missing columns {missing} — rebuilding demo DB.", flush=True)
                    break
        except Exception as e:  # noqa: BLE001
            # If introspection itself throws, safer to rebuild than leave
            # the user with a broken demo. Logged so it's noticeable.
            print(f"\n[demo] schema check failed ({e!r}) — rebuilding demo DB.", flush=True)
            needs_seed = True

    if not needs_seed:
        return

    # Drop + recreate so columns added by recent migrations get applied,
    # then seed. Idempotent — running twice produces the same result.
    Base.metadata.drop_all(bind=demo_engine)
    Base.metadata.create_all(bind=demo_engine)
    from app.scripts.seed_demo import seed_database
    db = DemoSessionLocal()
    try:
        seed_database(db)
        print("[demo] seed complete", flush=True)
    finally:
        db.close()


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup: run Alembic migrations (handles both fresh installs and
    # pre-Alembic DBs via baseline-stamp). Schema changes now flow through
    # alembic/versions/ — do NOT call Base.metadata.create_all() here.
    run_startup_migrations()
    # Snapshot the (post-migration) DB to backups/ so a corrupt write or
    # bad migration is recoverable. Idempotent within a day.
    run_startup_backup()
    _ensure_demo_db_seeded()
    if settings.DEV_BYPASS_AUTH:
        # Loud banner so this is impossible to miss in logs. If you ever see
        # this in a log that isn't your local dev machine, something is wrong.
        print(
            "\n"
            "============================================================\n"
            "  ⚠  DEV_BYPASS_AUTH is ON — login page is disabled.\n"
            "     Every request is treated as authenticated.\n"
            "     Unset DEV_BYPASS_AUTH in .env to restore login + MFA.\n"
            "============================================================\n",
            flush=True,
        )
    if settings.PLAID_CLIENT_ID:
        scheduler.add_job(
            scheduled_sync,
            "interval",
            hours=settings.SYNC_INTERVAL_HOURS,
            id="plaid_sync",
        )
        scheduler.start()
    yield
    # Shutdown
    if scheduler.running:
        scheduler.shutdown()


app = FastAPI(title=settings.APP_NAME, lifespan=lifespan)

# Session middleware — required for login/MFA.
# SESSION_SECRET may be configured in .env for persistent sessions across
# backend restarts; if absent, a fresh secret is generated at startup
# (which invalidates all prior sessions on restart — fine for a local app).
session_secret = settings.SESSION_SECRET or generate_session_secret()
app.add_middleware(
    SessionMiddleware,
    secret_key=session_secret,
    session_cookie="fintrack_session",
    same_site="lax",
    https_only=False,  # local-only app served over http://127.0.0.1
    # max_age omitted: cookie expires when the browser session ends
)

# CORS — allow the React dev server
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://localhost:5173", "http://127.0.0.1:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Auth router is unprotected (login/setup must be reachable pre-auth).
app.include_router(auth.router)
# Webhook router is also unprotected — it's called by Plaid, not the user.
# Authenticity is enforced inside the handler via the Plaid-Verification JWT
# (when PLAID_WEBHOOK_VERIFY is enabled).
app.include_router(webhooks.router)
# Demo router is unprotected so the mode toggle is reachable from pre-auth
# screens. Each route inside the router does its own DEMO_ENABLED check;
# /api/demo/refresh always operates on the demo session via get_demo_db,
# so a stray request can't touch real data.
app.include_router(demo.router)

# All data-bearing routers require an authenticated session with MFA verified.
protected = [Depends(require_auth)]
app.include_router(plaid_routes.router, dependencies=protected)
app.include_router(accounts.router, dependencies=protected)
app.include_router(transactions.router, dependencies=protected)
app.include_router(budgets.router, dependencies=protected)
app.include_router(net_worth.router, dependencies=protected)
app.include_router(analytics.router, dependencies=protected)
app.include_router(retirement.router, dependencies=protected)
app.include_router(business.router, dependencies=protected)
app.include_router(business_rules.router, dependencies=protected)
app.include_router(subscription_rules.router, dependencies=protected)
app.include_router(investments.router, dependencies=protected)
app.include_router(manual_assets.router, dependencies=protected)
app.include_router(bills.router, dependencies=protected)
app.include_router(goals.router, dependencies=protected)
app.include_router(csv_import.router, dependencies=protected)
app.include_router(loans.router, dependencies=protected)


@app.get("/api/health")
def health():
    # Lightweight liveness probe. Doesn't touch the DB so it stays green
    # even while migrations are running on startup.
    return {"status": "ok", "app": settings.APP_NAME}


# Serve the React build in production
frontend_build = os.path.join(os.path.dirname(__file__), "..", "..", "frontend", "dist")
if os.path.isdir(frontend_build):
    app.mount("/", StaticFiles(directory=frontend_build, html=True), name="frontend")
