"""Cross-portfolio exposure — does the Agentic sleeve overlap your main portfolio?

The agent trades a small universe; if it buys a name you already hold heavily in your main
accounts, your *true* exposure is larger than either view shows alone. This computes that
overlap: for each name in the agent's universe, your existing main-portfolio weight, with a
flag for names the agent is currently proposing and for ones you're already concentrated in.

Pure over two plain inputs (the agent's universe + a ``{ticker: market_value}`` map of your
main holdings); the live wiring (DB holdings + research universe) lives in the router.
"""
from __future__ import annotations

from typing import Iterable, Optional


def cross_exposure(
    universe: Iterable[str],
    main_holdings: dict[str, float],
    *,
    proposed: Optional[Iterable[str]] = None,
    concentration_threshold: float = 0.10,
) -> dict:
    """Overlap of the agent's ``universe`` against ``main_holdings`` (ticker → market value).

    Returns rows (proposed + concentrated names first), the overlap subset, and the names the
    agent is proposing that you're already concentrated in — the ones worth a second look.
    """
    prop = {p.upper().strip() for p in (proposed or [])}
    main = {k.upper(): float(v or 0.0) for k, v in main_holdings.items()}
    main_total = sum(v for v in main.values() if v > 0) or 0.0

    rows: list[dict] = []
    for raw in universe:
        t = (raw or "").upper().strip()
        if not t:
            continue
        mv = main.get(t, 0.0)
        pct = (mv / main_total) if main_total else 0.0
        rows.append({
            "ticker": t,
            "in_main": mv > 0,
            "main_value": round(mv, 2),
            "main_pct": round(pct, 4),
            "proposed": t in prop,
            "concentrated": pct >= concentration_threshold,
        })

    # proposed + most-concentrated names first
    rows.sort(key=lambda r: (r["proposed"], r["main_pct"]), reverse=True)
    overlap = [r for r in rows if r["in_main"]]
    return {
        "main_total": round(main_total, 2),
        "n_main_names": sum(1 for v in main.values() if v > 0),
        "n_universe": len(rows),
        "n_overlap": len(overlap),
        "rows": rows,
        "overlap": overlap,
        "concentrated_proposals": [r for r in overlap if r["concentrated"] and r["proposed"]],
    }
