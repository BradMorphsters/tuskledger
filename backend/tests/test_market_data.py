"""Tests for the Yahoo market-data service + the prices endpoint (no network)."""
from __future__ import annotations

from app.config import settings
from app.services import market_data as md
from app.routers import research as R

# 2024-07, 2024-08, 2026-06 (unix month-start timestamps), with a current price.
SAMPLE = {
    "chart": {
        "result": [
            {
                "meta": {"currency": "USD", "symbol": "MP", "regularMarketPrice": 57.55},
                "timestamp": [1719806400, 1722484800, 1780286400],
                "indicators": {"quote": [{"close": [13.520000457, 12.9, 57.549999237]}]},
            }
        ],
        "error": None,
    }
}


def test_parse_chart():
    p = md.parse_chart(SAMPLE)
    assert p["currency"] == "USD" and p["current"] == 57.55
    assert p["history"][0]["as_of"] == "2024-07" and p["history"][0]["close"] == 13.52
    assert p["history"][-1]["as_of"] == "2026-06" and p["history"][-1]["close"] == 57.55


def test_parse_chart_skips_null_closes():
    data = {"chart": {"result": [{"meta": {"currency": "USD", "regularMarketPrice": 10.0},
            "timestamp": [1719806400, 1722484800],
            "indicators": {"quote": [{"close": [None, 10.0]}]}}], "error": None}}
    p = md.parse_chart(data)
    assert len(p["history"]) == 1 and p["history"][0]["close"] == 10.0


def test_to_yahoo_symbol():
    assert md.to_yahoo_symbol("mp") == "MP"
    assert md.to_yahoo_symbol(" usar ") == "USAR"
    assert md.to_yahoo_symbol("BRK.B") == "BRK-B"


def test_fetch_prices_yahoo_fallback(monkeypatch):
    monkeypatch.setattr(settings, "MARKETDATA_API_KEY", "")  # no key → Yahoo path
    monkeypatch.setattr(md, "_fetch_json", lambda *a, **k: (SAMPLE, None))
    out = md.fetch_prices("MP", months=6)
    assert out["source"] == "yahoo" and out["symbol"] == "MP"
    assert out["current"] == 57.55
    assert out["history"][-1]["as_of"] == "2026-06" and out["history"][-1]["close"] == 57.55


def test_fetch_prices_none_on_no_data(monkeypatch):
    monkeypatch.setattr(settings, "MARKETDATA_API_KEY", "")
    monkeypatch.setattr(md, "_fetch_json", lambda *a, **k: (None, "http 404"))
    assert md.fetch_prices("ZZZZ") is None


TD_SAMPLE = {
    "status": "ok",
    "meta": {"symbol": "MP", "currency": "USD"},
    "values": [  # Twelve Data returns newest-first
        {"datetime": "2026-06-01", "close": "57.55"},
        {"datetime": "2026-05-01", "close": "64.70"},
        {"datetime": "2026-04-01", "close": "49.46"},
    ],
}


def test_fetch_prices_twelvedata(monkeypatch):
    monkeypatch.setattr(settings, "MARKETDATA_API_KEY", "testkey")
    monkeypatch.setattr(md, "_fetch_twelvedata", lambda *a, **k: (TD_SAMPLE, None))
    out = md.fetch_prices("MP", months=6)
    assert out["source"] == "twelvedata" and out["current"] == 57.55
    assert out["history"][0]["as_of"] == "2026-04" and out["history"][0]["close"] == 49.46  # ascending
    assert out["history"][-1]["as_of"] == "2026-06" and out["history"][-1]["close"] == 57.55


def test_compute_momentum_scores_uptrend():
    # rising closes, climbing volume → high score, near range top, positive 3mo return
    hist = [
        {"as_of": "2026-02", "close": 40.0, "volume": 1_000_000},
        {"as_of": "2026-03", "close": 44.0, "volume": 1_100_000},
        {"as_of": "2026-04", "close": 50.0, "volume": 1_400_000},
        {"as_of": "2026-05", "close": 55.0, "volume": 1_800_000},
        {"as_of": "2026-06", "close": 60.0, "volume": 2_000_000},
    ]
    m = md.compute_momentum(hist, 60.0)
    assert m is not None
    assert 0 <= m["score"] <= 100 and m["score"] >= 60
    assert m["range_pos"] == 1.0           # current == high
    assert m["ret_3mo_pct"] is not None and m["ret_3mo_pct"] > 0
    assert m["vol_trend"] == "up"


def test_compute_momentum_handles_thin_history():
    assert md.compute_momentum([{"as_of": "2026-06", "close": 10.0}], 10.0) is None
    assert md.compute_momentum([], None) is None


def test_relative_strength_outperforming():
    # symbol climbing, benchmark ~flat → outperforming, score above 50
    sym = [{"close": 100.0}, {"close": 105.0}, {"close": 112.0}, {"close": 120.0}]
    bench = [{"close": 400.0}, {"close": 401.0}, {"close": 402.0}, {"close": 403.0}]
    rs = md.relative_strength(sym, bench)
    assert rs is not None
    assert rs["score"] > 50 and rs["verdict"] == "outperforming"
    assert rs["rs_3mo"] is not None and rs["rs_3mo"] > 0


def test_relative_strength_lagging():
    sym = [{"close": 120.0}, {"close": 112.0}, {"close": 105.0}, {"close": 100.0}]
    bench = [{"close": 400.0}, {"close": 405.0}, {"close": 410.0}, {"close": 415.0}]
    rs = md.relative_strength(sym, bench)
    assert rs is not None and rs["score"] < 50 and rs["verdict"] == "lagging"


def test_relative_strength_insufficient():
    assert md.relative_strength([{"close": 1.0}], [{"close": 1.0}]) is None


def test_fetch_prices_twelvedata_carries_volume_and_momentum(monkeypatch):
    sample = {
        "status": "ok", "meta": {"symbol": "MP", "currency": "USD"},
        "values": [
            {"datetime": "2026-06-01", "close": "60.0", "volume": "2000000"},
            {"datetime": "2026-05-01", "close": "55.0", "volume": "1800000"},
            {"datetime": "2026-04-01", "close": "50.0", "volume": "1400000"},
            {"datetime": "2026-03-01", "close": "44.0", "volume": "1100000"},
        ],
    }
    monkeypatch.setattr(settings, "MARKETDATA_API_KEY", "testkey")
    monkeypatch.setattr(md, "_fetch_twelvedata", lambda *a, **k: (sample, None))
    out = md.fetch_prices("MP", months=6)
    assert out["history"][-1]["volume"] == 2000000
    assert out["momentum"] is not None and out["momentum"]["score"] >= 0


def test_prices_endpoint_fetches_then_caches(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "RESEARCH_DIR", str(tmp_path))
    monkeypatch.setattr(settings, "DEMO_LOCKED", False)
    fake = {
        "source": "yahoo", "symbol": "MP", "currency": "USD",
        "history": [{"as_of": "2026-05", "close": 64.7}, {"as_of": "2026-06", "close": 57.55}],
        "current": 57.55, "current_date": "2026-06",
    }
    calls = {"n": 0}

    def fake_fetch(ticker, months=14, exchange=None):
        calls["n"] += 1
        return fake

    monkeypatch.setattr(md, "fetch_prices", fake_fetch)
    r1 = R.research_prices("critical-minerals", "MP", months=14, refresh=False, debug=False)
    assert r1["cached"] is False and r1["current"] == 57.55 and calls["n"] == 1
    r2 = R.research_prices("critical-minerals", "MP", months=14, refresh=False, debug=False)
    assert r2["cached"] is True and calls["n"] == 1  # served from cache, no refetch


def test_prices_endpoint_unavailable(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "RESEARCH_DIR", str(tmp_path))
    monkeypatch.setattr(settings, "DEMO_LOCKED", False)
    monkeypatch.setattr(md, "fetch_prices", lambda *a, **k: None)
    r = R.research_prices("critical-minerals", "ZZZZ", months=14, refresh=False, debug=False)
    assert r["available"] is False


def test_prices_endpoint_no_fetch_on_demo(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "RESEARCH_DIR", str(tmp_path))
    monkeypatch.setattr(settings, "DEMO_LOCKED", True)
    called = {"n": 0}
    monkeypatch.setattr(md, "fetch_prices", lambda *a, **k: called.__setitem__("n", called["n"] + 1))
    r = R.research_prices("critical-minerals", "MP", months=14, refresh=False, debug=False)
    assert r["available"] is False and called["n"] == 0
