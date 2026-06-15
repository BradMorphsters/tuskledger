"""The loop: decisions -> guardrail gate -> broker -> decision log.

One :meth:`AgentTradingExecutor.run_cycle` call is one pass: pull proposals, mark the
broker with their reference prices, check the account-level drawdown halt, then gate and
(maybe) execute each order. Everything — proposals, the full guardrail trace, fills, and
blocks — is appended to a JSONL decision log, which is what the Agent Trading tab's
activity feed and the daily digest read.

**The broker is the source of truth** for cash and positions (Robinhood once live). When a
:class:`~app.agent_trading.state.StateStore` is supplied, the executor additionally
carries forward the policy state Robinhood can't know — the equity high-water mark and the
halt flag — and reconciles the broker snapshot against the decision log to surface drift.

The executor never arms anything. Whether it can move real money depends entirely on which
broker it was handed.
"""
from __future__ import annotations

import json
from dataclasses import asdict, dataclass, field, replace
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional, Protocol, Sequence

from .brokers import BrokerError, Fill
from .decisions import Decision, DecisionSource
from .guardrails import (
    AccountState,
    GuardrailConfig,
    GuardrailResult,
    ProposedOrder,
    WashSaleLookup,
    check_order,
    _no_wash_sale,
)
from .state import StateStore, reconcile


class Broker(Protocol):
    def place_order(self, order: ProposedOrder) -> Fill: ...
    def snapshot(self) -> AccountState: ...


@dataclass
class OrderOutcome:
    decision: Decision
    status: str  # "executed" | "blocked" | "skipped" | "error" | "halted"
    guardrail: Optional[GuardrailResult] = None
    fill: Optional[Fill] = None
    error: str = ""

    def to_log(self) -> dict:
        return {
            "decision": asdict(self.decision),
            "status": self.status,
            "guardrail": self.guardrail.as_dict() if self.guardrail else None,
            "fill": asdict(self.fill) if self.fill else None,
            "error": self.error,
        }


@dataclass
class CycleReport:
    as_of: str
    ts: str
    halted: bool
    outcomes: list[OrderOutcome] = field(default_factory=list)
    drift: list[dict] = field(default_factory=list)
    halt_reason: str = ""

    @property
    def executed(self) -> list[OrderOutcome]:
        return [o for o in self.outcomes if o.status == "executed"]

    @property
    def blocked(self) -> list[OrderOutcome]:
        return [o for o in self.outcomes if o.status in ("blocked", "halted")]

    def summary(self) -> str:
        ex, bl = len(self.executed), len(self.blocked)
        head = f"HALTED — {self.halt_reason or 'drawdown'}; placed nothing" if self.halted else "ran"
        drift = f" · ⚠ {len(self.drift)} drift" if self.drift else ""
        return f"[{self.as_of}] {head}: {ex} executed, {bl} blocked, {len(self.outcomes)} proposals{drift}"


class AgentTradingExecutor:
    def __init__(
        self,
        broker: Broker,
        source: DecisionSource,
        config: GuardrailConfig,
        *,
        log_path: Optional[str | Path] = None,
        wash_sale_lookup: WashSaleLookup = _no_wash_sale,
        default_notional: float = 100.0,
        state_store: Optional[StateStore] = None,
    ):
        self.broker = broker
        self.source = source
        self.config = config
        self.log_path = Path(log_path) if log_path else None
        self.wash_sale_lookup = wash_sale_lookup
        self.default_notional = default_notional
        self.state_store = state_store
        # cycle-scoped policy overlay; None on the no-store path (broker provides its own)
        self._peak: Optional[float] = None
        self._trades_base: int = 0
        self._placed: int = 0

    # ------------------------------------------------------------------ cycle
    def run_cycle(self, watchlist: Sequence[str], as_of: str) -> CycleReport:
        report = CycleReport(as_of=as_of, ts=datetime.now(timezone.utc).isoformat(), halted=False)

        decisions = self.source.get_decisions(watchlist, as_of)

        # Mark the broker with the analysts' reference prices so valuation (and thus the
        # drawdown + concentration checks) reflects the latest marks.
        prices = {d.ticker: d.ref_price for d in decisions if d.ref_price > 0}
        if hasattr(self.broker, "mark_prices"):
            self.broker.mark_prices(prices)  # type: ignore[attr-defined]

        # --- reconcile against the source of truth (broker) + persisted policy state ---
        self._peak, self._trades_base, self._placed = None, 0, 0
        persisted = None
        if self.state_store is not None:
            persisted = self.state_store.load()
            # A persisted halt/pause survives restarts — refuse to trade until re-armed.
            if persisted.halted or persisted.paused:
                report.halted = True
                report.halt_reason = "paused" if persisted.paused else "halted (awaiting re-arm)"
                self._halt_all(report, decisions)
                self._write(report)
                return report

            live = self.broker.snapshot()
            rows = self._read_log_rows()
            expected = self._expected_positions(rows)
            executed_today = sum(
                1 for r in rows if r.get("status") == "executed" and r.get("as_of") == as_of
            )
            rec = reconcile(live, persisted, expected_positions=expected, executed_today=executed_today)
            self._peak = rec.account_state.equity_peak
            self._trades_base = executed_today
            report.drift = rec.drift_dicts()
            self.state_store.save(rec.state)
            working = rec.account_state
        else:
            working = self.broker.snapshot()

        # Account-level drawdown halt: evaluate once, up front. If tripped, place nothing.
        if self._drawdown_tripped(working):
            report.halted = True
            report.halt_reason = "drawdown limit hit"
            self._halt_all(report, decisions)
            if self.state_store is not None:
                self.state_store.mark_halted()  # stays halted across restarts until re-armed
            self._write(report)
            return report

        for d in decisions:
            report.outcomes.append(self._handle_decision(d))

        # Persist any new high-water mark reached by this cycle's fills.
        if self.state_store is not None and persisted is not None:
            final_value = self.broker.snapshot().total_value()
            new_peak = max(self._peak or 0.0, final_value)
            self.state_store.save(replace(self.state_store.load(), equity_peak=new_peak))

        self._write(report)
        return report

    # ------------------------------------------------------------------ helpers
    def _handle_decision(self, d: Decision) -> OrderOutcome:
        if d.action.lower() == "hold":
            return OrderOutcome(decision=d, status="skipped")

        order = ProposedOrder(
            ticker=d.ticker,
            side=d.action,
            ref_price=d.ref_price,
            notional=d.target_notional if d.target_notional is not None else self.default_notional,
            rationale=d.rationale,
        )

        # Re-snapshot before each order so sequential trades in one cycle see prior fills
        # (a buy earlier in the loop reduces cash for the next check).
        state = self._state_for_order()
        result = check_order(order, state, self.config, self.wash_sale_lookup)
        if not result.ok:
            return OrderOutcome(decision=d, status="blocked", guardrail=result)

        try:
            fill = self.broker.place_order(order)
        except BrokerError as exc:
            return OrderOutcome(decision=d, status="error", guardrail=result, error=str(exc))
        self._placed += 1
        return OrderOutcome(decision=d, status="executed", guardrail=result, fill=fill)

    def _state_for_order(self) -> AccountState:
        """Per-order account state. Cash/positions/prices always come from the broker
        (source of truth). When a store is active, peak + trades_today are the persisted
        policy values, not the broker's own bookkeeping."""
        live = self.broker.snapshot()
        if self._peak is None:  # no-store path — broker provides peak/trades_today
            return live
        return AccountState(
            cash=live.cash,
            positions=live.positions,
            prices=live.prices,
            equity_peak=max(self._peak, live.total_value()),
            trades_today=self._trades_base + self._placed,
        )

    def _drawdown_tripped(self, state: AccountState) -> bool:
        if state.equity_peak <= 0:
            return False
        drawdown = (state.equity_peak - state.total_value()) / state.equity_peak
        return drawdown > self.config.max_drawdown_pct

    @staticmethod
    def _halt_all(report: CycleReport, decisions: Sequence[Decision]) -> None:
        for d in decisions:
            report.outcomes.append(OrderOutcome(decision=d, status="halted"))

    def _read_log_rows(self) -> list[dict]:
        if not self.log_path or not self.log_path.exists():
            return []
        from app.services import agent_trading_log as atl
        return atl.load_rows(self.log_path)

    @staticmethod
    def _expected_positions(rows: list[dict]) -> dict[str, float]:
        from app.services import agent_trading_log as atl
        return {p["ticker"]: p["qty"] for p in atl.positions(rows)}

    def _write(self, report: CycleReport) -> None:
        if not self.log_path:
            return
        self.log_path.parent.mkdir(parents=True, exist_ok=True)
        with self.log_path.open("a") as fh:
            for outcome in report.outcomes:
                row = {"as_of": report.as_of, "ts": report.ts, "halted": report.halted}
                row.update(outcome.to_log())
                fh.write(json.dumps(row) + "\n")
