"""Tests for the sector-tailwind signal (commodity-proxy ETF momentum)."""
from __future__ import annotations

from app.agent_trading import (
    Candidate,
    GuardrailConfig,
    StrategyConfig,
    build_candidates,
    proxies_for,
    theme_features,
)
from app.agent_trading.strategy import propose


class FakeMD:
    def __init__(self, scores):  # {etf: momentum_score}
        self._s = scores

    def compute_momentum(self, history, current):
        tag = history[0].get("tag") if history else None
        if tag not in self._s:
            return None
        sc = self._s[tag]
        return {"score": sc, "ret_3mo_pct": (sc - 50) * 0.4, "pct_off_high": -2.0}


def _hist(tag):
    return {"history": [{"tag": tag, "close": 10}], "current": 10.0}


def test_proxies_for_known_domain():
    assert proxies_for("critical-minerals") == ["URA", "REMX", "LIT", "COPX"]
    assert proxies_for("unknown") == [] and proxies_for(None) == []


def test_theme_features_uptrend_and_empty():
    md = FakeMD({"up": 80, "up2": 70})
    feat = theme_features({"URA": _hist("up"), "LIT": _hist("up2")}, md)
    assert feat["trend_up"] and feat["label"] == "uptrend" and feat["momentum"] > 0 and feat["n"] == 2
    assert theme_features({}, md) == {"momentum": 0.0, "trend_up": False, "label": "unknown", "n": 0}


def test_theme_features_downtrend():
    md = FakeMD({"dn": 20})
    feat = theme_features({"URA": _hist("dn")}, md)
    assert not feat["trend_up"] and feat["label"] == "downtrend" and feat["momentum"] < 0


# --------------------------------------------------------------------------- regime filter

def _name_md():
    class M:  # momentum exists for the held universe name's price
        def compute_momentum(self, h, c):
            return {"score": 80, "ret_3mo_pct": 20.0, "pct_off_high": -3.0}
    return M()


def test_build_candidates_stamps_theme():
    entities = {"USAR": {"ticker": "USAR", "scores": {"conviction": 80}}}
    prices = {"USAR": {"current": 10.0, "history": [{"tag": "x"}]}}
    cands = build_candidates(["USAR"], entities, {}, prices, {}, _name_md(),
                             theme={"momentum": 0.05, "trend_up": True})
    assert cands[0].theme_momentum == 0.05 and cands[0].theme_trend_up is True


def test_require_theme_tailwind_blocks_buys_in_downtrend():
    base = dict(ticker="USAR", price=10.0, research_score=0.9, trend_up=True, momentum=0.2)
    down = [Candidate(**base, theme_trend_up=False)]
    up = [Candidate(**base, theme_trend_up=True)]
    cfg = StrategyConfig(profile="momentum", require_theme_tailwind=True)
    assert propose(down, cfg) == []                       # sector downtrend -> no new buys
    assert any(d.action == "buy" for d in propose(up, cfg))  # sector uptrend -> buys
    # with the filter off, the downtrend name buys regardless
    assert any(d.action == "buy" for d in propose(down, StrategyConfig(profile="momentum")))
