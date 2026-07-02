"""Human-in-the-loop approval queue — the bridge between the gate and your tap.

The read-only cycle runs the Analyst → guardrail gate and, instead of placing anything,
writes each gate-APPROVED order here as a **pending proposal**. Tusk Ledger shows the queue;
you Approve or Reject each one in the app. Approving marks it ready-to-place; the actual
placement is done by the backend (the bound Robinhood agent) and is bound to *your* approval
action — there is deliberately no agent-callable path from "seen" to "placed".

Design mirrors state.py: a pure model + transitions (testable with no IO) plus a small atomic
JSON store. A proposal carries the exact ``order_args`` the gate produced, so placement later
is a faithful replay of what you approved — not a re-decision.

Status lifecycle:
    pending ──approve──▶ approved ──(backend places)──▶ placed
        │                    │
        └──reject──▶ rejected └──(unplaced at TTL)──▶ expired
    pending ──(TTL passes)──▶ expired      (stale prices ⇒ never auto-act on an old proposal)
"""
from __future__ import annotations

import json
import os
import tempfile
import threading
import uuid
from dataclasses import asdict, dataclass, field, replace
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Optional

# One process-wide lock guarding every read→modify→write on the proposals file. os.replace makes a
# single write atomic, but each mutating store method is _read()→mutate→_write(): without this, two
# concurrent writers (e.g. an approve racing a cycle's supersede/add, or a place racing a reconcile)
# each read the same list and the last _write wins — silently reverting a `placed` back to
# `approved` or dropping a supersede. Held across the whole read→write of each mutator.
_STORE_LOCK = threading.Lock()

PENDING, APPROVED, REJECTED, PLACED, EXPIRED = "pending", "approved", "rejected", "placed", "expired"
# Two more states for the placement handshake (finding #1/#2):
#   PLACING — a broker round-trip is IN FLIGHT for this proposal. Set by an atomic approved→placing
#             compare-and-swap so a double-tap Approve during the multi-second placement is a no-op.
#   UNKNOWN — placement failed in a way that MIGHT have reached the broker (a timeout), so it can't
#             be safely retried; needs a get_equity_orders reconcile before it's actionable again.
PLACING, UNKNOWN = "placing", "unknown"
TERMINAL = {REJECTED, PLACED, EXPIRED}
DEFAULT_TTL_MIN = 24 * 60  # a proposal you haven't acted on goes stale after a day


class PlacementInFlight(Exception):
    """Raised when a placement is already in flight (or done) for a proposal — the guard against a
    double-tap Approve placing the same live order twice."""


def resolve_proposals_path(configured: str) -> Path:
    if configured:
        return Path(configured).expanduser()
    return Path("var/agent_trading/proposals.json")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def new_id() -> str:
    return uuid.uuid4().hex[:12]


@dataclass
class Proposal:
    """One gate-approved order awaiting the user's decision. ``order_args`` is exactly what the
    backend would hand to ``place_equity_order`` if (and only if) the user approves."""

    id: str
    cycle_id: str
    as_of: str
    ticker: str
    side: str                      # buy | sell
    order_args: dict               # ready for place_equity_order (symbol/side/type/amount|quantity)
    est_price: float = 0.0
    est_notional: float = 0.0
    qty: Optional[float] = None
    rationale: str = ""
    guardrail_notes: list[str] = field(default_factory=list)  # warnings the gate let through
    status: str = PENDING
    created_at: str = ""
    expires_at: str = ""
    decided_at: Optional[str] = None
    decided_by: Optional[str] = None
    placed_ref: Optional[str] = None   # broker order id once placed (set later by the backend)
    placed_state: Optional[str] = None  # broker order state at placement: filled | queued | unconfirmed | …


# --------------------------------------------------------------------------- pure model

def proposals_from_plan(plan, *, cycle_id: str, now: Optional[str] = None,
                        ttl_minutes: int = DEFAULT_TTL_MIN) -> list[Proposal]:
    """Turn a CyclePlan's gate-APPROVED orders into pending Proposals. A halted plan yields
    nothing. Pure — no IO; ``plan`` only needs ``.approved`` (list of PlannedOrder) + ``.as_of``."""
    if getattr(plan, "halted", False):
        return []
    now = now or _now()
    try:
        exp = (datetime.fromisoformat(now) + timedelta(minutes=ttl_minutes)).isoformat()
    except ValueError:
        exp = now
    out: list[Proposal] = []
    for p in getattr(plan, "approved", []) or []:
        d = p.decision
        a = dict(p.order_args)
        notional = a.get("amount")
        qty = a.get("quantity")
        est_price = float(getattr(d, "ref_price", 0.0) or 0.0)
        if notional is None and qty is not None and est_price:
            notional = round(float(qty) * est_price, 2)
        out.append(Proposal(
            id=new_id(),
            cycle_id=cycle_id,
            as_of=getattr(plan, "as_of", now[:10]),
            ticker=(d.ticker or "").upper(),
            side=(d.action or "").lower(),
            order_args=a,
            est_price=est_price,
            est_notional=float(notional or 0.0),
            qty=float(qty) if qty is not None else None,
            rationale=getattr(d, "rationale", "") or "",
            guardrail_notes=list(getattr(getattr(p, "guardrail", None), "reasons", []) or []),
            status=PENDING,
            created_at=now,
            expires_at=exp,
        ))
    return out


def is_expired(p: Proposal, now: Optional[str] = None) -> bool:
    if p.status != PENDING or not p.expires_at:
        return False
    now = now or _now()
    try:
        return now >= p.expires_at
    except TypeError:
        return False


def apply_decision(p: Proposal, action: str, *, by: str = "user", now: Optional[str] = None) -> Proposal:
    """Pure transition for an Approve/Reject. Only a *pending* (non-expired) proposal may be
    decided; anything else raises so we never act on a stale or already-resolved order."""
    action = (action or "").lower().strip()
    if action not in ("approve", "reject"):
        raise ValueError(f"unknown action {action!r}; expected approve|reject")
    now = now or _now()
    if p.status != PENDING:
        raise ValueError(f"proposal {p.id} is {p.status}, not pending — cannot {action}")
    if is_expired(p, now):
        raise ValueError(f"proposal {p.id} has expired; regenerate before acting")
    return replace(p, status=(APPROVED if action == "approve" else REJECTED),
                   decided_at=now, decided_by=by)


# --------------------------------------------------------------------------- atomic store

class ProposalStore:
    """Atomic JSON list of proposals (one small file beside the decision log)."""

    def __init__(self, path: str | Path):
        self.path = Path(path)

    def _read(self) -> list[Proposal]:
        if not self.path.exists():
            return []
        try:
            rows = json.loads(self.path.read_text())
        except (json.JSONDecodeError, OSError):
            return []
        fields = Proposal.__dataclass_fields__
        out = []
        for r in rows if isinstance(rows, list) else []:
            out.append(Proposal(**{k: r[k] for k in fields if k in r}))
        return out

    def _write(self, items: list[Proposal]) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=str(self.path.parent), suffix=".tmp")
        try:
            with os.fdopen(fd, "w") as fh:
                json.dump([asdict(p) for p in items], fh, indent=2)
            os.replace(tmp, self.path)
        finally:
            if os.path.exists(tmp):
                os.unlink(tmp)

    def list(self, status: Optional[str] = None, *, now: Optional[str] = None) -> list[Proposal]:
        """All proposals (newest first), optionally filtered by status. Expired-but-still-pending
        rows are reported as ``expired`` so the UI never shows a stale order as actionable."""
        now = now or _now()
        items = self._read()
        for i, p in enumerate(items):
            if is_expired(p, now):
                items[i] = replace(p, status=EXPIRED)
        items.sort(key=lambda p: p.created_at, reverse=True)
        return [p for p in items if status is None or p.status == status]

    def get(self, pid: str) -> Optional[Proposal]:
        return next((p for p in self._read() if p.id == pid), None)

    def add(self, proposals: list[Proposal]) -> int:
        """Append new proposals (dedupe by id). Returns the count added."""
        with _STORE_LOCK:                          # read→write under the lock (see _STORE_LOCK)
            items = self._read()
            have = {p.id for p in items}
            fresh = [p for p in proposals if p.id not in have]
            if fresh:
                self._write(items + fresh)
            return len(fresh)

    def supersede_pending(self, cycle_id: str) -> int:
        """Expire any still-pending proposals from earlier cycles before queuing a new batch, so
        the user only ever sees the latest cycle's actionable orders. Returns count superseded."""
        with _STORE_LOCK:
            items = self._read()
            n = 0
            for i, p in enumerate(items):
                if p.status == PENDING and p.cycle_id != cycle_id:
                    items[i] = replace(p, status=EXPIRED)
                    n += 1
            if n:
                self._write(items)
            return n

    def decide(self, pid: str, action: str, *, by: str = "user", now: Optional[str] = None) -> Proposal:
        """Approve/Reject a pending proposal, persisting the transition. Raises if not actionable."""
        with _STORE_LOCK:
            items = self._read()
            for i, p in enumerate(items):
                if p.id == pid:
                    updated = apply_decision(p, action, by=by, now=now)
                    items[i] = updated
                    self._write(items)
                    return updated
            raise KeyError(f"no proposal {pid!r}")

    def begin_placing(self, pid: str, *, now: Optional[str] = None) -> Proposal:
        """Atomic APPROVED→PLACING compare-and-swap: claim a proposal for placement so the broker
        round-trip runs exactly once. Held under the store lock, so of two concurrent Approves only
        the first flips approved→placing; the second sees PLACING (or PLACED) and raises
        PlacementInFlight — the guard against double-placing the same live order (finding #1)."""
        with _STORE_LOCK:
            items = self._read()
            for i, p in enumerate(items):
                if p.id == pid:
                    if p.status == PLACING:
                        raise PlacementInFlight(f"proposal {pid} is already being placed")
                    if p.status == PLACED:
                        raise PlacementInFlight(f"proposal {pid} is already placed")
                    if p.status != APPROVED:
                        raise ValueError(f"proposal {pid} is {p.status}, not approved — cannot place")
                    items[i] = replace(p, status=PLACING, decided_at=now or _now())
                    self._write(items)
                    return items[i]
            raise KeyError(f"no proposal {pid!r}")

    def abort_placing(self, pid: str) -> Optional[Proposal]:
        """Roll a PLACING proposal back to APPROVED after a placement failure that definitely did
        NOT reach the broker (a clean reject), so the user can retry. No-op unless it's PLACING."""
        with _STORE_LOCK:
            items = self._read()
            for i, p in enumerate(items):
                if p.id == pid and p.status == PLACING:
                    items[i] = replace(p, status=APPROVED)
                    self._write(items)
                    return items[i]
            return None

    def mark_unknown(self, pid: str, reason: str = "") -> Optional[Proposal]:
        """Park a PLACING proposal in UNKNOWN after a timeout-class failure that MIGHT have reached
        the broker: it can't be safely retried (could duplicate a filled order) until a
        get_equity_orders reconcile resolves it. Records the reason in placed_state for the UI."""
        with _STORE_LOCK:
            items = self._read()
            for i, p in enumerate(items):
                if p.id == pid and p.status == PLACING:
                    items[i] = replace(p, status=UNKNOWN, placed_state=(reason or "needs reconcile"))
                    self._write(items)
                    return items[i]
            return None

    def mark_placed(self, pid: str, placed_ref: str, *, now: Optional[str] = None,
                    state: Optional[str] = None) -> Proposal:
        """Record that an APPROVED/PLACING proposal was placed by the backend (the bound agent).
        This is called by the placement path after the user approved — never to skip approval.
        ``state`` is the broker order state (filled/queued/unconfirmed) so the queue shows
        executed vs queued."""
        with _STORE_LOCK:
            items = self._read()
            for i, p in enumerate(items):
                if p.id == pid:
                    if p.status not in (APPROVED, PLACING):
                        raise ValueError(f"proposal {pid} is {p.status}, not approved — cannot mark placed")
                    items[i] = replace(p, status=PLACED, placed_ref=placed_ref,
                                       placed_state=state, decided_at=now or _now())
                    self._write(items)
                    return items[i]
            raise KeyError(f"no proposal {pid!r}")

    def update_placed_state(self, pid: str, state: str) -> Optional[Proposal]:
        """Refresh the recorded broker state of an already-PLACED proposal (e.g. queued→filled
        once a market order completes). No-op if the proposal isn't placed."""
        with _STORE_LOCK:
            items = self._read()
            for i, p in enumerate(items):
                if p.id == pid and p.status == PLACED:
                    items[i] = replace(p, placed_state=state)
                    self._write(items)
                    return items[i]
            return None

    def counts(self, *, now: Optional[str] = None) -> dict[str, int]:
        out: dict[str, int] = {}
        for p in self.list(now=now):
            out[p.status] = out.get(p.status, 0) + 1
        return out


def generate_proposals(store: ProposalStore, plan, *, cycle_id: Optional[str] = None,
                       supersede: bool = True, now: Optional[str] = None,
                       ttl_minutes: int = DEFAULT_TTL_MIN) -> tuple[str, list[Proposal]]:
    """Queue a cycle's gate-approved orders for approval. Supersedes earlier still-pending
    proposals first (so the user only acts on the latest cycle), then appends the new batch.
    Returns ``(cycle_id, queued)``. Never places anything — it only writes the queue."""
    now = now or _now()
    cycle_id = cycle_id or f"cycle-{int(datetime.fromisoformat(now).timestamp())}"
    if supersede:
        store.supersede_pending(cycle_id)
    fresh = proposals_from_plan(plan, cycle_id=cycle_id, now=now, ttl_minutes=ttl_minutes)
    store.add(fresh)
    return cycle_id, fresh
