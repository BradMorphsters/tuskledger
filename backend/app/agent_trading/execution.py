"""Execution adapter — the only place an approved order becomes a real trade.

Two entry points, both designed so Claude is never the one that places a trade:

* :func:`run_live_cycle` — READ the bound sleeve, run the Analyst → freshness gate →
  guardrail gate, and QUEUE the gate-approved orders for approval. It places nothing; safe to
  run on a schedule.
* :func:`place_approved_proposal` — called by the backend (the bound Robinhood agent) *after
  the user approved a proposal in the app*. It refuses while paused/halted, places via the
  broker, records the fill, and alerts on failure. It only ever acts on a proposal the user
  has already moved to ``approved`` — there is no path from "proposed" straight to "placed".

The broker is injected. With a ``SimulatedBroker`` this whole module runs with no money and no
network (that's how the tests exercise it); a live ``RobinhoodMCPBroker`` in ``MODE_LIVE`` is a
deliberate human arm, wired at deploy time — never constructed by the app on its own.
"""
from __future__ import annotations

import json
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from . import alerts
from .brokers import BrokerError
from .guardrails import GuardrailConfig, ProposedOrder
from .proposals import APPROVED, ProposalStore, generate_proposals
from .sizing import SizingConfig, size_decisions
from .state import AgentState, StateStore
from .strategy import StrategyConfig
from .strategy import propose as propose_strategy


@dataclass
class ExecutionResult:
    ok: bool
    status: str          # placed | refused | failed
    proposal_id: str
    fill: Optional[dict] = None
    reason: str = ""


def _format_exc(e: BaseException) -> str:
    """Flatten an exception — including anyio/asyncio ExceptionGroups — into a readable string so
    the *real* sub-exception (e.g. the broker/MCP rejection) surfaces instead of a vague wrapper."""
    import builtins
    eg = getattr(builtins, "BaseExceptionGroup", None)
    parts: list[str] = []

    def walk(x):
        if eg is not None and isinstance(x, eg):
            for sub in x.exceptions:
                walk(sub)
        else:
            parts.append(f"{type(x).__name__}: {x}")

    walk(e)
    return " | ".join(parts) or f"{type(e).__name__}: {e}"


def _order_from_proposal(p) -> ProposedOrder:
    """Reconstruct the ProposedOrder from exactly what the user approved (its ``order_args``),
    so placement is a faithful replay, not a re-decision."""
    a = p.order_args or {}
    ref = float(p.est_price or 0.0)
    if "amount" in a:
        return ProposedOrder(ticker=p.ticker, side=p.side, ref_price=ref, notional=float(a["amount"]))
    qty = a.get("quantity", p.qty)
    return ProposedOrder(ticker=p.ticker, side=p.side, ref_price=ref,
                         qty=float(qty) if qty is not None else None)


def _append_log(log_path, proposal, fill) -> None:
    row = {
        "as_of": proposal.as_of, "ts": datetime.now(timezone.utc).isoformat(),
        "decision": {"ticker": proposal.ticker, "action": proposal.side,
                     "ref_price": proposal.est_price, "rationale": proposal.rationale},
        "status": "executed", "guardrail": None,
        "fill": asdict(fill), "error": "", "proposal_id": proposal.id,
    }
    p = Path(log_path)
    p.parent.mkdir(parents=True, exist_ok=True)
    with p.open("a") as fh:
        fh.write(json.dumps(row) + "\n")


def place_approved_proposal(
    proposal,
    *,
    broker,
    proposal_store: ProposalStore,
    state_store: Optional[StateStore] = None,
    log_path=None,
    alert_log: Optional[alerts.AlertLog] = None,
    now: Optional[str] = None,
    max_age_minutes: Optional[float] = 120.0,
) -> ExecutionResult:
    """Place an order the user already APPROVED. Refuses while paused/halted, refuses a proposal
    older than ``max_age_minutes`` (its price snapshot has gone stale), and alerts on failure.

    Raises ``ValueError`` if the proposal isn't in ``approved`` state — there is intentionally no
    way to place something the user hasn't approved."""
    if proposal.status != APPROVED:
        raise ValueError(f"proposal {proposal.id} is {proposal.status}, not approved — refusing to place")
    now = now or datetime.now(timezone.utc).isoformat()

    # Kill-switch parity: a manual pause or a drawdown halt blocks placement outright.
    if state_store is not None:
        st = state_store.load()
        if st.halted or st.paused:
            why = "halted (drawdown breaker — re-arm to resume)" if st.halted else "paused"
            msg = f"{proposal.ticker}: not placed — loop is {why}."
            if alert_log:
                alert_log.emit(alerts.paused_skip(msg))
            return ExecutionResult(ok=False, status="refused", proposal_id=proposal.id, reason=msg)

    # Staleness window: the approval carries an approval-time price; don't place against it once
    # it's gone stale (regenerate for a fresh quote). Mirrors the stale-data gate on entry.
    if max_age_minutes is not None and proposal.created_at:
        try:
            age_min = (datetime.fromisoformat(now) - datetime.fromisoformat(proposal.created_at)).total_seconds() / 60.0
        except ValueError:
            age_min = 0.0
        if age_min > max_age_minutes:
            msg = (f"{proposal.ticker}: not placed — proposal is {age_min:.0f} min old "
                   f"(> {max_age_minutes:.0f}); regenerate for a fresh price.")
            if alert_log:
                alert_log.emit(alerts.stale_proposal(proposal.ticker, msg))
            return ExecutionResult(ok=False, status="refused", proposal_id=proposal.id, reason=msg)

    try:
        # Faithful replay: place EXACTLY the approved order_args when the broker supports it
        # (the live broker), so the limit price/type the user approved is what's sent. The sim
        # broker fills from the reconstructed ProposedOrder.
        if hasattr(broker, "place_raw"):
            fill = broker.place_raw(proposal.order_args)
        else:
            fill = broker.place_order(_order_from_proposal(proposal))
    except Exception as e:  # noqa: BLE001 — ANY placement failure (broker, network, MCP) becomes a
        # clean failed-result + alert, never a 500. The proposal stays approved so it can be retried.
        msg = _format_exc(e)
        if alert_log:
            alert_log.emit(alerts.placement_failed(proposal.ticker, msg))
        return ExecutionResult(ok=False, status="failed", proposal_id=proposal.id, reason=msg)

    # Prefer the broker's real order id as the placement reference (so the queue links to the
    # actual Robinhood order); fall back to venue:ts for the sim broker.
    placed_ref = getattr(fill, "order_id", "") or f"{fill.venue}:{fill.ts}"
    proposal_store.mark_placed(proposal.id, placed_ref, now=now, state=getattr(fill, "state", "filled"))
    if log_path:
        _append_log(log_path, proposal, fill)
    # The order was ACCEPTED by the broker. Whether it has *filled* yet is a separate question:
    # "filled"/"partially_filled" = executed; anything else = accepted-but-queued (will fill
    # shortly for a market order). Report that distinction via status so the UI can colour it.
    executed = getattr(fill, "is_filled", True)
    return ExecutionResult(
        ok=True,
        status="placed" if executed else "queued",
        proposal_id=proposal.id,
        fill=asdict(fill),
    )


def run_live_cycle(
    *,
    broker,
    domain: Optional[str],
    proposal_store: ProposalStore,
    prices: dict,
    entities_by_ticker: dict,
    strategy: Optional[StrategyConfig] = None,
    guardrails: Optional[GuardrailConfig] = None,
    sizing: Optional[SizingConfig] = None,
    order_policy=None,
    candidate_provider_factory=None,
    state_store: Optional[StateStore] = None,
    today: Optional[str] = None,
    now_epoch: Optional[float] = None,
    max_price_age_hours: float = 48.0,
    require_fresh_research: bool = True,
    alert_log: Optional[alerts.AlertLog] = None,
) -> dict:
    """Read the bound sleeve → Analyst → freshness gate → guardrail gate → QUEUE for approval.

    Places nothing. Wrapped so any failure becomes a ``cycle_error`` alert instead of a silent
    break. ``candidate_provider_factory`` and the data dicts are injectable for tests."""
    import time as _time

    from .bridge import plan_cycle
    from .candidates import freshness_skips, holdings_from_state, make_candidate_provider

    today = today or datetime.now(timezone.utc).date().isoformat()
    now_epoch = now_epoch if now_epoch is not None else _time.time()
    factory = candidate_provider_factory or make_candidate_provider
    strat = strategy or StrategyConfig()
    grc = guardrails or GuardrailConfig()
    account_number = getattr(broker, "account_number", "agentic")

    try:
        snapshot = broker.snapshot()
        holdings = holdings_from_state(snapshot)
        candidates = factory(domain, holdings, today=today)([], today)

        skips = freshness_skips(candidates, prices, entities_by_ticker, now_epoch=now_epoch,
                                today=today, max_price_age_hours=max_price_age_hours,
                                require_fresh_research=require_fresh_research)
        fresh = [c for c in candidates if c.held or c.ticker not in skips]

        decisions = propose_strategy(fresh, strat)
        decisions = size_decisions(decisions, snapshot, sizing or SizingConfig())

        persisted = state_store.load() if state_store is not None else AgentState()
        plan = plan_cycle(account_number=account_number, snapshot=snapshot, decisions=decisions,
                          config=grc, persisted=persisted, order_policy=order_policy, as_of=today)
        if state_store is not None:
            state_store.save(plan.state)
    except Exception as e:  # noqa: BLE001 — a broken cycle must alert, not vanish
        if alert_log:
            alert_log.emit(alerts.cycle_error(f"live cycle failed: {type(e).__name__}: {e}"))
        return {"ok": False, "error": str(e), "queued": 0, "skipped": []}

    if alert_log:
        if plan.halted:
            if "drawdown" in (plan.halt_reason or ""):
                alert_log.emit(alerts.drawdown_halt(plan.drawdown, grc.max_drawdown_pct))
            else:
                alert_log.emit(alerts.paused_skip(f"cycle produced nothing — {plan.halt_reason}"))
        for o in plan.blocked:
            alert_log.emit(alerts.guardrail_block(o.decision.ticker, list(o.guardrail.reasons)))

    cycle_id, queued = generate_proposals(proposal_store, plan)
    return {
        "ok": True, "cycle_id": cycle_id, "halted": plan.halted, "halt_reason": plan.halt_reason,
        "queued": len(queued), "blocked": len(plan.blocked),
        "skipped": [{"ticker": t, "reason": r} for t, r in sorted(skips.items())],
    }
