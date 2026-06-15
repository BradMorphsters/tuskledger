"""Agent-activity events — the live "watch it think" stream.

Best-practice pattern (AG-UI / LangSmith): emit structured execution events as a cycle
runs, stream them to the UI over SSE, render them as a trace timeline. This module is the
*model + store* for those events; the SSE transport lives in the router.

An event is a small JSON object:
    { seq, ts, cycle_id, type, label, status, detail }

``type`` mirrors the run lifecycle: cycle_started → read → parsed → (per order: decision →
sized → gate_check… → approved|blocked|skipped) → [halted] → cycle_completed.
``status`` drives the UI color: running | ok | blocked | halted | warn | info.

Events append to a JSONL file (default ``var/agent_trading/events.jsonl``); the SSE endpoint
tails it. Pure stdlib — the translation from a CyclePlan to events is deterministic and
testable without a server.
"""
from __future__ import annotations

import json
import time
from dataclasses import asdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterator, Optional

from .bridge import CyclePlan


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def make_event(cycle_id: str, seq: int, type_: str, label: str,
               status: str = "info", detail: str = "", **extra) -> dict:
    ev = {"seq": seq, "ts": _now(), "cycle_id": cycle_id, "type": type_,
          "label": label, "status": status, "detail": detail}
    ev.update(extra)
    return ev


def plan_to_events(plan: CyclePlan, *, cycle_id: str, cash: Optional[float] = None,
                   positions: Optional[int] = None) -> list[dict]:
    """Translate a planned cycle into the ordered event stream the UI renders.

    Deterministic: same plan → same events. The per-order gate checks become sub-events so
    the timeline can show exactly which guardrail passed or vetoed, the way a trace viewer
    expands a span.
    """
    evs: list[dict] = []
    n = 0

    def add(type_, label, status="info", detail="", **extra):
        nonlocal n
        evs.append(make_event(cycle_id, n, type_, label, status, detail, **extra))
        n += 1

    add("cycle_started", f"Cycle {plan.as_of} started", "running")
    add("read", "Read account from broker", "ok",
        detail=(f"cash ${cash:,.2f}" if cash is not None else "")
        + (f", {positions} positions" if positions is not None else ""))
    if plan.drift:
        add("read", "Reconcile vs decision log", "warn",
            detail="drift: " + ", ".join(f"{d['ticker']} {d['delta']:+g}" for d in plan.drift))
    else:
        add("read", "Reconcile vs decision log", "ok", detail="no drift")

    if plan.halted:
        add("halted", "Loop halted", "halted", detail=plan.halt_reason)
        add("cycle_completed", "Cycle complete — nothing placed", "halted")
        return evs

    for p in plan.approved:
        a = p.order_args
        size = f"${a['amount']:.2f}" if "amount" in a else f"{a['quantity']:g} sh"
        add("decision", f"Considering {a['side']} {a['symbol']}", "running",
            detail=p.decision.rationale, ticker=a["symbol"])
        add("sized", f"Sized {a['symbol']} → {size}", "info", ticker=a["symbol"])
        for c in p.guardrail.checks:
            add("gate_check", c.name, "ok" if c.passed else "blocked",
                detail="" if c.passed else c.detail, ticker=a["symbol"])
        for w in p.guardrail.warnings:
            add("gate_check", "wash_sale_risk", "warn", detail=w, ticker=a["symbol"])
        add("approved", f"APPROVED {a['side']} {a['symbol']} {size}", "ok",
            detail="ready to place (awaiting human arm)", ticker=a["symbol"])

    for o in plan.blocked:
        d = o.decision
        add("decision", f"Considering {d.action} {d.ticker}", "running",
            detail=d.rationale, ticker=d.ticker)
        for c in o.guardrail.checks:
            if not c.passed:
                add("gate_check", c.name, "blocked", detail=c.detail, ticker=d.ticker)
        add("blocked", f"BLOCKED {d.action} {d.ticker}", "blocked",
            detail="; ".join(o.guardrail.reasons), ticker=d.ticker)

    for d in plan.skipped:
        add("skipped", f"Skipped {d.ticker} (hold)", "info", ticker=d.ticker)

    add("cycle_completed",
        f"Cycle complete — {len(plan.approved)} approved, {len(plan.blocked)} blocked", "ok")
    return evs


class EventLog:
    """Append-only JSONL store the SSE endpoint tails."""

    def __init__(self, path: str | Path):
        self.path = Path(path)

    def append(self, event: dict) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.path.open("a") as fh:
            fh.write(json.dumps(event) + "\n")

    def append_all(self, events: list[dict]) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.path.open("a") as fh:
            for e in events:
                fh.write(json.dumps(e) + "\n")

    def read_all(self) -> list[dict]:
        if not self.path.exists():
            return []
        out = []
        for line in self.path.read_text().splitlines():
            line = line.strip()
            if line:
                try:
                    out.append(json.loads(line))
                except json.JSONDecodeError:
                    continue
        return out

    def read_from(self, offset: int) -> tuple[list[dict], int]:
        """Read events appended since byte ``offset``. Returns (events, new_offset). Used by
        the SSE tail loop to push only what's new."""
        if not self.path.exists():
            return ([], offset)
        out: list[dict] = []
        with self.path.open("r") as fh:
            fh.seek(offset)
            for line in fh:
                if not line.endswith("\n"):  # ignore a partially-written final line
                    break
                line = line.strip()
                if line:
                    try:
                        out.append(json.loads(line))
                    except json.JSONDecodeError:
                        pass
            new_offset = fh.tell()
        return (out, new_offset)


def demo_plan() -> tuple[CyclePlan, float, int]:
    """A sample cycle (no real account) for the live-UI demo: one approved, one blocked."""
    from .bridge import plan_cycle
    from .decisions import Decision
    from .guardrails import AccountState, GuardrailConfig
    from .state import AgentState

    snapshot = AccountState(cash=500.0, positions={}, prices={"F": 14.79, "NVDA": 212.45},
                            equity_peak=500.0, trades_today=0)
    decisions = [
        Decision("F", "buy", 14.79, target_notional=80.0, rationale="starter position, fits sleeve"),
        Decision("NVDA", "buy", 212.45, target_notional=600.0, rationale="oversized on purpose"),
    ]
    plan = plan_cycle(account_number="demo", snapshot=snapshot, decisions=decisions,
                      config=GuardrailConfig.conservative(), persisted=AgentState(),
                      as_of=datetime.now(timezone.utc).date().isoformat())
    return plan, 500.0, 0
