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


def _key_path() -> Path:
    override = os.environ.get("FINTRACK_ENCRYPTION_KEY_FILE")
    if override:
        return Path(override)
    # Default: alongside the working directory's DB file.
    # The backend is launched from the backend/ folder, where tuskledger.db lives.
    return Path.cwd() / _DEFAULT_KEY_FILENAME


def _load_or_create_key() -> bytes:
    inline = os.environ.get("FINTRACK_ENCRYPTION_KEY")
    if inline:
        return inline.encode("utf-8") if isinstance(inline, str) else inline

    path = _key_path()
    if path.exists():
        return path.read_bytes().strip()

    key = Fernet.generate_key()
    path.write_bytes(key)
    try:
        # chmod 600 — owner-only read/write. No-op on Windows.
        path.chmod(stat.S_IRUSR | stat.S_IWUSR)
    except (OSError, NotImplementedError):
        pass
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
