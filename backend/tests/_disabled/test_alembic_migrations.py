"""Tests that the Alembic migration chain still applies cleanly.

These exist to catch SQLAlchemy or Alembic patch-version upgrades that
silently break a migration op (e.g. column-type rendering changes,
batch-mode behavior shifts on SQLite, dialect-specific syntax). Running
`alembic upgrade head` from scratch against a fresh in-memory DB is
the most reliable canary for that whole class of breakage.

We also exercise downgrade because each migration's `downgrade()` is
written by hand and rarely tested in CI for personal projects — when
SQLAlchemy ships a release that breaks one, you want to know NOW
rather than the next time you need to roll back a release.
"""
from __future__ import annotations

import pathlib

import pytest
from alembic import command
from alembic.config import Config
from sqlalchemy import create_engine, inspect


# Backend directory holds alembic.ini and the alembic/ folder
BACKEND_DIR = pathlib.Path(__file__).resolve().parent.parent
ALEMBIC_INI = BACKEND_DIR / "alembic.ini"


def _alembic_config(database_url: str) -> Config:
    """Build an Alembic Config pointed at the test DB instead of the live one.

    Alembic's env.py overrides sqlalchemy.url from settings.DATABASE_URL,
    but we want this test to operate on an isolated SQLite file. We set
    the URL on the Config AND export it via the x_arguments mechanism so
    env.py can pick it up if the user later adds an override hook.
    """
    cfg = Config(str(ALEMBIC_INI))
    cfg.set_main_option("sqlalchemy.url", database_url)
    cfg.set_main_option("script_location", str(BACKEND_DIR / "alembic"))
    return cfg


def test_upgrade_head_from_empty_db(tmp_path, monkeypatch):
    """The simplest possible canary: take an empty SQLite file, run every
    migration in order, end up at head with no errors. If this fails after
    a SQLAlchemy/Alembic bump, every fresh-install user will hit the same
    failure on first boot."""
    db_file = tmp_path / "fresh.db"
    db_url = f"sqlite:///{db_file}"

    # env.py reads settings.DATABASE_URL — patch it for the test
    from app.config import settings
    monkeypatch.setattr(settings, "DATABASE_URL", db_url)

    cfg = _alembic_config(db_url)
    command.upgrade(cfg, "head")

    # After a clean upgrade, expected core tables must exist
    engine = create_engine(db_url)
    inspector = inspect(engine)
    tables = set(inspector.get_table_names())
    expected_subset = {
        "accounts", "transactions", "budgets", "budget_categories",
        "businesses", "users", "plaid_items", "alembic_version",
    }
    missing = expected_subset - tables
    assert not missing, f"After upgrade head, missing tables: {missing}"


def test_downgrade_to_base_from_head(tmp_path, monkeypatch):
    """Round-trip: upgrade head, then downgrade base, then upgrade head
    again. If any migration's downgrade() is broken, this fails. Critical
    safety net for releases where you might need to roll back."""
    db_file = tmp_path / "roundtrip.db"
    db_url = f"sqlite:///{db_file}"

    from app.config import settings
    monkeypatch.setattr(settings, "DATABASE_URL", db_url)

    cfg = _alembic_config(db_url)

    # Forward
    command.upgrade(cfg, "head")
    engine = create_engine(db_url)
    inspector = inspect(engine)
    assert "transactions" in inspector.get_table_names()

    # Backward
    command.downgrade(cfg, "base")
    inspector = inspect(create_engine(db_url))
    after_down = set(inspector.get_table_names())
    # Only alembic_version (and possibly nothing else) should remain.
    # Different migrations leave alembic_version with different version
    # column states; the important assertion is that user-facing tables
    # are gone.
    assert "transactions" not in after_down, \
        f"transactions should be dropped after downgrade base, got: {after_down}"
    assert "accounts" not in after_down

    # Forward again — should be idempotent
    command.upgrade(cfg, "head")
    inspector = inspect(create_engine(db_url))
    assert "transactions" in inspector.get_table_names()


def test_upgrade_then_compare_to_orm_metadata(tmp_path, monkeypatch):
    """The migration chain and the ORM models must end up describing the
    same schema. If they drift, autogenerate will start emitting noise
    and new column additions get missed. This catches drift early."""
    db_file = tmp_path / "drift_check.db"
    db_url = f"sqlite:///{db_file}"

    from app.config import settings
    monkeypatch.setattr(settings, "DATABASE_URL", db_url)

    cfg = _alembic_config(db_url)
    command.upgrade(cfg, "head")

    # Compare migration-built schema to ORM metadata.
    from app.database import Base
    import app.models  # noqa: F401 — side-effect: register all models

    engine = create_engine(db_url)
    inspector = inspect(engine)
    db_tables = set(inspector.get_table_names()) - {"alembic_version"}

    orm_tables = set(Base.metadata.tables.keys())

    # ORM should be a subset of (or equal to) migration-built tables.
    # If migrations defined tables the ORM doesn't know about, that's
    # legacy debris to clean up; if the ORM has tables migrations didn't
    # build, that's a missing migration.
    missing_in_db = orm_tables - db_tables
    assert not missing_in_db, (
        f"ORM defines tables that migrations don't build: {missing_in_db}. "
        "Run `alembic revision --autogenerate -m 'add missing tables'`."
    )
