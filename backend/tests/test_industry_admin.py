"""Tests for in-app industry admin: runtime switching + create (no network)."""
from __future__ import annotations

from pathlib import Path

import pytest
from fastapi import HTTPException

from app.config import settings
from app.routers import research as R
from app.services import research_store as store

SCHEMA = Path(__file__).resolve().parents[2] / "research" / "research.schema.json"


@pytest.fixture()
def env(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "RESEARCH_DIR", str(tmp_path))
    monkeypatch.setattr(settings, "ACTIVE_RESEARCH_DOMAIN", "")
    (tmp_path / "research.schema.json").write_text(SCHEMA.read_text(encoding="utf-8"), encoding="utf-8")
    return tmp_path


def test_create_industry_and_switch(env):
    r1 = R.create_industry(R.CreateIndustryIn(
        domain="retail", label="retail", benchmark="XRT", sector_etfs=["xrt", "RTH"]))
    assert r1["domain"] == "retail" and r1["active"] is True
    assert store.get_active_domain() == "retail"

    doc = store.load_domain("retail")
    assert doc["meta"]["industry"]["benchmark"] == "XRT"
    assert doc["meta"]["industry"]["sector_etfs"] == ["XRT", "RTH"]  # upper-cased
    assert doc["entities"] == []                                     # empty universe to fill

    # A second industry created without activating leaves the active one alone.
    R.create_industry(R.CreateIndustryIn(domain="defense", label="defense", activate=False))
    assert store.get_active_domain() == "retail"

    # Switch focus at runtime.
    assert R.set_active_industry(R.SetActiveIn(domain="defense"))["domain"] == "defense"
    assert store.get_active_domain() == "defense"

    # Duplicate create rejected.
    with pytest.raises(HTTPException):
        R.create_industry(R.CreateIndustryIn(domain="retail"))


def test_set_active_unknown_rejected(env):
    with pytest.raises(HTTPException):
        R.set_active_industry(R.SetActiveIn(domain="nope"))


def test_domains_sorts_active_first(env):
    R.create_industry(R.CreateIndustryIn(domain="alpha", activate=False))
    R.create_industry(R.CreateIndustryIn(domain="zeta", activate=True))  # active
    rows = R.list_research_domains()
    assert rows[0]["domain"] == "zeta" and rows[0]["active"] is True


def test_active_falls_back_to_env(env, monkeypatch):
    R.create_industry(R.CreateIndustryIn(domain="alpha", activate=False))
    # No runtime file written for the active pointer → env fallback applies.
    store.active_domain_path().unlink(missing_ok=True)
    monkeypatch.setattr(settings, "ACTIVE_RESEARCH_DOMAIN", "alpha")
    assert store.get_active_domain() == "alpha"
    monkeypatch.setattr(settings, "ACTIVE_RESEARCH_DOMAIN", "ghost")  # not on disk
    assert store.get_active_domain() is None
