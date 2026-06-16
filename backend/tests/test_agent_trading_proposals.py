"""Tests for the human-in-the-loop approval queue — pure model, transitions, and the atomic
store. The key safety property under test: a proposal can only move pending → approved/rejected,
never around the user, and a stale (expired) proposal can't be acted on."""
from __future__ import annotations

from types import SimpleNamespace

import pytest

from app.agent_trading.decisions import Decision
from app.agent_trading.proposals import (
    APPROVED,
    EXPIRED,
    PENDING,
    PLACED,
    REJECTED,
    ProposalStore,
    apply_decision,
    generate_proposals,
    is_expired,
    proposals_from_plan,
)

T0 = "2026-06-15T00:00:00+00:00"


def _planned(ticker, side, amount=200.0, price=10.0, reasons=None):
    d = Decision(ticker=ticker, action=side, ref_price=price, target_notional=amount,
                 rationale=f"{side} {ticker} — rule fired")
    args = {"account_number": "x", "symbol": ticker, "side": side, "type": "market", "amount": amount}
    return SimpleNamespace(decision=d, order_args=args, guardrail=SimpleNamespace(reasons=reasons or []))


def _plan(approved, halted=False):
    return SimpleNamespace(halted=halted, as_of="2026-06-15", approved=approved)


# --------------------------------------------------------------------------- pure model

def test_proposals_from_plan_maps_approved_orders():
    plan = _plan([_planned("NB", "buy", 171.0, 5.4), _planned("COPX", "sell", 300.0, 90.0)])
    props = proposals_from_plan(plan, cycle_id="c1", now=T0)
    by = {p.ticker: p for p in props}
    assert set(by) == {"NB", "COPX"}
    assert by["NB"].side == "buy" and by["NB"].status == PENDING and by["NB"].est_notional == 171.0
    assert by["NB"].order_args["symbol"] == "NB"          # exact placement args preserved
    assert by["COPX"].side == "sell"


def test_halted_plan_queues_nothing():
    assert proposals_from_plan(_plan([_planned("NB", "buy")], halted=True), cycle_id="c1") == []


def test_decision_is_pending_only_and_records_actor():
    p = proposals_from_plan(_plan([_planned("NB", "buy")]), cycle_id="c1")[0]
    approved = apply_decision(p, "approve", by="user", now=T0)
    assert approved.status == APPROVED and approved.decided_by == "user" and approved.decided_at == T0
    with pytest.raises(ValueError):       # already decided — cannot flip again
        apply_decision(approved, "reject")


def test_expired_proposal_cannot_be_decided():
    p = proposals_from_plan(_plan([_planned("NB", "buy")]), cycle_id="c1", now=T0, ttl_minutes=60)[0]
    assert is_expired(p, "2026-06-15T02:00:00+00:00")
    with pytest.raises(ValueError):
        apply_decision(p, "approve", now="2026-06-15T02:00:00+00:00")


# --------------------------------------------------------------------------- store

def test_store_roundtrip_and_decide(tmp_path):
    store = ProposalStore(tmp_path / "p.json")
    props = proposals_from_plan(_plan([_planned("NB", "buy"), _planned("SETM", "buy", 250, 35)]), cycle_id="c1")
    assert store.add(props) == 2
    assert len(store.list(status=PENDING)) == 2
    store.decide(props[0].id, "approve")
    assert store.get(props[0].id).status == APPROVED
    assert len(store.list(status=PENDING)) == 1
    assert store.counts()[APPROVED] == 1


def test_store_marks_stale_pending_as_expired_and_blocks_it(tmp_path):
    store = ProposalStore(tmp_path / "p.json")
    store.add(proposals_from_plan(_plan([_planned("NB", "buy")]), cycle_id="c1", now=T0, ttl_minutes=30))
    shown = store.list(now="2026-06-15T01:00:00+00:00")
    assert shown[0].status == EXPIRED
    with pytest.raises(ValueError):       # the store refuses to act on a stale order
        store.decide(shown[0].id, "approve", now="2026-06-15T01:00:00+00:00")


def test_new_cycle_supersedes_old_pending(tmp_path):
    store = ProposalStore(tmp_path / "p.json")
    store.add(proposals_from_plan(_plan([_planned("NB", "buy")]), cycle_id="c1"))
    generate_proposals(store, _plan([_planned("SETM", "buy", 250, 35)]), cycle_id="c2")
    pend = {p.ticker for p in store.list(status=PENDING)}
    assert pend == {"SETM"}                # last cycle's pending is what the user acts on


def test_mark_placed_requires_prior_approval(tmp_path):
    store = ProposalStore(tmp_path / "p.json")
    props = proposals_from_plan(_plan([_planned("NB", "buy")]), cycle_id="c1")
    store.add(props)
    with pytest.raises(ValueError):       # can't place something the user never approved
        store.mark_placed(props[0].id, "ord-1")
    store.decide(props[0].id, "approve")
    placed = store.mark_placed(props[0].id, "ord-1")
    assert placed.status == PLACED and placed.placed_ref == "ord-1"
