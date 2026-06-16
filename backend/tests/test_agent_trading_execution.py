"""Tests for the execution adapter — place-on-approval and the read-only live cycle, all against
the SimulatedBroker (no money, no network). The safety invariants under test: never place
something not approved, refuse while paused/halted, and alert on failure."""
from __future__ import annotations

import pytest

from app.agent_trading.alerts import AlertLog
from app.agent_trading.brokers import SimulatedBroker
from app.agent_trading.execution import place_approved_proposal, run_live_cycle
from app.agent_trading.guardrails import GuardrailConfig
from app.agent_trading.proposals import APPROVED, PENDING, PLACED, Proposal, ProposalStore
from app.agent_trading.sizing import SizingConfig
from app.agent_trading.state import AgentState, StateStore
from app.agent_trading.strategy import Candidate, StrategyConfig


def _queue_pending(store, *, ticker="NB", side="buy", amount=100.0, price=5.0, qty=None):
    args = {"account_number": "x", "symbol": ticker, "side": side, "type": "market"}
    if qty is not None:
        args["quantity"] = qty
    else:
        args["amount"] = amount
    p = Proposal(id="p1", cycle_id="c1", as_of="2026-06-16", ticker=ticker, side=side,
                 order_args=args, est_price=price, est_notional=amount, qty=qty,
                 status=PENDING, created_at="2026-06-16T00:00:00+00:00",
                 expires_at="2999-01-01T00:00:00+00:00")
    store.add([p])
    return p


def test_place_approved_fills_and_marks_placed(tmp_path):
    store = ProposalStore(tmp_path / "p.json")
    _queue_pending(store)
    store.decide("p1", "approve", now="2026-06-16T00:05:00+00:00")
    broker = SimulatedBroker(starting_cash=1000.0)
    res = place_approved_proposal(store.get("p1"), broker=broker, proposal_store=store,
                                  now="2026-06-16T00:06:00+00:00")
    assert res.ok and res.status == "placed"
    assert store.get("p1").status == PLACED and store.get("p1").placed_ref.startswith("sim:")


def test_refuses_while_paused_and_alerts(tmp_path):
    store = ProposalStore(tmp_path / "p.json")
    _queue_pending(store)
    store.decide("p1", "approve")
    ss = StateStore(tmp_path / "s.json"); ss.save(AgentState(paused=True))
    alog = AlertLog(tmp_path / "a.jsonl")
    res = place_approved_proposal(store.get("p1"), broker=SimulatedBroker(1000.0),
                                  proposal_store=store, state_store=ss, alert_log=alog)
    assert not res.ok and res.status == "refused"
    assert store.get("p1").status == APPROVED          # NOT placed
    assert any(r["kind"] == "paused_skip" for r in alog.read_all())


def test_broker_error_alerts_and_leaves_approved(tmp_path):
    store = ProposalStore(tmp_path / "p.json")
    _queue_pending(store, ticker="ZZ", side="sell", qty=5.0)   # sell nothing held → BrokerError
    store.decide("p1", "approve", now="2026-06-16T00:05:00+00:00")
    alog = AlertLog(tmp_path / "a.jsonl")
    res = place_approved_proposal(store.get("p1"), broker=SimulatedBroker(1000.0),
                                  proposal_store=store, alert_log=alog, now="2026-06-16T00:06:00+00:00")
    assert not res.ok and res.status == "failed"
    assert store.get("p1").status == APPROVED
    assert any(r["kind"] == "placement_failed" for r in alog.read_all())


def test_cannot_place_unapproved(tmp_path):
    store = ProposalStore(tmp_path / "p.json")
    _queue_pending(store)                                  # still pending, not approved
    with pytest.raises(ValueError):
        place_approved_proposal(store.get("p1"), broker=SimulatedBroker(1000.0), proposal_store=store)


def test_refuses_stale_approved_proposal(tmp_path):
    store = ProposalStore(tmp_path / "p.json")
    _queue_pending(store)  # created_at = 2026-06-16T00:00:00Z
    store.decide("p1", "approve", now="2026-06-16T00:05:00+00:00")
    alog = AlertLog(tmp_path / "a.jsonl")
    res = place_approved_proposal(store.get("p1"), broker=SimulatedBroker(1000.0), proposal_store=store,
                                  alert_log=alog, now="2026-06-16T05:00:00+00:00", max_age_minutes=120)
    assert not res.ok and res.status == "refused" and "old" in res.reason
    assert store.get("p1").status == APPROVED                       # NOT placed
    assert any(r["kind"] == "stale_proposal" for r in alog.read_all())


class _RawBroker:
    """A broker exposing place_raw, to prove the live path replays the approved args verbatim."""
    def __init__(self):
        self.placed = None

    def place_raw(self, args):
        from app.agent_trading.brokers import Fill
        self.placed = dict(args)
        return Fill(ticker=args["symbol"], side=args["side"], qty=args.get("quantity") or 0,
                    price=args.get("limit_price") or 0, notional=args.get("amount") or 0,
                    ts="t", venue="robinhood")


def test_place_raw_replays_exact_approved_args(tmp_path):
    store = ProposalStore(tmp_path / "p.json")
    args = {"account_number": "x", "symbol": "NB", "side": "buy", "type": "limit",
            "quantity": 10, "limit_price": 5.55}
    p = Proposal(id="p1", cycle_id="c1", as_of="2026-06-16", ticker="NB", side="buy",
                 order_args=args, est_price=5.5, est_notional=55.0, qty=10, status=PENDING,
                 created_at="2026-06-16T00:00:00+00:00", expires_at="2999-01-01T00:00:00+00:00")
    store.add([p])
    store.decide("p1", "approve", now="2026-06-16T00:01:00+00:00")
    br = _RawBroker()
    res = place_approved_proposal(store.get("p1"), broker=br, proposal_store=store,
                                  now="2026-06-16T00:02:00+00:00")
    assert res.ok and store.get("p1").status == PLACED
    # the exact approved limit price/type were sent — not recomputed from a policy
    assert br.placed["limit_price"] == 5.55 and br.placed["type"] == "limit"


def test_run_live_cycle_reads_and_queues_without_placing(tmp_path):
    store = ProposalStore(tmp_path / "p.json")
    broker = SimulatedBroker(starting_cash=2000.0)

    def factory(domain, holdings, *, today=None):
        def provider(watchlist, as_of):
            return [Candidate("NB", 5.0, research_score=0.9, trend_up=True, momentum=0.2),
                    Candidate("MP", 10.0, research_score=0.9, trend_up=True, momentum=0.2)]
        return provider

    prices = {"NB": {"fetched_at": 9e9}, "MP": {"fetched_at": 9e9}}  # fresh
    out = run_live_cycle(
        broker=broker, domain="d", proposal_store=store, prices=prices, entities_by_ticker={},
        strategy=StrategyConfig(profile="momentum"),
        guardrails=GuardrailConfig(per_order_max_notional=1e9),
        sizing=SizingConfig(method="fixed_fractional", fraction=0.10),
        candidate_provider_factory=factory, today="2026-06-16", now_epoch=1.0,
    )
    assert out["ok"] and out["queued"] >= 1
    assert len(store.list(status=PENDING)) >= 1
    # nothing placed — the broker never traded
    assert broker.snapshot().trades_today == 0


def test_run_live_cycle_skips_stale_names(tmp_path):
    store = ProposalStore(tmp_path / "p.json")
    broker = SimulatedBroker(starting_cash=2000.0)

    def factory(domain, holdings, *, today=None):
        def provider(watchlist, as_of):
            return [Candidate("STALE", 5.0, research_score=0.9, trend_up=True, momentum=0.2)]
        return provider

    prices = {"STALE": {"fetched_at": 0.0}}   # epoch 0 → ancient vs now_epoch
    out = run_live_cycle(
        broker=broker, domain="d", proposal_store=store, prices=prices, entities_by_ticker={},
        strategy=StrategyConfig(profile="momentum"),
        candidate_provider_factory=factory, today="2026-06-16",
        now_epoch=1_000_000_000.0, max_price_age_hours=48,
    )
    assert out["queued"] == 0 and any(s["ticker"] == "STALE" for s in out["skipped"])
