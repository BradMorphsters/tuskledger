"""Industry-agnostic config: the built-in critical-minerals domain keeps its curated ETFs/SIC
codes, but ANY new industry retargets the sector-tailwind signal and the universe screener purely
from its own research file (``meta.industry``) — no code change needed to switch industries."""
from __future__ import annotations

from app.agent_trading import themes, universe_screen


def _fake_store(monkeypatch, module, meta_industry):
    """Point the module's lazy research_store import at a fake domain with the given meta.industry."""
    import app.services.research_store as store
    monkeypatch.setattr(store, "load_domain", lambda d: {"meta": {"industry": meta_industry}})


def test_builtin_domain_uses_curated_lists():
    assert themes.proxies_for("critical-minerals") == ["URA", "REMX", "LIT", "COPX"]
    assert universe_screen.proxies_for("critical-minerals") == ["URA", "LIT", "COPX"]
    assert universe_screen.sic_for("critical-minerals") == ["1000", "1090", "1040", "2810"]


def test_new_industry_retargets_from_meta_industry(monkeypatch):
    _fake_store(monkeypatch, themes, {
        "sector_etfs": ["smh", "soxx"], "sic_codes": ["3674"]})
    # sector-tailwind proxies come from the new industry's own config (upper-cased)
    assert themes.proxies_for("ai-semis") == ["SMH", "SOXX"]
    # universe screener (Tier-1 ETFs + Tier-2 SIC) retargets too
    assert universe_screen.proxies_for("ai-semis") == ["SMH", "SOXX"]
    assert universe_screen.sic_for("ai-semis") == ["3674"]


def test_unconfigured_domain_degrades_to_empty_not_crash(monkeypatch):
    _fake_store(monkeypatch, themes, {})   # a domain with no industry config at all
    assert themes.proxies_for("brand-new") == []
    assert universe_screen.proxies_for("brand-new") == []
    assert universe_screen.sic_for("brand-new") == []
    assert themes.proxies_for(None) == []   # and no domain is safe
