"""Read-only scheduled runner + daily digest (Sprint 3 — no live trading).

The single entry point a scheduled job calls. It runs one read-only cycle (Analyst → sizer
→ guardrails), records the result to the decision log and the activity event stream (so the
tab, the live timeline, and the Trading Floor all reflect real scheduled runs), and builds a
human-readable digest. **It places nothing** — there is no broker write anywhere in here;
the only thing that can trade is a separate, human-armed step.
"""
from __future__ import annotations

import time
from datetime import datetime, timezone
from typing import Optional

from .bridge import CyclePlan, plan_strategy_cycle, record_cycle
from .candidates import make_candidate_provider
from .events import EventLog, plan_to_events
from .guardrails import GuardrailConfig, _no_wash_sale
from .sizing import SizingConfig
from .state import AgentState
from .strategy import StrategyConfig


def build_digest(plan: CyclePlan, *, strategy: Optional[str] = None,
                 domain: Optional[str] = None, account_value: Optional[float] = None,
                 scoreboard: Optional[str] = None) -> str:
    """A concise, shareable summary of a read-only cycle (for a daily digest)."""
    lines = [f"Agent Trading — read-only digest · {plan.as_of}"]
    if strategy:
        lines.append(f"strategy: {strategy}" + (f" · universe: {domain}" if domain else ""))
    if account_value is not None:
        lines.append(f"account value: ${account_value:,.2f}")
    if scoreboard:
        lines.append(scoreboard)

    if plan.halted:
        lines.append(f"HALTED — {plan.halt_reason}; nothing considered.")
        return "\n".join(lines)

    if plan.drift:
        lines.append("drift vs log: " + ", ".join(f"{d['ticker']} {d['delta']:+g}" for d in plan.drift))

    if plan.approved:
        lines.append(f"Would consider ({len(plan.approved)}):")
        for p in plan.approved:
            a = p.order_args
            size = f"${a['amount']:.2f}" if "amount" in a else f"{a['quantity']:g} sh"
            lines.append(f"  • {a['side']} {a['symbol']} {size} — {p.decision.rationale}")
    else:
        lines.append("Would consider: nothing cleared the rules today.")

    if plan.blocked:
        lines.append(f"Vetoed ({len(plan.blocked)}):")
        for o in plan.blocked:
            lines.append(f"  • {o.decision.action} {o.decision.ticker} — {'; '.join(o.guardrail.reasons)}")

    lines.append("Read-only — nothing placed. (Going live is a separate, human-armed step.)")
    return "\n".join(lines)


def run_readonly_cycle(
    *,
    account_number: str,
    portfolio,
    positions,
    quotes_payload=None,
    domain: Optional[str],
    strategy_profile: Optional[str] = None,
    sizing: Optional[SizingConfig] = None,
    config: Optional[GuardrailConfig] = None,
    persisted: Optional[AgentState] = None,
    log_path=None,
    events_path=None,
    state_store=None,
    wash_sale_lookup=None,
    account_value: Optional[float] = None,
    as_of: Optional[str] = None,
    candidate_provider_factory=make_candidate_provider,
    scoreboard: bool = True,
    prices: Optional[dict] = None,
    momentum_fn=None,
) -> dict:
    """Run one read-only cycle, persist + emit it, and return {plan, digest, cycle_id}.

    The strategy profile resolves from ``strategy_profile`` → persisted state → "signal_event".
    Cowork supplies the Robinhood read payloads; this never writes to the broker.
    """
    config = config or GuardrailConfig.conservative()
    persisted = persisted if persisted is not None else (state_store.load() if state_store else AgentState())
    profile = strategy_profile or (persisted.strategy or "signal_event")
    as_of = as_of or datetime.now(timezone.utc).date().isoformat()

    plan = plan_strategy_cycle(
        account_number=account_number, portfolio=portfolio, positions=positions,
        quotes_payload=quotes_payload, domain=domain,
        strategy=StrategyConfig(profile=profile), sizing=sizing, config=config,
        persisted=persisted, wash_sale_lookup=wash_sale_lookup or _no_wash_sale,
        as_of=as_of, candidate_provider_factory=candidate_provider_factory,
    )

    # read-only: no fills. Record to the decision log + persist policy state.
    record_cycle(plan, fills=None, log_path=log_path, state_store=state_store)

    cycle_id = f"cycle-{int(time.time())}"
    if events_path:
        EventLog(events_path).append_all(
            plan_to_events(plan, cycle_id=cycle_id, cash=account_value))

    # one-line backtest scoreboard (which profile is winning) — best-effort, never fatal
    board = None
    if scoreboard:
        px = prices
        if px is None and domain:
            try:
                from app.services import research_store as _rs
                px = _rs.load_prices(domain)
            except Exception:
                px = None
        if px:
            try:
                from .backtest import compare_profiles, scoreboard_line
                results = compare_profiles(px, starting_cash=account_value or 1000.0,
                                           momentum_fn=momentum_fn)
                board = scoreboard_line(results)
            except Exception:
                board = None

    digest = build_digest(plan, strategy=profile, domain=domain,
                          account_value=account_value, scoreboard=board)
    return {"plan": plan, "digest": digest, "cycle_id": cycle_id, "strategy": profile}
