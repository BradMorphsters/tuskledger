"""Tests for the universe discovery/maintenance layer — pure parse + diff, plus the live
orchestrator driven by an injected fetcher (no network)."""
from __future__ import annotations

from app.agent_trading import parse_globalx_csv, parse_sic_ciks, screen_universe
from app.agent_trading.universe_screen import (
    annotate_add_scores,
    build_provisional_entity,
    fetch_globalx_holdings,
    filter_review_with_decisions,
    globalx_us_listed,
    provisional_conviction,
    run_universe_review,
)

# --- a trimmed real Global X CSV (US + foreign + cash rows) ------------------
GLOBALX_CSV = (
    "Global X Copper Miners ETF\n"
    "Fund Holdings Data as of 06/12/2026\n"
    "% of Net Assets,Ticker,Name,SEDOL,Market Price ($),Shares Held,Market Value ($)\n"
    "5.37,TECK/B CN,TECK RESOURCES LTD-CLS B,2879327,64.78,\"6,537,398.00\",\"423,494,027.80\"\n"
    "4.88,SCCO,SOUTHERN COPPER CORP,2823777,189.79,\"2,028,470.00\",\"384,983,321.30\"\n"
    "4.80,FCX,FREEPORT-MCMORAN INC,2352118,68.41,\"5,536,955.00\",\"378,783,091.55\"\n"
    "3.97,2899 HK,ZIJIN MINING GROUP CO LTD-H,6725299,4.00,\"78,203,035.00\",\"313,373,017.82\"\n"
    "1.43,TGB,TASEKO MINES LTD,2592066,7.5,\"15,032,170.00\",\"112,741,275.00\"\n"
    "0.00,,CASH,,1.0,\"109,749.93\",\"109,749.93\"\n"
)

SIC_ATOM = """<?xml version="1.0"?><feed>
<entry><content><company-info><cik>0000091440</cik><sic>1040</sic></company-info></content></entry>
<entry><content><company-info><cik>0001893899</cik><sic>1040</sic></company-info></content></entry>
<entry><content><company-info><cik>0000091440</cik><sic>1040</sic></company-info></content></entry>
</feed>"""


# --------------------------------------------------------------------------- parsing

def test_globalx_us_listed_filters_foreign_and_cash():
    assert globalx_us_listed("SCCO") == "SCCO"
    assert globalx_us_listed("TGB") == "TGB"
    assert globalx_us_listed("TECK/B CN") is None   # foreign class share
    assert globalx_us_listed("BHP AU") is None      # foreign suffix
    assert globalx_us_listed("2899 HK") is None      # numeric foreign
    assert globalx_us_listed("") is None
    assert globalx_us_listed("BRK.B") == "BRK-B"     # US class share normalized


def test_parse_globalx_csv_keeps_us_drops_cash():
    rows = parse_globalx_csv(GLOBALX_CSV)
    by = {r["ticker"]: r for r in rows}
    assert by["SCCO"]["us_listed"] and by["FCX"]["us_listed"] and by["TGB"]["us_listed"]
    assert by["TECK/B CN"]["us_listed"] is False     # parsed but flagged foreign
    assert "CASH" not in {r["name"] for r in rows}    # cash row dropped
    assert by["SCCO"]["weight"] == 4.88


def test_parse_sic_ciks_dedupes_and_pads():
    assert parse_sic_ciks(SIC_ATOM) == ["0000091440", "0001893899"]


# --------------------------------------------------------------------------- diff

def test_screen_surfaces_new_etf_name_not_on_list():
    etf_lists = {"COPX": parse_globalx_csv(GLOBALX_CSV)}
    universe = ["FCX"]                                # you already hold FCX
    out = screen_universe(universe, etf_lists, scored=[], edgar_candidates=[])
    adds = {r["ticker"] for r in out["add"]}
    assert "SCCO" in adds and "TGB" in adds          # US names you're missing → add queue
    assert "FCX" not in adds                          # already on the list
    assert "TECK/B CN" not in adds                    # foreign, not tradable


def test_screen_edgar_tier_excludes_known_and_etf_names():
    etf_lists = {"COPX": parse_globalx_csv(GLOBALX_CSV)}
    edgar = [{"ticker": "SCCO", "cik": "1", "sic": "1000"},   # already an ETF add → skip
             {"ticker": "FCX", "cik": "2", "sic": "1000"},    # already on list → skip
             {"ticker": "NAK", "cik": "3", "sic": "1000"}]    # genuinely new → keep
    out = screen_universe(["FCX"], etf_lists, scored=[], edgar_candidates=edgar)
    assert [r["ticker"] for r in out["add_edgar"]] == ["NAK"]


def test_screen_flags_weak_or_stale_name_out_of_all_etfs():
    out = screen_universe(
        universe=["OLD", "GOOD", "FCX"],
        etf_lists={"COPX": parse_globalx_csv(GLOBALX_CSV)},   # contains FCX, not OLD/GOOD
        scored=[
            {"ticker": "OLD", "research_score": 0.30, "stale": True},    # weak + stale → drop
            {"ticker": "GOOD", "research_score": 0.90, "stale": False},  # strong → keep
            {"ticker": "FCX", "research_score": 0.20, "stale": True},    # weak BUT in ETF → keep
        ],
        edgar_candidates=[],
    )
    drops = {d["ticker"] for d in out["drop"]}
    assert drops == {"OLD"}


# --------------------------------------------------------------------------- live orchestrator (injected fetch)

def test_run_universe_review_with_injected_fetcher():
    page = 'see <a href="https://assets.globalxetfs.com/funds/holdings/copx_full-holdings_20260612.csv">csv</a>'

    def fake_get(url, headers):
        if url.endswith(".csv"):
            return GLOBALX_CSV, None
        if "globalxetfs.com/funds/" in url:
            return page, None
        if "browse-edgar" in url:
            return SIC_ATOM, None
        return None, "unexpected url"

    class FakeStore:
        def load_domain(self, d):
            return {"entities": [
                {"ticker": "FCX", "scores": {"conviction": 80}},
                {"ticker": "OLD", "scores": {"conviction": 25}, "review": {"next_due": "2020-01-01"}},
            ]}

    out = run_universe_review(
        "critical-minerals", get=fake_get, store=FakeStore(),
        cik_to_ticker={"0000091440": {"ticker": "NAK"}}, today="2026-06-15",
    )
    adds = {r["ticker"] for r in out["add"]}
    assert "SCCO" in adds and "TGB" in adds            # Tier 1 (ETF) scores >= floor → suggested
    assert all(r["provisional"]["conviction"] >= 50 for r in out["add"])  # only above-floor surfaced
    # NAK is a Tier-2 EDGAR filer with no ETF inclusion / signal → scores below 0.50 → screened out
    # (never suggested), so it can't churn the approve/reject queue.
    assert all(r["ticker"] != "NAK" for r in out["add_edgar"])
    assert out["below_floor_screened"] >= 1
    assert {d["ticker"] for d in out["drop"]} == {"OLD"}        # weak+stale, out of ETF


# --------------------------------------------------------------------------- approve: provisional score

def test_provisional_conviction_tier1_clears_floor_tier2_below():
    """A Tier-1 (ETF-included) name starts at the buy floor; a Tier-2 (EDGAR-only) filer below it,
    so the Analyst flags the latter 'needs a thesis' until confirmed."""
    t1 = provisional_conviction(tier=1)
    t2 = provisional_conviction(tier=2)
    assert t1["conviction"] >= 50          # at/above the 0.50 quality floor
    assert t2["conviction"] < 50           # below the floor by design
    assert "tier-1 base 50" in "; ".join(t1["basis"])


def test_provisional_conviction_evidence_lifts_and_caps_at_80():
    """Heavier ETF weight + breadth + a strong public-activity signal + uptrend lift the score,
    but a provisional score is capped at 80 (never auto-assigns top conviction)."""
    weak = provisional_conviction(tier=1, etf_weight=0.0, etf_count=1, signal_score=0.0)
    strong = provisional_conviction(tier=1, etf_weight=20.0, etf_count=3, signal_score=1.0,
                                    momentum=0.5, trend_up=True)
    assert strong["conviction"] > weak["conviction"]
    assert strong["conviction"] <= 80
    # the breakdown names the contributing evidence
    joined = "; ".join(strong["basis"])
    assert "ETF weight" in joined and "public-activity" in joined and "uptrend" in joined


def test_provisional_conviction_negative_momentum_lowers():
    base = provisional_conviction(tier=1, etf_weight=4.0)
    falling = provisional_conviction(tier=1, etf_weight=4.0, momentum=-0.5)
    assert falling["conviction"] < base["conviction"]


def test_build_provisional_entity_is_schema_shaped():
    scores = provisional_conviction(tier=1, etf_weight=5.0, etf_count=2)
    ent = build_provisional_entity(
        ticker="abc", domain="critical-minerals", scores=scores, name="ABC Corp",
        tier=1, security_type="equity", price=12.34, today="2026-06-22", next_due="2026-07-06",
        sources=[{"title": "Universe review (discovery)", "as_of": "2026-06-22", "confidence": "low"}],
    )
    # required entity keys per research.schema.json
    for k in ("id", "ticker", "name", "domain", "security_type", "scores"):
        assert k in ent
    assert ent["ticker"] == "ABC" and ent["id"] == "ABC"     # normalized upper
    assert ent["scores"]["conviction"] == scores["conviction"]
    assert ent["scores"]["factors"] == {}                    # empty factors map is schema-valid
    assert ent["scores"]["method"].startswith("provisional")
    assert ent["fundamentals"]["price"] == "$12.34"
    assert ent["review"]["last_reviewed"] == "2026-06-22"


def test_build_provisional_entity_bad_security_type_defaults_to_equity():
    ent = build_provisional_entity(
        ticker="XYZ", domain="d", scores={"conviction": 50, "upside": 40, "basis": []},
        security_type="garbage", today="2026-06-22",
    )
    assert ent["security_type"] == "equity"


# --------------------------------------------------------------------------- reject: decision filtering

def test_filter_review_with_decisions_drops_rejected_and_surfaces_lists():
    result = {
        "add": [{"ticker": "AAA"}, {"ticker": "BBB"}],
        "add_edgar": [{"ticker": "CCC"}],
        "drop": [{"ticker": "DDD"}, {"ticker": "EEE"}],
    }
    decisions = {"ignored": {"BBB": {"reason": "no"}}, "kept": {"DDD": {"reason": "keep"}}}
    out = filter_review_with_decisions(result, decisions)
    assert {r["ticker"] for r in out["add"]} == {"AAA"}        # BBB ignored
    assert {r["ticker"] for r in out["add_edgar"]} == {"CCC"}
    assert {r["ticker"] for r in out["drop"]} == {"EEE"}       # DDD kept
    assert out["ignored"] == ["BBB"] and out["kept"] == ["DDD"]


def test_filter_review_with_decisions_empty_is_passthrough():
    result = {"add": [{"ticker": "AAA"}], "add_edgar": [], "drop": []}
    out = filter_review_with_decisions(result, {})
    assert {r["ticker"] for r in out["add"]} == {"AAA"}
    assert out["ignored"] == [] and out["kept"] == []


# --------------------------------------------------------------------------- score preview + grace period

def test_annotate_add_scores_attaches_preview_and_sorts_edgar():
    result = {
        "add": [{"ticker": "AAA", "weight": 10.0, "sources": ["ETF URA (10.0%)", "ETF LIT (3.0%)"]}],
        "add_edgar": [{"ticker": "E1"}, {"ticker": "E2"}],
    }
    out = annotate_add_scores(result, signals={})
    # Tier-1 (ETF) preview lands at/above the buy floor; flagged not-below-floor
    assert out["add"][0]["provisional"]["conviction"] >= 50
    assert out["add"][0]["provisional"]["below_floor"] is False
    # Tier-2 (EDGAR) preview is below the floor — exactly what the user should see before approving
    assert all(c["provisional"]["below_floor"] for c in out["add_edgar"])
    assert all(c["provisional"]["conviction"] < 50 for c in out["add_edgar"])


def test_annotate_sorts_edgar_best_first():
    result = {"add": [], "add_edgar": [{"ticker": "LO"}, {"ticker": "HI", "weight": 0}]}
    # give HI a signal so it scores higher (inject a signals cache)
    out = annotate_add_scores(result, signals={"HI": {"signal": {"score": 3}}})
    assert out["add_edgar"][0]["ticker"] == "HI"  # higher provisional first


def test_screen_grace_period_skips_fresh_provisional_but_not_stale():
    scored = [
        {"ticker": "FRESH", "research_score": 0.35, "stale": False, "provisional": True},   # just added → grace
        {"ticker": "OLDP", "research_score": 0.35, "stale": True, "provisional": True},      # past review → drop
        {"ticker": "WEAK", "research_score": 0.30, "stale": False, "provisional": False},    # normal weak → drop
    ]
    out = screen_universe(["FRESH", "OLDP", "WEAK"], etf_lists={}, scored=scored, edgar_candidates=[])
    drops = {d["ticker"] for d in out["drop"]}
    assert "FRESH" not in drops          # grace period — not re-flagged the moment it's added
    assert "OLDP" in drops and "WEAK" in drops


def test_run_universe_review_surfaces_only_signaled_edgar():
    """The floor filter isn't a blanket EDGAR ban: a Tier-2 name with a strong public-activity
    signal clears 0.50 and IS suggested; an unsignaled one is screened out."""
    page = 'x <a href="https://assets.globalxetfs.com/funds/holdings/copx_full-holdings_20260612.csv">c</a>'

    def fake_get(url, headers):
        if url.endswith(".csv"):
            return GLOBALX_CSV, None
        if "globalxetfs.com/funds/" in url:
            return page, None
        if "browse-edgar" in url:
            return SIC_ATOM, None
        return None, "x"

    class FakeStore:
        def load_domain(self, d):
            return {"entities": [{"ticker": "FCX", "scores": {"conviction": 80}}]}

        def load_signals(self, d):
            return {"HOT": {"signal": {"score": 3}}}  # max composite → lifts to the floor

    out = run_universe_review(
        "critical-minerals", get=fake_get, store=FakeStore(),
        cik_to_ticker={"0000091440": {"ticker": "HOT"}, "0001893899": {"ticker": "COLD"}},
        today="2026-06-15",
    )
    edgar = {r["ticker"] for r in out["add_edgar"]}
    assert "HOT" in edgar       # signal lifted it to/above the floor → suggested
    assert "COLD" not in edgar  # no signal → below floor → screened out
