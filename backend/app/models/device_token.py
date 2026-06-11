"""Device tokens — long-lived bearer tokens for the mobile app.

Why a separate auth path from session cookies:

  - The web UI is gated by `require_auth` (session + MFA), with the
    DEV_BYPASS_AUTH escape hatch. That covers a *browser* on the same
    machine. It does NOT cover a phone on the LAN — the phone has no
    cookie store that the laptop knows about, and we don't want phone
    requests to ride on whatever DEV_BYPASS_AUTH is set to (which
    would mean "anyone on the LAN with the URL gets full access").

  - A bearer token issued through an explicit pairing flow is per-device,
    revocable, and has no relationship to DEV_BYPASS_AUTH. The laptop
    user can run with DEV_BYPASS_AUTH=true for local browsing AND have
    the mobile app properly authenticated with a token. Two
    independent gates.

Pairing flow (see routers/mobile.py):

  1. Laptop user clicks "Pair a device" → POST /api/mobile/pair/start
     creates a row with `pairing_code` set + `pairing_expires_at` 5min
     out + `token_hash` NULL. Returns the code and host info, which
     the laptop UI renders as a QR.
  2. Phone scans the QR, posts {code, label} to /api/mobile/pair/claim.
     Backend looks up the row by pairing_code, checks expiry, generates
     a long-lived random token, hashes it, sets token_hash + label,
     clears pairing_code (so the code is single-use). Returns the
     plaintext token to the phone.
  3. Phone stores the token in iOS SecureStore. Every subsequent request
     to /api/mobile/* sends `X-Device-Token: <token>`. The backend hashes
     and looks it up; matches → authenticated, else 401.

Tokens are stored as SHA-256 hashes, never plaintext. We never need to
display a token after issuance — losing one means the phone re-pairs.
"""
import datetime
from sqlalchemy import Column, String, DateTime, Integer
from app.database import Base
from app.utils import utcnow


class DeviceToken(Base):
    __tablename__ = "device_tokens"

    id = Column(Integer, primary_key=True, autoincrement=True)
    label = Column(String, nullable=True)  # user-friendly, e.g. "iPhone (2026-05-08)"

    # Permanent bearer token, stored as SHA-256(plaintext). Plaintext is
    # only ever returned once — at /pair/claim time. Lookup uses the
    # hash so a leaked DB doesn't reveal valid tokens.
    token_hash = Column(String, unique=True, nullable=True, index=True)

    # Short-lived pairing code. Populated at /pair/start, cleared at
    # /pair/claim. Indexed because /pair/claim does an equality lookup
    # under load (rate-limit retries). NULL once the code has been
    # claimed or has expired and been swept.
    pairing_code = Column(String, unique=True, nullable=True, index=True)
    pairing_expires_at = Column(DateTime, nullable=True)

    created_at = Column(DateTime, default=utcnow)
    last_seen_at = Column(DateTime, nullable=True)
    revoked_at = Column(DateTime, nullable=True)
