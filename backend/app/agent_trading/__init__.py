"""Agentic trading experiment harness.

A self-contained, DB-free closed loop for the Agent Trading tab (see
``docs/agent-trading-tab.md``). The pieces:

* ``decisions``  — where trade proposals come from (TradingAgents adapter + a stub).
* ``guardrails`` — the pre-trade gate that can veto an order before it reaches a broker.
* ``brokers``    — execution backends: ``SimulatedBroker`` (experiment default) and a
  gated ``RobinhoodMCPBroker`` that refuses to run unless a human arms it with a live
  Robinhood Trading MCP client.
* ``executor``   — wires the three together into a run-one-cycle loop with a drawdown halt.

Nothing here funds an account, authenticates a broker, or arms live execution; that is
always a human step. In simulated mode the whole thing runs with no money and no keys.
"""
from __future__ import annotations

from .brokers import (
    Fill,
    SimulatedBroker,
    RobinhoodMCPBroker,
    BrokerError,
    MODE_DISARMED,
    MODE_READ_ONLY,
    MODE_LIVE,
    parse_account_state,
)
from .decisions import Decision, StubDecisionSource
from .executor import AgentTradingExecutor, CycleReport, OrderOutcome
from .guardrails import (
    AccountState,
    GuardrailConfig,
    GuardrailResult,
    Position,
    ProposedOrder,
    check_order,
)
from .wash_sale import (
    assess_wash_sale,
    make_db_wash_sale_lookup,
    make_wash_sale_lookup,
)
from .state import AgentState, ReconcileResult, StateStore, reconcile
from .sizing import SizingConfig, rebalance, size_decision, size_decisions
from .lifecycle import (
    classify_fill,
    client_order_id,
    find_duplicates,
    is_market_open,
    market_session,
    validate_symbol,
)
from .events import EventLog, make_event, plan_to_events
from .strategy import (
    Candidate,
    StrategyConfig,
    StrategyDecisionSource,
    propose as propose_strategy,
)
from .candidates import build_candidates, holdings_from_state, make_candidate_provider
from .runner import build_digest, run_readonly_cycle
from .backtest import BacktestResult, backtest, backtest_report, compare_profiles, scoreboard_line
from .bridge import (
    CyclePlan,
    PlannedOrder,
    build_order_args,
    cycle_log_rows,
    plan_cycle,
    plan_from_payloads,
    plan_strategy_cycle,
    record_cycle,
    render_plan,
)

__all__ = [
    "AccountState",
    "AgentState",
    "AgentTradingExecutor",
    "BrokerError",
    "CyclePlan",
    "CycleReport",
    "Decision",
    "PlannedOrder",
    "build_order_args",
    "cycle_log_rows",
    "plan_cycle",
    "plan_from_payloads",
    "plan_strategy_cycle",
    "record_cycle",
    "render_plan",
    "Fill",
    "GuardrailConfig",
    "GuardrailResult",
    "MODE_DISARMED",
    "MODE_LIVE",
    "MODE_READ_ONLY",
    "OrderOutcome",
    "Position",
    "ProposedOrder",
    "ReconcileResult",
    "RobinhoodMCPBroker",
    "SimulatedBroker",
    "SizingConfig",
    "StateStore",
    "StubDecisionSource",
    "rebalance",
    "size_decision",
    "size_decisions",
    "assess_wash_sale",
    "check_order",
    "make_db_wash_sale_lookup",
    "make_wash_sale_lookup",
    "reconcile",
]
