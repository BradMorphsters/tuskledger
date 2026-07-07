"""The Cowork↔Tusk Ledger bridge — deterministic planning, no trade capability.

See ADR-0001. Cowork is the communication layer: it reads the Agentic account from the
Robinhood MCP and places approved orders back through it. Everything *between* those two
I/O steps is this module — pure, deterministic Tusk Ledger logic that Cowork executes and
obeys.

The safety property that makes this design sound: **`plan_cycle()` cannot place an order.**
It runs reconcile + the guardrail gate over a snapshot Cowork already fetched, and returns
*approved order arguments* (ready to hand to `place_equity_order`) plus vetoes. The only
code path that can actually trade lives in Cowork, and it only ever places what the gate
approved. The model never free-hands the rules.

Flow (ADR-0001 §"The thin loop"):
    snapshot = parse_account_state(...)        # Cowork fetched, Tusk Ledger parsed
    plan = plan_cycle(snapshot, decisions, ...)  # THIS module — gate, no trading
    for p in plan.approved: fill = place_equity_order(**p.order_args)  # Cowork only
    record_cycle(plan, fills, log_path, store)   # THIS module — log + persist
"""
from __future__ import annotations

import json
from dataclasses import asdict, dataclass, field, replace
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from .brokers import parse_account_state, parse_quotes
from .candidates import holdings_from_state, make_candidate_provider
from .decisions import Decision
from .order_policy import OrderPolicy, build_order_args, is_sub_share_limit
from .sizing import SizingConfig, size_decisions
from .strategy import StrategyConfig, StrategyDecisionSource
from .executor import OrderOutcome
from .guardrails import (
    AccountState,
    GuardrailConfig,
    GuardrailResult,
    Position,
    ProposedOrder,
    WashSaleLookup,
    _no_wash_sale,
    check_order,
)
from .state import AgentState, reconcile


# --------------------------------------------------------------------------- types

@dataclass
class PlannedOrder:
    """An order the gate APPROVED. ``order_args`` is ready for the Robinhood
    ``place_equity_order`` MCP tool — but this module never calls it."""

    decision: Decision
    order_args: dict
    guardrail: GuardrailResult


@dataclass
class CyclePlan:
    as_of: str
    halted: bool = False
    halt_reason: str = ""
    drawdown: float = 0.0          # account drawdown this cycle (fraction); what the breaker saw
    approved: list[PlannedOrder] = field(default_factory=list)
    blocked: list[OrderOutcome] = field(default_factory=list)
    skipped: list[Decision] = field(default_factory=list)
    drift: list[dict] = field(default_factory=list)
    state: AgentState = field(default_factory=AgentState)

    def approved_order_args(self) -> list[dict]:
        """Exactly what Cowork should place — nothing more."""
        return [p.order_args for p in self.approved]

    def summary(self) -> str:
        if self.halted:
            return f"[{self.as_of}] HALTED — {self.halt_reason}; approving nothing"
        drift = f" · ⚠ {len(self.drift)} drift" if self.drift else ""
        return (f"[{self.as_of}] approved {len(self.approved)}, blocked {len(self.blocked)}, "
                f"skipped {len(self.skipped)}{drift}")


# --------------------------------------------------------------------------- order args
# build_order_args + OrderPolicy now live in order_policy.py (shared with the live broker so
# the planner and the executor can never disagree on how an order is constructed).


def _apply(state: AccountState, order: ProposedOrder) -> AccountState:
    """Project the effect of an approved order so the NEXT order in the same cycle sees it
    (a buy reduces cash + buying headroom for subsequent cash-floor / concentration checks).
    This mirrors the executor's per-order re-snapshot, without a broker."""
    cash = state.cash
    positions = dict(state.positions)
    prices = dict(state.prices)
    t = order.ticker.upper().strip()
    qty = order.resolved_qty()
    notional = order.resolved_notional()
    prices.setdefault(t, order.ref_price)
    if order.side.lower().strip() == "buy":
        cash -= notional
        held = positions.get(t)
        if held:
            nq = held.qty + qty
            if nq > 1e-9:
                positions[t] = Position(nq, (held.qty * held.avg_price + notional) / nq)
            else:
                # Degenerate: a ~0-qty held position + ~0-qty buy. Mirror the
                # sell path's 1e-9 guard instead of dividing by near-zero and
                # injecting an Inf/NaN avg_price into same-cycle projections.
                positions.pop(t, None)
        else:
            positions[t] = Position(qty, order.ref_price)
    else:  # sell
        held = positions.get(t)
        if held:
            remaining = held.qty - qty
            if remaining <= 1e-9:
                positions.pop(t, None)
            else:
                positions[t] = Position(remaining, held.avg_price)
        cash += notional
    return AccountState(cash=cash, positions=positions, prices=prices,
                        equity_peak=state.equity_peak, trades_today=state.trades_today + 1)


# --------------------------------------------------------------------------- plan

def plan_cycle(
    *,
    account_number: str,
    snapshot: AccountState,
    decisions: list[Decision],
    config: GuardrailConfig,
    persisted: AgentState,
    expected_positions: Optional[dict[str, float]] = None,
    executed_today: int = 0,
    wash_sale_lookup: WashSaleLookup = _no_wash_sale,
    default_notional: float = 100.0,
    order_policy: Optional[OrderPolicy] = None,
    as_of: Optional[str] = None,
) -> CyclePlan:
    """Run reconcile + the guardrail gate over a Cowork-fetched snapshot.

    Returns approved order args + vetoes. **Places nothing.** ``snapshot`` is the live
    account state (Cowork fetched it, ``parse_account_state`` parsed it); ``persisted`` is
    Tusk Ledger's policy state (equity peak, halt flag). ``order_policy`` controls how the
    approved order args are built (market vs marketable-limit); default market.
    """
    as_of = as_of or datetime.now(timezone.utc).date().isoformat()
    plan = CyclePlan(as_of=as_of, state=persisted)

    # Persisted halt/pause survives restarts — approve nothing until a human re-arms.
    if persisted.halted or persisted.paused:
        plan.halted = True
        plan.halt_reason = "paused" if persisted.paused else "halted (awaiting re-arm)"
        return plan

    rec = reconcile(snapshot, persisted,
                    expected_positions=expected_positions or {},
                    executed_today=executed_today)
    plan.state = rec.state
    plan.drift = rec.drift_dicts()
    working = rec.account_state

    # Account-level drawdown breaker.
    drawdown = 0.0
    if working.equity_peak > 0:
        drawdown = (working.equity_peak - working.total_value()) / working.equity_peak
    plan.drawdown = round(drawdown, 4)
    if drawdown > config.max_drawdown_pct:
        plan.halted = True
        plan.halt_reason = "drawdown limit hit"
        plan.state = replace(rec.state, halted=True)  # persist the trip
        return plan

    running = working
    for d in decisions:
        if d.action.lower().strip() == "hold":
            plan.skipped.append(d)
            continue
        order = ProposedOrder(
            ticker=d.ticker,
            side=d.action,
            ref_price=d.ref_price,
            notional=d.target_notional if d.target_notional is not None else default_notional,
            rationale=d.rationale,
        )
        # Sub-1-share limit orders can't place as sized (Robinhood limits are
        # whole-share) and build_order_args now REFUSES to inflate them — skip
        # here like the /proposals/generate path does, so plan_cycle callers
        # that don't pre-filter (execution, events, runner) get a skip, not a
        # ValueError mid-plan.
        if is_sub_share_limit(order, order_policy):
            plan.skipped.append(d)
            continue
        result = check_order(order, running, config, wash_sale_lookup)
        if result.ok:
            plan.approved.append(
                PlannedOrder(decision=d, order_args=build_order_args(account_number, order, policy=order_policy),
                             guardrail=result)
            )
            running = _apply(running, order)  # sequential effect for the next check
        else:
            plan.blocked.append(OrderOutcome(decision=d, status="blocked", guardrail=result))

    return plan


# --------------------------------------------------------------------------- record

def cycle_log_rows(plan: CyclePlan, fills: Optional[list] = None) -> list[dict]:
    """Serialize a planned cycle (+ the fills Cowork got back) to decision-log rows,
    matching the schema the /agent-trading tab reads. ``fills[i]`` aligns to
    ``plan.approved[i]`` — a fill dict, or None if Cowork didn't place it."""
    fills = fills or []
    ts = datetime.now(timezone.utc).isoformat()

    def base(decision, status, guardrail=None, fill=None, error=""):
        return {
            "as_of": plan.as_of, "ts": ts, "halted": plan.halted,
            "decision": asdict(decision), "status": status,
            "guardrail": guardrail.as_dict() if guardrail else None,
            "fill": fill, "error": error,
        }

    rows: list[dict] = []
    if plan.halted:
        # nothing approved; record the proposals we declined to act on
        for d in plan.skipped:
            rows.append(base(d, "halted"))
        return rows

    for i, p in enumerate(plan.approved):
        fill = fills[i] if i < len(fills) else None
        rows.append(base(p.decision, "executed" if fill else "approved",
                         guardrail=p.guardrail, fill=fill))
    for o in plan.blocked:
        rows.append(base(o.decision, "blocked", guardrail=o.guardrail))
    for d in plan.skipped:
        rows.append(base(d, "skipped"))
    return rows


def record_cycle(plan: CyclePlan, fills=None, *, log_path=None, state_store=None) -> list[dict]:
    """Append the cycle to the decision log and persist policy state. Returns the rows."""
    rows = cycle_log_rows(plan, fills)
    if log_path:
        p = Path(log_path)
        p.parent.mkdir(parents=True, exist_ok=True)
        with p.open("a") as fh:
            for r in rows:
                fh.write(json.dumps(r) + "\n")
    if state_store is not None:
        state_store.save(plan.state)
    return rows


# --------------------------------------------------------------------------- read-only cycle

def plan_from_payloads(
    *,
    account_number: str,
    portfolio,
    positions,
    quotes_payload=None,
    decisions: list[Decision],
    config: GuardrailConfig,
    persisted: AgentState,
    expected_positions: Optional[dict[str, float]] = None,
    executed_today: int = 0,
    wash_sale_lookup: WashSaleLookup = _no_wash_sale,
    default_notional: float = 100.0,
    sizing: Optional[SizingConfig] = None,
    vols: Optional[dict[str, float]] = None,
    as_of: Optional[str] = None,
) -> CyclePlan:
    """One call for the read-only cycle: PARSE (step 2) + [SIZE] + GATE (step 3).

    Cowork fetches the three Robinhood read payloads (``get_portfolio``,
    ``get_equity_positions``, ``get_equity_quotes``) and hands them straight here. This
    parses them into an AccountState, optionally sizes the decisions (``sizing``), and runs
    the gate. **It places nothing** — it returns a plan. Cowork stops here in read-only
    mode; placing approved orders (step 4) is a separate, explicit, human-armed action.
    """
    quotes = parse_quotes(quotes_payload) if quotes_payload else {}
    snapshot = parse_account_state(portfolio, positions, quotes, account_number=account_number)
    if sizing is not None:
        decisions = size_decisions(decisions, snapshot, sizing, vols=vols)
    return plan_cycle(
        account_number=account_number, snapshot=snapshot, decisions=decisions, config=config,
        persisted=persisted, expected_positions=expected_positions, executed_today=executed_today,
        wash_sale_lookup=wash_sale_lookup, default_notional=default_notional, as_of=as_of,
    )


def plan_strategy_cycle(
    *,
    account_number: str,
    portfolio,
    positions,
    quotes_payload=None,
    domain: Optional[str],
    watchlist: Optional[list[str]] = None,
    strategy: Optional[StrategyConfig] = None,
    sizing: Optional[SizingConfig] = None,
    config: GuardrailConfig,
    persisted: AgentState,
    expected_positions: Optional[dict[str, float]] = None,
    executed_today: int = 0,
    wash_sale_lookup: WashSaleLookup = _no_wash_sale,
    as_of: Optional[str] = None,
    candidate_provider_factory=make_candidate_provider,
) -> CyclePlan:
    """The full read-only cycle, Analyst-driven: READ payloads → PARSE → ANALYST → SIZE → GATE.

    Cowork fetches the Robinhood read payloads; this parses them, builds the Analyst's
    candidate rows from the research/signals/price caches (overlaying the live holdings so
    exits can fire), runs the configured strategy profile to decide *what + why*, sizes the
    survivors, and gates them. **It places nothing** — it returns a plan. The provider
    factory is injectable for tests.
    """
    quotes = parse_quotes(quotes_payload) if quotes_payload else {}
    snapshot = parse_account_state(portfolio, positions, quotes, account_number=account_number)
    holdings = holdings_from_state(snapshot)

    provider = candidate_provider_factory(domain, holdings)
    strat = strategy or StrategyConfig()
    source = StrategyDecisionSource(strat, provider)
    as_of = as_of or datetime.now(timezone.utc).date().isoformat()
    decisions = source.get_decisions(watchlist or [], as_of)

    # the Analyst leaves size to the sizer — apply it (default fixed-fractional)
    decisions = size_decisions(decisions, snapshot, sizing or SizingConfig())

    return plan_cycle(
        account_number=account_number, snapshot=snapshot, decisions=decisions, config=config,
        persisted=persisted, expected_positions=expected_positions, executed_today=executed_today,
        wash_sale_lookup=wash_sale_lookup, as_of=as_of,
    )


def render_plan(plan: CyclePlan) -> str:
    """A human-readable read-only report of a planned cycle. No side effects."""
    lines = [plan.summary()]
    if plan.drift:
        lines.append("  drift vs log: " + ", ".join(
            f"{d['ticker']} {d['delta']:+g}" for d in plan.drift))
    if plan.halted:
        return "\n".join(lines)
    for p in plan.approved:
        a = p.order_args
        size = f"${a['amount']:.2f}" if "amount" in a else f"{a['quantity']:g} sh"
        lines.append(f"  ✓ APPROVED  {a['side']} {a['symbol']} {size}")
    for o in plan.blocked:
        lines.append(f"  ✗ BLOCKED   {o.decision.action} {o.decision.ticker}: "
                     f"{'; '.join(o.guardrail.reasons)}")
    for d in plan.skipped:
        lines.append(f"  – skipped   {d.ticker} (hold)")
    lines.append("  (read-only — nothing placed. Executing the APPROVED orders is a "
                 "separate, human-armed step.)")
    return "\n".join(lines)
