"""End-to-end: the Analyst wired into the read-only cycle.

plan_strategy_cycle ties snapshot → candidate provider → strategy → sizer → guardrails into
one plan. The candidate provider is injected so the test runs without research files. It
still places nothing — it returns a plan.
"""
from __future__ import annotations

from app.agent_trading import (
    AgentState,
    Candidate,
    GuardrailConfig,
    SizingConfig,
    StrategyConfig,
    plan_strategy_cycle,
)

# Robinhood read payloads (real shapes): $1,000 cash, no positions.
PORTFOLIO = {"data": {"cash": "1000", "buying_power": {"buying_power": "1000.0000"}}}
POSITIONS = {"data": {"positions": []}}


def _factory(candidates):
    """A candidate_provider_factory that ignores domain/holdings and yields fixed rows."""
    return lambda domain, holdings: (lambda watchlist, as_of: candidates)


def test_momentum_cycle_proposes_and_gates_from_analyst():
    cands = [
        Candidate("USAR", price=23.0, research_score=0.92, trend_up=True, momentum=0.53),
        Candidate("DOWN", price=10.0, research_score=0.90, trend_up=False, momentum=-0.10),  # not uptrend
    ]
    plan = plan_strategy_cycle(
        account_number="test-001", portfolio=PORTFOLIO, positions=POSITIONS,
        domain="critical-minerals", watchlist=["USAR", "DOWN"],
        strategy=StrategyConfig(profile="momentum"),
        sizing=SizingConfig(method="fixed_fractional", fraction=0.10),
        config=GuardrailConfig.conservative(), persisted=AgentState(), as_of="2026-06-16",
        candidate_provider_factory=_factory(cands),
    )
    # USAR (uptrend) was considered, sized to ~10% ($100), and approved; DOWN never proposed
    approved = {p.order_args["symbol"] for p in plan.approved}
    assert "USAR" in approved and "DOWN" not in approved
    args = next(p.order_args for p in plan.approved if p.order_args["symbol"] == "USAR")
    # 10% of $1,000 = $100 → $100 / $23 ref ≈ 4.347826 shares (fractional quantity, no dollar amount)
    assert args["side"] == "buy" and args["quantity"] == round(100.0 / 23.0, 6) and "amount" not in args


def test_quiet_signals_propose_nothing():
    # signal_event with no signal strength -> Analyst proposes nothing -> empty plan
    cands = [Candidate("USAR", price=23.0, research_score=0.92, signal_score=0.0)]
    plan = plan_strategy_cycle(
        account_number="test-001", portfolio=PORTFOLIO, positions=POSITIONS,
        domain="critical-minerals", watchlist=["USAR"],
        strategy=StrategyConfig(profile="signal_event"),
        config=GuardrailConfig.conservative(), persisted=AgentState(), as_of="2026-06-16",
        candidate_provider_factory=_factory(cands),
    )
    assert plan.approved == [] and plan.blocked == []   # honest: nothing forced
