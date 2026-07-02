"""SQLite database backup on app startup.

Why this exists: tuskledger.db holds every manual category override, business
tag, split, manual account/asset, savings goal, and budget the user has ever
entered. None of that is recoverable from Plaid — if the file corrupts (bad
migration, disk hiccup, fat-finger `rm`), the work is gone.

Strategy:
  - On boot, copy the live DB file to backups/tuskledger-YYYY-MM-DD.db
  - Use SQLite's online backup API rather than a raw file copy so we don't
    capture a half-written page mid-WAL-checkpoint.
  - Keep the most recent N daily files; prune older ones.
  - Idempotent within a day — if today's backup already exists, skip.
  - All failures swallowed and logged. The app must boot even if disk is
    full or the backups dir is read-only — backups should never block sync.
"""
from __future__ import annotations

import datetime
import os
import sqlite3
from pathlib import Path

from app.config import settings


# Tuneables — kept in module scope rather than settings to avoid env-var
# sprawl for what's an internal hygiene concern. If someone genuinely needs
# more retention they can edit this number.
RETENTION_COUNT = 14   # keep the last N daily backups
BACKUP_DIRNAME = "backups"


def _resolve_db_path() -> Path | None:
    """Pull the SQLite file path out of DATABASE_URL.

    Only handles `sqlite:///./foo.db` style URLs. Returns None for non-SQLite
    backends — we don't want to silently no-op-then-pretend on Postgres.
    """
    url = settings.DATABASE_URL
    if not url.startswith("sqlite"):
        return None
    # sqlite:///relative/path.db  → "/relative/path.db" after split
    # sqlite:////absolute/path.db → "/absolute/path.db"
    raw = url.split("///", 1)[-1]
    return Path(raw).resolve()


def _backup_dir(db_path: Path) -> Path:
    """Backups live alongside the DB file so they share storage and follow
    the same git-ignore. Created on first call."""
    d = db_path.parent / BACKUP_DIRNAME
    d.mkdir(parents=True, exist_ok=True)
    return d


def _today_backup_path(db_path: Path) -> Path:
    today = datetime.date.today().isoformat()
    return _backup_dir(db_path) / f"{db_path.stem}-{today}.db"


def _online_backup(src: Path, dst: Path) -> None:
    """Copy a SQLite DB file using the online backup API, atomically.

    Safer than shutil.copy() because SQLite serializes pages through its
    own backup pipeline — no risk of grabbing the file mid-WAL-write and
    ending up with a torn DB on disk. Slower than file copy but for a few-MB
    personal finance DB it's instant.

    Atomicity: we write to a temp file in the same directory, fsync it, and
    then os.replace() it onto `dst`. os.replace is atomic on POSIX and
    Windows, so a crash mid-backup can never leave a partial file at `dst`.
    This matters because run_startup_backup treats an existing dst as
    "already backed up today" and skips — a torn file there would poison
    every future run until manually deleted.
    """
    # Same-directory temp so the final os.replace stays on one filesystem
    # (cross-device replace would fail / fall back to a non-atomic copy).
    tmp = dst.with_name(f"{dst.name}.tmp-{os.getpid()}")
    src_conn = sqlite3.connect(str(src))
    try:
        dst_conn = sqlite3.connect(str(tmp))
        try:
            src_conn.backup(dst_conn)
            # Flush SQLite's own buffers, then fsync the file descriptor so
            # the bytes are durably on disk before we publish via rename.
            dst_conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
            dst_conn.commit()
        finally:
            dst_conn.close()
        with open(tmp, "rb") as f:
            os.fsync(f.fileno())
        os.replace(tmp, dst)  # atomic publish
    except BaseException:
        # Clean up the partial temp on any failure so it doesn't accumulate.
        try:
            tmp.unlink()
        except OSError:
            pass
        raise
    finally:
        src_conn.close()


def _prune_old_backups(db_path: Path, keep: int) -> int:
    """Keep only the most recent `keep` backups for this DB. Returns the
    number of files pruned.

    Matches `<dbstem>-*.db` so a stray file in the backups dir (e.g. an
    older naming scheme, or a backup of a different DB) is left alone.
    """
    pattern = f"{db_path.stem}-*.db"
    files = sorted(_backup_dir(db_path).glob(pattern))  # lexical sort = chronological for ISO dates
    if len(files) <= keep:
        return 0
    to_remove = files[: len(files) - keep]
    for p in to_remove:
        try:
            p.unlink()
        except OSError:
            # Don't crash startup over a stuck file; we'll catch it next boot.
            pass
    return len(to_remove)


def run_startup_backup() -> None:
    """Make today's backup if not already present, then prune old ones.

    Wrapped so callers (lifespan startup) can fire-and-forget — every
    exception path is swallowed with a log line. Boot order is: migrations
    run first (they may modify the DB schema), THEN this — so the backup
    always reflects post-migration state, which is what you want when
    restoring (a pre-migration backup against post-migration code is
    worse than no backup).
    """
    try:
        db_path = _resolve_db_path()
        if db_path is None:
            return  # non-SQLite — skip silently
        if not db_path.exists():
            return  # fresh install, nothing to back up yet

        target = _today_backup_path(db_path)
        if target.exists():
            return  # already backed up today; idempotent

        _online_backup(db_path, target)
        pruned = _prune_old_backups(db_path, RETENTION_COUNT)

        size_kb = target.stat().st_size // 1024
        msg = f"[backup] {target.name} ({size_kb} KB)"
        if pruned:
            msg += f"; pruned {pruned} older"
        print(msg, flush=True)
    except Exception as e:
        # Backups are belt-and-suspenders. Don't take the app down because
        # disk is full or perms are off — log loudly and continue.
        print(f"[backup] FAILED: {e!r}", flush=True)
