"""FRED macro/commodity series → theme blend."""
from __future__ import annotations

from app.agent_trading.themes import blend_theme
from app.services import fred


def test_parse_fred_csv_skips_missing():
    txt = "DATE,PCOPPUSDM\n2026-03-01,9000\n2026-04-01,.\n2026-05-01,9900\n"
    obs = fred.parse_fred_csv(txt)
    assert obs == [("2026-03-01", 9000.0), ("2026-05-01", 9900.0)]


def test_series_change_uses_base_at_or_before_target():
    obs = [("2026-01-01", 100.0), ("2026-03-01", 110.0), ("2026-06-01", 121.0)]
    # ~90d before 2026-06-01 ≈ 2026-03-03 → base is the 2026-03-01 value (110) → (121-110)/110
    assert fred.series_change(obs, lookback_days=90) == round((121.0 - 110.0) / 110.0, 4)


def test_series_change_insufficient_data():
    assert fred.series_change([("2026-06-01", 100.0)]) is None
    assert fred.series_change([]) is None


def test_theme_from_series_aggregates_and_ignores_none():
    feat = fred.theme_from_series({"COPPER": 0.10, "RATES": -0.02, "MISS": None})
    assert feat["n"] == 2 and feat["trend_up"] is True
    assert feat["momentum"] == round((0.10 - 0.02) / 2, 4)


def test_theme_from_series_empty():
    feat = fred.theme_from_series({"X": None})
    assert feat == {"momentum": 0.0, "trend_up": False, "n": 0, "series": ["X"]}


def test_blend_theme_averages_etf_and_fred():
    etf = {"momentum": 0.04, "trend_up": True, "n": 4, "label": "uptrend"}
    fred_feat = {"momentum": 0.10, "trend_up": True, "n": 2}
    out = blend_theme(etf, fred_feat)
    assert out["momentum"] == round((0.04 + 0.10) / 2, 4)
    assert out["etf_momentum"] == 0.04 and out["fred_momentum"] == 0.10
    assert out["trend_up"] is True


def test_blend_theme_commodity_rollover_can_flip_regime():
    # miner ETF flat-positive, but the commodity is falling hard → blended momentum negative → off
    etf = {"momentum": 0.01, "trend_up": True, "n": 4}
    fred_feat = {"momentum": -0.20, "trend_up": False, "n": 1}
    out = blend_theme(etf, fred_feat)
    assert out["momentum"] < 0 and out["trend_up"] is False


def test_blend_theme_no_fred_is_passthrough():
    etf = {"momentum": 0.04, "trend_up": True, "n": 4}
    assert blend_theme(etf, None) == etf
    assert blend_theme(etf, {"momentum": 0.0, "trend_up": False, "n": 0}) == etf
