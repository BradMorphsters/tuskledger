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
    # Robinhood's agentic place_equity_order takes a share QUANTITY (it rejects a dollar `amount`),
    # as a fractional value (the first successful live fill, ALM, was 5.567929 sh). Limit orders
    # get coerced to whole shares at placement (place_raw); market orders stay fractional.
    args["quantity"] = round(order.resolved_qty(), 6)
    if policy.order_type == "limit":
        args["limit_price"] = limit_price(side, order.ref_price, policy)
    return args
