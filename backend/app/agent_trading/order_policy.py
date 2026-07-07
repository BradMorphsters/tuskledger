"""Order construction policy — market vs limit, and how a limit price is set.

Thin, illiquid names (the critical-minerals juniors) can move on a single market order, so the
default for live should be a **marketable limit**: a limit a few bps through the last price —
aggressive enough to fill promptly, but with a hard cap on the price you'll pay (buy) or accept
(sell). This module is the single source of truth for the ``place_equity_order`` arguments, used
by both the planner (``bridge``) and the live broker (``brokers``) so they can never disagree.

Pure and dependency-free (only the ProposedOrder shape), so it unit-tests without a broker.
"""
from __future__ import annotations

from dataclasses import dataclass

from .guardrails import ProposedOrder


@dataclass(frozen=True)
class OrderPolicy:
    """How to turn an approved order into broker arguments.

    ``limit`` caps slippage on thin names; ``market`` is simplest but exposed to bad fills.
    ``limit_offset_bps`` is how far *through* the reference price the marketable limit sits
    (buy = ref·(1+bps); sell = ref·(1−bps)). 25 bps = 0.25%."""

    order_type: str = "market"          # "market" | "limit"
    limit_offset_bps: float = 25.0
    round_decimals: int = 2

    def __post_init__(self):
        if self.order_type not in ("market", "limit"):
            raise ValueError(f"unknown order_type {self.order_type!r}; expected market|limit")
        if self.limit_offset_bps < 0:
            raise ValueError("limit_offset_bps must be ≥ 0")


def is_sub_share_limit(order: ProposedOrder, policy: OrderPolicy | None) -> bool:
    """True when this is a LIMIT order whose sized quantity is < 1 whole share. Robinhood limit
    orders are whole-share only, so such an order can't be placed as sized — build_order_args would
    otherwise floor it UP to 1 share (a $50 buy of a $400 name becomes a $400 order, and can oversell
    a fractional position). The generation path uses this to SKIP the order rather than inflate it."""
    if policy is None or policy.order_type != "limit":
        return False
    return order.resolved_qty() < 1.0


def limit_price(side: str, ref_price: float, policy: OrderPolicy) -> float:
    """Marketable-limit price: a buy sits slightly ABOVE the last (to fill), a sell slightly
    BELOW — each capping how far the fill can drift from the reference."""
    off = policy.limit_offset_bps / 10_000.0
    px = ref_price * (1 + off) if side.lower().strip() == "buy" else ref_price * (1 - off)
    return round(max(0.01, px), policy.round_decimals)


def build_order_args(account_number: str, order: ProposedOrder, *, policy: OrderPolicy | None = None) -> dict:
    """Map an approved order onto Robinhood ``place_equity_order`` arguments under ``policy``.

    * market: notional (``amount``) when set, else ``quantity`` — fractional-friendly.
    * limit: always a share ``quantity`` + a ``limit_price`` (notional/limit orders aren't a
      thing), with ``type='limit'``.
    """
    policy = policy or OrderPolicy()
    side = order.side.lower().strip()
    args = {
        "account_number": account_number,
        "symbol": order.ticker.upper().strip(),
        "side": side,
        "type": policy.order_type,
    }
    # Robinhood's agentic place_equity_order takes a share QUANTITY (it rejects a dollar `amount`).
    # Market orders are fractional (the first live fill, ALM, was 5.567929 sh). Limit orders are
    # whole-share only at Robinhood, so floor here at generation — the proposal then shows exactly
    # what will place (no fractional→whole surprise between Approve and the fill).
    if policy.order_type == "limit":
        if is_sub_share_limit(order, policy):
            # Refuse rather than silently inflate: max(1, ...) below would turn a
            # 0.4-share order into a full share (a $50 buy of a $400 name becomes
            # a $400 order). The generation path skips these via
            # is_sub_share_limit(); any other caller must not sneak past it.
            raise ValueError(
                f"{args['symbol']}: sub-share limit order ({order.resolved_qty():.4f} sh) "
                "cannot be built — Robinhood limits are whole-share; skip it instead"
            )
        args["quantity"] = float(max(1, int(order.resolved_qty())))
        args["limit_price"] = limit_price(side, order.ref_price, policy)
    else:
        args["quantity"] = round(order.resolved_qty(), 6)
    return args
