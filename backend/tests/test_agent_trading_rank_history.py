"""Rank-history trend: snapshots persist daily and the delta reads climbed (+) / fell (-)
against the most recent PRIOR day — same-day reloads don't pile up or move the trend, and the
trend is isolated per (profile, domain) so switching industries doesn't mix universes."""
from __future__ import annotations

from app.agent_trading import rank_history as rh

DOM = "critical-minerals"


def test_first_day_has_no_trend_then_day_two_measures_against_day_one():
    hist = []
    # Day 1 — nothing to compare to yet.
    d1 = {"USAR": 2, "PPTA": 5, "MP": 9}
    assert rh.deltas(hist, profile="rotation", domain=DOM, today="2026-06-16", ranks=d1) == {
        "USAR": None, "PPTA": None, "MP": None}
    hist = rh.record(hist, profile="rotation", domain=DOM, today="2026-06-16", ranks=d1)

    # Day 2 — USAR fell 2→4 (−2), PPTA climbed 5→3 (+2), MP unchanged, NEW has no prior.
    d2 = {"USAR": 4, "PPTA": 3, "MP": 9, "NEW": 7}
    out = rh.deltas(hist, profile="rotation", domain=DOM, today="2026-06-17", ranks=d2)
    assert out == {"USAR": -2, "PPTA": 2, "MP": 0, "NEW": None}


def test_same_day_reload_compares_to_prior_day_not_itself():
    hist = []
    hist = rh.record(hist, profile="rotation", domain=DOM, today="2026-06-16", ranks={"USAR": 5})
    hist = rh.record(hist, profile="rotation", domain=DOM, today="2026-06-17", ranks={"USAR": 2})
    # A reload later on day 2 still measures vs day 1 (5 → 3 = +2), and recording again is dedup'd.
    out = rh.deltas(hist, profile="rotation", domain=DOM, today="2026-06-17", ranks={"USAR": 3})
    assert out["USAR"] == 2
    hist2 = rh.record(hist, profile="rotation", domain=DOM, today="2026-06-17", ranks={"USAR": 3})
    days = [(s["date"], s["profile"], s["domain"]) for s in hist2]
    assert days.count(("2026-06-17", "rotation", DOM)) == 1   # one snapshot per (day, profile, domain)


def test_seed_flat_gives_no_movement_on_first_run_then_no_ops():
    ranks = {"USAR": 2, "PPTA": 5, "MP": 6}
    seeded = rh.seed_flat([], profile="rotation", domain=DOM, today="2026-06-16", ranks=ranks, days=2)
    assert [s["date"] for s in seeded] == ["2026-06-14", "2026-06-15"]
    assert all(s["ranks"] == ranks for s in seeded)
    # first view reads flat (0), not blank (None)
    assert rh.deltas(seeded, profile="rotation", domain=DOM, today="2026-06-16", ranks=ranks) == {
        "USAR": 0, "PPTA": 0, "MP": 0}
    # once real prior history exists, seeding is a no-op
    real = [{"date": "2026-06-15", "profile": "rotation", "domain": DOM, "ranks": {"USAR": 9}}]
    assert rh.seed_flat(real, profile="rotation", domain=DOM, today="2026-06-16", ranks=ranks) is real


def test_profile_AND_domain_isolated_and_history_capped():
    # a different PROFILE isn't used as the rotation baseline
    h = [{"date": "2026-06-16", "profile": "momentum", "domain": DOM, "ranks": {"USAR": 1}}]
    assert rh.deltas(h, profile="rotation", domain=DOM, today="2026-06-17", ranks={"USAR": 9})["USAR"] is None
    # a different DOMAIN isn't used either — switching industries starts a fresh trend, no cross-mix
    h2 = [{"date": "2026-06-16", "profile": "rotation", "domain": "ai-semis", "ranks": {"NVDA": 1}}]
    assert rh.deltas(h2, profile="rotation", domain=DOM, today="2026-06-17", ranks={"USAR": 9})["USAR"] is None
    # cap holds
    hist = []
    for i in range(250):
        hist = rh.record(hist, profile="rotation", domain=DOM,
                         today=f"2026-{(i % 12) + 1:02d}-{(i % 28) + 1:02d}", ranks={"USAR": i}, cap=180)
    assert len(hist) <= 180
