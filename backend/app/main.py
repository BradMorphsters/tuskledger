"""Tusk Ledger — Personal Finance Dashboard API."""
from __future__ import annotations

from contextlib import asynccontextmanager
from fastapi import Depends, FastAPI, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
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
    chat,
    view,
    mobile,
)


def scheduled_sync():
    """Background job to auto-sync all Plaid items."""
    from app.services.sync_service import sync_all_items
    db = SessionLocal()
    try:
        sync_all_items(db)
    finally:
        db.close()


def _detect_listen_host() -> str | None:
    """Best-effort read of the host this uvicorn process is bound to.

    Used by the DEV_BYPASS_AUTH startup guard — if auth is bypassed,
    the app must not be reachable from outside the machine. We can't
    introspect uvicorn's actual socket from inside lifespan() (the
    socket isn't bound yet at that point), so we fall back to the
    canonical sources in priority order:

      1. UVICORN_HOST env var (set by some launchers)
      2. HOST env var (Railway / generic)
      3. ./start.sh-style hint variable, if any
      4. None — caller treats this as "unknown, don't crash"

    Returning None on uncertainty is deliberate: a startup-time crash
    on a false positive (e.g. some launcher we haven't seen) would be
    worse than letting the loud DEV_BYPASS_AUTH banner do its job.
    """
    for var in ("UVICORN_HOST", "HOST", "TUSKLEDGER_HOST"):
        value = os.environ.get(var)
        if value:
            return value.strip()
    return None


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
    # Skip on the public demo instance — the demo DB is disposable, and
    # backups would just churn disk on a free-tier host.
    if not settings.DEMO_LOCKED:
        run_startup_backup()
    _ensure_demo_db_seeded()
    if settings.DEMO_LOCKED:
        # Loud banner so the operator can never confuse a normal install
        # with a demo deployment in logs. Mirrors the DEV_BYPASS_AUTH
        # banner pattern below.
        print(
            "\n"
            "============================================================\n"
            "  📣 DEMO_LOCKED is ON — this instance is a public demo.\n"
            "     • Every request is forced onto the demo database.\n"
            "     • Read-only middleware blocks every mutating request\n"
            "       outside the auth/view/demo-mode allowlist.\n"
            "     • Plaid sync scheduler will not start.\n"
            "     • Auto-backup is disabled.\n"
            "     If you see this in logs for an instance that holds\n"
            "     real user data, unset DEMO_LOCKED in the environment.\n"
            "============================================================\n",
            flush=True,
        )
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
        # Refuse to boot if DEV_BYPASS_AUTH is paired with a non-localhost
        # bind. The check looks at the host uvicorn was launched with —
        # the documented launchers (./start.sh, Tusk Ledger.command) bind
        # to 127.0.0.1, so this only fires if someone deliberately
        # exposes the port without flipping the auth flag back on. Better
        # to crash loud at startup than to serve a no-auth API on a
        # routable interface.
        #
        # EXCEPTION: when DEMO_LOCKED is also true, the guard stands down.
        # On the public demo instance the read-only middleware (gates every
        # mutation) IS the security boundary, not auth — there's no real
        # user data to protect, the only DB is the synthetic Alex-Carter
        # demo. Auth in front of a read-only synthetic dataset would be a
        # nuisance, not a protection. The demo is deliberately bound to
        # 0.0.0.0 so Railway can reach it.
        #
        # SECOND EXCEPTION: when LAN_SYNC_ENABLED is true, the user has
        # deliberately enabled mobile sync over their home Wi-Fi. The
        # mobile API has its own device-token auth (see routers/mobile.py)
        # that doesn't depend on DEV_BYPASS_AUTH. The web UI on the LAN
        # is the same trust boundary as the desktop browser session in
        # this configuration — explicit user choice, on a network they
        # control. Crashing here would block the feature from ever
        # working, which is the opposite of what we want.
        if not settings.DEMO_LOCKED and not settings.LAN_SYNC_ENABLED:
            host = _detect_listen_host()
            if host and host not in ("127.0.0.1", "localhost", "::1"):
                raise RuntimeError(
                    f"DEV_BYPASS_AUTH is enabled but the server is bound to "
                    f"{host!r}, which is reachable from outside this machine. "
                    "Refusing to start. Either bind to 127.0.0.1 (the default), "
                    "set LAN_SYNC_ENABLED=true if you intend to expose this "
                    "to your home Wi-Fi for the mobile app, or set "
                    "DEV_BYPASS_AUTH=false in .env."
                )

    # Production-Plaid + un-verified webhooks is a forged-event hazard if
    # the webhook endpoint ever gets exposed (tunnel, port-forward, etc.).
    # We don't crash here because most local-only installs never expose
    # the webhook endpoint to the public internet, so verification is
    # moot for them — but a loud warning at every startup makes the
    # maintainer aware before they tunnel for the first time.
    if settings.PLAID_ENV == "production" and not settings.PLAID_WEBHOOK_VERIFY:
        print(
            "\n"
            "============================================================\n"
            "  ⚠  PLAID_ENV=production with PLAID_WEBHOOK_VERIFY=false.\n"
            "     Safe while the webhook endpoint isn't reachable from\n"
            "     outside this machine. The MOMENT you set up a tunnel\n"
            "     (ngrok, cloudflared, port-forward, deployed host),\n"
            "     enable verification:\n"
            "         PLAID_WEBHOOK_VERIFY=true  in backend/.env\n"
            "     Otherwise anyone who can reach /api/plaid/webhook can\n"
            "     forge events (TRANSACTIONS_SYNCED, ITEM_LOGIN_REQUIRED,\n"
            "     etc.) and trigger re-link / sync flows.\n"
            "============================================================\n",
            flush=True,
        )
    # Plaid auto-sync scheduler. Skipped on the public demo deployment —
    # the demo DB is a snapshot of synthetic data; pulling Plaid against
    # it would be both pointless (no real items) and an attack surface
    # (someone supplying their own PLAID_CLIENT_ID env var to a hosted
    # demo could cause unexpected outbound calls).
    if settings.PLAID_CLIENT_ID and not settings.DEMO_LOCKED:
        scheduler.add_job(
            scheduled_sync,
            "interval",
            hours=settings.SYNC_INTERVAL_HOURS,
            id="plaid_sync",
        )
        scheduler.start()

    # Bonjour / mDNS advertisement for the mobile app's auto-discovery.
    # Only meaningful on a LAN bind, and the user has to opt in explicitly
    # via LAN_SYNC_ENABLED. Failures are non-fatal — the phone can still
    # pair via QR, which embeds the host directly.
    if settings.LAN_SYNC_ENABLED and not settings.DEMO_LOCKED:
        from app.services.bonjour import start as bonjour_start
        bonjour_start()

    yield
    # Shutdown
    if scheduler.running:
        scheduler.shutdown()
    if settings.LAN_SYNC_ENABLED and not settings.DEMO_LOCKED:
        from app.services.bonjour import stop as bonjour_stop
        bonjour_stop()


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

# CORS — allow the React dev server. Origins, methods, and headers
# are all explicitly enumerated rather than wildcarded; the React
# dev server only needs the standard CRUD verbs and Content-Type +
# Authorization headers, so a tighter allow-list is just hygiene.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://localhost:5173", "http://127.0.0.1:3000"],
    # Allow LAN-IP origins (e.g. http://192.168.1.42:3000) so a phone
    # on the same wifi can reach the dev server at the Mac's LAN IP.
    # The regex is intentionally narrow: only RFC1918 private ranges
    # (10/8, 172.16/12, 192.168/16) on the dev ports. Public IPs and
    # arbitrary hostnames don't match — if you ever expose Tusk Ledger
    # on the public internet (Cloudflare Tunnel etc.), the upstream
    # already does origin checking and the request reaches FastAPI as
    # 127.0.0.1 anyway.
    allow_origin_regex=r"http://(10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}):(3000|5173)",
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["Content-Type", "Authorization", "X-Requested-With", "X-Device-Token"],
)


# ─── Read-only mode middleware ────────────────────────────────────────
#
# When the `tuskledger_view` cookie is set to "readonly", every mutating
# HTTP method (POST/PUT/PATCH/DELETE) returns 403 — except for a tiny
# allow-list of endpoints needed to flip the mode itself off (so the
# user can't lock themselves out of their own laptop) and a few endpoints
# that aren't really "user mutations" (auth login, mode toggles).
#
# Why a cookie instead of a config file: a cookie is per-device. The
# user's phone gets the cookie set once (via /api/view/readonly or by
# loading the app with ?view=readonly), and then every request from
# that phone is gated. The laptop browser never sets the cookie, so
# it stays fully editable. No redeploy needed to switch a device's mode.
#
# Why a middleware instead of per-route Depends: every mutating endpoint
# would need the dependency added explicitly, and a forgotten import
# would silently leave a write surface open. A middleware blocks the
# whole class with one ~20-line check; new endpoints inherit it for free.
#
# This is layered on TOP of require_auth — read-only is a UX gate, not
# an auth gate. An unauthenticated request still gets bounced first.
_READ_METHODS = {"GET", "HEAD", "OPTIONS"}
_MUTATION_ALLOWLIST_PREFIXES = (
    "/api/auth/login",   # needed to authenticate
    "/api/auth/logout",  # needed to de-authenticate
    # NOTE: /api/auth/setup/* is deliberately NOT allowlisted — first-run
    # setup happens on the laptop, never on a read-only device or the
    # public demo (where it would let visitors create a user + TOTP secret).
    "/api/view/",        # the mode toggle itself — can't lock-out paradox
    "/api/demo/mode",    # demo-mode toggle — same reason
)


@app.middleware("http")
async def read_only_gate(request: Request, call_next):
    """If the request comes from a device flagged as read-only AND is
    a mutating method AND isn't on the small allow-list, 403 it before
    it ever reaches a route handler.

    Two paths into "device is read-only":
      1. The per-device cookie `tuskledger_view=readonly` (normal
         phone-installed-PWA case).
      2. The instance-wide env var `DEMO_LOCKED=true` (public demo
         deployment — visitors can't unset env vars, so this is the
         hard lock).
    """
    if request.method not in _READ_METHODS:
        is_readonly_device = (
            settings.DEMO_LOCKED
            or request.cookies.get("tuskledger_view") == "readonly"
        )
        if is_readonly_device:
            path = request.url.path
            if not any(path.startswith(p) for p in _MUTATION_ALLOWLIST_PREFIXES):
                return JSONResponse(
                    status_code=403,
                    content={
                        "detail": (
                            "This instance is read-only. "
                            "Mutations are disabled here."
                            if settings.DEMO_LOCKED else
                            "This device is in read-only mode. Edits "
                            "happen on your laptop. To make changes "
                            "from here, switch to edit mode at "
                            "/api/view/edit (or load the app with "
                            "?view=edit)."
                        ),
                        "code": "read_only_mode",
                    },
                )
    return await call_next(request)

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
# View-mode router: read-only ↔ edit toggle per device. Unprotected for
# the same reason as demo — a phone in read-only mode needs to be able
# to flip back even if its session has expired. Setting the cookie does
# not grant data access; it only changes how the read-only middleware
# treats future requests from this device.
app.include_router(view.router)
# Mobile router: handles its own auth via X-Device-Token (see
# routers/mobile.py). Mounted unprotected at the router level — each
# endpoint inside picks the right gate (require_auth for laptop-side
# pairing/management, require_device_token for the phone's data calls).
app.include_router(mobile.router)

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
# Curated AI chat — pre-built prompts answered with pre-computed numbers
# + local Ollama narration. Same protection as data routers since the
# bundles read transactions, snapshots, and account balances.
app.include_router(chat.router, dependencies=protected)


@app.get("/api/health")
def health():
    # Lightweight liveness probe. Doesn't touch the DB so it stays green
    # even while migrations are running on startup.
    return {"status": "ok", "app": settings.APP_NAME}


# Serve the React build in production
frontend_build = os.path.join(os.path.dirname(__file__), "..", "..", "frontend", "dist")
if os.path.isdir(frontend_build):
    app.mount("/", StaticFiles(directory=frontend_build, html=True), name="frontend")
