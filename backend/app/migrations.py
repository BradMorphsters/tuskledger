"""Migration bootstrap.

Runs Alembic upgrades on startup. Handles three cases:

1. Fresh install (DB file does not exist or is empty): apply every migration
   from the beginning.
2. Pre-Alembic install (tables exist but no `alembic_version` table): stamp
   the baseline revision so subsequent migrations apply cleanly without
   trying to re-create tables that already exist.
3. Normal: apply any pending migrations beyond the current revision.
"""
from __future__ import annotations

import os
from pathlib import Path

from alembic import command
from alembic.config import Config
from sqlalchemy import inspect

from app.database import engine

BASELINE_REVISION = "0001"


def _alembic_config() -> Config:
    backend_root = Path(__file__).resolve().parent.parent
    cfg = Config(str(backend_root / "alembic.ini"))
    # Make the script location absolute so it works regardless of cwd
    cfg.set_main_option("script_location", str(backend_root / "alembic"))
    return cfg


def run_startup_migrations() -> None:
    """Bring the live DB up to head, stamping the baseline for pre-Alembic DBs."""
    insp = inspect(engine)
    table_names = set(insp.get_table_names())
    has_data_tables = any(
        t in table_names for t in ("plaid_items", "accounts", "transactions", "users")
    )
    has_alembic_table = "alembic_version" in table_names

    cfg = _alembic_config()

    if has_data_tables and not has_alembic_table:
        # Pre-Alembic install: stamp baseline, then upgrade to head.
        command.stamp(cfg, BASELINE_REVISION)

    command.upgrade(cfg, "head")
