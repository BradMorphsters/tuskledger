"""Execution backends.

Two brokers share one tiny interface (:meth:`place_order` + :meth:`snapshot`):

* :class:`SimulatedBroker` — fills instantly at the order's reference price and tracks
  cash, positions, a daily trade counter, and an equity high-water mark. This is the
  experiment default: no money, no network, fully deterministic.

* :class:`RobinhoodMCPBroker` — maps an order onto the Robinhood Trading MCP
  ``place_order`` tool. It is **disarmed by default and refuses to place anything** until
  a human passes ``armed=True`` *and* a live MCP client callable. Arming, funding, and
  authenticating the broker is always the account owner's action — never the app's.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Callable, Optional

from .guardrails import AccountState, Position, ProposedOrder


class BrokerError(RuntimeError):
    """Raised when a broker cannot (or must not) execute an order."""


@dataclass(frozen=True)
class Fill:
    ticker: str
    side: str
    qty: float
    price: float
    notional: float
    ts: str
    venue: str  # "sim" | "robinhood"


# --------------------------------------------------------------------------- sim

class SimulatedBroker:
    """Deterministic paper broker. The whole experiment runs against this first."""

    def __init__(self, starting_cash: float):
        if starting_cash <= 0:
            raise ValueError("starting_cash must be positive")
        self._cash = float(starting_cash)
        self._positions: dict[str, Position] = {}
        self._prices: dict[str, float] = {}
        self._equity_peak = float(starting_cash)
        self._trades_today = 0

    # -- price marking -------------------------------------------------------
    def mark_prices(self, prices: dict[str, float]) -> None:
        """Update the last-known marks used for valuation (the analyst's ref prices)."""
        self._prices.update({k.upper(): float(v) for k, v in prices.items()})
        self._refresh_peak()

    def reset_day(self) -> None:
        self._trades_today = 0

    # -- execution -----------------------------------------------------------
    def place_order(self, order: ProposedOrder) -> Fill:
        ticker = order.ticker.upper().strip()
        side = order.side.lower().strip()
        price = float(order.ref_price)
        qty = order.resolved_qty()
        notional = order.resolved_notional()
        if price <= 0 or qty <= 0:
            raise BrokerError(f"invalid order: price={price}, qty={qty}")

        if side == "buy":
            if notional > self._cash + 1e-9:
                raise BrokerError(
                    f"insufficient cash: need ${notional:,.2f}, have ${self._cash:,.2f}"
                )
            self._cash -= notional
            self._add_position(ticker, qty, price)
        elif side == "sell":
            held = self._positions.get(ticker)
            if not held or qty > held.qty + 1e-9:
                raise BrokerError(
                    f"cannot sell {qty:.4f} {ticker}: hold {held.qty if held else 0:.4f}"
                )
            self._cash += notional
            self._reduce_position(ticker, qty)
        else:
            raise BrokerError(f"unknown side {order.side!r}")

        self._prices[ticker] = price
        self._trades_today += 1
        self._refresh_peak()
        return Fill(
            ticker=ticker,
            side=side,
            qty=qty,
            price=price,
            notional=notional,
            ts=datetime.now(timezone.utc).isoformat(),
            venue="sim",
        )

    # -- state ---------------------------------------------------------------
    def snapshot(self) -> AccountState:
        return AccountState(
            cash=round(self._cash, 6),
            positions=dict(self._positions),
            prices=dict(self._prices),
            equity_peak=round(self._equity_peak, 6),
            trades_today=self._trades_today,
        )

    # -- internals -----------------------------------------------------------
    def _add_position(self, ticker: str, qty: float, price: float) -> None:
        held = self._positions.get(ticker)
        if held:
            new_qty = held.qty + qty
            new_avg = (held.qty * held.avg_price + qty * price) / new_qty
            self._positions[ticker] = Position(qty=new_qty, avg_price=new_avg)
        else:
            self._positions[ticker] = Position(qty=qty, avg_price=price)

    def _reduce_position(self, ticker: str, qty: float) -> None:
        held = self._positions[ticker]
        remaining = held.qty - qty
        if remaining <= 1e-9:
            del self._positions[ticker]
        else:
            self._positions[ticker] = Position(qty=remaining, avg_price=held.avg_price)

    def _refresh_peak(self) -> None:
        self._equity_peak = max(self._equity_peak, self.snapshot_total())

    def snapshot_total(self) -> float:
        invested = sum(
            pos.qty * self._prices.get(tkr, pos.avg_price)
            for tkr, pos in self._positions.items()
        )
        return self._cash + invested


# --------------------------------------------------------------------------- robinhood

# A live MCP client: given (tool_name, arguments) it calls the Robinhood Trading MCP and
# returns the tool result. The app never constructs this — the human wires it from their
# armed agent session. Signature kept deliberately generic.
MCPClient = Callable[[str, dict], dict]


# Mode tiers for the live broker. The jump from read-only to live is the single most
# consequential human decision in the system, so it's an explicit, named state.
MODE_DISARMED = "disarmed"    # no calls at all (default)
MODE_READ_ONLY = "read_only"  # read tools + review_equity_order (simulate) — never places
MODE_LIVE = "live"            # everything incl. place/cancel — a deliberate human arm

# Robinhood Trading MCP tool names (beta: equities only).
_REVIEW_TOOL = "review_equity_order"   # simulate + pre-trade warnings; does NOT execute
_PLACE_TOOL = "place_equity_order"
_CANCEL_TOOL = "cancel_equity_order"


def _num(d: dict, *keys: str, default: float = 0.0) -> float:
    for k in keys:
        v = d.get(k) if isinstance(d, dict) else None
        if v is not None:
            try:
                return float(v)
            except (TypeError, ValueError):
                continue
    return default


def _sym(d: dict, *keys: str) -> str:
    for k in keys:
        v = d.get(k) if isinstance(d, dict) else None
        if v:
            return str(v).upper().strip()
    return ""


def _unwrap(payload):
    """Real Robinhood MCP responses wrap the body in a ``data`` envelope (alongside a
    ``guide`` string). Strip it so parsing sees the actual fields. Tolerant of an
    already-unwrapped payload (the test fakes return bare shapes)."""
    if isinstance(payload, dict) and isinstance(payload.get("data"), (dict, list)):
        return payload["data"]
    return payload


def _as_list(payload) -> list:
    """Pull a list out of an MCP response (after unwrapping the ``data`` envelope)."""
    payload = _unwrap(payload)
    if isinstance(payload, list):
        return payload
    if isinstance(payload, dict):
        for k in ("accounts", "positions", "equity_positions", "results", "items", "orders", "quotes"):
            if isinstance(payload.get(k), list):
                return payload[k]
    return []


def parse_quotes(payload) -> dict:
    """Live shape: get_equity_quotes.data.results[] = { quote: {symbol, last_trade_price,
    ...}, close: {...} }. Unwrap the nested ``quote`` (tolerant of a flat row too)."""
    out: dict[str, float] = {}
    for item in _as_list(payload):
        q = item.get("quote", item) if isinstance(item, dict) else item
        s = _sym(q, "symbol", "ticker")
        if s:
            out[s] = _num(q, "last_trade_price", "last_non_reg_trade_price",
                          "mark_price", "last_price", "price", "ask_price")
    return out


def parse_account_state(
    portfolio: dict,
    positions,
    quotes: Optional[dict] = None,
    *,
    account_number: Optional[str] = None,
) -> AccountState:
    """Map the Robinhood MCP read payloads onto our AccountState.

    Pinned to the live schema captured 2026-06-15:
      * ``get_portfolio.data``: ``{ cash, total_value, buying_power: { buying_power } }``
      * ``get_equity_positions.data.positions[]``: ``{ symbol, quantity, average_buy_price }``
      * ``get_equity_quotes`` rows: ``{ symbol, last_trade_price }``

    ``equity_peak`` / ``trades_today`` are the snapshot's own values; when a StateStore is
    in play, reconcile() overrides both with the persisted policy values.
    """
    p = _unwrap(portfolio) or {}
    quotes = quotes or {}
    bp = p.get("buying_power")
    cash = _num(p, "cash", "total_value")
    if cash == 0:
        cash = (_num(bp, "buying_power", "unleveraged_buying_power")
                if isinstance(bp, dict) else _num(p, "buying_power"))

    items = positions if isinstance(positions, list) else _as_list(positions)
    pos: dict[str, Position] = {}
    prices: dict[str, float] = {}
    for item in items:
        sym = _sym(item, "symbol", "ticker", "instrument_symbol")
        qty = _num(item, "quantity", "shares", "qty")
        if not sym or qty <= 0:
            continue
        avg = _num(item, "average_buy_price", "average_cost", "avg_cost", "cost_basis_per_share")
        pos[sym] = Position(qty=qty, avg_price=avg)
        mark = quotes.get(sym)
        if mark is None:
            mark = _num(item, "last_trade_price", "mark_price", "last_price", "price", default=avg)
        prices[sym] = mark
    total = cash + sum(q.qty * prices.get(s, q.avg_price) for s, q in pos.items())
    return AccountState(cash=cash, positions=pos, prices=prices, equity_peak=total, trades_today=0)


class RobinhoodMCPBroker:
    """Live broker over the Robinhood Trading MCP, with an explicit mode tier.

    * ``MODE_DISARMED`` (default) — refuses every call.
    * ``MODE_READ_ONLY`` — read tools + ``review_equity_order`` (a non-executing simulate)
      are allowed; ``place``/``cancel`` are hard-blocked. This is the Sprint-1 dry-run: read
      your real account and preview orders against Robinhood's own pre-trade warnings, with
      no ability to actually trade.
    * ``MODE_LIVE`` — places and cancels too. Reaching this state is a deliberate human arm;
      the application never sets it on its own.

    Auth is OAuth via the owner's connected MCP client — the app never sees a password and
    never constructs the client; it's injected from the owner's session.
    """

    TRADING_MCP_URL = "https://agent.robinhood.com/mcp/trading"

    def __init__(
        self,
        account_number: str,
        mcp_client: Optional[MCPClient] = None,
        *,
        mode: str = MODE_DISARMED,
    ):
        if mode not in (MODE_DISARMED, MODE_READ_ONLY, MODE_LIVE):
            raise ValueError(f"unknown mode {mode!r}")
        self.account_number = account_number
        self._mcp_client = mcp_client
        self._mode = mode

    @property
    def mode(self) -> str:
        return self._mode

    # -- guards --------------------------------------------------------------
    def _require_read(self) -> None:
        if self._mode == MODE_DISARMED or self._mcp_client is None:
            raise BrokerError(
                "RobinhoodMCPBroker is disarmed. Connect a Robinhood Trading MCP client "
                "and set mode='read_only' (reads + simulate) or 'live'."
            )

    def _require_live(self) -> None:
        if self._mode != MODE_LIVE:
            raise BrokerError(
                f"order blocked: broker is in '{self._mode}' mode. Placing or cancelling "
                "orders requires mode='live' — an explicit human arm. Reads and "
                "review_equity_order (simulate) are available in read_only."
            )

    def _read(self, tool: str, args: dict):
        self._require_read()
        return self._mcp_client(tool, args)

    # -- reads ---------------------------------------------------------------
    def ping(self) -> dict:
        """Connectivity + auth self-check: can we reach the read tools, and is the
        configured Agentic account visible? No side effects."""
        accounts = _as_list(self._read("get_accounts", {}))
        return {
            "ok": True,
            "mode": self._mode,
            "accounts": len(accounts),
            "agentic_account_found": any(self._account_matches(a) for a in accounts),
            "account_number": self.account_number,
        }

    def find_agentic_account(self) -> Optional[str]:
        """The account_number of the (single) account where agentic trading is allowed."""
        for a in _as_list(self._read("get_accounts", {})):
            if a.get("agentic_allowed"):
                return str(a.get("account_number"))
        return None

    def snapshot(self) -> AccountState:
        acct = self.account_number
        portfolio = self._read("get_portfolio", {"account_number": acct})
        positions = _as_list(self._read("get_equity_positions", {"account_number": acct}))
        syms = [s for s in (_sym(p, "symbol", "ticker", "instrument_symbol") for p in positions) if s]
        quotes = parse_quotes(self._read("get_equity_quotes", {"symbols": syms})) if syms else {}
        return parse_account_state(portfolio, positions, quotes, account_number=acct)

    def review_order(self, order: ProposedOrder) -> dict:
        """Simulate an order via review_equity_order — returns Robinhood's pre-trade
        warnings WITHOUT placing. Allowed in read_only; this is the live dry-run."""
        return _unwrap(self._read(_REVIEW_TOOL, self._order_args(order))) or {}

    # -- writes (live only) --------------------------------------------------
    def place_order(self, order: ProposedOrder) -> Fill:
        self._require_live()
        result = _unwrap(self._mcp_client(_PLACE_TOOL, self._order_args(order))) or {}
        return Fill(
            ticker=order.ticker.upper().strip(),
            side=order.side.lower().strip(),
            qty=_num(result, "filled_quantity", "quantity", default=order.resolved_qty()),
            price=_num(result, "average_price", "price", default=order.ref_price),
            notional=_num(result, "filled_notional", "notional", default=order.resolved_notional()),
            ts=str(result.get("created_at") or datetime.now(timezone.utc).isoformat()),
            venue="robinhood",
        )

    # -- helpers -------------------------------------------------------------
    def _order_args(self, order: ProposedOrder) -> dict:
        args = {
            "account_number": self.account_number,
            "symbol": order.ticker.upper().strip(),
            "side": order.side.lower().strip(),
            "type": "market",
        }
        if order.notional is not None:
            args["amount"] = round(order.resolved_notional(), 2)
        else:
            args["quantity"] = order.resolved_qty()
        return args

    def _account_matches(self, a: dict) -> bool:
        ours = str(self.account_number)
        return ours in (str(a.get("account_number", "")), str(a.get("rhs_account_number", "")))
