"""Tests for the signals router bulk-refresh rate-limit resilience (no network)."""
from __future__ import annotations

from app.routers import signals as S


def test_refresh_preserves_good_data_on_transient_failure(monkeypatch):
    monkeypatch.setattr(S.quiver, "has_key", lambda: True)
    monkeypatch.setattr(S.time, "sleep", lambda *_a, **_k: None)

    entities = [{"ticker": "AAA"}, {"ticker": "BBB"}, {"ticker": "CCC"}]
    monkeypatch.setattr(S.store, "load_domain", lambda d: {"entities": entities})

    # AAA + BBB previously pulled cleanly; CCC never had data.
    existing = {
        "AAA": {"available": True, "offexchange": {"dpi_recent": 0.5}, "_ts": 1},
        "BBB": {"available": True, "offexchange": {"dpi_recent": 0.4}, "_ts": 1},
    }
    monkeypatch.setattr(S.store, "load_signals", lambda d: dict(existing))
    saved: dict = {}
    monkeypatch.setattr(S.store, "save_signals", lambda d, c: saved.update(c))

    # This pass: AAA succeeds fresh; BBB rate-limited; CCC unavailable (no prior).
    def fake_signals_for(tk):
        if tk == "AAA":
            return {"available": True, "offexchange": {"dpi_recent": 0.55}}
        return {"available": False, "reason": "rate limited"}

    monkeypatch.setattr(S.quiver, "signals_for", fake_signals_for)

    out = S.signals_refresh("critical-minerals")
    assert out["refreshed"] == 1
    assert out["kept_stale"] == ["BBB"]   # preserved, not clobbered
    assert out["failed"] == ["CCC"]       # no prior good data to keep
    # BBB keeps its good DPI and is flagged stale (transient miss didn't wipe it).
    assert saved["BBB"]["available"] is True and saved["BBB"]["stale"] is True
    assert saved["BBB"]["offexchange"]["dpi_recent"] == 0.4
    # AAA updated to the fresh value.
    assert saved["AAA"]["offexchange"]["dpi_recent"] == 0.55
    # CCC stored as unavailable.
    assert saved["CCC"]["available"] is False
