"""Sell-to-fund coupling + tax-aware exit for the rotation profile.

By default the Analyst's rotation rule sells a held name the moment it slips out of the
keep band — even when nothing replaces it that cycle. In a taxable account that's avoidable,
gain-realizing turnover. This layer makes rotation *tax-friendly* without touching the pure
strategy (so the backtest's mechanical rotation is unchanged):

1. **Sell-to-fund coupling** — a *soft* rank-slip exit (``exit_kind == "rotate"``) only fires
   when the cycle actually needs to free capital to fund a qualifying new buy. If on-hand cash
   (within the deploy cap and above the cash floor) already covers the new buys, the slipped
   name is **held**, not sold. If there are no new buys at all, nothing soft is sold.
2. **Hard exits stay unconditional** — a name below the quality floor, out of the active
   universe (orphan), or hit by a stop/target (``exit_kind == "thesis"`` / untagged) is a
   broken thesis or a risk event, not turnover. Always exited.
3. **Tax-aware drop ordering** — when capital *must* be freed, sell the most tax-favorable
   names first: realized **losses** (harvest), then **long-term** gains, then **short-term**
   gains; smaller gains before larger within a bucket.
4. **Wash-sale deferral** — a new buy flagged as a cross-account wash-sale risk is deferred
   this cycle (so it never drags a soft sell along to fund it); a loss-harvest sell that would
   itself trip a wash sale is de-prioritised (sold only if nothing cleaner covers the need).

Pure and deterministic: every capital / lot / wash-sale input is passed in. Runs AFTER sizing
(buys carry their ``target_notional``; soft sells carry their full-position notional) and
BEFORE the guardrail gate.
"""
from __future__ import annotations

import datetime
from dataclasses import dataclass, field
from typing import Callable, Optional, Sequence

from .decisions import Decision
from .guardrails import AccountState

# (ticker, side) -> True if executing it would create / be part of a wash sale. Mirrors
# guardrails.WashSaleLookup. Default: never flags (no-op), so the layer is testable in isolation.
WashSaleLookup = Callable[[str, str], bool]


def _no_wash_sale(_ticker: str, _side: str) -> bool:
    return False


@dataclass(frozen=True)
class CouplingResult:
    """Outcome of the coupling pass. ``decisions`` is the trimmed plan to gate; the rest are
    transparency rows so the UI can explain *why* a name was held or a buy deferred."""

    decisions: list[Decision]
    funded_sells: list[str] = field(default_factory=list)            # tickers sold to free capital
    held_back: list[tuple[str, str]] = field(default_factory=list)   # (ticker, reason) soft sells suppressed
    deferred_buys: list[tuple[str, str]] = field(default_factory=list)  # (ticker, reason) wash-sale defers

    def skips(self) -> dict[str, str]:
        """Merge the suppressed/deferred names into the cycle's ``{ticker: reason}`` skip map."""
        out: dict[str, str] = {}
        for t, r in self.held_back:
            out[t.upper()] = r
        for t, r in self.deferred_buys:
            out[t.upper()] = r
        return out


def _is_long_term(ticker: str, acquired_at: dict[str, str], today: str) -> bool:
    """True only when we can confirm the lot has been held > 1 year. Unknown acquisition date
    → False (treated as short-term: the least tax-favorable to sell, so it's preserved, not
    dumped, when the holding period can't be proven)."""
    d = acquired_at.get(ticker.upper())
    if not d:
        return False
    try:
        acq = datetime.date.fromisoformat(str(d)[:10])
        now = datetime.date.fromisoformat(str(today)[:10])
    except (ValueError, TypeError):
        return False
    return (now - acq).days > 365


def _position_value(sell: Decision, snapshot: AccountState) -> float:
    """Dollars freed by liquidating this position — the sized notional, or the live position
    value as a fallback."""
    if sell.target_notional and sell.target_notional > 0:
        return float(sell.target_notional)
    return snapshot.position_value(sell.ticker.upper().strip())


def _unrealized(sell: Decision, snapshot: AccountState) -> float:
    """Unrealized $ gain/loss on the position (price − avg_cost) × qty. 0 if unknown."""
    pos = snapshot.positions.get(sell.ticker.upper().strip())
    if not pos or pos.qty <= 0:
        return 0.0
    price = snapshot.prices.get(sell.ticker.upper().strip(), pos.avg_price)
    return (price - pos.avg_price) * pos.qty


def _tax_key(sell: Decision, snapshot: AccountState, *, acquired_at: dict[str, str], today: str,
             wash_sale_lookup: WashSaleLookup) -> tuple[int, float]:
    """Sort key — ascending = sell first. Buckets by tax cost:
        0  realized LOSS (clean)        → harvest first; biggest loss first
        1  LONG-TERM gain               → lower rate; smallest gain first
        2  SHORT-TERM / unknown gain    → highest rate; smallest gain first
        3  realized LOSS but wash-sale-flagged → no clean harvest; use only if nothing else covers
    """
    u = _unrealized(sell, snapshot)
    if u < 0:
        bucket = 3 if wash_sale_lookup(sell.ticker, "sell") else 0
    else:
        bucket = 1 if _is_long_term(sell.ticker, acquired_at, today) else 2
    return (bucket, u)


def couple_rotation_sells(
    decisions: Sequence[Decision],
    snapshot: AccountState,
    *,
    cap: float = 0.0,
    cash_floor_pct: float = 0.05,
    wash_sale_lookup: WashSaleLookup = _no_wash_sale,
    acquired_at: Optional[dict[str, str]] = None,
    today: Optional[str] = None,
    couple: bool = True,
    tax_aware: bool = True,
) -> CouplingResult:
    """Apply sell-to-fund coupling + tax-aware exit ordering to a SIZED decision list.

    Only ``exit_kind == "rotate"`` sells are coupled; hard exits and buys pass through (buys
    may be deferred on a wash-sale flag). ``cap`` is the deploy ceiling (0 = unlimited);
    ``cash_floor_pct`` mirrors the guardrail reserve. Pure.
    """
    decisions = list(decisions)
    if not couple:
        return CouplingResult(decisions=decisions)

    acquired_at = {k.upper(): v for k, v in (acquired_at or {}).items()}
    today = today or datetime.date.today().isoformat()

    buys = [d for d in decisions if d.action.lower().strip() == "buy"
            and (d.target_notional or 0) > 0]
    soft_sells = [d for d in decisions if d.action.lower().strip() == "sell"
                  and (d.exit_kind or "").lower() == "rotate"]
    # everything else (hard sells, holds, zero-notional buys) passes through verbatim
    passthrough = [d for d in decisions if d not in buys and d not in soft_sells]

    # 1. Wash-sale deferral on new buys — a buy flagged against a recent cross-account loss is
    #    held off this cycle, so it can't drag a soft sell along to fund it.
    kept_buys: list[Decision] = []
    deferred_buys: list[tuple[str, str]] = []
    for b in buys:
        if wash_sale_lookup(b.ticker, "buy"):
            deferred_buys.append((b.ticker.upper(),
                                  "deferred — buying now would trip a 30-day wash sale against a "
                                  "recent loss in another account; re-check next cycle"))
        else:
            kept_buys.append(b)

    # 2. How much capital do the surviving buys need beyond what cash already covers?
    total = snapshot.total_value()
    invested = max(0.0, total - snapshot.cash)
    cash_reserve = cash_floor_pct * total
    cap_headroom = (cap - invested) if cap and cap > 0 else float("inf")
    deployable_cash = max(0.0, min(snapshot.cash - cash_reserve, cap_headroom))
    buy_cost = sum(float(b.target_notional or 0) for b in kept_buys)
    shortfall = max(0.0, buy_cost - deployable_cash)

    funded_sells: list[Decision] = []
    held_back: list[tuple[str, str]] = []

    if not kept_buys or shortfall <= 1e-9:
        # Nothing to fund (or cash already covers it) → hold every soft-slipped name. No turnover.
        reason = ("held — thesis intact and no new buy needs its capital this cycle "
                  "(rotation deferred to avoid a taxable sale)") if kept_buys else \
                 ("held — no qualifying replacement buy this cycle, so the slip doesn't force a "
                  "taxable sale")
        held_back = [(s.ticker.upper(), reason) for s in soft_sells]
    else:
        # 3. Capital MUST be freed — sell the minimum, most tax-favorable names first.
        order = sorted(
            soft_sells,
            key=lambda s: _tax_key(s, snapshot, acquired_at=acquired_at, today=today,
                                   wash_sale_lookup=wash_sale_lookup),
        ) if tax_aware else list(soft_sells)
        freed = 0.0
        for s in order:
            if freed >= shortfall - 1e-9:
                held_back.append((s.ticker.upper(),
                                  "held — earlier rotations already freed enough to fund this "
                                  "cycle's buys (kept to avoid an unneeded taxable sale)"))
                continue
            funded_sells.append(s)
            freed += _position_value(s, snapshot)

    kept = kept_buys + funded_sells + passthrough
    # Preserve original decision order for a stable, readable plan/log.
    kept_set = {id(d) for d in kept}
    out = [d for d in decisions if id(d) in kept_set]
    return CouplingResult(
        decisions=out,
        funded_sells=[s.ticker.upper() for s in funded_sells],
        held_back=held_back,
        deferred_buys=deferred_buys,
    )


def acquired_at_from_place_log(rows: Sequence[dict]) -> dict[str, str]:
    """Best-effort acquisition dates for the holding-period test, from the agent's own
    ``place_log.jsonl`` buy rows (the earliest successful buy per symbol). Pre-existing,
    broker-synced positions won't appear here — those fall back to short-term (preserved, not
    dumped). Pure over the parsed rows.

    Each row looks like ``{"ts": <epoch>, "args": {"symbol": "X", "side": "buy", ...},
    "raw": {"data": {"order": {...}}}}``. Rows whose ``raw`` carries an ``_error`` are skipped
    (the order never placed)."""
    earliest: dict[str, float] = {}
    for r in rows or []:
        args = (r or {}).get("args") or {}
        if str(args.get("side", "")).lower() != "buy":
            continue
        if ((r.get("raw") or {}) or {}).get("_error"):
            continue
        sym = str(args.get("symbol", "")).upper().strip()
        ts = r.get("ts")
        if not sym or not isinstance(ts, (int, float)):
            continue
        if sym not in earliest or ts < earliest[sym]:
            earliest[sym] = float(ts)
    return {
        sym: datetime.datetime.fromtimestamp(ts, datetime.timezone.utc).date().isoformat()
        for sym, ts in earliest.items()
    }
