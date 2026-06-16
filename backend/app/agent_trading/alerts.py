"""Failure alerting — so a silent break can't hide.

When a cycle errors, a guardrail vetoes, the drawdown breaker trips, or a placement fails,
the loop records an :class:`Alert`. The Agent tab and the daily digest read these so you find
out *something needs your attention* instead of discovering it later in the account.

Pure model + helpers (testable) over a small append-only JSONL sink, mirroring the event log.
This module never sends email/SMS itself — it's the durable record; surfacing it (UI badge,
digest line, a future push) reads from here.
"""
from __future__ import annotations

import json
import os
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

# Severity ordering for sorting/filtering.
INFO, WARNING, CRITICAL = "info", "warning", "critical"
_SEV_RANK = {CRITICAL: 0, WARNING: 1, INFO: 2}


def resolve_alerts_path(configured: str) -> Path:
    if configured:
        return Path(configured).expanduser()
    return Path("var/agent_trading/alerts.jsonl")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


@dataclass
class Alert:
    kind: str                 # cycle_error | guardrail_block | drawdown_halt | placement_failed | paused_skip
    severity: str             # info | warning | critical
    message: str
    ticker: Optional[str] = None
    detail: dict = field(default_factory=dict)
    ts: str = ""
    acknowledged: bool = False


# --------------------------------------------------------------------------- pure builders

def cycle_error(message: str, **detail) -> Alert:
    return Alert(kind="cycle_error", severity=CRITICAL, message=message, detail=detail, ts=_now())


def placement_failed(ticker: str, message: str, **detail) -> Alert:
    return Alert(kind="placement_failed", severity=CRITICAL, message=message, ticker=ticker, detail=detail, ts=_now())


def drawdown_halt(drawdown_pct: float, limit_pct: float) -> Alert:
    return Alert(kind="drawdown_halt", severity=CRITICAL,
                 message=f"Drawdown {drawdown_pct:.1%} exceeded the {limit_pct:.0%} limit — loop halted; re-arm to resume.",
                 detail={"drawdown_pct": drawdown_pct, "limit_pct": limit_pct}, ts=_now())


def guardrail_block(ticker: str, reasons: list[str]) -> Alert:
    return Alert(kind="guardrail_block", severity=WARNING,
                 message=f"{ticker}: order vetoed by the gate — {'; '.join(reasons)}",
                 ticker=ticker, detail={"reasons": reasons}, ts=_now())


def paused_skip(message: str) -> Alert:
    return Alert(kind="paused_skip", severity=INFO, message=message, ts=_now())


def stale_proposal(ticker: str, message: str) -> Alert:
    return Alert(kind="stale_proposal", severity=WARNING, message=message, ticker=ticker, ts=_now())


# --------------------------------------------------------------------------- sink

class AlertLog:
    """Append-only JSONL of alerts (newest read last)."""

    def __init__(self, path: str | Path):
        self.path = Path(path)

    def append(self, alert: Alert) -> Alert:
        if not alert.ts:
            alert.ts = _now()
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.path.open("a") as fh:
            fh.write(json.dumps(asdict(alert)) + "\n")
        return alert

    def emit(self, alert: Optional[Alert]) -> Optional[Alert]:
        """Append an alert if one was produced (convenience for ``log.emit(maybe_alert)``)."""
        return self.append(alert) if alert is not None else None

    def read_all(self) -> list[dict]:
        if not self.path.exists():
            return []
        out: list[dict] = []
        with self.path.open() as fh:
            for line in fh:
                line = line.strip()
                if line:
                    try:
                        out.append(json.loads(line))
                    except json.JSONDecodeError:
                        continue
        return out

    def recent(self, limit: int = 50, *, unacknowledged_only: bool = False) -> list[dict]:
        rows = self.read_all()
        if unacknowledged_only:
            rows = [r for r in rows if not r.get("acknowledged")]
        # newest first, then a stable sort by severity → critical first, recency preserved within.
        rows.sort(key=lambda r: r.get("ts", ""), reverse=True)
        rows.sort(key=lambda r: _SEV_RANK.get(r.get("severity"), 3))
        return rows[:limit]

    def summary(self) -> dict:
        rows = self.read_all()
        out = {"total": len(rows), "critical": 0, "warning": 0, "info": 0, "unacknowledged": 0}
        for r in rows:
            sev = r.get("severity") if r.get("severity") in (CRITICAL, WARNING, INFO) else INFO
            out[sev] += 1
            if not r.get("acknowledged"):
                out["unacknowledged"] += 1
        return out
