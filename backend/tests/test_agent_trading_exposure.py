"""Tests for cross-portfolio exposure — overlap of the agent universe vs main holdings."""
from __future__ import annotations

from app.agent_trading import cross_exposure


def test_overlap_and_weights():
    universe = ["AAA", "BBB", "CCC"]
    main = {"AAA": 600.0, "CCC": 400.0}   # main total $1,000
    out = cross_exposure(universe, main)
    assert out["main_total"] == 1000.0 and out["n_main_names"] == 2
    assert out["n_universe"] == 3 and out["n_overlap"] == 2
    by = {r["ticker"]: r for r in out["rows"]}
    assert by["AAA"]["in_main"] and by["AAA"]["main_pct"] == 0.6
    assert not by["BBB"]["in_main"]


def test_concentrated_proposal_is_flagged():
    out = cross_exposure(["AAA"], {"AAA": 300.0, "ZZZ": 700.0}, proposed=["AAA"],
                         concentration_threshold=0.10)
    # AAA is 30% of main and the agent is proposing it -> a concentrated proposal
    assert out["concentrated_proposals"] and out["concentrated_proposals"][0]["ticker"] == "AAA"


def test_no_overlap_is_clean():
    out = cross_exposure(["NEW1", "NEW2"], {"OLD": 1000.0})
    assert out["n_overlap"] == 0 and out["overlap"] == [] and out["concentrated_proposals"] == []


def test_proposed_and_concentrated_sort_first():
    out = cross_exposure(["LOW", "HIGH"], {"LOW": 50.0, "HIGH": 950.0}, proposed=["LOW"])
    # proposed first, then by weight — LOW is proposed so it leads despite the smaller weight
    assert out["rows"][0]["ticker"] == "LOW"
