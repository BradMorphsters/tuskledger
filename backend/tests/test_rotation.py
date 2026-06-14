"""Tests for the sector rotation aggregate + narrative fallback."""
from __future__ import annotations

import datetime
import json
from pathlib import Path

import pytest

from app.config import settings
from app.services import research_store as store
from app.services import rotation as rot

TODAY = datetime.date(2026, 6, 13)
REPO = Path(__file__).resolve().parents[2]
SCHEMA = REPO / "research" / "research.schema.json"


def _doc():
    return {
        "meta": {"schema_version": "1.0", "domain": "rot-test",
                 "last_updated": "2026-06-13T00:00:00Z", "updated_by": "t",
                 "industry": {"label": "rot test", "benchmark": "SPY",
                              "sector_etfs": ["URA", "COPX"], "proxy_keywords": {"uranium": "URA"}}},
        "dimensions": {"factors": [{"id": "x", "label": "X"}], "tiers": [{"id": 1, "label": "P"}],
                       "composites": {"equity": {}}},
        "entities": [
            {"id": "A", "ticker": "A", "name": "A", "domain": "rot-test", "security_type": "equity",
             "scores": {"factors": {"x": 5}, "conviction": 90, "upside": 88},
             "fundamentals": {"price": "$10", "as_of": "2026-06"},
             "price_targets": {"low": 20, "base": 30, "high": 40},          # $10 < $20 → oversold
             "catalysts": [{"due": "2026-Q3", "description": "c", "status": "in_progress", "impact": "high"}]},
            {"id": "B", "ticker": "B", "name": "B", "domain": "rot-test", "security_type": "equity",
             "scores": {"factors": {"x": 4}, "conviction": 80, "upside": 82},
             "fundamentals": {"price": "$35", "as_of": "2026-06"},
             "price_targets": {"low": 20, "base": 30, "high": 40}},         # $35 in range
            {"id": "F", "ticker": "F", "name": "Fund", "domain": "rot-test", "security_type": "fund",
             "scores": {"factors": {"x": 3}, "conviction": 70, "upside": 70}},
        ],
    }


@pytest.fixture()
def env(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "RESEARCH_DIR", str(tmp_path))
    (tmp_path / "research.schema.json").write_text(SCHEMA.read_text(), encoding="utf-8")
    (tmp_path / "rot-test.research.json").write_text(json.dumps(_doc()), encoding="utf-8")
    return tmp_path


def test_compute_valuation_cadence_temperature(env):
    agg = rot.compute("rot-test", today=TODAY)
    rr = agg["components"]["rerating"]
    assert rr["rated"] == 2 and rr["oversold"] == 1 and rr["in_range"] == 1
    assert rr["score"] == 50                       # (in_range+above)/rated
    assert agg["components"]["cadence"]["near_term_catalysts"] == 1
    assert agg["components"]["flow"]["score"] == 0  # no signals cache warmed
    assert 0 <= agg["temperature"] <= 100
    assert agg["label"] in ("Early", "Stirring", "Rotating", "Hot")
    assert agg["coverage"]["equities"] == 2         # the fund is excluded


def test_snapshot_appends_history(env):
    rot.snapshot("rot-test")
    hist = store.read_rotation("rot-test")
    assert len(hist) == 1 and "temperature" in hist[0] and "flow" in hist[0]


def test_relative_strength_feeds_momentum(env):
    # Warm a price cache: a sector ETF (URA) outperforming the benchmark (SPY).
    sym = [{"as_of": "2026-03", "close": 100.0}, {"as_of": "2026-04", "close": 108.0},
           {"as_of": "2026-05", "close": 116.0}, {"as_of": "2026-06", "close": 125.0}]
    bench = [{"as_of": "2026-03", "close": 400.0}, {"as_of": "2026-04", "close": 401.0},
             {"as_of": "2026-05", "close": 402.0}, {"as_of": "2026-06", "close": 403.0}]
    store.save_prices("rot-test", {"SPY": {"history": bench}, "URA": {"history": sym}})
    score, detail = rot._relative_strength("rot-test")
    assert detail["available"] is True and detail["verdict"] == "outperforming" and score > 50
    agg = rot.compute("rot-test", today=TODAY)
    rs = agg["components"]["momentum"]["relative_strength"]
    assert rs["available"] is True and rs["benchmark"] == "SPY"


def test_relative_strength_unavailable_without_benchmark(env):
    score, detail = rot._relative_strength("rot-test")  # no prices cache warmed
    assert score is None and detail["available"] is False


def test_industry_config_reads_meta(env):
    cfg = rot.industry_config("rot-test")
    assert cfg["label"] == "rot test" and cfg["benchmark"] == "SPY"
    assert cfg["sector_etfs"] == ["URA", "COPX"]
    assert cfg["proxy_keywords"] == {"uranium": "URA"}
    # Defaults when not declared.
    assert abs(sum(cfg["weights"].values()) - 1.0) < 1e-9
    assert abs(cfg["weights"]["flow"] - 0.35) < 1e-9
    assert cfg["flow_signals"] == set(rot.ALL_FLOW_SIGNALS)


def test_rotation_weights_and_flow_signals(tmp_path, monkeypatch):
    # A retail-shaped domain: re-rating/momentum heavy, only EDGAR flow counts.
    monkeypatch.setattr(settings, "RESEARCH_DIR", str(tmp_path))
    (tmp_path / "research.schema.json").write_text(SCHEMA.read_text(), encoding="utf-8")
    doc = _doc()
    doc["meta"]["domain"] = "retail"
    doc["meta"]["industry"] = {
        "label": "retail", "benchmark": "XRT", "sector_etfs": [],
        "rotation_weights": {"flow": 0.1, "rerating": 0.5, "momentum": 0.3, "cadence": 0.1},
        "flow_signals": ["edgar"],
    }
    (tmp_path / "retail.research.json").write_text(json.dumps(doc), encoding="utf-8")
    cfg = rot.industry_config("retail")
    assert cfg["flow_signals"] == {"edgar"} and cfg["benchmark"] == "XRT"
    assert abs(cfg["weights"]["rerating"] - 0.5) < 1e-9
    # Warm a Quiver signal that WOULD add flow (lobbying/gov) — but those are
    # off for retail, so they must not lift the flow score.
    store.save_signals("retail", {
        "A": {"available": True, "lobbying": {"recent_usd": 9_000_000, "prior_usd": 0},
              "gov_contracts": {"recent_usd_90d": 9_000_000, "trend": "up"},
              "signal": {"score": 0}},
    })
    fl = rot.compute("retail", today=TODAY)["components"]["flow"]
    # active=1/checked=1 → base 60; lobbying/gov bonuses suppressed by flow_signals.
    assert fl["score"] == 60


def test_industry_config_defaults_when_absent(tmp_path, monkeypatch):
    # A domain with no meta.industry → SPY benchmark, no sector ETFs (RS off).
    monkeypatch.setattr(settings, "RESEARCH_DIR", str(tmp_path))
    (tmp_path / "research.schema.json").write_text(SCHEMA.read_text(), encoding="utf-8")
    doc = _doc()
    doc["meta"]["domain"] = "plain"
    doc["meta"].pop("industry")
    (tmp_path / "plain.research.json").write_text(json.dumps(doc), encoding="utf-8")
    cfg = rot.industry_config("plain")
    assert cfg["benchmark"] == "SPY" and cfg["sector_etfs"] == []
    score, detail = rot._relative_strength("plain")
    assert score is None and detail["reason"] == "no sector ETFs configured"


def test_edgar_folds_into_flow(env):
    # Insider clustering should lift flow; capital raises should drag it.
    store.save_edgar("rot-test", {
        "A": {"available": True, "insider_filings_90d": 12, "insider_trend": "up",
              "capital_raises_90d": 0},
        "B": {"available": True, "insider_filings_90d": 1, "insider_trend": "flat",
              "capital_raises_90d": 2},  # dilution drag
    })
    agg = rot.compute("rot-test", today=TODAY)
    fl = agg["components"]["flow"]
    assert fl["edgar_checked"] == 2
    assert fl["insider_clusters"] == 1 and fl["capital_raises"] == 1
    # No Quiver cache warmed, so flow is driven purely by EDGAR here:
    # +min(10, 1*3)=3 insider, -min(10, 1*2)=2 dilution → net 1.
    assert fl["score"] == 1


def test_edgar_flow_absent_when_cache_cold(env):
    agg = rot.compute("rot-test", today=TODAY)
    fl = agg["components"]["flow"]
    assert fl["edgar_checked"] == 0 and fl["insider_clusters"] == 0 and fl["capital_raises"] == 0


def test_template_narrative_when_llm_off(env, monkeypatch):
    monkeypatch.setattr(settings, "LLM_ENABLED", False)
    n = rot.narrative("rot-test")
    assert n["source"] == "template"
    assert "not investment advice" in n["narrative"].lower()
    assert n["bundle"]["rotation_temperature_0_100"] == rot.compute("rot-test")["temperature"]
