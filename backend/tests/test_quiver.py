"""Tests for the Quiver public-purchase aggregation (no network)."""
from __future__ import annotations

import datetime

from app.config import settings
from app.services import quiver as q

TODAY = datetime.date(2026, 6, 13)


def test_to_num_handles_ranges():
    assert q._to_num("$1,001 - $15,000") == 8000.5  # range → midpoint
    assert q._to_num("$57.55") == 57.55
    assert q._to_num(42) == 42.0
    assert q._to_num(None) is None


def test_agg_govcontracts_quarterly_trend():
    # Real Quiver shape: quarterly {Year, Qtr, Amount} — latest qtr vs prior.
    rows = [
        {"Ticker": "X", "Amount": "3000000", "Year": 2026, "Qtr": 2},
        {"Ticker": "X", "Amount": "1000000", "Year": 2026, "Qtr": 1},
    ]
    g = q.agg_govcontracts(rows, TODAY)
    assert g["recent_usd_90d"] == 3000000 and g["prior_usd_90d"] == 1000000
    assert g["trend"] == "up"
    assert g["latest"]["period"] == "2026-Q2"


def test_agg_congress_net_and_buyers():
    rows = [
        {"TransactionDate": "2026-06-01", "Transaction": "Purchase", "Amount": "$15,001 - $50,000",
         "Representative": "A", "Party": "D", "House": "Senate"},
        {"TransactionDate": "2026-05-15", "Transaction": "Purchase", "Range": "$1,001 - $15,000", "Representative": "B"},
        {"TransactionDate": "2026-05-10", "Transaction": "Sale", "Amount": "$1,001 - $15,000", "Representative": "C"},
    ]
    c = q.agg_congress(rows, TODAY)
    assert c["buyers_90d"] == 2 and c["net_usd_90d"] > 0


def test_agg_insider_net():
    rows = [
        {"Date": "2026-06-01", "Shares": "1000", "PricePerShare": "10", "AcquiredDisposedCode": "A", "Name": "CEO"},
        {"Date": "2026-05-20", "Shares": "500", "PricePerShare": "10", "AcquiredDisposedCode": "D", "Name": "CFO"},
    ]
    i = q.agg_insider(rows, TODAY)
    assert i["buys_90d"] == 1 and i["sells_90d"] == 1 and i["net_usd_90d"] == 5000


def test_agg_offexchange():
    rows = [
        {"Date": "2026-06-10", "DPI": "0.5", "OTC_Short": "100", "OTC_Total": "400"},  # recent
        {"Date": "2026-06-01", "DPI": "0.5", "OTC_Short": "100", "OTC_Total": "400"},  # recent
        {"Date": "2026-05-01", "DPI": "0.3", "OTC_Short": "50", "OTC_Total": "500"},   # prior window
    ]
    oe = q.agg_offexchange(rows, TODAY)
    assert oe["dpi_recent"] == 0.5 and oe["dpi_prior"] == 0.3 and oe["dpi_trend"] == "up"
    assert oe["short_pct"] == 25.0


def test_composite_signal_heating_up():
    s = q.composite_signal(
        {"recent_usd_90d": 4000000, "trend": "up"},
        {"net_usd_90d": 50000, "buyers_90d": 2},
        {"net_usd_90d": 5000},
        {"trend": "up"},
    )
    assert s["label"] == "Heating up" and s["score"] >= 2
    assert any("federal contracts accelerating" in d for d in s["drivers"])


def test_signals_for_no_key(monkeypatch):
    monkeypatch.setattr(settings, "QUIVER_API_KEY", "")
    out = q.signals_for("USAR", today=TODAY)
    assert out["available"] is False and out["reason"] == "no_key"


def test_signals_for_with_mocked_get(monkeypatch):
    monkeypatch.setattr(settings, "QUIVER_API_KEY", "testkey")

    def fake_get(path):
        if "govcontracts" in path:
            return ([{"Ticker": "USAR", "Amount": "3000000", "Year": 2026, "Qtr": 2}], None)
        if "congresstrading" in path:
            return ([{"TransactionDate": "2026-06-01", "Transaction": "Purchase",
                      "Range": "$15,001 - $50,000", "Representative": "A"}], None)
        if "insiders" in path:
            return ([{"Date": "2026-06-01", "Shares": "1000", "PricePerShare": "10",
                      "AcquiredDisposedCode": "A", "Name": "CEO"}], None)
        if "lobbying" in path:
            return ([{"Date": "2026-05-01", "Amount": "200000", "Issue": "Defense"}], None)
        if "offexchange" in path:
            return ([{"Date": "2026-06-10", "DPI": "0.5", "OTC_Short": "100", "OTC_Total": "400"},
                     {"Date": "2026-05-01", "DPI": "0.3", "OTC_Short": "50", "OTC_Total": "500"}], None)
        return (None, "unknown")

    monkeypatch.setattr(q, "_get", fake_get)
    out = q.signals_for("USAR", today=TODAY)
    assert out["available"] is True
    assert out["gov_contracts"]["recent_usd_90d"] == 3000000
    assert out["congress"]["buyers_90d"] == 1
    assert out["insider"]["net_usd_90d"] == 10000
    assert out["offexchange"]["dpi_trend"] == "up"
    assert out["signal"]["label"] in ("Heating up", "Steady")


def test_capabilities_detects_unlocked_vs_gated(monkeypatch):
    monkeypatch.setattr(settings, "QUIVER_API_KEY", "testkey")
    q._CAP.update(data=None, ts=0)

    def fake_get(path):
        if "govcontracts" in path or "congresstrading" in path:
            return ([{"x": 1}], None)        # accessible (200)
        return (None, "403 (dataset not in your Quiver tier)")  # gated

    monkeypatch.setattr(q, "_get", fake_get)
    cap = q.capabilities(force=True)
    assert cap["configured"] is True
    assert set(cap["accessible"]) == {"govcontracts", "congress"}
    assert set(cap["locked"]) == {"insider", "lobbying", "offexchange"}
    assert cap["datasets"]["insider"]["status"] == "gated"


def test_capabilities_no_key(monkeypatch):
    monkeypatch.setattr(settings, "QUIVER_API_KEY", "")
    cap = q.capabilities(force=True)
    assert cap["configured"] is False and len(cap["locked"]) == len(q.DATASET_LABELS)


def test_signals_for_dataset_status(monkeypatch):
    monkeypatch.setattr(settings, "QUIVER_API_KEY", "testkey")

    def fake_get(path):
        if "congresstrading" in path:
            return ([{"TransactionDate": "2026-06-01", "Transaction": "Purchase",
                      "Amount": "$1,001 - $15,000", "Representative": "A"}], None)
        return (None, "403 gated")

    monkeypatch.setattr(q, "_get", fake_get)
    out = q.signals_for("USAR", today=TODAY)
    assert out["available"] is True
    assert out["dataset_status"]["congress"] == "ok"
    assert out["dataset_status"]["insider"] == "gated"


def test_signals_for_tier_gated_some_datasets(monkeypatch):
    monkeypatch.setattr(settings, "QUIVER_API_KEY", "testkey")

    def fake_get(path):
        if "govcontracts" in path:
            return ([{"Date": "2026-06-01", "Amount": "1000000", "Agency": "DoD"}], None)
        return (None, "403 (key invalid or dataset not in your Quiver tier)")

    monkeypatch.setattr(q, "_get", fake_get)
    out = q.signals_for("MP", today=TODAY)
    assert out["available"] is True  # gov contracts worked
    assert out["gov_contracts"]["recent_usd_90d"] == 1000000
    assert "congress" in out["errors"]
