"""Finnhub: earnings-date parse, recommendation revision, earnings-blackout gate, revision tilt."""
from __future__ import annotations

from app.agent_trading.event_risk import apply_revision_tilt, earnings_skips
from app.agent_trading.strategy import Candidate
from app.services import finnhub


def _cand(tkr, *, held=False, rot=0.8):
    return Candidate(ticker=tkr, price=10.0, research_score=0.9, rotation_score=rot,
                     held_qty=(5.0 if held else 0.0))


# --------------------------------------------------------------------------- pure parsers

def test_next_earnings_date_picks_earliest_upcoming():
    payload = {"earningsCalendar": [
        {"date": "2026-08-01", "symbol": "X"},
        {"date": "2026-06-20", "symbol": "X"},
        {"date": "2026-05-01", "symbol": "X"},   # past — ignored
    ]}
    assert finnhub.next_earnings_date(payload, "2026-06-17") == "2026-06-20"
    assert finnhub.next_earnings_date({"earningsCalendar": []}, "2026-06-17") is None


def test_earnings_by_symbol_groups_unfiltered_calendar():
    payload = {"earningsCalendar": [
        {"symbol": "FCX", "date": "2026-07-22"},
        {"symbol": "FCX", "date": "2026-10-21"},   # later — ignored
        {"symbol": "ALB", "date": "2026-08-05"},
        {"symbol": "OLD", "date": "2026-05-01"},   # past — dropped
    ]}
    m = finnhub.earnings_by_symbol(payload, "2026-06-17")
    assert m == {"FCX": "2026-07-22", "ALB": "2026-08-05"}


def test_recommendation_revision_latest_minus_prior():
    rows = [  # newest first
        {"strongBuy": 4, "buy": 4, "hold": 2, "sell": 0, "strongSell": 0},   # net high
        {"strongBuy": 1, "buy": 3, "hold": 4, "sell": 2, "strongSell": 0},   # net lower
    ]
    rev = finnhub.recommendation_revision(rows)
    assert rev is not None and rev > 0          # ratings improved → positive revision


def test_recommendation_revision_needs_two_periods():
    assert finnhub.recommendation_revision([{"strongBuy": 1, "buy": 1, "hold": 1, "sell": 0, "strongSell": 0}]) is None
    assert finnhub.recommendation_revision([]) is None


# --------------------------------------------------------------------------- earnings gate

def test_earnings_blackout_blocks_new_buy_within_window():
    cache = {"SOON": {"available": True, "next_earnings": "2026-06-20"}}
    skips = earnings_skips([_cand("SOON")], cache, today="2026-06-17", blackout_days=5)
    assert "SOON" in skips and "earnings in 3d" in skips["SOON"]


def test_earnings_far_out_is_allowed():
    cache = {"LATER": {"available": True, "next_earnings": "2026-09-01"}}
    assert earnings_skips([_cand("LATER")], cache, today="2026-06-17", blackout_days=5) == {}


def test_earnings_gate_exempts_held_names():
    cache = {"HELD": {"available": True, "next_earnings": "2026-06-18"}}
    assert earnings_skips([_cand("HELD", held=True)], cache, today="2026-06-17", blackout_days=5) == {}


# --------------------------------------------------------------------------- revision tilt

def test_revision_tilt_lifts_and_cuts_rotation_score():
    cache = {"UP": {"available": True, "revision": 0.8}, "DN": {"available": True, "revision": -0.8}}
    up, dn = apply_revision_tilt([_cand("UP", rot=1.0), _cand("DN", rot=1.0)], cache, weight=0.10)
    assert up.rotation_score > 1.0 and dn.rotation_score < 1.0


def test_revision_tilt_is_bounded():
    cache = {"X": {"available": True, "revision": 100.0}}     # absurd → clamps to +max_tilt
    out = apply_revision_tilt([_cand("X", rot=1.0)], cache, weight=0.10, max_tilt=0.10)[0]
    assert out.rotation_score == 1.1


def test_revision_tilt_noop_on_cold_cache():
    cands = [_cand("X", rot=1.0)]
    assert apply_revision_tilt(cands, {}) == cands
