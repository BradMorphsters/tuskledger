"""Tests for the long-term-hold research layer (store + join + alerts)."""
from __future__ import annotations

import copy
import datetime
import json
from pathlib import Path

import pytest

from app.config import settings
from app.services import research_join as rj
from app.services import research_store as store

REPO_ROOT = Path(__file__).resolve().parents[2]
REAL_SCHEMA = REPO_ROOT / "research" / "research.schema.json"
REAL_SEED = REPO_ROOT / "research" / "critical-minerals.research.json"

TODAY = datetime.date(2026, 6, 13)
DOMAIN = "test-domain"


def _doc() -> dict:
    """A compact, schema-valid research doc engineered to exercise every
    join + alert path deterministically."""
    return {
        "meta": {
            "schema_version": "1.0",
            "domain": DOMAIN,
            "title": "Test Domain",
            "last_updated": "2026-06-13T00:00:00Z",
            "updated_by": "test",
        },
        "dimensions": {
            "factors": [{"id": "criticality", "label": "Criticality"}],
            "scale": {"min": 1, "max": 5},
            "tiers": [
                {"id": 1, "label": "Producing"},
                {"id": 2, "label": "Near-term"},
                {"id": 3, "label": "Speculative"},
            ],
            "composites": {"equity": {}, "fund": {}},
        },
        "entities": [
            {
                "id": "HELD1", "ticker": "HELD1", "name": "Held One",
                "domain": DOMAIN, "security_type": "equity", "tier": 2,
                "category": "Rare earths", "risk_rating": "High",
                "scores": {"factors": {"criticality": 5}, "conviction": 90, "upside": 88},
                "fundamentals": {"as_of": "2026-01", "source": "filings", "price": "~$25"},
                "price_targets": {
                    "low": 30, "base": 40, "high": 55, "currency": "USD",
                    "as_of": "2026-06", "basis": "consensus", "n_analysts": 5,
                    "source": "test", "url": None, "confidence": "high",
                },
                "thesis": {"summary": "Cash-rich challenger."},
                "catalysts": [
                    {"due": "2026-Q1", "description": "ramp", "status": "in_progress", "impact": "high"}
                ],
                "invalidation_triggers": ["cash burn outruns funding", "ramp stalls"],
                "review": {"last_reviewed": "2025-12-01", "next_due": "2026-03-01"},
                "sources": [{"title": "sweep", "confidence": "high"}],
            },
            {
                "id": "HELD2", "ticker": "HELD2", "name": "Held Two Fund",
                "domain": DOMAIN, "security_type": "fund",
                "category": "Copper", "exposure": "Copper",
                "scores": {"factors": {"criticality": 4}, "conviction": 80, "upside": 82},
                "fundamentals": {"as_of": "2026-06", "source": "fund sheet"},
                "review": {"next_due": "2027-01-01"},
                "sources": [{"title": "sweep", "confidence": "medium"}],
            },
            {
                "id": "ALIASD", "ticker": "NEWT", "aliases": ["OLDT"], "name": "Aliased Co",
                "domain": DOMAIN, "security_type": "equity", "category": "Lithium",
                "scores": {"factors": {"criticality": 3}, "conviction": 75, "upside": 70},
                "review": {"next_due": "2027-01-01"},
            },
            {
                "id": "PINNED", "ticker": "AMBIGX", "plaid_security_id": "pid-pinned",
                "name": "Pinned Co", "domain": DOMAIN, "security_type": "equity",
                "category": "Tungsten",
                "scores": {"factors": {"criticality": 3}, "conviction": 60, "upside": 65},
                "review": {"next_due": "2027-01-01"},
            },
            {
                "id": "WATCH1", "ticker": "WATCH1", "name": "Watch One",
                "domain": DOMAIN, "security_type": "equity", "tier": 3,
                "category": "Uranium",
                "scores": {"factors": {"criticality": 4}, "conviction": 70, "upside": 72},
                "review": {"next_due": "2026-02-01"},
                "catalysts": [
                    {"due": "2026-Q1", "description": "permit", "status": "upcoming", "impact": "med"}
                ],
            },
        ],
    }


@pytest.fixture()
def research_env(tmp_path, monkeypatch):
    """Point the store at a temp dir with the real schema + the test doc."""
    monkeypatch.setattr(settings, "RESEARCH_DIR", str(tmp_path))
    (tmp_path / "research.schema.json").write_text(
        REAL_SCHEMA.read_text(encoding="utf-8"), encoding="utf-8"
    )
    (tmp_path / f"{DOMAIN}.research.json").write_text(
        json.dumps(_doc()), encoding="utf-8"
    )
    return tmp_path


def _seed_holdings(factory):
    """Holdings that match HELD1 (×2 accounts), HELD2, an alias, a pid-pin,
    plus an unmatched cash line. Total portfolio = $100,000."""
    a = factory.account(name="Brokerage A")
    a.tax_bucket = "taxable"
    b = factory.account(name="Roth B")
    b.tax_bucket = "roth"
    factory.db.flush()

    factory.security(plaid_security_id="pid-h1", ticker_symbol="HELD1", name="Held One", type="equity")
    factory.security(plaid_security_id="pid-h2", ticker_symbol="HELD2", name="Held Two", type="etf")
    factory.security(plaid_security_id="pid-al", ticker_symbol="OLDT", name="Aliased", type="equity")
    factory.security(plaid_security_id="pid-pinned", ticker_symbol="AMBIG", name="Pinned", type="equity")
    factory.security(plaid_security_id="pid-cash", ticker_symbol="CASHX", name="Cash", type="cash")

    # HELD1 split across two accounts → aggregate value 60k, cost 67k (below cost)
    factory.holding(account_id=a.id, plaid_security_id="pid-h1", quantity=1000, institution_value=36000, cost_basis=40000)
    factory.holding(account_id=b.id, plaid_security_id="pid-h1", quantity=600, institution_value=24000, cost_basis=27000)
    factory.holding(account_id=a.id, plaid_security_id="pid-h2", quantity=100, institution_value=3000, cost_basis=2500)
    factory.holding(account_id=a.id, plaid_security_id="pid-al", quantity=50, institution_value=2000, cost_basis=1800)
    factory.holding(account_id=a.id, plaid_security_id="pid-pinned", quantity=10, institution_value=1000, cost_basis=900)
    factory.holding(account_id=a.id, plaid_security_id="pid-cash", quantity=34000, institution_value=34000)
    factory.commit()


# ── Schema / store ────────────────────────────────────────────────────────
def test_real_seed_validates():
    from jsonschema.validators import Draft202012Validator
    schema = json.loads(REAL_SCHEMA.read_text())
    seed = json.loads(REAL_SEED.read_text())
    errs = list(Draft202012Validator(schema).iter_errors(seed))
    assert errs == [], errs[:3]
    assert seed["meta"]["domain"] == "critical-minerals"
    # Lower bound, not exact: the universe is curated over time (names approved/dropped via the
    # universe-review flow), so pinning an exact count would make this brittle.
    assert len(seed["entities"]) >= 60


def test_validate_rejects_missing_required(research_env):
    bad = _doc()
    del bad["entities"]
    with pytest.raises(store.ResearchValidationError):
        store.validate(bad)


def test_atomic_write_round_trip(research_env):
    data = store.load_domain(DOMAIN)
    data["meta"]["title"] = "Edited"
    store.save_domain(DOMAIN, data, updated_by="pytest")
    reloaded = store.load_domain(DOMAIN)
    assert reloaded["meta"]["title"] == "Edited"
    assert reloaded["meta"]["updated_by"] == "pytest"
    assert reloaded["meta"]["last_updated"].endswith("Z")


def test_version_guard_refuses_unknown_major(research_env):
    data = store.load_domain(DOMAIN)
    data["meta"]["schema_version"] = "2.0"
    with pytest.raises(store.ResearchError):
        store.save_domain(DOMAIN, data)


def test_upsert_inserts_then_merges(research_env):
    new = {
        "id": "NEWCO", "ticker": "NEWCO", "name": "New Co", "domain": DOMAIN,
        "security_type": "equity",
        "scores": {"factors": {"criticality": 4}, "conviction": 50, "upside": 55},
    }
    store.upsert_entity(DOMAIN, new, updated_by="pytest")
    assert store.get_entity(DOMAIN, "NEWCO")["name"] == "New Co"
    # Partial merge keeps prior fields, overrides given ones.
    store.upsert_entity(DOMAIN, {"id": "NEWCO", "risk_rating": "High"})
    merged = store.get_entity(DOMAIN, "NEWCO")
    assert merged["risk_rating"] == "High"
    assert merged["name"] == "New Co"
    # History accrued.
    hist = store.read_history(DOMAIN)
    assert any(r["id"] == "NEWCO" for r in hist)


def test_update_field_persists_and_validates(research_env):
    store.update_field(DOMAIN, "HELD1", "scores.conviction", 95, updated_by="pytest")
    assert store.get_entity(DOMAIN, "HELD1")["scores"]["conviction"] == 95


def test_update_field_bad_value_rejected_and_file_untouched(research_env):
    before = store.load_domain(DOMAIN)
    with pytest.raises(store.ResearchValidationError):
        store.update_field(DOMAIN, "HELD1", "scores.factors.criticality", 9)  # >5
    after = store.load_domain(DOMAIN)
    assert after["entities"] == before["entities"]


# ── Join ──────────────────────────────────────────────────────────────────
def test_tolerant_join_unmatched_counted_not_errored(research_env, db, factory):
    _seed_holdings(factory)
    res = rj.get_position_research(db, domain=DOMAIN, today=TODAY)
    # The cash line (CASHX) has no research match → counted, never errors.
    assert res["unmatched_holdings"] == 1
    assert res["total_market_value"] == 100000.0
    tickers = {p["ticker"] for p in res["positions"]}
    assert "CASHX" not in tickers


def test_position_aggregates_accounts_and_weight(research_env, db, factory):
    _seed_holdings(factory)
    res = rj.get_position_research(db, domain=DOMAIN, today=TODAY)
    held1 = next(p for p in res["positions"] if p["ticker"] == "HELD1")
    pos = held1["position"]
    assert pos["market_value"] == 60000.0
    assert pos["cost_basis"] == 67000.0
    assert pos["unrealized_gl"] == -7000.0
    assert pos["weight_pct"] == 60.0
    assert len(pos["accounts"]) == 2
    assert set(pos["tax_buckets"]) == {"taxable", "roth"}
    # Sorted by weight: HELD1 first.
    assert res["positions"][0]["ticker"] == "HELD1"


def test_alias_and_pid_matching(research_env, db, factory):
    _seed_holdings(factory)
    res = rj.get_position_research(db, domain=DOMAIN, today=TODAY)
    by_id = {p["research"]["id"] for p in res["positions"]}
    assert "ALIASD" in by_id   # held ticker OLDT matched via aliases[]
    assert "PINNED" in by_id   # held ticker AMBIG matched via plaid_security_id pin


def test_position_flags(research_env, db, factory):
    _seed_holdings(factory)
    res = rj.get_position_research(db, domain=DOMAIN, today=TODAY)
    held1 = next(p for p in res["positions"] if p["ticker"] == "HELD1")
    assert set(held1["flags"]) >= {
        "large_position", "below_cost", "overdue_catalyst",
        "stale_research", "invalidation_watch",
    }
    # next_catalyst carries a parsed due date + overdue marker
    nc = held1["research"]["next_catalyst"]
    assert nc["overdue"] is True and nc["due_date"] == "2026-03-31"


def test_alerts(research_env, db, factory):
    _seed_holdings(factory)
    alerts = rj.get_alerts(db, domain=DOMAIN, today=TODAY)
    types_held = {(a["type"], a["scope"]) for a in alerts}
    assert ("large_below_cost", "held") in types_held
    assert ("overdue_catalyst", "held") in types_held
    assert ("invalidation_watch", "held") in types_held
    assert ("concentration", "held") in types_held
    # WATCH1 is not held → surfaces as a universe-scope stale alert.
    assert any(a["type"] == "stale" and a["scope"] == "universe" and a["ticker"] == "WATCH1"
               for a in alerts)
    # High-severity alerts sort to the front.
    assert alerts[0]["severity"] == "high"


def test_signal_tripwire_alerts_from_caches(research_env, db, factory):
    """Flow (Quiver) + filing (EDGAR) caches surface as research alerts."""
    _seed_holdings(factory)
    store.save_signals(DOMAIN, {
        "HELD1": {"available": True,
                  "gov_contracts": {"recent_usd_90d": 4_000_000, "trend": "up",
                                    "latest": {"stale": False}},
                  "offexchange": {"dpi_recent": 0.61, "dpi_trend": "up"}},
    })
    store.save_edgar(DOMAIN, {
        "HELD1": {"available": True, "insider_filings_90d": 14, "insider_trend": "up",
                  "capital_raises_90d": 1, "recent_raises": [{"form": "S-3", "date": "2026-06-01"}]},
    })
    alerts = rj.get_alerts(db, domain=DOMAIN, today=TODAY)
    by_type = {a["type"]: a for a in alerts}
    assert {"flow_contract", "flow_darkpool", "dilution_watch", "insider_cluster"} <= set(by_type)
    # Dilution on a below-cost held name is high severity and sourced to EDGAR.
    assert by_type["dilution_watch"]["severity"] == "high"
    assert by_type["dilution_watch"]["source"] == "edgar"
    assert by_type["flow_contract"]["source"] == "quiver"


def test_political_flow_and_congress_sell_alert(research_env, db, factory):
    """Universe-filtered congressional buys/sells (with trades) + a net-selling alert."""
    _seed_holdings(factory)
    store.save_signals(DOMAIN, {"HELD1": {"available": True, "congress": {
        "buys_usd_90d": 0, "sells_usd_90d": 50000, "net_usd_90d": -50000, "buyers_90d": 0,
        "items": [{"date": "2026-06-01", "who": "Rep. X", "party": "R",
                   "house": "Representatives", "tx": "sale", "amount": 50000}]}}})
    store.save_edgar(DOMAIN, {"HELD1": {"available": True, "insider_filings_90d": 9, "insider_trend": "up"}})

    pf = rj.get_political_flow(domain=DOMAIN, today=TODAY)
    row = next(r for r in pf["rows"] if r["ticker"] == "HELD1")
    assert row["direction"] == "selling" and row["sells_usd_90d"] == 50000
    assert row["trades"][0]["side"] == "sell" and row["trades"][0]["who"] == "Rep. X"
    assert row["trades"][0]["committee_relevant"] is False        # phase-2 scaffold
    assert row["insider_filings_90d"] == 9

    alerts = rj.get_alerts(db, domain=DOMAIN, today=TODAY)        # net selling surfaces as an alert
    assert any(a["type"] == "flow_congress_sell" and a["ticker"] == "HELD1" for a in alerts)


def test_congress_committee_map_and_matching():
    """Pure: build the member→committee map and match Quiver-style names (incl. fuzzy fallback)."""
    from app.services import congress_committees as cc
    committees = [{"type": "house", "name": "House Committee on Natural Resources", "thomas_id": "HSII"},
                  {"type": "senate", "name": "Senate Committee on Armed Services", "thomas_id": "SSAS"},
                  {"type": "house", "name": "House Committee on Agriculture", "thomas_id": "HSAG"}]
    membership = {"HSII": [{"name": "Ro Khanna"}], "SSAS": [{"name": "Jack Reed"}],
                  "HSAG": [{"name": "Someone Else"}]}
    m = cc.build_map(committees, membership, keywords=None)
    assert m["members"]["ro khanna"]["committees"] == ["House Committee on Natural Resources"]
    assert cc.committees_for("Ro Khanna", m, ["natural resources"]) == ["House Committee on Natural Resources"]
    assert cc.committees_for("Ro Khanna", m, ["armed services"]) == []          # not on that committee
    assert cc.committees_for("Rohit Khanna", m, ["natural resources"])          # last-name + first-initial fallback
    assert cc.committees_for("Nobody Here", m) == []


def test_political_flow_committee_flagging(research_env, db, factory):
    """A traded member who sits on a relevant committee gets committee_relevant=True end-to-end."""
    import json
    from app.services import congress_committees as cc
    _seed_holdings(factory)
    store.save_signals(DOMAIN, {"HELD1": {"available": True, "congress": {
        "buys_usd_90d": 8000, "sells_usd_90d": 0, "net_usd_90d": 8000, "buyers_90d": 1,
        "items": [{"date": "2026-06-01", "who": "Ro Khanna", "party": "D",
                   "house": "Representatives", "tx": "purchase", "amount": 8000}]}}})
    cc._map_path().write_text(json.dumps({"members": {
        "ro khanna": {"name": "Ro Khanna", "committees": ["House Committee on Natural Resources"]}}}))
    d = store.load_domain(DOMAIN)
    d.setdefault("meta", {}).setdefault("industry", {})["relevant_committees"] = ["Natural Resources"]
    store.save_domain(DOMAIN, d, updated_by="test")
    row = next(r for r in rj.get_political_flow(domain=DOMAIN, today=TODAY)["rows"] if r["ticker"] == "HELD1")
    assert row["committee_relevant"] is True
    assert "Natural Resources" in row["trades"][0]["committees"][0]


def test_signal_alerts_absent_when_caches_cold(research_env, db, factory):
    """Single-source self-disabling: no flow/filing alerts when caches are cold."""
    _seed_holdings(factory)
    alerts = rj.get_alerts(db, domain=DOMAIN, today=TODAY)
    types = {a["type"] for a in alerts}
    assert not ({"flow_contract", "flow_darkpool", "dilution_watch", "insider_cluster"} & types)
    # Finnhub plane is likewise dormant when its cache is cold.
    assert not ({"earnings_soon", "revision_up", "revision_down"} & types)


def test_data_freshness_flags_stale_prices(research_env):
    """The synthesis surfaces stale price caches so old data isn't presented as current."""
    import time
    from app.services import research_synthesis as rsyn
    store.save_prices(DOMAIN, {
        "AAA": {"history": [{}], "current": 1, "fetched_at": time.time() - 200 * 3600},  # 200h stale
        "BBB": {"history": [{}], "current": 1, "fetched_at": time.time() - 1 * 3600},     # fresh
    })
    fr = rsyn._data_freshness(DOMAIN)["prices"]
    assert fr["n"] == 2 and fr["n_stale"] == 1 and fr["stalest_h"] >= 199


def test_research_synthesis_bundle_and_template(research_env, db, factory, monkeypatch):
    """The holistic synthesis assembles every plane and narrates via the template when LLM is off."""
    from app.services import finnhub, research_synthesis
    monkeypatch.setattr(research_synthesis.settings, "LLM_ENABLED", False)  # force the computed path
    _seed_holdings(factory)
    finnhub.save_cache(DOMAIN, {"HELD1": {"available": True, "next_earnings": "2026-06-18", "revision": 0.4}})
    out = research_synthesis.synthesize(db, DOMAIN)
    assert out["source"] == "template"
    assert "not investment advice" in out["narrative"].lower()
    b = out["bundle"]
    assert set(b) >= {"portfolio", "alerts", "sector", "names_to_watch"}
    assert b["portfolio"]["n_positions"] >= 1
    # The sector block carries the rotation temperature; holdings carry their flags.
    assert "rotation_temperature_0_100" in b["sector"]
    assert any(h.get("flags") for h in b["portfolio"]["holdings"])


def test_build_spotlights_and_highlight_parsing():
    """Deterministic spotlights from a bundle + AI HIGHLIGHTS parsing (pure, no DB)."""
    from app.services import research_synthesis as rsyn
    bundle = {
        "portfolio": {"holdings": [
            {"ticker": "USAR", "weight_pct": 13.3, "flags": ["below_cost", "large_position"],
             "next_earnings": None, "days_to_earnings": None},
            {"ticker": "NB", "weight_pct": 6.2, "flags": [], "next_earnings": "2026-06-20", "days_to_earnings": 3},
        ]},
        "alerts": [{"severity": "high", "type": "dilution_watch", "ticker": "USAR", "message": "x"}],
        "sector": {"rotation_temperature_0_100": 34, "stage": "Stirring",
                   "commodity_context": {"commodity_3mo_change": 0.038}},
        "names_to_watch": [{"ticker": "LAC", "next_earnings": "2026-08-12", "days_to_earnings": 56}],
    }
    spots = rsyn.build_spotlights(bundle)
    ids = [s["id"] for s in spots]
    assert ids == ["concentration", "risk_flags", "sector_gauge", "earnings_runway"]
    rf = next(s for s in spots if s["id"] == "risk_flags")
    assert rf["ticker"] == "USAR" and any(c["label"] == "dilution" for c in rf["flags"])  # alert folded in
    er = next(s for s in spots if s["id"] == "earnings_runway")
    assert [e["ticker"] for e in er["events"]] == ["NB", "LAC"]   # held + watch, nearest first

    clean, hl = rsyn._parse_highlights(
        "Para.\nInformational only, not investment advice.\nHIGHLIGHTS: risk_flags, sector_gauge, bogus", ids)
    assert hl == ["risk_flags", "sector_gauge"] and "HIGHLIGHTS" not in clean
    clean2, hl2 = rsyn._parse_highlights("just prose", ids)
    assert hl2 is None and clean2 == "just prose"

    # AI-curation fallback: order spotlights by where the model emphasises each topic in prose.
    spots = [{"id": "concentration", "type": "concentration", "items": [{"ticker": "USAR"}]},
             {"id": "risk_flags", "type": "risk_flags", "ticker": "USAR"},
             {"id": "sector_gauge", "type": "sector_gauge"},
             {"id": "earnings_runway", "type": "earnings_runway"}]
    narr = "The sector backdrop is stirring with copper firming. USAR shows dilution risk. Earnings are months out."
    inferred = rsyn._infer_highlights(narr, spots)
    assert inferred[0] == "sector_gauge"                       # 'sector' is mentioned first
    assert {"risk_flags", "earnings_runway"} <= set(inferred)
    assert rsyn._infer_highlights("nothing relevant here", spots) is None


def test_finnhub_tripwire_alerts_from_cache(research_env, db, factory):
    """Finnhub earnings/revision cache surfaces as additive research alerts (source=finnhub)."""
    from app.services import finnhub
    _seed_holdings(factory)
    finnhub.save_cache(DOMAIN, {
        "HELD1": {"available": True, "next_earnings": "2026-06-18", "revision": 0.5},  # 5d after TODAY
    })
    alerts = rj.get_alerts(db, domain=DOMAIN, today=TODAY)
    by = {(a["type"], a["ticker"]): a for a in alerts}
    assert ("earnings_soon", "HELD1") in by
    assert "5d" in by[("earnings_soon", "HELD1")]["message"]
    assert by[("earnings_soon", "HELD1")]["source"] == "finnhub"
    assert ("revision_up", "HELD1") in by
    assert by[("revision_up", "HELD1")]["source"] == "finnhub"


# ── Universe ──────────────────────────────────────────────────────────────
def test_universe_marks_held_and_sorts(research_env, db, factory):
    _seed_holdings(factory)
    rows = rj.get_universe(db, domain=DOMAIN, today=TODAY)
    assert len(rows) == 5
    assert rows[0]["conviction"] >= rows[-1]["conviction"]  # desc by conviction
    held = {r["ticker"] for r in rows if r["held"]}
    assert "HELD1" in held and "WATCH1" not in held


def test_parse_price():
    assert rj.parse_price("~$28") == 28.0
    assert rj.parse_price("~$80 ADS") == 80.0
    assert rj.parse_price("~$1.9") == 1.9
    assert rj.parse_price("~$1,234.5") == 1234.5
    assert rj.parse_price(42) == 42.0
    assert rj.parse_price(None) is None
    assert rj.parse_price("n/a") is None


def test_price_targets_and_current_price_surface(research_env, db, factory):
    _seed_holdings(factory)
    # Universe row carries targets + a parsed current price from fundamentals.
    rows = rj.get_universe(db, domain=DOMAIN, today=TODAY)
    h1 = next(r for r in rows if r["id"] == "HELD1")
    assert h1["price_targets"]["base"] == 40
    assert h1["current_price"] == 25.0  # parsed from "~$25"
    # Held position carries a LIVE per-share price (market_value / quantity).
    pr = rj.get_position_research(db, domain=DOMAIN, today=TODAY)
    held1 = next(p for p in pr["positions"] if p["ticker"] == "HELD1")
    assert held1["research"]["price_targets"]["high"] == 55
    assert held1["position"]["current_price"] == 37.5  # 60000 / 1600


def test_record_snapshots_appends_heartbeat(research_env):
    n = store.record_snapshots(DOMAIN)
    assert n == 5  # one per entity in the test doc
    rows = store.read_history(DOMAIN)
    assert len(rows) >= 5
    assert any(r["id"] == "HELD1" and r["conviction"] == 90 for r in rows)


def test_universe_filters(research_env, db, factory):
    _seed_holdings(factory)
    assert all(r["tier"] == 3 for r in rj.get_universe(db, domain=DOMAIN, tier=3, today=TODAY))
    assert all(r["conviction"] >= 80 for r in rj.get_universe(db, domain=DOMAIN, min_conviction=80, today=TODAY))
    held_rows = rj.get_universe(db, domain=DOMAIN, held_only=True, today=TODAY)
    assert {r["ticker"] for r in held_rows} == {"HELD1", "HELD2", "NEWT", "AMBIGX"}


# ── Universe-review apply: remove_entity + decisions sidecar ────────────────
def test_remove_entity_drops_and_persists(research_env):
    before = store.load_domain(DOMAIN)
    n0 = len(before["entities"])
    res = store.remove_entity(DOMAIN, "WATCH1", updated_by="universe-review")
    assert res["removed"] is True and res["ticker"] == "WATCH1"
    after = store.load_domain(DOMAIN)
    assert len(after["entities"]) == n0 - 1
    assert all(e.get("id") != "WATCH1" for e in after["entities"])
    # doc still validates after the write
    store.validate(after)


def test_remove_entity_matches_by_ticker_and_raises_when_absent(research_env):
    # match by ticker even though the id differs (NEWT's id is ALIASD)
    res = store.remove_entity(DOMAIN, "NEWT")
    assert res["removed"] is True and res["id"] == "ALIASD"
    with pytest.raises(store.ResearchNotFound):
        store.remove_entity(DOMAIN, "NOPE")


def test_universe_decisions_roundtrip_and_restore(research_env):
    assert store.load_universe_decisions(DOMAIN) == {"ignored": {}, "kept": {}}
    store.record_universe_decision(DOMAIN, "tsla", "ignored", reason="off-theme")
    store.record_universe_decision(DOMAIN, "ddd", "kept", reason="still good")
    dec = store.load_universe_decisions(DOMAIN)
    assert "TSLA" in dec["ignored"] and dec["ignored"]["TSLA"]["reason"] == "off-theme"
    assert "DDD" in dec["kept"]
    # restore removes it
    store.record_universe_decision(DOMAIN, "TSLA", "ignored", restore=True)
    assert "TSLA" not in store.load_universe_decisions(DOMAIN)["ignored"]


def test_universe_decision_bad_bucket_raises(research_env):
    with pytest.raises(store.ResearchValidationError):
        store.record_universe_decision(DOMAIN, "AAA", "garbage")


def test_upsert_entities_batch_adds_in_one_write(research_env):
    n0 = len(store.load_domain(DOMAIN)["entities"])
    new = [
        {"id": "NEWA", "ticker": "NEWA", "name": "New A", "domain": DOMAIN,
         "security_type": "equity", "scores": {"factors": {}, "conviction": 55, "upside": 40}},
        {"id": "NEWB", "ticker": "NEWB", "name": "New B", "domain": DOMAIN,
         "security_type": "equity", "scores": {"factors": {}, "conviction": 41, "upside": 42}},
    ]
    res = store.upsert_entities(DOMAIN, new, updated_by="universe-review")
    assert res["count"] == 2 and set(res["written"]) == {"NEWA", "NEWB"}
    after = store.load_domain(DOMAIN)
    assert len(after["entities"]) == n0 + 2
    store.validate(after)
    # an existing id merges instead of duplicating
    res2 = store.upsert_entities(DOMAIN, [{"id": "NEWA", "ticker": "NEWA", "name": "New A",
        "domain": DOMAIN, "security_type": "equity",
        "scores": {"factors": {}, "conviction": 70, "upside": 50}}])
    assert res2["count"] == 1
    a = next(e for e in store.load_domain(DOMAIN)["entities"] if e["id"] == "NEWA")
    assert a["scores"]["conviction"] == 70
    assert len([e for e in store.load_domain(DOMAIN)["entities"] if e["id"] == "NEWA"]) == 1


def test_remove_entities_batch(research_env):
    n0 = len(store.load_domain(DOMAIN)["entities"])
    res = store.remove_entities(DOMAIN, ["WATCH1", "newt", "nope"], updated_by="universe-review")
    # WATCH1 by id, NEWT by ticker; "nope" skipped
    assert res["count"] == 2 and set(res["removed"]) == {"WATCH1", "ALIASD"}
    after = store.load_domain(DOMAIN)
    assert len(after["entities"]) == n0 - 2
    store.validate(after)


def test_remove_entities_empty_is_noop(research_env):
    n0 = len(store.load_domain(DOMAIN)["entities"])
    res = store.remove_entities(DOMAIN, [])
    assert res["count"] == 0 and res["remaining"] == n0
