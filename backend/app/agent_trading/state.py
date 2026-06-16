"""Persistent policy state + reconciliation against the broker (the source of truth).

**Robinhood is the backbone.** Once the Agentic account is live, the broker snapshot
(positions, cash, value) is authoritative — we do not keep a parallel ledger we trust
over it. What we persist locally is only the policy/derived state Robinhood doesn't track
for us:

* the **equity high-water mark** behind the drawdown breaker (a restart must not reset an
  existing drawdown to zero), and
* the **halt / pause** flags (a tripped breaker stays tripped until a human re-arms it).

:func:`reconcile` folds the live snapshot together with that persisted state: it carries
the high-water mark forward, takes the day's trade count from our own decision log, and
flags **drift** — any gap between the positions our log expects and the positions the
broker actually reports (dividends, corporate actions, partial fills, manual trades,
rejects). Drift is surfaced, never silently corrected; the broker's numbers win.

Pure stdlib + a small atomic JSON store, so it tests without a DB or a live broker.
"""
from __future__ import annotations

import json
import os
import tempfile
from dataclasses import asdict, dataclass, field, replace
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from .guardrails import AccountState

STATE_SCHEMA = 1


def resolve_state_path(configured: str) -> Path:
    """Where the policy-state file lives. Honors the configured path, else a default
    beside the decision log (``var/agent_trading/state.json``)."""
    if configured:
        return Path(configured).expanduser()
    return Path("var/agent_trading/state.json")


@dataclass
class AgentState:
    """The only state we own. Everything else is read from the broker each cycle."""

    equity_peak: float = 0.0
    halted: bool = False          # drawdown breaker tripped; needs human re-arm
    paused: bool = False          # manual pause
    strategy: str = ""            # active Analyst profile ("" → config default)
    last_reconciled: Optional[str] = None
    schema: int = STATE_SCHEMA


@dataclass
class DriftItem:
    ticker: str
    expected_qty: float           # what our decision log says we should hold
    actual_qty: float             # what the broker actually reports
    delta: float                  # actual - expected


@dataclass
class ReconcileResult:
    account_state: AccountState   # what the guardrails should reason over this cycle
    state: AgentState             # persisted state, updated (new peak, timestamp)
    drift: list[DriftItem] = field(default_factory=list)
    new_high: bool = False

    def drift_dicts(self) -> list[dict]:
        return [asdict(d) for d in self.drift]


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def reconcile(
    live: AccountState,
    state: AgentState,
    *,
    expected_positions: dict[str, float],
    executed_today: int,
    tol: float = 1e-6,
    now: Optional[str] = None,
) -> ReconcileResult:
    """Fold the live broker snapshot together with our persisted policy state.

    ``live`` is the source of truth for cash/positions/prices. We override only the two
    things the broker can't know: the high-water ``equity_peak`` (carried forward) and
    ``trades_today`` (derived from our own log, since the cap governs *our* placements).
    """
    value = live.total_value()
    prior_peak = state.equity_peak or 0.0
    new_peak = max(prior_peak, value)
    new_high = value >= prior_peak and value > 0

    drift: list[DriftItem] = []
    tickers = set(expected_positions) | set(live.positions)
    for t in sorted(tickers):
        exp = float(expected_positions.get(t, 0.0))
        act = float(live.positions[t].qty) if t in live.positions else 0.0
        if abs(act - exp) > tol:
            drift.append(DriftItem(ticker=t, expected_qty=round(exp, 6),
                                   actual_qty=round(act, 6), delta=round(act - exp, 6)))

    account_state = AccountState(
        cash=live.cash,
        positions=live.positions,
        prices=live.prices,
        equity_peak=new_peak,
        trades_today=executed_today,
    )
    updated = replace(state, equity_peak=new_peak, last_reconciled=now or _now())
    return ReconcileResult(account_state=account_state, state=updated, drift=drift, new_high=new_high)


class StateStore:
    """Atomic JSON persistence for :class:`AgentState` (one small file beside the log)."""

    def __init__(self, path: str | Path):
        self.path = Path(path)

    def load(self) -> AgentState:
        """Return persisted state, or sensible defaults if missing/corrupt.

        A corrupt file must never wedge the loop; we fall back to defaults (which start
        the peak at 0, i.e. unconstrained until the first cycle sets it)."""
        if not self.path.exists():
            return AgentState()
        try:
            data = json.loads(self.path.read_text())
        except (json.JSONDecodeError, OSError):
            return AgentState()
        known = {f: data[f] for f in AgentState().__dict__ if f in data}
        return AgentState(**known)

    def save(self, state: AgentState) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=str(self.path.parent), suffix=".tmp")
        try:
            with os.fdopen(fd, "w") as fh:
                json.dump(asdict(state), fh, indent=2)
            os.replace(tmp, self.path)  # atomic — readers never see a half-written file
        finally:
            if os.path.exists(tmp):
                os.unlink(tmp)

    # convenience policy transitions ---------------------------------------
    def mark_halted(self) -> AgentState:
        s = replace(self.load(), halted=True)
        self.save(s)
        return s

    def rearm(self) -> AgentState:
        """Human re-arm: clear halt/pause so the loop can run again."""
        s = replace(self.load(), halted=False, paused=False)
        self.save(s)
        return s


def control_status(state: AgentState) -> str:
    """The loop's run-state for the control UI: 'halted' (breaker tripped, needs re-arm) >
    'paused' (manual stop) > 'active' (may run)."""
    if state.halted:
        return "halted"
    if state.paused:
        return "paused"
    return "active"
