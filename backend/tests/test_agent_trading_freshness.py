"""Tests for the stale-data gate — the agent should only BUY on fresh method inputs, but a
held name must still be allowed to exit even if its feed is stale."""
from __future__ import annotations

from app.agent_trading.candidates import freshness_skips, overlay_live_prices
from app.agent_trading.strategy import Candidate

NOW = 1_781_000_000.0
HOUR = 3600.0


def test_overlay_live_prices_refreshes_current_and_feed_age():
    cache = {"USAR": {"current": 20.0, "fetched_at": 0.0, "history": [{"close": 19}]},
             "NB": {"current": 5.0, "fetched_at": 0.0}}
    out = overlay_live_prices(cache, {"USAR": 23.5, "ZZ": 1.0, "BAD": 0}, now_epoch=NOW)
    assert out["USAR"]["current"] == 23.5 and out["USAR"]["fetched_at"] == NOW       # live price + fresh feed
    assert out["USAR"]["history"] == [{"close": 19}]                                  # history preserved
    assert out["NB"]["current"] == 5.0                                                # no quote → untouched
    assert out["ZZ"]["current"] == 1.0                                                # new ticker added
    assert "BAD" not in out                                                           # 0/invalid quote ignored
    assert cache["USAR"]["current"] == 20.0                                           # original not mutated


def _c(ticker, held=False):
    return Candidate(ticker=ticker, price=10.0, research_score=0.9,
                     held_qty=(1.0 if held else 0.0), avg_cost=10.0)


def test_fresh_price_passes():
    cands = [_c("FRESH")]
    prices = {"FRESH": {"fetched_at": NOW - 1 * HOUR}}
    assert freshness_skips(cands, prices, {}, now_epoch=NOW, max_price_age_hours=48) == {}


def test_stale_price_is_skipped():
    cands = [_c("OLD")]
    prices = {"OLD": {"fetched_at": NOW - 100 * HOUR}}
    skips = freshness_skips(cands, prices, {}, now_epoch=NOW, max_price_age_hours=48)
    assert "OLD" in skips and "stale" in skips["OLD"]


def test_missing_price_feed_is_skipped():
    skips = freshness_skips([_c("NOFEED")], {}, {}, now_epoch=NOW)
    assert "NOFEED" in skips and "snapshot" in skips["NOFEED"]


def test_held_name_is_exempt_so_exits_still_fire():
    cands = [_c("HELD", held=True)]
    prices = {"HELD": {"fetched_at": NOW - 999 * HOUR}}   # very stale, but held
    assert freshness_skips(cands, prices, {}, now_epoch=NOW, max_price_age_hours=48) == {}


def test_stale_research_skips_when_required():
    cands = [_c("RSTALE")]
    prices = {"RSTALE": {"fetched_at": NOW - 1 * HOUR}}         # price fresh
    ents = {"RSTALE": {"review": {"next_due": "2020-01-01"}}}   # research long overdue
    skips = freshness_skips(cands, prices, ents, now_epoch=NOW, today="2026-06-16",
                            max_price_age_hours=48, require_fresh_research=True)
    assert "RSTALE" in skips and "review" in skips["RSTALE"]
    # and ignored when the research check is off
    assert freshness_skips(cands, prices, ents, now_epoch=NOW, today="2026-06-16",
                           require_fresh_research=False) == {}
