"""Persisted rank snapshots — so the ranking can show each name's trend (climbed / fell), not
just where it sits today.

One snapshot per (date, profile): ``{date, profile, domain, ranks: {ticker: rank}}``. The delta
for a name is ``baseline_rank - current_rank`` against the most recent snapshot from a *different*
day, so a positive number means it CLIMBED (its rank number got smaller) and negative means it
FELL. Same-day reloads compare against the prior day and don't multiply snapshots.

Pure transforms + tiny IO helpers (atomic write), so the ranking logic stays testable without a
broker or a server. The file lives under ``var/agent_trading/`` (gitignored runtime data)."""
from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path


def load(path) -> list[dict]:
    p = Path(path)
    if not p.exists():
        return []
    try:
        data = json.loads(p.read_text())
        return data if isinstance(data, list) else []
    except (json.JSONDecodeError, OSError):
        return []


def baseline(history: list[dict], *, profile: str, domain, today: str) -> dict[str, int]:
    """The ranks from the most recent snapshot for this (``profile``, ``domain``) whose date is
    NOT ``today`` — the point we measure the trend against. Keyed by domain too, so switching
    industries doesn't compare ranks across different universes. ``{}`` when there's no prior day."""
    for snap in reversed(history):
        if (snap.get("profile") == profile and snap.get("domain") == domain
                and snap.get("date") and snap.get("date") != today):
            ranks = snap.get("ranks")
            return ranks if isinstance(ranks, dict) else {}
    return {}


def deltas(history: list[dict], *, profile: str, domain, today: str, ranks: dict[str, int]) -> dict[str, object]:
    """``{ticker: prev_rank - rank}`` vs the baseline (positive = climbed). ``None`` for a name
    with no prior rank (new, or first run)."""
    base = baseline(history, profile=profile, domain=domain, today=today)
    out: dict[str, object] = {}
    for t, r in ranks.items():
        pr = base.get(t)
        out[t] = (int(pr) - int(r)) if isinstance(pr, (int, float)) else None
    return out


def seed_flat(history: list[dict], *, profile: str, domain, today: str,
              ranks: dict[str, int], days: int = 2) -> list[dict]:
    """Pre-seed ``days`` flat snapshots on the days just before ``today`` (same ranks), so the
    trend reads 'no movement' from the very first view instead of blank. No-op once a real
    prior-day snapshot for this (profile, domain) exists, so it only fires on the first run. Pure."""
    if baseline(history, profile=profile, domain=domain, today=today):
        return history
    import datetime as _dt
    try:
        d0 = _dt.date.fromisoformat(today)
    except ValueError:
        return history
    seeds = [{"date": (d0 - _dt.timedelta(days=k)).isoformat(),
              "profile": profile, "domain": domain, "ranks": dict(ranks)}
             for k in range(days, 0, -1)]
    return seeds + history


def record(history: list[dict], *, profile: str, domain, today: str,
           ranks: dict[str, int], cap: int = 180) -> list[dict]:
    """Append today's snapshot, replacing any existing one for the same (date, profile, domain),
    capped to the last ``cap`` entries. Pure."""
    kept = [s for s in history
            if not (s.get("date") == today and s.get("profile") == profile and s.get("domain") == domain)]
    kept.append({"date": today, "profile": profile, "domain": domain, "ranks": dict(ranks)})
    return kept[-cap:]


def save(path, history: list[dict]) -> None:
    """Atomic write (temp file + replace) so a crash can't truncate the history."""
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=str(p.parent), suffix=".tmp")
    with os.fdopen(fd, "w") as fh:
        fh.write(json.dumps(history))
    os.replace(tmp, p)
