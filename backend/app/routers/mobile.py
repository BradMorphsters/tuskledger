"""Mobile app sync API.

Why this router is structurally different from the others:

  - Auth is via X-Device-Token header, NOT the session cookie. The
    phone has no cookie store the laptop has trusted, so each request
    carries an explicit bearer token issued through the pairing flow
    in this same module. This is independent of `require_auth` and
    DEV_BYPASS_AUTH — both can be on or off without affecting mobile.

  - Reads are cursor-based, not page-based. The phone keeps a local
    SQLite mirror; on each sync it sends the cursor it last saw
    (`?since=<iso8601>`) and we return rows whose `updated_at` is at
    or after that cursor, plus a new cursor (server time) the phone
    persists for next time. First-time sync omits the cursor → full
    table dump.

  - Deletions: in v1 we don't propagate row deletions through the
    delta endpoint — Plaid rarely deletes transactions, and the few
    that do (chargeback reversals) don't materially mislead the user
    until the next full resync. The phone exposes a "Resync from
    scratch" button in Settings that wipes its local DB and starts
    over with no cursor.

  - The phone is read-only. There are no POST/PATCH/DELETE handlers
    here for transactions or accounts. If we ever loosen the
    read-only-by-design constraint on mobile, those become explicit
    additions, not implicit because we forgot to gate them.

Pairing flow (high level):

  laptop → POST /api/mobile/pair/start  (require_auth) ──► returns code
                                                          + host info
                                                          + qr_payload
  phone  → POST /api/mobile/pair/claim  (no auth, code-gated)
                                          ──► returns long-lived token
  phone  → GET  /api/mobile/sync?since=…  (X-Device-Token)
                                          ──► JSON delta
"""
from __future__ import annotations

import datetime
import hashlib
import secrets
import socket
import time
from collections import defaultdict
from typing import Optional

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request, status
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.config import settings
from app.database import get_db, get_real_db
from app.dependencies import require_auth
from app.models import (
    Account,
    Budget,
    DeviceToken,
    Holding,
    ManualAsset,
    NetWorthSnapshot,
    Security,
    Transaction,
)
from app.utils import utcnow


router = APIRouter(prefix="/api/mobile", tags=["mobile"])


# ─── Token helpers ──────────────────────────────────────────────────────

# Avoid lookalike chars (0/O, 1/I/l) — these codes are read off a
# screen by a human if QR scanning fails.
_PAIRING_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
_PAIRING_CODE_LEN = 8
_TOKEN_BYTES = 32  # 256-bit token, base64 → 43-char string
_PAIRING_TTL_SECONDS = 300  # 5 minutes


def _generate_pairing_code() -> str:
    """Generate a fresh pairing code. Caller must ensure DB uniqueness."""
    return "".join(secrets.choice(_PAIRING_ALPHABET) for _ in range(_PAIRING_CODE_LEN))


# ─── Pair-claim brute-force protection ──────────────────────────────────
# Per-IP failed-claim tracking, modeled on auth.py's _check_lockout. The
# pairing code is high-entropy (32^8 ≈ 1T) and single-use, but a claim
# endpoint with NO rate limit still invites unbounded guessing on the LAN;
# an attacker on the same Wi-Fi could hammer /pair/claim. This caps failed
# claims per IP the same way the login flow caps failed TOTP attempts.
# In-memory, resets on restart — fine for a single-user local app.
_PAIR_MAX_FAILURES = 10
_PAIR_LOCKOUT_SECONDS = 15 * 60
_pair_failures: dict[str, list[float]] = defaultdict(list)


def _pair_client_ip(request: Request) -> str:
    return request.client.host if request.client else "unknown"


def _pair_check_lockout(request: Request) -> None:
    ip = _pair_client_ip(request)
    now = time.time()
    recent = [t for t in _pair_failures[ip] if now - t < _PAIR_LOCKOUT_SECONDS]
    _pair_failures[ip] = recent
    if len(recent) >= _PAIR_MAX_FAILURES:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Too many failed pairing attempts. Try again in 15 minutes.",
        )


def _pair_record_failure(request: Request) -> None:
    _pair_failures[_pair_client_ip(request)].append(time.time())


def _pair_record_success(request: Request) -> None:
    _pair_failures.pop(_pair_client_ip(request), None)


def _hash_token(plaintext: str) -> str:
    """One-way hash for storage / lookup.

    SHA-256 (not bcrypt) is deliberate. The token is high-entropy
    (256 bits of randomness) — adding a slow KDF would only protect
    against an attacker who already has the DB AND wants to crack a
    256-bit secret, which is not a realistic threat. Fast hashing
    keeps the per-request lookup cheap.
    """
    return hashlib.sha256(plaintext.encode("utf-8")).hexdigest()


def _detect_lan_ip() -> Optional[str]:
    """Best-effort guess at the LAN IP this machine is reachable on.

    Why this dance: socket.gethostbyname(hostname) on macOS commonly
    returns 127.0.0.1 (the loopback alias for the hostname), which is
    useless to a phone. The 'connect to 8.8.8.8' trick asks the OS
    routing table which interface would be used for outbound traffic
    and reads the local end of that hypothetical socket — that's
    almost always the LAN-facing IP, even though no packet is sent.
    Fails gracefully (None) on machines with no default route.
    """
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))
        return s.getsockname()[0]
    except OSError:
        return None
    finally:
        s.close()


# ─── Auth dependency ────────────────────────────────────────────────────

def require_device_token(
    x_device_token: Optional[str] = Header(default=None, alias="X-Device-Token"),
    db: Session = Depends(get_real_db),
) -> DeviceToken:
    """Resolve X-Device-Token to a DeviceToken row, or 401.

    Updates last_seen_at on every authenticated request. That timestamp
    drives the "Devices" page — so the user can spot stale or unknown
    pairings — and is a soft signal for revoking long-idle ones later.

    Auth ALWAYS reads from the real database (get_real_db), independent
    of the per-request fintrack_mode cookie. Reason: the demo database
    has no DeviceToken rows, so a request that legitimately wants demo
    data (Cookie: fintrack_mode=demo) would fail auth if the token
    lookup ran against demo. The downstream data endpoint can still pick
    whichever DB the cookie selects via its own get_db dependency.
    """
    if not x_device_token:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="X-Device-Token header is required for /api/mobile/*.",
        )
    token_hash = _hash_token(x_device_token)
    row = (
        db.query(DeviceToken)
        .filter(DeviceToken.token_hash == token_hash)
        .filter(DeviceToken.revoked_at.is_(None))
        .first()
    )
    if not row:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Unknown or revoked device token.",
        )
    row.last_seen_at = utcnow()
    db.commit()
    return row


# ─── Schemas ────────────────────────────────────────────────────────────

class PairStartResponse(BaseModel):
    code: str = Field(..., description="One-time pairing code, valid for 5 minutes.")
    expires_at: datetime.datetime
    host: Optional[str] = Field(
        None,
        description=(
            "Best-guess LAN IP of this laptop, for the phone to use as "
            "the API base. May be None if the OS can't determine it; "
            "in that case the phone falls back to mac.local or manual "
            "entry."
        ),
    )
    port: int
    # Single-string payload the laptop UI encodes as a QR. The phone
    # parses this in one step rather than reading the individual fields.
    # Custom URL scheme makes deep-linking from a Camera-app QR scan
    # trivial once the iOS app is installed.
    qr_payload: str
    # Server-rendered QR as a data URL the frontend can drop straight
    # into <img src=…>. Avoids pulling a JS QR library into the bundle
    # for one screen, and the existing qrcode[pil] dep is already in
    # requirements.txt for the MFA setup flow — reusing it.
    qr_data_url: str


class PairClaimRequest(BaseModel):
    code: str = Field(..., min_length=4, max_length=32)
    label: Optional[str] = Field(None, max_length=64)


class PairClaimResponse(BaseModel):
    token: str = Field(
        ...,
        description=(
            "Long-lived bearer token. Returned exactly once — store it "
            "in iOS SecureStore. If lost, re-pair the device."
        ),
    )
    label: Optional[str]
    server_time: datetime.datetime


class ManifestResponse(BaseModel):
    """Server self-description, polled by the phone after pairing.

    Lets the phone surface a friendly host name in Settings and bail
    early if it ends up pointing at a different laptop than it paired
    with (e.g. someone else on the LAN happens to be running Tusk
    Ledger on the same port — the host_id won't match the one the
    phone cached at pair time).
    """
    host_id: str
    hostname: str
    app_name: str
    server_time: datetime.datetime
    schema_version: int
    demo_available: bool = Field(
        default=False,
        description=(
            "True when the laptop has DEMO_ENABLED=true and the demo "
            "database is reachable. The phone uses this to enable/"
            "disable the 'Demo mode' toggle in Settings — no point "
            "showing it if the laptop won't honor it."
        ),
    )


class AccountOut(BaseModel):
    id: int
    name: str
    custom_name: Optional[str]
    type: str
    subtype: Optional[str]
    institution_name: Optional[str]
    mask: Optional[str]
    current_balance: Optional[float]
    available_balance: Optional[float]
    currency: Optional[str]
    updated_at: Optional[datetime.datetime]


class TransactionOut(BaseModel):
    id: int
    account_id: int
    name: str
    merchant_name: Optional[str]
    amount: float
    date: datetime.date
    pending: bool
    category: Optional[str]
    custom_category: Optional[str]
    is_transfer: bool
    notes: Optional[str]
    updated_at: Optional[datetime.datetime]


class SecurityOut(BaseModel):
    plaid_security_id: str
    ticker_symbol: Optional[str]
    name: Optional[str]
    type: Optional[str]
    close_price: Optional[float]
    close_price_as_of: Optional[datetime.datetime]
    is_cash_equivalent: bool
    updated_at: Optional[datetime.datetime]


class HoldingOut(BaseModel):
    id: int
    account_id: int
    plaid_security_id: str
    quantity: float
    institution_price: Optional[float]
    institution_value: Optional[float]
    cost_basis: Optional[float]
    iso_currency_code: Optional[str]
    updated_at: Optional[datetime.datetime]


class NetWorthSnapshotOut(BaseModel):
    id: int
    date: datetime.date
    total_assets: float
    total_liabilities: float
    net_worth: float
    created_at: Optional[datetime.datetime]


class ManualAssetOut(BaseModel):
    """A user-tracked asset OR liability that doesn't come from Plaid.

    Mirrors the laptop's `manual_assets` table — homes, vehicles, manual
    student loans, etc. The `side` field disambiguates asset vs.
    liability so the phone's net-worth math can include both halves.
    Without this, the phone's net worth was missing everything that
    isn't a Plaid-synced account, which is exactly what the user
    spotted — phone said $483k while laptop totals were higher.
    """
    id: int
    name: str
    side: str  # 'asset' | 'liability'
    type: str
    current_value: float
    value_as_of: Optional[datetime.date]
    notes: Optional[str]
    plaid_mortgage_account_id: Optional[int]
    updated_at: Optional[datetime.datetime]


class BudgetCategoryOut(BaseModel):
    id: int
    budget_id: int
    category: str
    limit_amount: float


class BudgetOut(BaseModel):
    """A monthly budget + its per-category limits, for the phone's
    read-only Budgets card. Sent in FULL on every sync (schema v3) —
    the table is tiny (months × categories), so re-sending everything
    and letting the phone wipe+reinsert is simpler and makes deletions
    propagate without tombstones. The phone computes "spent" locally
    from its transactions mirror; only the LIMITS come from here."""
    id: int
    month: int  # 1-12
    year: int
    total_limit: Optional[float]
    categories: list[BudgetCategoryOut]
    updated_at: Optional[datetime.datetime]


class SyncResponse(BaseModel):
    server_time: datetime.datetime = Field(
        ...,
        description=(
            "Cursor for the phone's NEXT sync request. The phone "
            "stores this and passes it back as ?since=<server_time> "
            "next time. Setting this to server time (not max(updated_at)) "
            "is deliberate: rows updated DURING this request are still "
            "covered next time, even if their updated_at falls between "
            "our query and our response."
        ),
    )
    full: bool = Field(
        ...,
        description=(
            "True if this was a full sync (no since cursor or "
            "?full=true). The phone uses this to know whether to wipe "
            "its local DB before applying the response."
        ),
    )
    accounts: list[AccountOut]
    transactions: list[TransactionOut]
    securities: list[SecurityOut] = Field(
        default_factory=list,
        description=(
            "Reference data for holdings. Phones with schema_version<2 "
            "can ignore. Pulled in full on a full sync; on incrementals, "
            "rows whose updated_at >= since (close_price refreshes are "
            "frequent enough that this is meaningful)."
        ),
    )
    holdings: list[HoldingOut] = Field(
        default_factory=list,
        description=(
            "Investment positions. Same cursor semantics as transactions. "
            "Holdings that disappear server-side (sold, transferred out) "
            "are NOT propagated by the delta endpoint in v1 — phones "
            "running 'Resync from scratch' get the truth."
        ),
    )
    net_worth_snapshots: list[NetWorthSnapshotOut] = Field(
        default_factory=list,
        description=(
            "Daily net-worth snapshots. Filtered by created_at >= since. "
            "First sync pulls the last 365 days only — older history is "
            "not phone-relevant and would bloat the local DB. The phone "
            "uses these for the Net Worth sparkline."
        ),
    )
    manual_assets: list[ManualAssetOut] = Field(
        default_factory=list,
        description=(
            "User-tracked assets and manual liabilities (homes, "
            "vehicles, etc.). The phone needs these to compute net "
            "worth correctly — Plaid accounts alone miss this whole "
            "side of the balance sheet."
        ),
    )
    budgets: list[BudgetOut] = Field(
        default_factory=list,
        description=(
            "Monthly budgets with per-category limits (schema_version "
            ">= 3). ALWAYS the complete set — not cursor-filtered — so "
            "the phone wipes + reinserts its budget tables each sync "
            "and laptop-side deletions propagate. Phones with "
            "schema_version < 3 ignore this field."
        ),
    )
    has_more: bool = Field(
        False,
        description=(
            "True if the transaction page hit the limit and the phone "
            "should immediately call again with ?since=<earliest "
            "updated_at returned>. v1 doesn't paginate accounts (count "
            "is small) so has_more only ever reflects transactions."
        ),
    )


# ─── Pairing endpoints ──────────────────────────────────────────────────

@router.post(
    "/pair/start",
    response_model=PairStartResponse,
    dependencies=[Depends(require_auth)],
)
def pair_start(
    request: Request,
    db: Session = Depends(get_db),
):
    """Generate a single-use pairing code.

    Auth: laptop session (or DEV_BYPASS_AUTH if the operator runs
    without login). The phone is NOT authenticated yet — that's what
    this whole flow is bootstrapping.

    Stores a row with token_hash NULL + pairing_code set + 5-minute
    expiry. The corresponding /pair/claim call:
      - Looks up by code
      - Verifies expiry hasn't passed
      - Generates the real token, sets token_hash, clears the code
    """
    # Retry on the rare uniqueness collision (alphabet has 32^8 ≈ 1
    # trillion codes, so this should basically never fire — but it's
    # cheap insurance against a bug that recycles codes).
    for _attempt in range(5):
        code = _generate_pairing_code()
        existing = db.query(DeviceToken).filter(DeviceToken.pairing_code == code).first()
        if existing is None:
            break
    else:
        raise HTTPException(500, "Could not allocate pairing code; try again.")

    now = utcnow()
    expires_at = now + datetime.timedelta(seconds=_PAIRING_TTL_SECONDS)

    row = DeviceToken(
        pairing_code=code,
        pairing_expires_at=expires_at,
        created_at=now,
    )
    db.add(row)
    db.commit()
    db.refresh(row)

    host = _detect_lan_ip()
    # Honor TUSKLEDGER_PUBLIC_HOST if set — overrides auto-detection
    # for cases where the phone reaches the laptop via a non-default
    # interface (e.g. travel router, Tailscale, etc.).
    import os
    host = os.environ.get("TUSKLEDGER_PUBLIC_HOST") or host

    port = int(os.environ.get("TUSKLEDGER_PORT", "8000"))

    # Compact QR payload. The custom scheme makes this a deep link
    # (the iOS app registers tuskledger:// in its Info.plist), so a
    # successful camera scan can launch and pre-fill claim args.
    qr_payload = f"tuskledger://pair?host={host or ''}&port={port}&code={code}"

    # Render the QR server-side so the laptop UI just shows an <img>.
    # Box-size 6 keeps the PNG roughly 200×200 px — large enough to
    # scan from a phone held a foot away from the laptop screen.
    import base64
    import io
    import qrcode
    img = qrcode.make(qr_payload, box_size=6, border=2)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    qr_data_url = "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode("ascii")

    return PairStartResponse(
        code=code,
        expires_at=expires_at,
        host=host,
        port=port,
        qr_payload=qr_payload,
        qr_data_url=qr_data_url,
    )


@router.post("/pair/claim", response_model=PairClaimResponse)
def pair_claim(
    body: PairClaimRequest,
    request: Request,
    db: Session = Depends(get_db),
):
    """Trade a pairing code for a long-lived device token.

    No auth required by design — the code IS the auth. The code is
    high-entropy (32^8 ≈ 1T values), single-use, and expires in 5
    minutes. On a LAN, brute force is not a realistic threat — but we
    still rate-limit failed claims per IP (see _pair_check_lockout) so a
    same-network attacker can't hammer the endpoint unbounded.

    Single-use is enforced by clearing pairing_code as part of the
    claim. A second claim with the same code will 404.
    """
    # Throttle first: reject the request before touching the DB if this
    # IP has already burned through its failed-claim budget.
    _pair_check_lockout(request)
    code = body.code.strip().upper()
    row = (
        db.query(DeviceToken)
        .filter(DeviceToken.pairing_code == code)
        .filter(DeviceToken.token_hash.is_(None))
        .first()
    )
    if not row:
        # Same 404 for both 'never existed' and 'already claimed' so
        # an attacker can't distinguish "wrong code" from "right code,
        # too late" by the response.
        _pair_record_failure(request)
        raise HTTPException(404, "Pairing code not found or already claimed.")
    now = utcnow()
    if row.pairing_expires_at and row.pairing_expires_at < now:
        # Don't leak the row — drop it so the unique index doesn't
        # block a future code with the same value.
        db.delete(row)
        db.commit()
        # An expired-but-correct code isn't a brute-force signal, but the
        # attacker can't tell it apart from a miss anyway; count it toward
        # the budget to keep the guessing cost uniform.
        _pair_record_failure(request)
        raise HTTPException(410, "Pairing code expired. Generate a fresh one on the laptop.")

    plaintext = secrets.token_urlsafe(_TOKEN_BYTES)
    row.token_hash = _hash_token(plaintext)
    row.label = body.label
    row.pairing_code = None
    row.pairing_expires_at = None
    row.last_seen_at = now
    db.commit()

    # Successful claim clears this IP's failure counter.
    _pair_record_success(request)
    return PairClaimResponse(
        token=plaintext,
        label=row.label,
        server_time=now,
    )


# ─── Authenticated mobile endpoints ─────────────────────────────────────

@router.get("/manifest", response_model=ManifestResponse)
def manifest(
    device: DeviceToken = Depends(require_device_token),
):
    """Server self-description. Cheap, no DB I/O beyond the auth check.

    Phone polls this on launch to confirm "yes, the host I cached is
    still my paired Tusk Ledger laptop, not someone else who happens
    to occupy the same IP today."
    """
    # host_id is derived from SESSION_SECRET + a stable suffix so it
    # changes if the user rotates their session secret (a clear "this
    # is now a different installation" signal) but not on every boot.
    host_id = hashlib.sha256(
        f"{settings.SESSION_SECRET}:tuskledger-host".encode()
    ).hexdigest()[:16]
    return ManifestResponse(
        host_id=host_id,
        hostname=socket.gethostname(),
        app_name=settings.APP_NAME,
        server_time=utcnow(),
        # 2 = adds securities + holdings + net_worth_snapshots to /sync.
        # 3 = adds budgets (full set each sync, not cursor-filtered).
        # Older phone clients ignore the new fields safely; their
        # SyncResponse type just doesn't reference them.
        schema_version=3,
        demo_available=bool(settings.DEMO_ENABLED),
    )


@router.get("/sync", response_model=SyncResponse)
def sync(
    since: Optional[datetime.datetime] = Query(
        None,
        description=(
            "ISO8601 cursor from the phone's previous sync response. "
            "Omit on first sync (or to force a full pull)."
        ),
    ),
    full: bool = Query(
        False,
        description=(
            "Force a full sync regardless of the since cursor. The "
            "phone exposes this as 'Resync from scratch' in Settings — "
            "useful after schema changes or to recover from a broken "
            "local DB."
        ),
    ),
    transaction_limit: int = Query(2000, ge=1, le=5000),
    device: DeviceToken = Depends(require_device_token),
    db: Session = Depends(get_db),
):
    """Cursor-based delta of accounts + transactions.

    Cursor semantics:
      - Server records the response timestamp BEFORE issuing the SELECT
        and returns it as `server_time`. The phone passes that back as
        `since` next time. This avoids the race where a row is updated
        between our SELECT's snapshot and our response — the next sync
        re-reads it as a (cheap) duplicate, which is fine because the
        phone upserts.

      - Rows are filtered by `updated_at >= since`. Equality is
        deliberate — running back-to-back syncs at sub-second
        granularity could otherwise drop a row whose updated_at exactly
        matches the cursor.

    Pagination:
      - Accounts: not paginated. Even maximalists have <100 accounts.
      - Transactions: limit + has_more flag. The phone follows up with
        another sync using the most-recent updated_at it received.

    Read-only by design: this endpoint does no writes other than the
    last_seen_at bump in `require_device_token`.
    """
    is_full = full or since is None
    server_time = utcnow()

    accounts_q = db.query(Account)
    transactions_q = db.query(Transaction).order_by(Transaction.updated_at.asc())
    securities_q = db.query(Security)
    holdings_q = db.query(Holding)
    manual_assets_q = db.query(ManualAsset)
    # Net-worth snapshots are append-only — created_at is what we filter
    # on. On a full sync we cap to the last 365 days because everything
    # older is past the phone's UI horizon and would bloat the mirror.
    snapshot_q = db.query(NetWorthSnapshot).order_by(NetWorthSnapshot.date.asc())

    if not is_full and since is not None:
        accounts_q = accounts_q.filter(Account.updated_at >= since)
        transactions_q = transactions_q.filter(Transaction.updated_at >= since)
        securities_q = securities_q.filter(Security.updated_at >= since)
        holdings_q = holdings_q.filter(Holding.updated_at >= since)
        manual_assets_q = manual_assets_q.filter(ManualAsset.updated_at >= since)
        snapshot_q = snapshot_q.filter(NetWorthSnapshot.created_at >= since)
    else:
        # Full sync: cap snapshot history at 365 days.
        cutoff = datetime.date.today() - datetime.timedelta(days=365)
        snapshot_q = snapshot_q.filter(NetWorthSnapshot.date >= cutoff)

    accounts = accounts_q.all()
    securities = securities_q.all()
    holdings = holdings_q.all()
    manual_assets = manual_assets_q.all()
    snapshots = snapshot_q.all()
    # Budgets: always the complete set (tiny table; wipe+reinsert on the
    # phone means laptop-side deletions propagate without tombstones).
    budgets = (
        db.query(Budget)
        .order_by(Budget.year.desc(), Budget.month.desc())
        .all()
    )

    txn_rows = transactions_q.limit(transaction_limit + 1).all()
    has_more = len(txn_rows) > transaction_limit
    if has_more:
        txn_rows = txn_rows[:transaction_limit]

    return SyncResponse(
        server_time=server_time,
        full=is_full,
        accounts=[
            AccountOut(
                id=a.id,
                name=a.name,
                custom_name=a.custom_name,
                type=a.type,
                subtype=a.subtype,
                institution_name=a.institution_name,
                mask=a.mask,
                current_balance=a.current_balance,
                available_balance=a.available_balance,
                currency=a.currency,
                updated_at=a.updated_at,
            )
            for a in accounts
        ],
        transactions=[
            TransactionOut(
                id=t.id,
                account_id=t.account_id,
                name=t.name,
                merchant_name=t.merchant_name,
                amount=t.amount,
                date=t.date,
                pending=bool(t.pending),
                category=t.category,
                custom_category=t.custom_category,
                is_transfer=bool(t.is_transfer),
                notes=t.notes,
                updated_at=t.updated_at,
            )
            for t in txn_rows
        ],
        securities=[
            SecurityOut(
                plaid_security_id=s.plaid_security_id,
                ticker_symbol=s.ticker_symbol,
                name=s.name,
                type=s.type,
                close_price=s.close_price,
                close_price_as_of=s.close_price_as_of,
                is_cash_equivalent=bool(s.is_cash_equivalent),
                updated_at=s.updated_at,
            )
            for s in securities
        ],
        holdings=[
            HoldingOut(
                id=h.id,
                account_id=h.account_id,
                plaid_security_id=h.plaid_security_id,
                quantity=h.quantity,
                institution_price=h.institution_price,
                institution_value=h.institution_value,
                cost_basis=h.cost_basis,
                iso_currency_code=h.iso_currency_code,
                updated_at=h.updated_at,
            )
            for h in holdings
        ],
        net_worth_snapshots=[
            NetWorthSnapshotOut(
                id=n.id,
                date=n.date,
                total_assets=n.total_assets,
                total_liabilities=n.total_liabilities,
                net_worth=n.net_worth,
                created_at=n.created_at,
            )
            for n in snapshots
        ],
        manual_assets=[
            ManualAssetOut(
                id=m.id,
                name=m.name,
                side=m.side,
                type=m.type,
                current_value=m.current_value,
                value_as_of=m.value_as_of,
                notes=m.notes,
                plaid_mortgage_account_id=m.plaid_mortgage_account_id,
                updated_at=m.updated_at,
            )
            for m in manual_assets
        ],
        budgets=[
            BudgetOut(
                id=b.id,
                month=b.month,
                year=b.year,
                total_limit=b.total_limit,
                categories=[
                    BudgetCategoryOut(
                        id=c.id,
                        budget_id=c.budget_id,
                        category=c.category,
                        limit_amount=c.limit_amount,
                    )
                    for c in b.categories
                ],
                updated_at=b.updated_at,
            )
            for b in budgets
        ],
        has_more=has_more,
    )


# ─── Device management (laptop UI) ──────────────────────────────────────

class DeviceOut(BaseModel):
    id: int
    label: Optional[str]
    created_at: Optional[datetime.datetime]
    last_seen_at: Optional[datetime.datetime]
    revoked: bool


@router.get(
    "/devices",
    response_model=list[DeviceOut],
    dependencies=[Depends(require_auth)],
)
def list_devices(db: Session = Depends(get_db)):
    """List paired devices for the laptop UI.

    Excludes rows that are pending pairing (token_hash NULL) — those
    are codes that haven't been claimed yet, surfaced separately if
    the UI ever wants them.
    """
    rows = (
        db.query(DeviceToken)
        .filter(DeviceToken.token_hash.isnot(None))
        .order_by(DeviceToken.created_at.desc())
        .all()
    )
    return [
        DeviceOut(
            id=r.id,
            label=r.label,
            created_at=r.created_at,
            last_seen_at=r.last_seen_at,
            revoked=r.revoked_at is not None,
        )
        for r in rows
    ]


@router.post(
    "/devices/{device_id}/revoke",
    dependencies=[Depends(require_auth)],
)
def revoke_device(device_id: int, db: Session = Depends(get_db)):
    """Mark a device's token as revoked. Subsequent /api/mobile/* calls
    from that token return 401. Phone reacts by clearing local state
    and prompting the user to re-pair.
    """
    row = db.query(DeviceToken).filter(DeviceToken.id == device_id).first()
    if not row:
        raise HTTPException(404, "Device not found.")
    if row.revoked_at is None:
        row.revoked_at = utcnow()
        db.commit()
    return {"status": "revoked", "id": row.id}
