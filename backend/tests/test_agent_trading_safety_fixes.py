"""Safety fixes (2026-11): research drops are non-destructive and never silently force-sell a
held name; re-arm can re-baseline the drawdown peak; the drawdown breaker holds back BUYS but
lets exits through. All tickers/amounts here are fictional."""
from __future__ import annotations

import json

import pytest
from fastapi import HTTPException

from app.config import settings
from app.services import research_store as store
from app.agent_trading import (
    AccountState, AgentState, Decision, GuardrailConfig, Position, StateStore, plan_cycle,
)
from app.agent_trading.alerts import AlertLog
from app.agent_trading.brokers import SimulatedBroker
from app.agent_trading.execution import place_approved_proposal
from app.agent_trading.guardrails import ProposedOrder, check_order
from app.agent_trading.proposals import APPROVED, PENDING, Proposal, ProposalStore, proposals_from_plan
from app.agent_trading.state import reconcile
from app.agent_trading.universe_screen import screen_universe

from tests.test_research import DOMAIN, REAL_SCHEMA, _doc

ACCT = "test-agentic-001"


@pytest.fixture()
def research_env(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "RESEARCH_DIR", str(tmp_path))
    (tmp_path / "research.schema.json").write_text(REAL_SCHEMA.read_text(encoding="utf-8"), encoding="utf-8")
    (tmp_path / f"{DOMAIN}.research.json").write_text(json.dumps(_doc()), encoding="utf-8")
    return tmp_path


# ── 1. Universe drops ────────────────────────────────────────────────────────

def test_overdue_alone_is_not_a_drop():
    out = screen_universe(
        ["STRONGOLD", "WEAKOLD"], {},
        [{"ticker": "STRONGOLD", "research_score": 0.90, "stale": True},
         {"ticker": "WEAKOLD", "research_score": 0.30, "stale": True}],
        [],
    )
    assert {d["ticker"] for d in out["drop"]} == {"WEAKOLD"}
    assert out["review_overdue"] == ["STRONGOLD", "WEAKOLD"]


def test_remove_archives_and_restore_brings_it_back(research_env):
    before = {e["id"]: e for e in store.load_domain(DOMAIN)["entities"]}
    store.remove_entity(DOMAIN, "WATCH1", updated_by="universe-review")
    arch = store.load_archive(DOMAIN)
    assert arch["WATCH1"]["entity"] == before["WATCH1"]
    assert arch["WATCH1"]["removed_by"] == "universe-review"

    res = store.restore_entities(DOMAIN, ["WATCH1", "NOPE"])
    assert res["restored"] == ["WATCH1"] and res["not_archived"] == ["NOPE"]
    after = {e["id"]: e for e in store.load_domain(DOMAIN)["entities"]}
    assert after["WATCH1"] == before["WATCH1"]
    assert "WATCH1" not in store.load_archive(DOMAIN)
    store.validate(store.load_domain(DOMAIN))


def test_bulk_remove_backs_up_first_and_archives_every_name(research_env):
    original = (research_env / f"{DOMAIN}.research.json").read_text(encoding="utf-8")
    store.remove_entities(DOMAIN, ["WATCH1", "HELD1"], updated_by="universe-review")
    backups = sorted((research_env / "backups").glob(f"{DOMAIN}.research.*.json"))
    assert len(backups) == 1 and backups[0].read_text(encoding="utf-8") == original
    assert {"WATCH1", "HELD1"} <= set(store.load_archive(DOMAIN))


def test_backups_are_pruned(research_env, monkeypatch):
    monkeypatch.setattr(store, "BACKUP_KEEP", 3)
    for _ in range(5):
        store.backup_domain(DOMAIN, reason="t")
    assert len(list((research_env / "backups").glob("*.json"))) == 3


def _route(monkeypatch, held):
    from app.routers import agent_trading as r
    monkeypatch.setattr(r, "_held_tickers", lambda db: set(held))
    monkeypatch.setattr(store, "get_active_domain", lambda: DOMAIN)
    return r


def test_single_drop_of_held_name_needs_confirmation(research_env, monkeypatch):
    r = _route(monkeypatch, {"WATCH1"})
    with pytest.raises(HTTPException) as e:
        r.agent_trading_universe_decide(
            r.UniverseDecideIn(action="approve", kind="drop", ticker="WATCH1"), db=None)
    assert e.value.status_code == 409
    assert any(x["id"] == "WATCH1" for x in store.load_domain(DOMAIN)["entities"])  # untouched

    ok = r.agent_trading_universe_decide(
        r.UniverseDecideIn(action="approve", kind="drop", ticker="WATCH1", confirm_held=True), db=None)
    assert ok["applied"] == "drop"


def test_bulk_drop_skips_held_names(research_env, monkeypatch):
    r = _route(monkeypatch, {"HELD1"})
    out = r.agent_trading_universe_decide_bulk(
        r.UniverseBulkIn(action="approve", kind="drops",
                         items=[r.UniverseBulkItem(ticker="WATCH1"), r.UniverseBulkItem(ticker="HELD1")]),
        db=None)
    assert out["skipped_held"] == ["HELD1"] and out["removed"] == ["WATCH1"]
    ids = {x["id"] for x in store.load_domain(DOMAIN)["entities"]}
    assert "HELD1" in ids and "WATCH1" not in ids


# ── 2. Re-arm + peak reset ───────────────────────────────────────────────────

def test_rearm_reset_peak_rebaselines_on_next_read(tmp_path):
    ss = StateStore(tmp_path / "s.json")
    ss.save(AgentState(halted=True, equity_peak=2000.0))
    assert ss.rearm().equity_peak == 2000.0            # default keeps the old mark
    ss.save(AgentState(halted=True, equity_peak=2000.0))
    st = ss.rearm(reset_peak=True)
    assert not st.halted and st.equity_peak == 0.0
    live = AccountState(cash=200.0, positions={"AAA": Position(100, 12.0)}, prices={"AAA": 13.0},
                        equity_peak=0.0, trades_today=0)
    rec = reconcile(live, st, expected_positions={"AAA": 100}, executed_today=0)
    assert rec.state.equity_peak == pytest.approx(1500.0)   # 200 + 100 × 13


# ── 3. Drawdown holds back buys, not exits ───────────────────────────────────

def _state_in_drawdown():
    # peak 2000, now 1500 → 25% drawdown (over the 15% default)
    return AccountState(cash=500.0, positions={"AAA": Position(100, 12.0)}, prices={"AAA": 10.0},
                        equity_peak=2000.0, trades_today=0)


def test_gate_blocks_buy_but_passes_sell_in_drawdown():
    st, cfg = _state_in_drawdown(), GuardrailConfig()
    buy = check_order(ProposedOrder("BBB", "buy", 5.0, notional=50.0), st, cfg)
    sell = check_order(ProposedOrder("AAA", "sell", 10.0, qty=40), st, cfg)   # $400, under the per-order cap
    assert not buy.ok and any("no new buys" in r for r in buy.reasons)
    assert sell.ok


def _dec(t, a, price=10.0, notional=50.0):
    return Decision(ticker=t, action=a, ref_price=price, target_notional=notional, rationale=f"{a} {t}")


def test_fresh_trip_queues_exits_and_holds_back_buys():
    plan = plan_cycle(account_number=ACCT, snapshot=_state_in_drawdown(),
                      decisions=[_dec("BBB", "buy", 5.0), _dec("AAA", "sell", 10.0, 400.0)],
                      config=GuardrailConfig(), persisted=AgentState(equity_peak=2000.0), as_of="2026-11-13")
    assert plan.halted and plan.sells_only and plan.state.halted          # trip persisted
    assert [p.decision.ticker for p in plan.approved] == ["AAA"]
    assert [d.ticker for d in plan.skipped] == ["BBB"]
    props = proposals_from_plan(plan, cycle_id="c1", now="2026-11-13T12:00:00+00:00")
    assert [(p.ticker, p.side) for p in props] == [("AAA", "sell")]


def test_persisted_halt_still_allows_exits_but_pause_stops_everything():
    snap = AccountState(cash=500.0, positions={"AAA": Position(10, 10.0)}, prices={"AAA": 10.0},
                        equity_peak=0.0, trades_today=0)
    decs = [_dec("BBB", "buy", 5.0), _dec("AAA", "sell", 10.0, 100.0)]
    halted = plan_cycle(account_number=ACCT, snapshot=snap, decisions=decs, config=GuardrailConfig(),
                        persisted=AgentState(halted=True), as_of="2026-11-13")
    assert halted.sells_only and [p.decision.ticker for p in halted.approved] == ["AAA"]
    paused = plan_cycle(account_number=ACCT, snapshot=snap, decisions=decs, config=GuardrailConfig(),
                        persisted=AgentState(paused=True), as_of="2026-11-13")
    assert paused.halted and not paused.sells_only and paused.approved == []
    assert proposals_from_plan(paused, cycle_id="c2") == []


def _approved(store_, side):
    args = {"account_number": "x", "symbol": "AAA", "side": side, "type": "market", "quantity": 1}
    store_.add([Proposal(id="p1", cycle_id="c1", as_of="2026-11-13", ticker="AAA", side=side,
                         order_args=args, est_price=10.0, est_notional=10.0, qty=1, status=PENDING,
                         created_at="2026-11-13T00:00:00+00:00", expires_at="2999-01-01T00:00:00+00:00")])
    store_.decide("p1", "approve", now="2026-11-13T00:01:00+00:00")
    return store_.get("p1")


def test_placement_while_halted_refuses_buys_but_places_sells(tmp_path):
    ss = StateStore(tmp_path / "s.json"); ss.save(AgentState(halted=True))
    broker = SimulatedBroker(starting_cash=1000.0)
    buy_store = ProposalStore(tmp_path / "b.json")
    res = place_approved_proposal(_approved(buy_store, "buy"), broker=broker, proposal_store=buy_store,
                                  state_store=ss, alert_log=AlertLog(tmp_path / "a.jsonl"),
                                  now="2026-11-13T00:02:00+00:00")
    assert res.status == "refused" and buy_store.get("p1").status == APPROVED

    sell_store = ProposalStore(tmp_path / "s2.json")
    res = place_approved_proposal(_approved(sell_store, "sell"), broker=broker, proposal_store=sell_store,
                                  state_store=ss, now="2026-11-13T00:02:00+00:00")
    assert res.status != "refused"   # not stopped by the halt (the sim broker decides the rest)
