"""Encryption for Plaid access tokens at rest.

Tokens are stored in SQLite as `enc:v1:<urlsafe-base64-fernet-token>`. If
someone grabs just the `tuskledger.db` file they still cannot call Plaid
without also obtaining the key file.

Key lifecycle:
- Key is a 32-byte urlsafe-base64 value (Fernet format).
- Stored in a sibling file next to the DB, default path `.encryption_key`.
  The path can be overridden via the FINTRACK_ENCRYPTION_KEY_FILE env var.
- If the key file is missing on first call, a fresh key is generated and
  written (chmod 600 on POSIX systems).
- If an explicit key is set in FINTRACK_ENCRYPTION_KEY, that value takes
  precedence over the file — useful for CI/tests and for users who prefer
  to keep the key in a password manager rather than on disk.

Format: the stored value always starts with `enc:v1:` so legacy plaintext
tokens (pre-encryption) can be detected and migrated on next access.
"""
from __future__ import annotations

import os
import stat
from pathlib import Path

from cryptography.fernet import Fernet, InvalidToken

PREFIX = "enc:v1:"
_DEFAULT_KEY_FILENAME = ".encryption_key"

# Backend root = .../backend (this file is backend/app/services/crypto.py).
# We anchor the key file HERE rather than to Path.cwd(): launching uvicorn
# from a different working directory used to make cwd-relative resolution
# generate a BRAND-NEW key, after which every stored Plaid token failed to
# decrypt (the key that wrote them was in the old cwd). Anchoring to the
# module location makes the key path stable regardless of where the
# process is started from.
_BACKEND_ROOT = Path(__file__).resolve().parents[2]


def _key_path() -> Path:
    override = os.environ.get("FINTRACK_ENCRYPTION_KEY_FILE")
    if override:
        return Path(override)
    # Default: anchored to the backend root (where tuskledger.db lives),
    # NOT Path.cwd(). See _BACKEND_ROOT above.
    return _BACKEND_ROOT / _DEFAULT_KEY_FILENAME


def _legacy_cwd_key_path() -> Path:
    """The pre-fix location: the process's current working directory. Kept
    so we can MIGRATE an existing key written under the old scheme instead
    of silently minting a new one and orphaning every encrypted token."""
    return Path.cwd() / _DEFAULT_KEY_FILENAME


def _write_key(path: Path, key: bytes) -> None:
    path.write_bytes(key)
    try:
        # chmod 600 — owner-only read/write. No-op on Windows.
        path.chmod(stat.S_IRUSR | stat.S_IWUSR)
    except (OSError, NotImplementedError):
        pass


def _load_or_create_key() -> bytes:
    inline = os.environ.get("FINTRACK_ENCRYPTION_KEY")
    if inline:
        return inline.encode("utf-8") if isinstance(inline, str) else inline

    path = _key_path()
    if path.exists():
        return path.read_bytes().strip()

    # Anchored key is missing. Before generating a fresh one, check the
    # legacy cwd-relative location: if a key exists there (written before
    # this anchoring fix, or by a run started from backend/), MIGRATE it to
    # the anchored path so previously-encrypted tokens keep decrypting.
    # NEVER silently generate a new key when a legacy key exists — that
    # would permanently orphan every stored Plaid access token.
    legacy = _legacy_cwd_key_path()
    if legacy.exists() and legacy.resolve() != path.resolve():
        key = legacy.read_bytes().strip()
        try:
            _write_key(path, key)  # copy forward to the stable location
        except OSError:
            # Couldn't write the anchored copy (read-only mount, etc.) —
            # still use the legacy key so decryption works this run.
            pass
        return key

    key = Fernet.generate_key()
    _write_key(path, key)
    return key


_cipher: Fernet | None = None


def _get_cipher() -> Fernet:
    global _cipher
    if _cipher is None:
        _cipher = Fernet(_load_or_create_key())
    return _cipher


def is_encrypted(value: str | None) -> bool:
    return isinstance(value, str) and value.startswith(PREFIX)


def encrypt_token(plaintext: str) -> str:
    """Encrypt a token. Idempotent — already-encrypted values pass through."""
    if plaintext is None:
        return plaintext
    if is_encrypted(plaintext):
        return plaintext
    token = _get_cipher().encrypt(plaintext.encode("utf-8")).decode("utf-8")
    return f"{PREFIX}{token}"


def decrypt_token(stored: str | None) -> str | None:
    """Decrypt a stored token. Returns the input unchanged if it's plaintext
    (legacy pre-encryption row) so the caller can proceed while a background
    migration re-encrypts it."""
    if stored is None:
        return None
    if not is_encrypted(stored):
        return stored
    payload = stored[len(PREFIX):].encode("utf-8")
    try:
        return _get_cipher().decrypt(payload).decode("utf-8")
    except InvalidToken as e:
        raise RuntimeError(
            "Failed to decrypt Plaid access token — the encryption key does "
            "not match the key used to write this row. If you restored the "
            "DB from backup, restore the matching .encryption_key file too."
        ) from e
