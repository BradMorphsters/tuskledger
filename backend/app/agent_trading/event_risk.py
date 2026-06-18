"""Event-risk gate — defer NEW buys on a fresh dilution / capital-raise SEC filing.

For the pre-revenue, small-cap names this engine trades, a surprise capital raise (a shelf
takedown, an ATM program, an S-1/424B offering) is the single biggest drawdown source — and the
rotation Analyst is otherwise blind to it. This reads the per-domain EDGAR activity cache that
``app.services.sec_edgar`` already warms (``store.load_edgar`` → ``{ticker: activity}`` with a
dated ``recent_raises`` list) and, exactly like the freshness / don't-chase gates, returns a
per-cycle ``{ticker: reason}`` skip map.

A NON-held name whose most recent dilution filing landed within the lookback window is skipped
for new buys (re-checked next cycle). HELD names are exempt — a dilution headline is a reason
not to ADD, not a forced (taxable) exit; it surfaces as a warning instead, never a sell.

Pure: the EDGAR cache and ``today`` are passed in. Cold/empty cache → no skips (safe no-op), so
the gate simply does nothing until the daily job warms the cache.
"""
from __future__ import annotations

import datetime
from dataclasses import replace
from typing import Optional, Sequence

from .strategy import Candidate

# Dilution forms, mirrored from sec_edgar._RAISE_FORMS, only for the human-readable reason; the
# cache has already filtered ``recent_raises`` to these.
_RAISE_LABEL = {
    "S-1": "S-1 (IPO/registration)", "S-1/A": "S-1/A",
    "S-3": "S-3 shelf", "S-3/A": "S-3/A shelf",
    "424B5": "424B5 (shelf takedown)", "424B4": "424B4 (offering)", "424B3": "424B3 (offering)",
}


def _latest_raise(bundle: dict) -> Optional[tuple[datetime.date, str]]:
    """(date, form) of the most recent capital-raise filing in the cached bundle, or None."""
    best: Optional[tuple[datetime.date, str]] = None
    for r in (bundle or {}).get("recent_raises") or []:
        try:
            d = datetime.date.fromisoformat(str(r.get("date"))[:10])
        except (TypeError, ValueError):
            continue
        if best is None or d > best[0]:
            best = (d, str(r.get("form") or "raise"))
    return best


def event_risk_skips(
    candidates: Sequence[Candidate],
    edgar_cache: dict[str, dict],
    *,
    today: Optional[str] = None,
    lookback_days: int = 21,
    held_warn: bool = True,
) -> dict[str, str]:
    """``{ticker: reason}`` for names with a FRESH dilution filing.

    Non-held names are returned as a hard *buy* skip (the caller drops them from new buys, like
    the freshness gate). Held names are returned only as a warning (when ``held_warn``) and must
    NOT be dropped/sold by the caller — the standard ``c.held or ticker not in skips`` filter
    keeps them. Cold cache or ``lookback_days<=0`` → ``{}``."""
    if not edgar_cache or lookback_days <= 0:
        return {}
    today_d = datetime.date.fromisoformat((today or datetime.date.today().isoformat())[:10])
    cutoff = today_d - datetime.timedelta(days=lookback_days)
    out: dict[str, str] = {}
    for c in candidates:
        t = (c.ticker or "").upper()
        bundle = edgar_cache.get(t) or edgar_cache.get(c.ticker or "")
        if not bundle or not bundle.get("available"):
            continue
        latest = _latest_raise(bundle)
        if latest is None or latest[0] < cutoff:
            continue
        d, form = latest
        age = (today_d - d).days
        label = _RAISE_LABEL.get(form, form)
        if c.held:
            if held_warn:
                out[t] = (f"⚠ dilution filing while held: {label} filed {age}d ago — flagging, "
                          f"not force-selling (kept per the no-gratuitous-sale rule)")
            continue
        out[t] = (f"dilution risk: {label} filed {age}d ago (capital raise) — deferring the new "
                  f"buy, re-check after it clears")
    return out


# --------------------------------------------------------------------------- Finnhub overlays

def earnings_skips(
    candidates: Sequence[Candidate],
    finnhub_cache: dict[str, dict],
    *,
    today: Optional[str] = None,
    blackout_days: int = 5,
) -> dict[str, str]:
    """``{ticker: reason}`` for NON-held names whose next earnings date is within ``blackout_days``
    — defer the buy through the print's event risk. Held names are exempt (exits still fire).
    Cold cache or ``blackout_days<=0`` → ``{}``."""
    if not finnhub_cache or blackout_days <= 0:
        return {}
    today_d = datetime.date.fromisoformat((today or datetime.date.today().isoformat())[:10])
    out: dict[str, str] = {}
    for c in candidates:
        if c.held:
            continue
        t = (c.ticker or "").upper()
        bundle = finnhub_cache.get(t) or finnhub_cache.get(c.ticker or "")
        nxt = (bundle or {}).get("next_earnings")
        if not nxt:
            continue
        try:
            ed = datetime.date.fromisoformat(str(nxt)[:10])
        except (TypeError, ValueError):
            continue
        days = (ed - today_d).days
        if 0 <= days <= blackout_days:
            out[t] = (f"earnings in {days}d ({ed.isoformat()}) — deferring the new buy through the "
                      f"print, re-check after")
    return out


def apply_revision_tilt(
    candidates: Sequence[Candidate],
    finnhub_cache: dict[str, dict],
    *,
    weight: float = 0.10,
    max_tilt: float = 0.10,
) -> list[Candidate]:
    """Nudge each name's ``rotation_score`` by its analyst-revision momentum: rising estimates
    lift the rank, falling ones cut it. The tilt is bounded to ±``max_tilt`` so it tunes the
    ranking without overriding the thesis. Cold cache → candidates returned unchanged. Pure."""
    if not finnhub_cache or weight <= 0:
        return list(candidates)
    out: list[Candidate] = []
    for c in candidates:
        bundle = finnhub_cache.get((c.ticker or "").upper()) or finnhub_cache.get(c.ticker or "")
        rev = (bundle or {}).get("revision")
        if not isinstance(rev, (int, float)) or not c.rotation_score:
            out.append(c)
            continue
        tilt = max(-max_tilt, min(max_tilt, weight * float(rev)))
        out.append(replace(c, rotation_score=round(c.rotation_score * (1.0 + tilt), 6)))
    return out
