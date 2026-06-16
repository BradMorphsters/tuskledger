"""Pre-trade guardrail gate.

This is the load-bearing safety layer for autonomous trading. Robinhood caps the
*blast radius* to the funded Agentic budget, but it does not enforce any of the
account-owner's custom rules. So before any proposed order reaches a broker it passes
through :func:`check_order`, which can veto it.

Everything here is pure and side-effect free: same inputs, same result, no I/O. That
makes the gate trivially unit-testable, which is the whole point — you want to *trust*
the thing that can stop a runaway loop.

Each check returns a :class:`Check` row (name, passed, detail) so the decision log and
the UI can show exactly why an order was allowed or blocked, not just a yes/no.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Callable, Optional


# --------------------------------------------------------------------------- state

@dataclass(frozen=True)
class Position:
    """A held position. ``avg_price`` is cost basis per share."""

    qty: float
    avg_price: float


@dataclass(frozen=True)
class AccountState:
    """Snapshot of the Agentic account the gate reasons over.

    ``equity_peak`` is the high-water mark of total value, used for the drawdown
    halt. ``trades_today`` is the count already placed in the current session/day.
    """

    cash: float
    positions: dict[str, Position]
    prices: dict[str, float]
    equity_peak: float
    trades_today: int = 0
    settled_cash: Optional[float] = None   # cash account: settled (T+1) buying power; None = unknown

    def position_value(self, ticker: str) -> float:
        pos = self.positions.get(ticker)
        if not pos:
            return 0.0
        return pos.qty * self.prices.get(ticker, pos.avg_price)

    def total_value(self) -> float:
        invested = sum(
            pos.qty * self.prices.get(tkr, pos.avg_price)
            for tkr, pos in self.positions.items()
        )
        return self.cash + invested


# --------------------------------------------------------------------------- order

@dataclass(frozen=True)
class ProposedOrder:
    """A trade the decision source wants to place.

    Exactly one of ``notional`` (dollars) or ``qty`` (shares) should be set; the gate
    resolves it to a notional using ``ref_price`` for sizing checks.
    """

    ticker: str
    side: str  # "buy" | "sell"
    ref_price: float
    notional: Optional[float] = None
    qty: Optional[float] = None
    rationale: str = ""

    def resolved_notional(self) -> float:
        if self.notional is not None:
            return float(self.notional)
        if self.qty is not None:
            return float(self.qty) * self.ref_price
        return 0.0

    def resolved_qty(self) -> float:
        if self.qty is not None:
            return float(self.qty)
        if self.notional is not None and self.ref_price > 0:
            return float(self.notional) / self.ref_price
        return 0.0


# --------------------------------------------------------------------------- config

@dataclass(frozen=True)
class GuardrailConfig:
    """The owner's rules. Tighten freely; defaults are deliberately conservative.

    ``allowlist`` of ``None`` means "any ticker allowed" (the blocklist still applies).
    Percentages are fractions of total account value (0.20 == 20%).
    """

    allowlist: Optional[frozenset[str]] = None
    blocklist: frozenset[str] = frozenset()
    per_order_max_notional: float = 500.0
    max_position_pct: float = 0.20
    cash_floor_pct: float = 0.05
    max_trades_per_day: int = 10
    max_drawdown_pct: float = 0.15
    block_on_wash_sale: bool = False  # False = warn only, True = hard veto
    require_settled_cash: bool = False  # cash account: block buys exceeding settled cash (T+1)
    max_deployed_notional: Optional[float] = None  # hard $ ceiling on TOTAL invested (None = no cap)

    @staticmethod
    def conservative() -> "GuardrailConfig":
        """A sane starting point for a small experiment sleeve."""
        return GuardrailConfig()


# --------------------------------------------------------------------------- result

@dataclass(frozen=True)
class Check:
    name: str
    passed: bool
    detail: str


@dataclass
class GuardrailResult:
    ok: bool
    reasons: list[str] = field(default_factory=list)       # why it was vetoed
    warnings: list[str] = field(default_factory=list)      # noted, not blocking
    checks: list[Check] = field(default_factory=list)      # full trace

    def as_dict(self) -> dict:
        return {
            "ok": self.ok,
            "reasons": self.reasons,
            "warnings": self.warnings,
            "checks": [c.__dict__ for c in self.checks],
        }


# Optional cross-account hook: given a ticker + side, return True if executing it would
# create / be involved in a wash sale against ANY of the owner's accounts. The agent is
# blind to the main portfolio, so this is where Tusk Ledger earns its keep. Default: no.
WashSaleLookup = Callable[[str, str], bool]


def _no_wash_sale(_ticker: str, _side: str) -> bool:
    return False


# --------------------------------------------------------------------------- the gate

def check_order(
    order: ProposedOrder,
    state: AccountState,
    config: GuardrailConfig,
    wash_sale_lookup: WashSaleLookup = _no_wash_sale,
) -> GuardrailResult:
    """Evaluate one proposed order. Returns a fully-traced pass/veto.

    The order is vetoed if *any* hard check fails; ``reasons`` lists every failure
    (we don't short-circuit, so the log shows all problems at once). ``warnings`` holds
    non-blocking notes (e.g. a wash-sale flag when ``block_on_wash_sale`` is off).
    """
    checks: list[Check] = []
    reasons: list[str] = []
    warnings: list[str] = []

    side = order.side.lower().strip()
    ticker = order.ticker.upper().strip()
    notional = order.resolved_notional()
    qty = order.resolved_qty()
    total = state.total_value()

    def record(name: str, passed: bool, detail: str, blocking: bool = True) -> None:
        checks.append(Check(name, passed, detail))
        if not passed and blocking:
            reasons.append(detail)

    # 0. Basic sanity ------------------------------------------------------------
    record(
        "valid_side",
        side in ("buy", "sell"),
        f"side must be buy/sell, got {order.side!r}",
    )
    record(
        "positive_size",
        notional > 0 and qty > 0,
        f"order size must be positive (notional={notional:.2f}, qty={qty:.4f})",
    )
    record("has_price", order.ref_price > 0, f"ref_price must be > 0, got {order.ref_price}")

    # 1. Drawdown halt (account-level) -------------------------------------------
    if state.equity_peak > 0:
        drawdown = (state.equity_peak - total) / state.equity_peak
    else:
        drawdown = 0.0
    record(
        "drawdown_halt",
        drawdown <= config.max_drawdown_pct,
        f"account drawdown {drawdown:.1%} exceeds limit {config.max_drawdown_pct:.0%} — loop should halt",
    )

    # 2. Ticker permissions ------------------------------------------------------
    record(
        "not_blocklisted",
        ticker not in config.blocklist,
        f"{ticker} is on the blocklist",
    )
    record(
        "allowlisted",
        config.allowlist is None or ticker in config.allowlist,
        f"{ticker} is not on the allowlist",
    )

    # 3. Daily trade cap ---------------------------------------------------------
    record(
        "daily_trade_cap",
        state.trades_today < config.max_trades_per_day,
        f"daily trade cap reached ({state.trades_today}/{config.max_trades_per_day})",
    )

    # 4. Per-order notional cap --------------------------------------------------
    record(
        "per_order_notional",
        notional <= config.per_order_max_notional,
        f"order ${notional:,.2f} exceeds per-order cap ${config.per_order_max_notional:,.2f}",
    )

    if side == "buy":
        # 5. Cash floor — never spend below the reserve ---------------------------
        post_cash = state.cash - notional
        floor = config.cash_floor_pct * total
        record(
            "cash_floor",
            post_cash >= floor,
            f"buy would drop cash to ${post_cash:,.2f}, below floor ${floor:,.2f}"
            f" ({config.cash_floor_pct:.0%} of ${total:,.2f})",
        )
        record(
            "sufficient_cash",
            post_cash >= 0,
            f"insufficient cash: need ${notional:,.2f}, have ${state.cash:,.2f}",
        )
        # 5b. Settled-cash (cash account, T+1) — avoid good-faith violations from buying with
        # unsettled proceeds. Only enforced when required AND the broker reported settled cash.
        if config.require_settled_cash and state.settled_cash is not None:
            record(
                "settled_cash",
                notional <= state.settled_cash + 1e-9,
                f"buy ${notional:,.2f} exceeds settled cash ${state.settled_cash:,.2f} "
                f"(cash account T+1 — would risk a good-faith violation)",
            )

        # 6. Max position concentration (post-trade) ------------------------------
        post_position_value = state.position_value(ticker) + notional
        cap = config.max_position_pct * total
        record(
            "max_position_pct",
            total <= 0 or post_position_value <= cap + 1e-9,
            f"{ticker} would be ${post_position_value:,.2f} "
            f"({(post_position_value / total) if total else 0:.1%}), over the "
            f"{config.max_position_pct:.0%} cap (${cap:,.2f})",
        )
        # 6b. Total-deployment ceiling — the absolute $ cap on how much the sleeve may invest.
        # This is the "go live with $300, expand later" knob: raise the cap to scale up.
        if config.max_deployed_notional is not None:
            invested_after = (total - state.cash) + notional
            record(
                "max_deployed",
                invested_after <= config.max_deployed_notional + 1e-9,
                f"buy would bring total deployed to ${invested_after:,.2f}, over the "
                f"${config.max_deployed_notional:,.2f} ceiling",
            )
    elif side == "sell":
        # 7. No shorting — can't sell more than held ------------------------------
        held = state.positions.get(ticker)
        held_qty = held.qty if held else 0.0
        record(
            "no_oversell",
            qty <= held_qty + 1e-9,
            f"sell {qty:.4f} {ticker} exceeds held {held_qty:.4f} (no shorting)",
        )

    # 8. Cross-account wash-sale risk -------------------------------------------
    flagged = False
    try:
        flagged = bool(wash_sale_lookup(ticker, side))
    except Exception as exc:  # a lookup failure must never crash the gate
        warnings.append(f"wash-sale lookup failed: {exc}")
    if flagged:
        detail = f"{ticker} {side} flagged as cross-account wash-sale risk"
        checks.append(Check("wash_sale_risk", not config.block_on_wash_sale, detail))
        if config.block_on_wash_sale:
            reasons.append(detail)
        else:
            warnings.append(detail)
    else:
        checks.append(Check("wash_sale_risk", True, "no wash-sale risk detected"))

    return GuardrailResult(ok=not reasons, reasons=reasons, warnings=warnings, checks=checks)
