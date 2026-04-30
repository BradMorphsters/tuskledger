"""Unit tests for db_backup.

These exercise the pure helpers (no monkeypatching of settings needed) plus
one end-to-end test that creates a tiny SQLite file, runs the backup, and
asserts the artifact is valid SQLite that can be queried.
"""
import datetime
import sqlite3
from pathlib import Path

import pytest

from app.services import db_backup


def _make_tiny_db(path: Path) -> None:
    """Create a minimal SQLite DB with a single row so we can sanity-check
    that the restore round-trips actual data, not just a 0-byte file."""
    conn = sqlite3.connect(str(path))
    conn.execute("CREATE TABLE t (k TEXT, v INTEGER)")
    conn.execute("INSERT INTO t (k, v) VALUES ('hello', 42)")
    conn.commit()
    conn.close()


def test_online_backup_round_trips_data(tmp_path):
    """The online-backup API should produce a file that opens and yields the
    same data we put in. Catches the worst failure mode: backup files exist
    on disk but are corrupt."""
    src = tmp_path / "live.db"
    dst = tmp_path / "copy.db"
    _make_tiny_db(src)

    db_backup._online_backup(src, dst)

    assert dst.exists()
    conn = sqlite3.connect(str(dst))
    try:
        rows = conn.execute("SELECT k, v FROM t").fetchall()
    finally:
        conn.close()
    assert rows == [("hello", 42)]


def test_prune_keeps_most_recent(tmp_path):
    """Older files (lexically earlier ISO dates) should be removed first;
    newer files should survive."""
    db_path = tmp_path / "tuskledger.db"
    db_path.touch()  # _backup_dir() doesn't care if the source exists

    backup_dir = db_backup._backup_dir(db_path)
    # 5 dated copies, oldest first
    dates = [
        "2026-04-20", "2026-04-21", "2026-04-22", "2026-04-23", "2026-04-24",
    ]
    for d in dates:
        (backup_dir / f"{db_path.stem}-{d}.db").touch()

    pruned = db_backup._prune_old_backups(db_path, keep=3)

    assert pruned == 2
    surviving = sorted(p.name for p in backup_dir.iterdir())
    assert surviving == [
        "tuskledger-2026-04-22.db",
        "tuskledger-2026-04-23.db",
        "tuskledger-2026-04-24.db",
    ]


def test_prune_no_op_below_threshold(tmp_path):
    """If there are fewer files than `keep`, nothing should be removed."""
    db_path = tmp_path / "tuskledger.db"
    db_path.touch()
    backup_dir = db_backup._backup_dir(db_path)
    (backup_dir / "tuskledger-2026-04-20.db").touch()
    (backup_dir / "tuskledger-2026-04-21.db").touch()

    pruned = db_backup._prune_old_backups(db_path, keep=14)

    assert pruned == 0
    assert len(list(backup_dir.iterdir())) == 2


def test_prune_ignores_unrelated_files(tmp_path):
    """A file that doesn't match `<dbstem>-*.db` (e.g. a backup of a
    different DB, or a stray note) must not be deleted."""
    db_path = tmp_path / "tuskledger.db"
    db_path.touch()
    backup_dir = db_backup._backup_dir(db_path)
    # Stale backup of a different db — should be left alone.
    (backup_dir / "other-2026-04-20.db").touch()
    (backup_dir / "tuskledger-2026-04-20.db").touch()
    (backup_dir / "tuskledger-2026-04-21.db").touch()
    (backup_dir / "tuskledger-2026-04-22.db").touch()

    pruned = db_backup._prune_old_backups(db_path, keep=1)

    assert pruned == 2
    assert (backup_dir / "other-2026-04-20.db").exists()
    assert (backup_dir / "tuskledger-2026-04-22.db").exists()


def test_run_startup_backup_idempotent(tmp_path, monkeypatch):
    """Calling run_startup_backup twice in the same day should produce only
    one backup file — re-running on every uvicorn reload during dev would
    otherwise pile up identical copies."""
    src = tmp_path / "tuskledger.db"
    _make_tiny_db(src)
    monkeypatch.setattr(db_backup, "_resolve_db_path", lambda: src)

    db_backup.run_startup_backup()
    db_backup.run_startup_backup()

    today = datetime.date.today().isoformat()
    expected = src.parent / db_backup.BACKUP_DIRNAME / f"tuskledger-{today}.db"
    assert expected.exists()
    # Only one file, even though we called twice.
    assert len(list((src.parent / db_backup.BACKUP_DIRNAME).iterdir())) == 1


def test_run_startup_backup_skips_when_db_missing(tmp_path, monkeypatch):
    """Fresh install: no DB file yet. Backup should silently no-op rather
    than creating an empty file or raising."""
    monkeypatch.setattr(db_backup, "_resolve_db_path", lambda: tmp_path / "nope.db")

    db_backup.run_startup_backup()  # must not raise

    backup_dir = tmp_path / db_backup.BACKUP_DIRNAME
    # Either dir doesn't exist or it's empty — both fine.
    assert not backup_dir.exists() or list(backup_dir.iterdir()) == []
