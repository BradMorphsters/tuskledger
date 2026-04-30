"""Tests for the at-rest encryption layer.

Plaid access tokens live in SQLite as `enc:v1:<fernet>`. If the encryption
contract silently breaks (cryptography lib upgrade, key-loading regression,
prefix change), the user can't sync their accounts AND can't recover the
existing tokens — they have to relink every bank. These tests are the
loud-failure tripwire for that scenario.

The cipher is a module-level singleton in app.services.crypto, so we
reset it between tests via the _reset_cipher helper. Every test sets
FINTRACK_ENCRYPTION_KEY explicitly so we don't pollute the developer's
real .encryption_key file.
"""
from __future__ import annotations

import os
import pytest
from cryptography.fernet import Fernet

from app.services import crypto


@pytest.fixture(autouse=True)
def _reset_cipher_and_env(monkeypatch, tmp_path):
    """Reset the module-level cipher and isolate env between tests."""
    monkeypatch.delenv("FINTRACK_ENCRYPTION_KEY", raising=False)
    monkeypatch.delenv("FINTRACK_ENCRYPTION_KEY_FILE", raising=False)
    # Force the key file path into the per-test tmp dir so we don't write
    # next to the real DB if some test forgets to set FINTRACK_ENCRYPTION_KEY.
    monkeypatch.setenv("FINTRACK_ENCRYPTION_KEY_FILE", str(tmp_path / ".encryption_key"))
    crypto._cipher = None
    yield
    crypto._cipher = None


def test_round_trip_encrypts_and_decrypts():
    """The most basic guarantee: encrypt(x) → decrypt → x."""
    key = Fernet.generate_key().decode()
    os.environ["FINTRACK_ENCRYPTION_KEY"] = key
    crypto._cipher = None

    plaintext = "access-sandbox-12345-abcde"
    encrypted = crypto.encrypt_token(plaintext)
    assert encrypted != plaintext
    assert encrypted.startswith(crypto.PREFIX)
    assert crypto.decrypt_token(encrypted) == plaintext


def test_encrypt_is_idempotent():
    """Already-encrypted values pass through unchanged. Important because
    the sync service calls encrypt_token defensively on every Item before
    storing — a non-idempotent encrypt would double-wrap and break decrypt."""
    key = Fernet.generate_key().decode()
    os.environ["FINTRACK_ENCRYPTION_KEY"] = key
    crypto._cipher = None

    once = crypto.encrypt_token("plain-token")
    twice = crypto.encrypt_token(once)
    assert once == twice
    assert crypto.decrypt_token(twice) == "plain-token"


def test_decrypt_passes_through_legacy_plaintext():
    """Pre-encryption rows (no `enc:v1:` prefix) decrypt to themselves so
    the sync flow can keep working while a background migration re-encrypts.
    If this regresses, restoring an old DB backup would crash on every
    Plaid call."""
    key = Fernet.generate_key().decode()
    os.environ["FINTRACK_ENCRYPTION_KEY"] = key
    crypto._cipher = None

    legacy = "access-production-deadbeef"
    assert not crypto.is_encrypted(legacy)
    assert crypto.decrypt_token(legacy) == legacy


def test_decrypt_with_wrong_key_raises_clear_error():
    """The error message has to point at 'restore the .encryption_key file'
    or the user will think the DB itself is corrupt and try to recover via
    backup, making the problem worse."""
    key1 = Fernet.generate_key().decode()
    os.environ["FINTRACK_ENCRYPTION_KEY"] = key1
    crypto._cipher = None
    encrypted = crypto.encrypt_token("secret-token")

    # Swap to a different key — simulates restoring DB but losing key file.
    key2 = Fernet.generate_key().decode()
    os.environ["FINTRACK_ENCRYPTION_KEY"] = key2
    crypto._cipher = None

    with pytest.raises(RuntimeError) as exc:
        crypto.decrypt_token(encrypted)
    msg = str(exc.value)
    # The actionable hint is what makes the error useful.
    assert "encryption key" in msg.lower()
    assert ".encryption_key" in msg


def test_key_file_is_created_on_first_use(tmp_path, monkeypatch):
    """The auto-key-creation path is the first-run experience for every
    new user. If it breaks, fresh installs can't store any token at all."""
    key_file = tmp_path / "fresh.encryption_key"
    monkeypatch.setenv("FINTRACK_ENCRYPTION_KEY_FILE", str(key_file))
    monkeypatch.delenv("FINTRACK_ENCRYPTION_KEY", raising=False)
    crypto._cipher = None

    assert not key_file.exists()
    encrypted = crypto.encrypt_token("first-token")
    assert key_file.exists()
    assert crypto.decrypt_token(encrypted) == "first-token"


def test_key_file_persists_across_cipher_reset(tmp_path, monkeypatch):
    """The 'restart the backend' case: the key file must be re-readable
    and produce a cipher that decrypts what the prior process wrote.
    This is the property that lets your DB survive backend restarts."""
    key_file = tmp_path / "persist.encryption_key"
    monkeypatch.setenv("FINTRACK_ENCRYPTION_KEY_FILE", str(key_file))
    monkeypatch.delenv("FINTRACK_ENCRYPTION_KEY", raising=False)

    # Process 1: encrypt
    crypto._cipher = None
    encrypted = crypto.encrypt_token("persistent-token")

    # Process 2: re-initialize the cipher from disk and decrypt
    crypto._cipher = None
    assert crypto.decrypt_token(encrypted) == "persistent-token"


def test_inline_env_key_takes_precedence_over_file(tmp_path, monkeypatch):
    """FINTRACK_ENCRYPTION_KEY overriding the file is the documented
    way for ops/CI to inject a key without touching disk. If the
    precedence flips, secrets stored in CI vaults would silently get
    written to the filesystem instead."""
    key_file = tmp_path / "ignored.encryption_key"
    monkeypatch.setenv("FINTRACK_ENCRYPTION_KEY_FILE", str(key_file))

    inline_key = Fernet.generate_key().decode()
    monkeypatch.setenv("FINTRACK_ENCRYPTION_KEY", inline_key)
    crypto._cipher = None

    encrypted = crypto.encrypt_token("env-key-token")
    # Key file should NOT have been created since the env var won.
    assert not key_file.exists()
    assert crypto.decrypt_token(encrypted) == "env-key-token"


def test_none_passes_through():
    """Some callers store None when the Plaid item is in an error state.
    Encrypting None must not crash — it stays None."""
    key = Fernet.generate_key().decode()
    os.environ["FINTRACK_ENCRYPTION_KEY"] = key
    crypto._cipher = None

    assert crypto.encrypt_token(None) is None
    assert crypto.decrypt_token(None) is None


def test_prefix_format_is_stable():
    """The on-disk format string `enc:v1:` is part of the data contract.
    Changing it would invalidate every stored token without a migration.
    This test exists to make that change loud."""
    assert crypto.PREFIX == "enc:v1:"
