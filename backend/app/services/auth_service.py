"""Authentication service: password hashing, TOTP, and QR code generation."""
from __future__ import annotations

import base64
import hashlib
import hmac
import io
import secrets
from typing import Optional

import bcrypt
import pyotp
import qrcode
from sqlalchemy.orm import Session

from app.models import User


TOTP_ISSUER = "Tusk Ledger"


# bcrypt has a hard 72-byte password limit, and bcrypt>=4 raises rather than
# silently truncating. We pre-hash the password with SHA-256 (deterministic,
# 32 bytes → 44 base64 bytes, well under the limit), then feed the result to
# bcrypt. This is the standard "bcrypt-sha256" construction, implemented
# directly to avoid passlib's stale bcrypt-version diagnostics.
def _prehash(password: str) -> bytes:
    digest = hashlib.sha256(password.encode("utf-8")).digest()
    return base64.b64encode(digest)  # 44 bytes, URL-safe alphabet


def hash_password(password: str) -> str:
    """One-way hash a plaintext password using SHA-256 + bcrypt."""
    hashed = bcrypt.hashpw(_prehash(password), bcrypt.gensalt(rounds=12))
    return hashed.decode("ascii")


def verify_password(password: str, hashed: str) -> bool:
    """Constant-time compare of a plaintext password against a stored hash."""
    try:
        return bcrypt.checkpw(_prehash(password), hashed.encode("ascii"))
    except Exception:
        return False


def generate_totp_secret() -> str:
    """Generate a new base32 TOTP shared secret."""
    return pyotp.random_base32()


def totp_uri(secret: str, username: str) -> str:
    """Build the otpauth:// provisioning URI for authenticator apps."""
    return pyotp.TOTP(secret).provisioning_uri(name=username, issuer_name=TOTP_ISSUER)


def qr_code_data_url(uri: str) -> str:
    """Render an otpauth URI as a base64-encoded PNG data URL."""
    img = qrcode.make(uri)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    b64 = base64.b64encode(buf.getvalue()).decode("ascii")
    return f"data:image/png;base64,{b64}"


def verify_totp(secret: str, code: str) -> bool:
    """Verify a 6-digit TOTP code against the shared secret, with +/- 1 step skew."""
    if not code or not secret:
        return False
    code = code.strip().replace(" ", "").replace("-", "")
    if not code.isdigit():
        return False
    return pyotp.TOTP(secret).verify(code, valid_window=1)


def get_user(db: Session) -> Optional[User]:
    """Return the single Tusk Ledger user if one exists, else None."""
    return db.query(User).first()


def generate_session_secret() -> str:
    """Generate a cryptographically-strong random value for SessionMiddleware."""
    return secrets.token_urlsafe(64)
