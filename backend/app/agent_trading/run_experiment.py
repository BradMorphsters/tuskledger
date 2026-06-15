"""Run the agentic-trading loop end-to-end in SIMULATED mode.

No money, no broker connection, no API keys. It seeds a paper account, runs a few cycles
against scripted prices through the real guardrail gate, and prints what executed, what
was blocked (and why), and the final account state.

    cd backend
    python -m app.agent_trading.run_experiment
    python -m app.agent_trading.run_experiment --budget 250 --cycles 5 --log /tmp/agent.jsonl

This is Phase 0 from docs/agent-trading-tab.md: prove the gate vetoes what it should and
the decision log is legible before anything is ever armed for live trading.
"""
from __future__ import annotations

import argparse
import datetime
from pathlib import Path

from .brokers import SimulatedBroker
from .decisions import StubDecisionSource
from .executor import AgentTradingExecutor
from .guardrails import GuardrailConfig
from .wash_sale import make_wash_sale_lookup


def _demo_wash_sale_lookup():
    """The REAL §1091 check, driven by a tiny seeded 'main account' history.

    NVDA was bought 40 days ago and sold 10 days ago at a loss. The agent — blind to
    this main-account history — wants to re-buy NVDA, which would disallow that loss.
    The same engine that powers the Trading Tax page makes the call (no hardcoded ticker).
    """
    today = datetime.date.today()
    seed = {
        "NVDA": [
            {"date": today - datetime.timedelta(days=40), "plaid_security_id": "NVDA",
             "symbol": "NVDA", "type": "buy", "quantity": 1.0, "price": 150.0, "fees": 0.0},
            {"date": today - datetime.timedelta(days=10), "plaid_security_id": "NVDA",
             "symbol": "NVDA", "type": "sell", "quantity": 1.0, "price": 120.0, "fees": 0.0},
        ],
    }

    def fetch(symbol, since):
        return [t for t in seed.get(symbol.upper(), []) if t["date"] >= since]

    return make_wash_sale_lookup(fetch, get_today=lambda: today)


def main() -> int:
    ap = argparse.ArgumentParser(description="Simulated agentic-trading experiment")
    ap.add_argument("--budget", type=float, default=300.0, help="paper account starting cash")
    ap.add_argument("--cycles", type=int, default=3, help="number of trading cycles to run")
    ap.add_argument("--log", type=str, default="", help="optional JSONL decision-log path")
    ap.add_argument("--block-wash-sales", action="store_true", help="hard-veto wash-sale flags")
    args = ap.parse_args()

    watchlist = ["ROAR", "HMNI", "NVDA"]

    # A small scripted universe. ROAR drifts up; one oversized order is scripted to prove
    # the per-order cap fires; NVDA trips the wash-sale hook.
    prices = {"ROAR": 10.0, "HMNI": 25.0, "NVDA": 120.0}
    script = {
        "ROAR": {"action": "buy", "notional": 80.0, "rationale": "momentum continuation"},
        "HMNI": {"action": "buy", "notional": 600.0, "rationale": "OVERSIZED on purpose — should be blocked"},
        "NVDA": {"action": "buy", "notional": 50.0, "rationale": "dip buy (wash-sale risk in main acct)"},
    }

    broker = SimulatedBroker(starting_cash=args.budget)
    source = StubDecisionSource(prices, script=script)
    config = GuardrailConfig.conservative()
    if args.block_wash_sales:
        config = GuardrailConfig(
            allowlist=config.allowlist,
            blocklist=config.blocklist,
            per_order_max_notional=config.per_order_max_notional,
            max_position_pct=config.max_position_pct,
            cash_floor_pct=config.cash_floor_pct,
            max_trades_per_day=config.max_trades_per_day,
            max_drawdown_pct=config.max_drawdown_pct,
            block_on_wash_sale=True,
        )

    log_path = Path(args.log) if args.log else None
    execu = AgentTradingExecutor(
        broker, source, config,
        log_path=log_path,
        wash_sale_lookup=_demo_wash_sale_lookup(),
    )

    print(f"== Simulated agentic-trading experiment ==")
    print(f"budget=${args.budget:,.2f}  cycles={args.cycles}  "
          f"block_wash_sales={config.block_on_wash_sale}\n")

    for c in range(1, args.cycles + 1):
        broker.reset_day()
        # nudge ROAR up each cycle so concentration/drawdown logic has something to chew on
        prices["ROAR"] = round(prices["ROAR"] * 1.03, 2)
        source = StubDecisionSource(prices, script=script)
        execu.source = source

        report = execu.run_cycle(watchlist, as_of=f"2026-06-{14 + c:02d}")
        print(report.summary())
        for o in report.outcomes:
            if o.status == "executed" and o.fill:
                f = o.fill
                print(f"   ✓ {f.side:<4} {f.qty:>7.3f} {f.ticker:<5} @ ${f.price:>7.2f}  (${f.notional:,.2f})")
            elif o.status == "blocked" and o.guardrail:
                print(f"   ✗ {o.decision.action:<4} {o.decision.ticker:<5} blocked: {'; '.join(o.guardrail.reasons)}")
            elif o.status == "halted":
                print(f"   ‖ {o.decision.ticker:<5} not placed (loop halted)")
            elif o.status == "error":
                print(f"   ! {o.decision.ticker:<5} broker error: {o.error}")
        # surface warnings (e.g. wash-sale notes when not hard-blocking)
        for o in report.outcomes:
            if o.guardrail and o.guardrail.warnings:
                print(f"     ⚠ {o.decision.ticker}: {'; '.join(o.guardrail.warnings)}")
        print()

    state = broker.snapshot()
    print("== Final paper account ==")
    print(f"cash      ${state.cash:,.2f}")
    print(f"value     ${state.total_value():,.2f}   (peak ${state.equity_peak:,.2f})")
    for tkr, pos in state.positions.items():
        mkt = pos.qty * state.prices.get(tkr, pos.avg_price)
        print(f"  {tkr:<5} {pos.qty:>7.3f} @ avg ${pos.avg_price:>7.2f}  -> ${mkt:,.2f}")
    if log_path:
        print(f"\ndecision log -> {log_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
