"""Read-only views over the agentic-trading decision log.

The executor (``app.agent_trading.executor``) appends one JSON object per order outcome
to a JSONL file. This module is the *read* side: it parses that log and derives the
shapes the Agent Trading tab renders — status, activity feed, reconstructed positions,
and a guardrail-breach summary.

Deliberately pure stdlib and side-effect free (apart from reading the file) so it unit
tests without the rest of the app. It never writes, never trades, and degrades to empty
"no runs yet" shapes when the log is absent — matching how the Signals/Research routers
behave when unconfigured.
"""
from __future__ import annotations

import json
from collections import Counter
from pathlib import Path
from typing import Any, Optional


# --------------------------------------------------------------------------- io

def resolve_log_path(configured: str) -> Path:
    """Where the decision log lives. Honors the configured path, else a default
    under the backend working dir (``var/agent_trading/decisions.jsonl``)."""
    if configured:
        return Path(configured).expanduser()
    return Path("var/agent_trading/decisions.jsonl")


def load_rows(path: Path) -> list[dict[str, Any]]:
    """Parse the JSONL log into a list of rows (chronological = file order).

    Bad/partial lines are skipped rather than crashing the endpoint — a half-written
    final line must never take the tab down.
    """
    if not path.exists():
        return []
    rows: list[dict[str, Any]] = []
    with path.open() as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    return rows


# --------------------------------------------------------------------------- backfill (pure)

def backfill_fill(rows: list[dict], order_id: str, *, price: Optional[float] = None,
                  qty: Optional[float] = None, state: Optional[str] = None) -> tuple[list[dict], bool]:
    """Pure: return ``(rows, changed)`` with the fill whose ``order_id`` matches updated to the
    real executed price/notional/state.

    The place response returns the *accepted order* (price 0 / unconfirmed), not the executed
    fill, so a freshly-placed row understates cost basis until the order settles. Once the
    reconcile reads back the broker's ``average_price``, this rewrites that one row so the
    positions view (notional ÷ qty) shows the true average cost. Idempotent — re-applying the
    same values reports ``changed=False`` so the caller can skip the disk write. No IO.
    """
    oid = str(order_id or "")
    if not oid:
        return rows, False
    changed = False
    out: list[dict] = []
    for r in rows:
        f = r.get("fill") or {}
        if str(f.get("order_id") or "") != oid:
            out.append(r)
            continue
        f = dict(f)
        row = dict(r)
        row_changed = False
        if price is not None:
            try:
                p = float(price)
            except (TypeError, ValueError):
                p = 0.0
            if p > 0 and f.get("price") != round(p, 4):
                f["price"] = round(p, 4)
                if qty:
                    f["notional"] = round(p * float(qty), 4)
                row_changed = True
        if state and f.get("state") != state:
            f["state"] = state
            row_changed = True
        if row.get("status") == "placed":
            row["status"] = "executed"
            row_changed = True
        if row_changed:
            row["fill"] = f
            changed = True
        out.append(row)
    return out, changed


def cancel_fill(rows: list[dict], order_id: str, *, state: str = "cancelled") -> tuple[list[dict], bool]:
    """Pure: mark the row for ``order_id`` as cancelled-unfilled and zero its fill, so the position
    view (which sums fill qty/notional) stops showing a phantom holding.

    A queued limit order is written to the log as 'executed' at placement (the place response
    is the accepted order, not a fill). If Robinhood later cancels it unfilled — e.g. a GFD order
    at the close — this corrects that row to status='cancelled' with qty/notional 0. Only fully
    unfilled orders reach this (a partial fill is a real position and goes the executed path).
    Idempotent. No IO."""
    oid = str(order_id or "")
    if not oid:
        return rows, False
    changed = False
    out: list[dict] = []
    for r in rows:
        f = r.get("fill") or {}
        if str(f.get("order_id") or "") == oid and r.get("status") != "cancelled":
            f = {**f, "state": state, "qty": 0.0, "notional": 0.0}
            out.append({**r, "fill": f, "status": "cancelled"})
            changed = True
            continue
        out.append(r)
    return out, changed


# --------------------------------------------------------------------------- helpers

def _fills(rows: list[dict]) -> list[dict]:
    return [r["fill"] for r in rows if r.get("fill")]


def _latest_ts(rows: list[dict]) -> Optional[str]:
    ts = [r.get("ts") for r in rows if r.get("ts")]
    return max(ts) if ts else None


def _mode(rows: list[dict]) -> Optional[str]:
    """'live' if any fill went to Robinhood, else 'simulated' if anything filled."""
    venues = {f.get("venue") for f in _fills(rows)}
    if "robinhood" in venues:
        return "live"
    if venues:
        return "simulated"
    return None


def _marks(rows: list[dict]) -> dict[str, float]:
    """Last-seen price per ticker, from decisions and fills, in chronological order."""
    marks: dict[str, float] = {}
    for r in rows:
        d = r.get("decision") or {}
        if d.get("ticker") and d.get("ref_price"):
            marks[d["ticker"].upper()] = float(d["ref_price"])
        f = r.get("fill")
        if f and f.get("ticker") and f.get("price"):
            marks[f["ticker"].upper()] = float(f["price"])
    return marks


# --------------------------------------------------------------------------- views

def status(path: Path) -> dict[str, Any]:
    rows = load_rows(path)
    return {
        "configured": bool(rows),
        "path": str(path),
        "last_run": _latest_ts(rows),
        "halted": bool(rows and rows[-1].get("halted")),
        "mode": _mode(rows),
        "total_outcomes": len(rows),
    }


def positions(rows: list[dict]) -> list[dict[str, Any]]:
    """Reconstruct open positions from the fill stream (running qty + weighted cost).

    Cost basis is a simple share-weighted average of buys; sells reduce quantity at that
    average (no FIFO realized-gain accounting here — that's the Trading Tax page's job).
    """
    qty: dict[str, float] = {}
    cost: dict[str, float] = {}  # total cost basis remaining
    for f in _fills(rows):
        t = f["ticker"].upper()
        side = f["side"].lower()
        q = float(f["qty"])
        n = float(f["notional"])
        if side == "buy":
            qty[t] = qty.get(t, 0.0) + q
            cost[t] = cost.get(t, 0.0) + n
        elif side == "sell":
            held = qty.get(t, 0.0)
            if held > 0:
                avg = cost.get(t, 0.0) / held
                sell_q = min(q, held)
                qty[t] = held - sell_q
                cost[t] = cost.get(t, 0.0) - avg * sell_q

    marks = _marks(rows)
    out: list[dict[str, Any]] = []
    for t, q in qty.items():
        if q <= 1e-9:
            continue
        basis = cost.get(t, 0.0)
        avg = basis / q if q else 0.0
        mark = marks.get(t, avg)
        mkt = q * mark
        out.append({
            "ticker": t,
            "qty": round(q, 6),
            "avg_cost": round(avg, 4),
            "mark": round(mark, 4),
            "cost_basis": round(basis, 2),
            "market_value": round(mkt, 2),
            "unrealized": round(mkt - basis, 2),
            "unrealized_pct": round((mkt - basis) / basis, 4) if basis else 0.0,
        })
    out.sort(key=lambda p: p["market_value"], reverse=True)
    return out


def summary(rows: list[dict]) -> dict[str, Any]:
    status_counts = Counter(r.get("status", "?") for r in rows)
    pos = positions(rows)
    buys = sum(float(f["notional"]) for f in _fills(rows) if f["side"].lower() == "buy")
    sells = sum(float(f["notional"]) for f in _fills(rows) if f["side"].lower() == "sell")
    mkt_value = sum(p["market_value"] for p in pos)
    unrealized = sum(p["unrealized"] for p in pos)

    last_executed = next(
        (r for r in reversed(rows) if r.get("status") == "executed"), None
    )
    return {
        "last_run": _latest_ts(rows),
        "halted": bool(rows and rows[-1].get("halted")),
        "mode": _mode(rows),
        "counts": {
            "executed": status_counts.get("executed", 0),
            "blocked": status_counts.get("blocked", 0),
            "skipped": status_counts.get("skipped", 0),
            "halted": status_counts.get("halted", 0),
            "error": status_counts.get("error", 0),
            "total": len(rows),
        },
        "open_positions": len(pos),
        "market_value": round(mkt_value, 2),
        "unrealized": round(unrealized, 2),
        "net_deployed": round(buys - sells, 2),  # buys minus sells, in $
        "last_rationale": (last_executed or {}).get("decision", {}).get("rationale", ""),
    }


def activity(rows: list[dict], limit: int = 100) -> list[dict[str, Any]]:
    """Newest-first feed of outcomes: what was proposed, what happened, and why."""
    out: list[dict[str, Any]] = []
    for r in reversed(rows):
        d = r.get("decision") or {}
        g = r.get("guardrail") or {}
        f = r.get("fill")
        out.append({
            "ts": r.get("ts"),
            "as_of": r.get("as_of"),
            "ticker": d.get("ticker"),
            "action": d.get("action"),
            "status": r.get("status"),
            "rationale": d.get("rationale", ""),
            "confidence": d.get("confidence"),
            "reasons": g.get("reasons", []),
            "warnings": g.get("warnings", []),
            "fill": f,
            "error": r.get("error", ""),
        })
        if len(out) >= limit:
            break
    return out


def guardrail_breaches(rows: list[dict]) -> dict[str, Any]:
    """Which guardrails are doing the work — failed-check counts across blocked rows.

    This is the panel that tells you whether your config is too tight (everything is
    bouncing off one rule) or actually catching distinct problems.
    """
    failed = Counter()
    blocked = 0
    warned = Counter()
    for r in rows:
        if r.get("status") in ("blocked", "halted"):
            blocked += 1
        g = r.get("guardrail") or {}
        for c in g.get("checks", []):
            if not c.get("passed"):
                failed[c.get("name", "?")] += 1
        for w in g.get("warnings", []):
            # bucket warnings loosely by keyword
            key = "wash_sale" if "wash" in w.lower() else "other"
            warned[key] += 1
    return {
        "blocked_total": blocked,
        "by_check": [{"check": k, "count": v} for k, v in failed.most_common()],
        "warnings": [{"kind": k, "count": v} for k, v in warned.most_common()],
    }
