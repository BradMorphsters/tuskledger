"""Tests for the universe discovery/maintenance layer — pure parse + diff, plus the live
orchestrator driven by an injected fetcher (no network)."""
from __future__ import annotations

from app.agent_trading import parse_globalx_csv, parse_sic_ciks, screen_universe
from app.agent_trading.universe_screen import (
    fetch_globalx_holdings,
    globalx_us_listed,
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
    assert "SCCO" in adds and "TGB" in adds            # Tier 1 from the CSV
    assert any(r["ticker"] == "NAK" for r in out["add_edgar"])  # Tier 2 from EDGAR CIK map
    assert {d["ticker"] for d in out["drop"]} == {"OLD"}        # weak+stale, out of ETF
