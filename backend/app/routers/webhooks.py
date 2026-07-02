"""Plaid webhook receiver.

Plaid posts events to a public HTTPS URL. Because Tusk Ledger runs locally
on `http://127.0.0.1:8000`, you need a tunnel to expose this endpoint to
the public internet (options: ngrok, Cloudflare Tunnel, tailscale funnel).
Set the resulting public URL in the Plaid dashboard under
"API → Webhook URL", e.g. `https://<tunnel-host>/api/webhooks/plaid`.

Request authenticity is verified via the `Plaid-Verification` JWT header
when `PLAID_WEBHOOK_VERIFY` is enabled. In local-dev workflows you can
leave verification off and rely on the tunnel being short-lived.

This router is deliberately NOT behind session auth — it's called by
Plaid, not by the logged-in user.
"""
from __future__ import annotations

import hashlib
import json
import logging
import threading
from typing import Optional

from fastapi import APIRouter, Body, Depends, HTTPException, Request
from sqlalchemy.orm import Session

from app.config import settings
from app.database import get_db
from app.models import PlaidItem
from app.services.plaid_service import get_plaid_client
from app.services.sync_service import sync_single_item

log = logging.getLogger("fintrack.webhooks")

router = APIRouter(prefix="/api/webhooks", tags=["webhooks"])


# ─── Per-item sync serialization ────────────────────────────────
# Plaid can fire two webhooks for the same item within milliseconds
# (e.g. DEFAULT_UPDATE immediately followed by SYNC_UPDATES_AVAILABLE).
# sync_single_item reads and then advances the item's cursor; running two
# concurrently races the cursor and can drop or double-process a page.
# We serialize syncs PER ITEM with a lock so concurrent webhooks for the
# same item queue up instead of racing, while different items still sync
# in parallel. `_item_locks_guard` protects the lock registry itself.
_item_sync_locks: dict[str, threading.Lock] = {}
_item_locks_guard = threading.Lock()


def _get_item_sync_lock(item_id: str) -> threading.Lock:
    """Return the per-item sync lock, creating it on first use."""
    with _item_locks_guard:
        lock = _item_sync_locks.get(item_id)
        if lock is None:
            lock = threading.Lock()
            _item_sync_locks[item_id] = lock
        return lock


# ─── Signature verification ─────────────────────────────────────
def _verify_plaid_signature(
    body_bytes: bytes,
    verification_header: Optional[str],
) -> None:
    """Verify the Plaid-Verification JWT against the raw body.

    Plaid signs each webhook with a JWT whose payload contains a
    `request_body_sha256` claim matching a SHA-256 hex digest of the raw
    request body. We verify:

      1. The JWT signature is valid against the key ID's RSA public key
         (fetched from /webhook_verification_key/get and cached).
      2. The `iat` (issued-at) claim is within 5 minutes of now
         (rejects replays of captured webhooks).
      3. The body hash matches.

    Raises HTTPException(401) on any failure.

    NOTE: this import lazily pulls in PyJWT so the rest of the app still
    works if the user hasn't installed optional deps. If PyJWT is missing
    and verification is enabled, we refuse to process the webhook.
    """
    if not verification_header:
        raise HTTPException(401, "Missing Plaid-Verification header")

    try:
        import jwt  # PyJWT
    except ImportError:
        raise HTTPException(
            500,
            "PLAID_WEBHOOK_VERIFY is enabled but PyJWT is not installed. "
            "Either `pip install pyjwt[crypto]` or unset PLAID_WEBHOOK_VERIFY.",
        )

    # Peek at the header to extract the key ID.
    try:
        unverified_header = jwt.get_unverified_header(verification_header)
    except Exception as e:
        raise HTTPException(401, f"Malformed JWT: {e}")

    kid = unverified_header.get("kid")
    if not kid:
        raise HTTPException(401, "JWT missing kid")

    # Fetch the key via Plaid. Cached across calls via module-level dict.
    public_key_pem = _fetch_plaid_public_key(kid)

    try:
        claims = jwt.decode(
            verification_header,
            key=public_key_pem,
            algorithms=["ES256"],
            options={"require": ["iat", "request_body_sha256"]},
        )
    except Exception as e:
        raise HTTPException(401, f"Invalid webhook signature: {e}")

    import time
    iat = claims.get("iat", 0)
    if abs(time.time() - iat) > 5 * 60:
        raise HTTPException(401, "Webhook signature is outside the 5-minute freshness window")

    body_hash = hashlib.sha256(body_bytes).hexdigest()
    if body_hash != claims.get("request_body_sha256"):
        raise HTTPException(401, "Webhook body hash mismatch")


# kid -> (pem, fetched_at). TTL'd + size-capped: Plaid rotates webhook
# signing keys, and an unbounded forever-cache would (a) grow with every
# rotated-away kid and (b) keep serving a key after Plaid revokes it.
_key_cache: dict[str, tuple[str, float]] = {}
_KEY_CACHE_TTL_SECONDS = 24 * 60 * 60
_KEY_CACHE_MAX_ENTRIES = 8


def _fetch_plaid_public_key(kid: str) -> str:
    """Fetch and cache (24h TTL) the PEM-encoded public key for a JWT key id."""
    import time as _time

    cached = _key_cache.get(kid)
    if cached and _time.time() - cached[1] < _KEY_CACHE_TTL_SECONDS:
        return cached[0]

    from plaid.model.webhook_verification_key_get_request import WebhookVerificationKeyGetRequest

    client = get_plaid_client()
    req = WebhookVerificationKeyGetRequest(key_id=kid)
    resp = client.webhook_verification_key_get(req)

    # Plaid returns a JWK. Convert to PEM via `cryptography`.
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.hazmat.primitives import serialization
    import base64

    jwk = resp["key"]
    x = int.from_bytes(base64.urlsafe_b64decode(jwk["x"] + "=="), "big")
    y = int.from_bytes(base64.urlsafe_b64decode(jwk["y"] + "=="), "big")
    pub_nums = ec.EllipticCurvePublicNumbers(x, y, ec.SECP256R1())
    pub_key = pub_nums.public_key()
    pem = pub_key.public_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PublicFormat.SubjectPublicKeyInfo,
    ).decode("utf-8")

    if len(_key_cache) >= _KEY_CACHE_MAX_ENTRIES:
        # Evict the oldest entry — simple FIFO-by-fetch-time is plenty here.
        oldest = min(_key_cache, key=lambda k: _key_cache[k][1])
        _key_cache.pop(oldest, None)
    _key_cache[kid] = (pem, _time.time())
    return pem


# ─── Event dispatch ─────────────────────────────────────────────
@router.post("/plaid")
def plaid_webhook(
    request: Request,
    body_bytes: bytes = Body(default=b"", media_type="application/json"),
    db: Session = Depends(get_db),
):
    # This handler is intentionally a plain `def`, not `async def`. It calls
    # the synchronous, seconds-long sync_single_item; on the event loop that
    # would freeze every other request until the Plaid round-trips finish.
    # As a sync endpoint FastAPI runs it in its threadpool instead, so the
    # loop stays responsive. We take the raw body via `Body(bytes)` (rather
    # than `await request.body()`, which isn't available in a sync handler)
    # so signature verification still hashes the exact bytes Plaid sent.
    if settings.PLAID_WEBHOOK_VERIFY:
        _verify_plaid_signature(body_bytes, request.headers.get("Plaid-Verification"))

    try:
        payload = json.loads(body_bytes or b"{}")
    except json.JSONDecodeError:
        raise HTTPException(400, "Invalid JSON body")

    webhook_type = payload.get("webhook_type")
    webhook_code = payload.get("webhook_code")
    item_id = payload.get("item_id")
    log.info("Plaid webhook received: type=%s code=%s item_id=%s", webhook_type, webhook_code, item_id)

    if not item_id:
        # ITEM/ERROR-without-item, or test pings. Return 200 so Plaid doesn't retry.
        return {"status": "ok", "note": "no item_id; nothing to do"}

    item = db.query(PlaidItem).filter_by(item_id=item_id).first()
    if not item:
        log.warning("Plaid webhook for unknown item_id=%s — ignoring", item_id)
        return {"status": "ok", "note": "unknown item_id"}

    # Sync trigger codes. `SYNC_UPDATES_AVAILABLE` is the modern path;
    # the others are older-API codes that still arrive for some items.
    sync_trigger_codes = {
        "SYNC_UPDATES_AVAILABLE",
        "INITIAL_UPDATE",
        "HISTORICAL_UPDATE",
        "DEFAULT_UPDATE",
        "TRANSACTIONS_REMOVED",
    }

    if webhook_type == "TRANSACTIONS" and webhook_code in sync_trigger_codes:
        try:
            client = get_plaid_client()
            # Serialize concurrent syncs of the SAME item so two near-
            # simultaneous webhooks don't race the item cursor. Different
            # items still sync in parallel (separate locks). This runs in
            # FastAPI's threadpool, so blocking on the lock is fine.
            with _get_item_sync_lock(str(item_id)):
                result = sync_single_item(db, client, item)
            return {"status": "synced", "item_id": item_id, "result": result}
        except Exception as e:
            log.exception("Sync-on-webhook failed for item_id=%s", item_id)
            # Return 200 so Plaid doesn't hammer us with retries; the next
            # scheduled sync will retry on its normal cadence.
            return {"status": "error", "item_id": item_id, "error": str(e)}

    # Other events (ITEM/ERROR, ITEM/PENDING_EXPIRATION, etc.) are not
    # actioned yet — log for visibility. Future: store on PlaidItem and
    # surface a "re-auth needed" banner in the UI.
    return {"status": "ok", "note": f"no handler for {webhook_type}/{webhook_code}"}
