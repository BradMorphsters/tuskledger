"""Event-risk gate — defer NEW buys on a fresh capital-raise (dilution) SEC filing.

Pure tests over the EDGAR activity cache shape produced by app.services.sec_edgar.aggregate.
"""
from __future__ import annotations

from app.agent_trading.event_risk import event_risk_skips
from app.agent_trading.strategy import Candidate


def _cand(tkr, *, held=False):
    return Candidate(ticker=tkr, price=10.0, research_score=0.9,
                     rotation_score=0.9, held_qty=(5.0 if held else 0.0))


def _bundle(*raises, available=True):
    return {"available": available, "recent_raises": [{"form": f, "date": d} for f, d in raises]}


def test_fresh_raise_blocks_new_buy():
    cache = {"DILUTE": _bundle(("424B5", "2026-06-10"))}
    skips = event_risk_skips([_cand("DILUTE")], cache, today="2026-06-17", lookback_days=21)
    assert "DILUTE" in skips
    assert "424B5" in skips["DILUTE"] and "dilution" in skips["DILUTE"].lower()


def test_old_raise_is_ignored():
    cache = {"OLD": _bundle(("S-3", "2026-04-01"))}        # >21d before 2026-06-17
    assert event_risk_skips([_cand("OLD")], cache, today="2026-06-17", lookback_days=21) == {}


def test_held_name_is_flagged_not_blocked():
    cache = {"HELD": _bundle(("424B5", "2026-06-15"))}
    skips = event_risk_skips([_cand("HELD", held=True)], cache, today="2026-06-17", lookback_days=21)
    # present as a warning, and the reason makes clear it is NOT a forced sell
    assert "HELD" in skips
    assert "not force-selling" in skips["HELD"]


def test_unavailable_or_missing_bundle_is_noop():
    cache = {"X": _bundle(("S-1", "2026-06-16"), available=False)}
    assert event_risk_skips([_cand("X"), _cand("Y")], cache, today="2026-06-17") == {}


def test_lookback_zero_disables_gate():
    cache = {"DILUTE": _bundle(("424B5", "2026-06-17"))}
    assert event_risk_skips([_cand("DILUTE")], cache, today="2026-06-17", lookback_days=0) == {}


def test_uses_most_recent_raise():
    # an old S-3 plus a brand-new 424B5 → the fresh one governs and it blocks
    cache = {"D": _bundle(("S-3", "2026-01-02"), ("424B5", "2026-06-16"))}
    skips = event_risk_skips([_cand("D")], cache, today="2026-06-17", lookback_days=21)
    assert "D" in skips and "424B5" in skips["D"]
