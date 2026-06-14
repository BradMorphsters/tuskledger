"""Tests for the free SEC EDGAR filing-activity service (no network)."""
from __future__ import annotations

import datetime

from app.services import sec_edgar as edgar

TODAY = datetime.date(2026, 6, 13)


def _recent():
    # newest-first parallel arrays, mirroring filings.recent from EDGAR
    return {
        "form": ["8-K", "4", "4", "424B5", "4", "10-Q"],
        "filingDate": [
            "2026-06-10",  # 8-K  — recent event
            "2026-06-01",  # 4    — recent insider
            "2026-05-20",  # 4    — recent insider
            "2026-05-15",  # 424B5 — recent capital raise
            "2026-02-01",  # 4    — prior 90d window
            "2025-11-01",  # 10-Q — old
        ],
        "accessionNumber": ["a1", "a2", "a3", "a4", "a5", "a6"],
        "primaryDocument": ["d1", "d2", "d3", "d4", "d5", "d6"],
    }


def test_aggregate_counts_windows():
    agg = edgar.aggregate(_recent(), TODAY)
    assert agg["insider_filings_90d"] == 2        # 06-01, 05-20
    assert agg["insider_filings_prior_90d"] == 1  # 02-01 (within prior 90d)
    assert agg["insider_trend"] == "up"
    assert agg["events_8k_90d"] == 1
    assert agg["capital_raises_90d"] == 1
    assert agg["latest_filing"] == {"form": "8-K", "date": "2026-06-10"}


def test_aggregate_empty():
    agg = edgar.aggregate({}, TODAY)
    assert agg["insider_filings_90d"] == 0 and agg["events_8k_90d"] == 0
    assert agg["latest_filing"] is None


def test_fetch_activity_no_cik(monkeypatch):
    monkeypatch.setattr(edgar, "cik_for", lambda t: None)
    out = edgar.fetch_activity("ZZZZ", today=TODAY)
    assert out["available"] is False and out["reason"] == "no CIK for ticker"


def test_fetch_activity_with_mocked_get(monkeypatch):
    monkeypatch.setattr(edgar, "cik_for", lambda t: "0000123456")

    def fake_get(url, host):
        assert "0000123456" in url
        return ({"name": "Test Co", "filings": {"recent": _recent()}}, None)

    monkeypatch.setattr(edgar, "_get", fake_get)
    out = edgar.fetch_activity("USAR", today=TODAY)
    assert out["available"] is True and out["company"] == "Test Co"
    assert out["cik"] == "0000123456"
    assert out["insider_filings_90d"] == 2 and out["capital_raises_90d"] == 1
    assert out["source"] == "sec_edgar"


def test_fetch_activity_http_error(monkeypatch):
    monkeypatch.setattr(edgar, "cik_for", lambda t: "0000123456")
    monkeypatch.setattr(edgar, "_get", lambda url, host: (None, "http 404"))
    out = edgar.fetch_activity("USAR", today=TODAY)
    assert out["available"] is False and out["reason"] == "http 404"


def test_ticker_cik_map_parses_and_caches(tmp_path, monkeypatch):
    from app.config import settings
    monkeypatch.setattr(settings, "RESEARCH_DIR", str(tmp_path))
    edgar._CIK.update(map=None, ts=0.0)
    sample = {
        "0": {"cik_str": 320193, "ticker": "AAPL", "title": "Apple Inc."},
        "1": {"cik_str": 1090727, "ticker": "USAR", "title": "US Rare Earth"},
    }
    calls = {"n": 0}

    def fake_get(url, host):
        calls["n"] += 1
        return (sample, None)

    monkeypatch.setattr(edgar, "_get", fake_get)
    m = edgar._ticker_cik_map(force=True)
    assert m["AAPL"] == "0000320193" and m["USAR"] == "0001090727"
    assert edgar.cik_for("usar") == "0001090727"   # case-insensitive
    # in-process cache → no second network call
    edgar._ticker_cik_map()
    assert calls["n"] == 1
