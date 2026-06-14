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
    assert len(seed["entities"]) == 60


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


def test_signal_alerts_absent_when_caches_cold(research_env, db, factory):
    """Single-source self-disabling: no flow/filing alerts when caches are cold."""
    _seed_holdings(factory)
    alerts = rj.get_alerts(db, domain=DOMAIN, today=TODAY)
    types = {a["type"] for a in alerts}
    assert not ({"flow_contract", "flow_darkpool", "dilution_watch", "insider_cluster"} & types)


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
