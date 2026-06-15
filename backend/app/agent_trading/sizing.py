"""Position sizing — choose *how much* to trade, before the gate.

A decision says *what* (buy/sell TICKER); the sizer sets *how much* (``target_notional``),
from account value and the chosen method. The sizer only *proposes* a size — the guardrail
gate remains the authority that VETOES an oversized result (max position %, cash floor).
So a slightly aggressive sizer can't bypass risk limits; the two are complementary.

Pure and deterministic. Methods:
  * ``fixed_fractional`` — each new position gets a fixed fraction of account value.
  * ``vol_target``       — size inversely to the asset's volatility (≈ equal risk per name).
  * ``rebalance``        — move each name toward a target weight (emits buys AND sells).
"""
from __future__ import annotations

from dataclasses import dataclass, replace
from typing import Optional

from .decisions import Decision
from .guardrails import AccountState


@dataclass(frozen=True)
class SizingConfig:
    method: str = "fixed_fractional"      # fixed_fractional | vol_target
    fraction: float = 0.10                # fixed_fractional: fraction of account per position
    target_risk: float = 0.01             # vol_target: per-position risk budget (frac of account)
    max_fraction: float = 0.20            # hard clamp on any single position (mirrors the gate)
    min_trade_notional: float = 1.0       # below this, don't bother trading


def _buy_notional(ticker: str, want: float, state: AccountState, cfg: SizingConfig) -> float:
    """Clamp a desired buy notional to the per-name fraction cap (post-trade) and cash."""
    total = state.total_value()
    headroom = max(0.0, cfg.max_fraction * total - state.position_value(ticker))
    return max(0.0, min(want, headroom, state.cash))


def size_decision(decision: Decision, state: AccountState, cfg: SizingConfig,
                  *, vol: Optional[float] = None) -> Decision:
    """Return a copy of ``decision`` with ``target_notional`` chosen by the method.

    A buy that clamps below ``min_trade_notional`` becomes a ``hold`` (nothing to do). A
    sell with no held position also becomes a ``hold``. Sells are valued at the decision's
    own ``ref_price`` so the resulting quantity matches the position exactly (no oversell).
    """
    side = decision.action.lower().strip()
    if side == "hold":
        return decision

    total = state.total_value()
    tkr = decision.ticker.upper().strip()

    if side == "buy":
        if cfg.method == "vol_target" and vol and vol > 0:
            want = (cfg.target_risk * total) / vol
        else:  # fixed_fractional, or vol_target with no vol available
            want = cfg.fraction * total
        notional = _buy_notional(tkr, want, state, cfg)
        if notional < cfg.min_trade_notional:
            return replace(decision, action="hold", target_notional=0.0)
        return replace(decision, target_notional=round(notional, 2))

    # sell — default to liquidating the held position
    pos = state.positions.get(tkr)
    if not pos or pos.qty <= 0:
        return replace(decision, action="hold", target_notional=0.0)
    ref = decision.ref_price if decision.ref_price > 0 else pos.avg_price
    return replace(decision, target_notional=round(pos.qty * ref, 2))


def size_decisions(decisions: list[Decision], state: AccountState, cfg: SizingConfig,
                   *, vols: Optional[dict[str, float]] = None) -> list[Decision]:
    vols = vols or {}
    return [size_decision(d, state, cfg, vol=vols.get(d.ticker.upper().strip())) for d in decisions]


def rebalance(targets: dict[str, float], state: AccountState, cfg: SizingConfig) -> list[Decision]:
    """Generate buy/sell decisions to move each name toward its target weight.

    ``targets`` maps ticker → weight (fraction of account value). Underweight names emit a
    buy of the shortfall (capped at cash); overweight names emit a sell of the excess. Names
    already within ``min_trade_notional`` of target are skipped.
    """
    total = state.total_value()
    out: list[Decision] = []
    for raw, weight in targets.items():
        t = raw.upper().strip()
        price = state.prices.get(t, 0.0)
        delta = weight * total - state.position_value(t)
        if abs(delta) < cfg.min_trade_notional:
            continue
        if delta > 0:
            notional = min(delta, state.cash)
            if notional < cfg.min_trade_notional:
                continue
            out.append(Decision(t, "buy", price, target_notional=round(notional, 2),
                                rationale=f"rebalance → {weight:.0%}"))
        else:
            out.append(Decision(t, "sell", price, target_notional=round(-delta, 2),
                                rationale=f"rebalance → {weight:.0%}"))
    return out
