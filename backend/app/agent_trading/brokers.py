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
    state: str = "filled"   # broker order state: filled | partially_filled | unconfirmed | queued | …
    order_id: str = ""

    @property
    def is_filled(self) -> bool:
        return self.state in ("filled", "partially_filled") or self.venue == "sim"


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
_ORDERS_TOOL = "get_equity_orders"     # read back order status (executed vs queued)
_TRADABILITY_TOOL = "get_equity_tradability"  # is a symbol tradable / agentic-eligible (pre-trade gate)

# Broker order states that mean shares are actually in hand (vs merely accepted/queued).
_EXECUTED_STATES = {"filled", "partially_filled"}


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


def _place_log_path():
    """Where place_equity_order requests/responses are captured. Anchored to the backend root
    (…/backend/var/agent_trading/place_log.jsonl) via __file__ so it's the SAME file regardless of
    the process's cwd — a place log written by a run started elsewhere is still read by acquired_at.
    Backward compat: if the old cwd-relative file already exists, keep appending to that one."""
    from pathlib import Path as _Path
    legacy = _Path("var/agent_trading/place_log.jsonl")
    if legacy.exists():
        return legacy
    # brokers.py → agent_trading → app → backend
    return _Path(__file__).resolve().parents[2] / "var" / "agent_trading" / "place_log.jsonl"


def _log_place(args: dict, raw) -> None:
    """Best-effort capture of every place_equity_order request + response, so a placement can be
    verified against what Robinhood actually returned (var/agent_trading/place_log.jsonl)."""
    try:
        import json as _json
        import time as _time
        p = _place_log_path()
        p.parent.mkdir(parents=True, exist_ok=True)
        with p.open("a") as fh:
            fh.write(_json.dumps({"ts": _time.time(), "args": args, "raw": raw}, default=str) + "\n")
    except Exception:
        pass


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


def _truthy(v) -> Optional[bool]:
    """Coerce a stringy/boolean flag to a real bool, or None when unknown/absent."""
    if v is None:
        return None
    if isinstance(v, bool):
        return v
    s = str(v).strip().lower()
    if s in ("true", "1", "yes", "y", "t"):
        return True
    if s in ("false", "0", "no", "n", "f"):
        return False
    return None


def parse_tradability(payload) -> dict[str, dict]:
    """Map get_equity_tradability onto ``{SYMBOL: {tradable: bool|None, fractional: bool|None}}``.

    The live response shape for this tool isn't pinned to a captured sample yet (it's one of the
    newer read tools), so this is deliberately tolerant: it accepts a bare list of rows, a
    ``{results:[...]}`` / ``{items:[...]}`` envelope, or a symbol-keyed dict, and coerces stringy
    booleans. ``tradable=None`` means "the tool didn't say" — callers must treat None as
    not-a-veto so a schema drift can never silently block every order.
    """
    body = _unwrap(payload)
    rows: list = []
    if isinstance(body, dict):
        envelope_keys = ("results", "items", "tradability", "instruments", "quotes")
        if body and all(isinstance(v, dict) for v in body.values()) and not any(
                k in body for k in envelope_keys):
            rows = [{**v, "symbol": v.get("symbol", k)} for k, v in body.items()]
        else:
            for k in envelope_keys:
                if isinstance(body.get(k), list):
                    rows = body[k]
                    break
    elif isinstance(body, list):
        rows = body

    out: dict[str, dict] = {}
    for r in rows:
        if not isinstance(r, dict):
            continue
        sym = _sym(r, "symbol", "ticker", "instrument_symbol")
        if not sym:
            continue
        tradable = None
        for key in ("tradable", "tradeable", "is_tradable", "can_trade",
                    "agentic_tradable", "agentic_allowed", "marketable"):
            if key in r:
                tradable = _truthy(r.get(key))
                if tradable is not None:
                    break
        fractional = None
        for key in ("fractional", "fractional_tradable", "fractionable"):
            if key in r:
                fractional = _truthy(r.get(key))
                if fractional is not None:
                    break
        out[sym] = {"tradable": tradable, "fractional": fractional}
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
    # NEVER fall back to total_value for spendable cash: on a schema drift that would make the whole
    # portfolio (positions included) look like free cash and blow past sizing/cash-floor checks. Fall
    # back only to buying_power (settled/withdrawable-ish), which is the correct spendable proxy.
    cash = _num(p, "cash")
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
        order_policy=None,
    ):
        if mode not in (MODE_DISARMED, MODE_READ_ONLY, MODE_LIVE):
            raise ValueError(f"unknown mode {mode!r}")
        self.account_number = account_number
        self._mcp_client = mcp_client
        self._mode = mode
        self._order_policy = order_policy  # OrderPolicy | None (None → market)

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

    def quotes(self, symbols: list[str]) -> dict[str, float]:
        """Real-time quotes for ``symbols`` (read tool). Used to size a proposal off the LIVE
        price right before placing, so a market order doesn't fill far from the logged price."""
        syms = [s.upper().strip() for s in symbols if s]
        if not syms:
            return {}
        out: dict[str, float] = {}
        for i in range(0, len(syms), 20):  # the tool accepts up to 20 symbols per call
            chunk = syms[i:i + 20]
            out.update(parse_quotes(self._read("get_equity_quotes", {"symbols": chunk})))
        return out

    def tradability(self, symbols: list[str]) -> dict[str, dict]:
        """Per-symbol tradability flags via get_equity_tradability (read tool, added by Robinhood
        post-launch). Used as a pre-trade gate so a name Robinhood won't trade — or won't trade in
        an Agentic account — never reaches the approval queue. Chunked at 20 like quotes; a symbol
        absent from the result maps to ``{}`` (caller treats unknown as not-a-veto)."""
        syms = [s.upper().strip() for s in symbols if s]
        if not syms:
            return {}
        out: dict[str, dict] = {}
        for i in range(0, len(syms), 20):
            chunk = syms[i:i + 20]
            out.update(parse_tradability(self._read(_TRADABILITY_TOOL, {"symbols": chunk})))
        return out

    def portfolio_details(self) -> dict:
        """Richer get_portfolio read (read tool): cash, buying power, total/market value,
        withdrawable. snapshot() only needs cash for sizing; this surfaces the rest for the
        sleeve display/UI. Best-effort field extraction — missing fields come back as 0.0."""
        p = _unwrap(self._read("get_portfolio", {"account_number": self.account_number})) or {}
        bp = p.get("buying_power")
        buying_power = (_num(bp, "buying_power", "unleveraged_buying_power")
                        if isinstance(bp, dict) else _num(p, "buying_power"))
        return {
            "cash": _num(p, "cash"),
            "buying_power": buying_power,
            "total_value": _num(p, "total_value", "equity"),
            "market_value": _num(p, "market_value", "equity_value"),
            "withdrawable": _num(p, "withdrawable_amount", "withdrawable_cash"),
        }

    def review_order(self, order: ProposedOrder) -> dict:
        """Simulate an order via review_equity_order — returns Robinhood's pre-trade
        warnings WITHOUT placing. Allowed in read_only; this is the live dry-run."""
        return _unwrap(self._read(_REVIEW_TOOL, self._order_args(order))) or {}

    def recent_orders(self) -> list[dict]:
        """The recent-orders feed (get_equity_orders, read tool) as a list of raw order dicts.
        Used after a placement TIMEOUT to check whether the order actually reached the broker
        before allowing a retry (finding #2) — a blind retry could duplicate a filled order."""
        return _as_list(self._read(_ORDERS_TOOL, {"account_number": self.account_number}))

    def order_status(self, order_id: str) -> dict:
        """Read back ONE order's live status (read tool) so we can tell executed from queued
        after placing. A market order is "unconfirmed" the instant it's placed and flips to
        "filled" moments later — this is how the loop reconciles that. Returns a compact dict;
        ``state == ""`` means the order wasn't found in the recent-orders feed."""
        oid = str(order_id or "").strip()
        if not oid:
            return {"order_id": "", "state": "", "executed": False, "found": False}
        rows = _as_list(self._read(_ORDERS_TOOL, {"account_number": self.account_number}))
        match = next((o for o in rows if str(o.get("id") or o.get("order_id")) == oid), None)
        if not match:
            return {"order_id": oid, "state": "", "executed": False, "found": False}
        state = str(match.get("state", "")).lower().strip()
        filled = _num(match, "cumulative_quantity", "filled_quantity")
        return {
            "order_id": oid,
            "state": state,
            "executed": state in _EXECUTED_STATES or filled > 0,
            "filled_qty": filled,
            "avg_price": _num(match, "average_price"),
            "found": True,
        }

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

    def place_raw(self, order_args: dict) -> Fill:
        """Place the approved ``order_args``, but ALWAYS on this broker's bound account (the
        generation-time account_number is a placeholder) and with a limit quantity coerced to
        whole shares (Robinhood limit orders aren't fractional). Live only."""
        self._require_live()
        args = dict(order_args)
        # Our idempotency key rides ALONGSIDE the call (captured in the place log for verification /
        # timeout reconcile), but is NOT sent to place_equity_order — the agentic tool has no such
        # field and would reject an unknown arg. Pop it before building the MCP request.
        coid = args.pop("client_order_id", None)
        args["account_number"] = self.account_number        # the real agentic account, not a placeholder
        if args.get("type") == "limit" and args.get("quantity") is not None:
            args["quantity"] = max(1, int(float(args["quantity"])))  # limit orders are whole-share
        # Robinhood's schema wants decimal fields as STRINGS, not JSON numbers.
        for k in ("quantity", "limit_price"):
            if args.get(k) is not None:
                args[k] = str(args[k])
        raw = self._mcp_client(_PLACE_TOOL, args)
        _log_place({**args, "client_order_id": coid}, raw)  # capture the request (+ idempotency key) & response
        result = _unwrap(raw) or {}
        # Surface a rejection reason if the tool returned an error message (not a real order).
        if isinstance(result, dict) and result.get("_error"):
            raise BrokerError(f"place_equity_order rejected: {result['_error']}")
        # The order object is nested one level deeper (place_equity_order returns
        # {"data": {"order": {...}}}; _unwrap stripped "data", leaving {"order": {...}}). Older/
        # test shapes put the fields at top level, so fall back to ``result`` itself.
        order = result.get("order") if isinstance(result, dict) and isinstance(result.get("order"), dict) else result
        oid = (order.get("id") or order.get("order_id")) if isinstance(order, dict) else None
        # A genuine placement returns an order id; if it didn't, this was NOT a real order — fail
        # loudly (with the raw response) instead of falsely reporting "placed".
        if not oid:
            raise BrokerError(f"place_equity_order returned no order id — not placed: {raw}")
        # State tells us executed vs queued: "filled"/"partially_filled" = executed (some shares
        # in hand); "unconfirmed"/"confirmed"/"queued"/"new" = accepted but not yet filled. A
        # market order is "unconfirmed" the instant it's placed and fills moments later.
        state = str(order.get("state", "")).lower().strip() or "submitted"
        filled_qty = _num(order, "cumulative_quantity", "filled_quantity")
        order_qty = _num(order, "quantity", default=_num(order_args, "quantity"))
        fill_px = _num(order, "average_price") or _num(order, "price", default=_num(order_args, "limit_price"))
        shown_qty = filled_qty or order_qty
        return Fill(
            ticker=_sym(order_args, "symbol") or _sym(order, "symbol"),
            side=str(order_args.get("side", "")).lower().strip(),
            qty=shown_qty,
            price=fill_px,
            notional=_num(order, "filled_notional", "notional", default=shown_qty * fill_px),
            ts=str(order.get("created_at") or datetime.now(timezone.utc).isoformat()),
            venue="robinhood",
            state=state,
            order_id=str(oid),
        )

    # -- helpers -------------------------------------------------------------
    def _order_args(self, order: ProposedOrder) -> dict:
        # Shared builder (order_policy.py) so the live broker and the planner construct orders
        # identically — market by default, marketable-limit when an OrderPolicy is set.
        from .order_policy import build_order_args
        return build_order_args(self.account_number, order, policy=self._order_policy)

    def _account_matches(self, a: dict) -> bool:
        ours = str(self.account_number)
        return ours in (str(a.get("account_number", "")), str(a.get("rhs_account_number", "")))
