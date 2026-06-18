"""Agent Trading tab — read-only API over the agentic-trading decision log.

Phase 1 (see ``docs/agent-trading-tab.md``): the tab is a supervisory cockpit, not an
executor. Every endpoint here is read-only; it parses the decision log the experiment
harness writes and never places, cancels, or sizes a trade. The live kill switch lives
on Robinhood and is surfaced to the UI as a deep link, not reimplemented.

Degrades gracefully: with no log yet, ``/status`` reports ``configured: false`` and the
rest return empty shapes, so the tab renders a clean "no runs yet" state.
"""
from __future__ import annotations

import asyncio
import json
import time
from pathlib import Path

from fastapi import APIRouter, Query
from fastapi.responses import StreamingResponse

from dataclasses import replace

from fastapi import Depends, HTTPException
from sqlalchemy.orm import Session

from app.config import settings
from app.database import get_db
from app.services import agent_trading_log as log
from app.agent_trading.events import EventLog, demo_plan, plan_to_events
from app.agent_trading.state import StateStore, control_status, resolve_state_path
from app.agent_trading.strategy import PROFILES

router = APIRouter(prefix="/api/agent-trading", tags=["agent-trading"])

# The owner hits the live kill switch on Robinhood; we only link to it.
ROBINHOOD_KILL_URL = "https://robinhood.com/us/en/agentic-trading/"


def _path():
    return log.resolve_log_path(settings.AGENT_TRADING_LOG)


def _events_path() -> Path:
    if settings.AGENT_TRADING_EVENTS:
        return Path(settings.AGENT_TRADING_EVENTS).expanduser()
    return Path("var/agent_trading/events.jsonl")


def _store() -> StateStore:
    return StateStore(resolve_state_path(settings.AGENT_TRADING_STATE))


def _control_payload(store: StateStore) -> dict:
    s = store.load()
    return {
        "status": control_status(s),     # active | paused | halted
        "halted": s.halted,
        "paused": s.paused,
        "equity_peak": s.equity_peak,
        "last_reconciled": s.last_reconciled,
        "strategy": s.strategy or settings.AGENT_TRADING_STRATEGY,  # active Analyst profile
        "strategies": list(PROFILES),                              # the selectable profiles
        "kill_switch_url": ROBINHOOD_KILL_URL,
    }


@router.get("/status")
def agent_trading_status():
    """Is there a log, when did it last run, what mode, is it halted."""
    s = log.status(_path())
    s["kill_switch_url"] = ROBINHOOD_KILL_URL
    return s


@router.get("/summary")
def agent_trading_summary():
    rows = log.load_rows(_path())
    out = log.summary(rows)
    out["kill_switch_url"] = ROBINHOOD_KILL_URL
    return out


@router.get("/positions")
def agent_trading_positions():
    rows = log.load_rows(_path())
    return {"positions": log.positions(rows)}


@router.get("/sleeve")
def agent_trading_sleeve():
    """Live cash on hand + how much is deployable right now (read-only). Powers the 'cash to
    trade' display. ``cash`` is the sleeve's available balance; ``deployable`` is the lesser of
    that and the remaining room under your self-imposed cap. Degrades to disconnected when Tusk
    Ledger isn't the bound agent yet (no network call in that case)."""
    from app.agent_trading.brokers import MODE_READ_ONLY
    from app.agent_trading.robinhood_agent import connection_status, make_broker
    store = _agent_store()
    if not connection_status(store)["connected"]:
        return {"connected": False, "armed": bool(settings.AGENT_TRADING_ARMED),
                "cash": None, "deployable": None}
    try:
        snap = make_broker(store, mode=MODE_READ_ONLY).snapshot()
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"Couldn't read your sleeve: {e}")
    invested = round(snap.total_value() - snap.cash, 2)
    cap = settings.AGENT_TRADING_MAX_DEPLOYED or 0.0
    headroom = round(cap - invested, 2) if cap > 0 else None
    deployable = min(snap.cash, headroom) if headroom is not None else snap.cash
    return {
        "connected": True, "armed": bool(settings.AGENT_TRADING_ARMED),
        "cash": round(snap.cash, 2),          # sleeve cash available to trade
        "invested": invested,                 # current market value of held positions
        "cap": cap or None,                   # self-imposed deployment ceiling (0/None = unlimited)
        "cap_headroom": headroom,             # room left under the cap
        "deployable": round(max(0.0, deployable), 2),  # what a new buy can actually use
        "positions": len(snap.positions),
        "order_type": str(settings.AGENT_TRADING_ORDER_TYPE).lower(),
    }


@router.get("/activity")
def agent_trading_activity(limit: int = Query(100, ge=1, le=1000)):
    rows = log.load_rows(_path())
    return {"activity": log.activity(rows, limit=limit)}


@router.get("/guardrails")
def agent_trading_guardrails():
    rows = log.load_rows(_path())
    return log.guardrail_breaches(rows)


@router.get("/exposure")
def agent_trading_exposure(db: Session = Depends(get_db)):
    """Cross-portfolio exposure: the agent's universe vs your main-portfolio holdings, so a
    name the agent wants to buy that you already hold heavily stands out. Read-only."""
    from app.models import Holding, Security
    from app.agent_trading.exposure import cross_exposure
    from app.services import research_store as rs

    main: dict[str, float] = {}
    rows_q = (db.query(Holding, Security)
              .join(Security, Holding.plaid_security_id == Security.plaid_security_id).all())
    for h, sec in rows_q:
        t = (sec.ticker_symbol or "").upper()
        if not t:
            continue
        val = h.institution_value or (h.quantity or 0.0) * (h.institution_price or 0.0)
        main[t] = main.get(t, 0.0) + (val or 0.0)

    dom = rs.get_active_domain() or (rs.list_domains() or [None])[0]
    universe = [(e.get("ticker") or "").upper()
                for e in ((rs.load_domain(dom).get("entities") if dom else []) or []) if e.get("ticker")]

    log_rows = log.load_rows(_path())
    proposed: set[str] = set()
    if log_rows:
        last = log_rows[-1].get("as_of")
        for r in log_rows:
            if r.get("as_of") == last and r.get("status") in ("approved", "executed"):
                tk = (r.get("decision") or {}).get("ticker")
                if tk:
                    proposed.add(tk.upper())

    out = cross_exposure(universe, main, proposed=proposed)
    out["domain"] = dom
    return out


@router.get("/backtest")
def agent_trading_backtest(profile: str = Query(None, description="profile for the per-name detail")):
    """Backtest the price-driven Analyst profiles over the cached history. Returns a
    comparison scoreboard + per-ticker simulated trades for one profile. Read-only."""
    from app.agent_trading.backtest import PRICE_PROFILES, compare_profiles, trades_by_ticker
    from app.services import research_store as rs

    dom = rs.get_active_domain() or (rs.list_domains() or [None])[0]
    prices = rs.load_prices(dom) if dom else {}
    if not prices:
        return {"configured": False, "domain": dom, "comparison": [], "detail": None}

    results = compare_profiles(prices, starting_cash=1000.0)
    any_r = next(iter(results.values()))
    comparison = sorted(
        [{"profile": p, "total_return": r.total_return, "cagr": r.cagr,
          "max_drawdown": r.max_drawdown, "trades": r.trades, "beats": r.beat_benchmark()}
         for p, r in results.items()],
        key=lambda x: x["total_return"], reverse=True,
    )

    # detail profile: the requested one (if price-based) → else the persisted strategy → else the best
    persisted = _store().load().strategy or settings.AGENT_TRADING_STRATEGY
    sel = profile if profile in PRICE_PROFILES else (persisted if persisted in PRICE_PROFILES else comparison[0]["profile"])
    detail_res = results.get(sel)
    detail = {
        "profile": sel,
        "trades_by_ticker": trades_by_ticker(detail_res),
        "equity_curve": detail_res.equity_curve,
        "benchmark_curve": detail_res.benchmark_curve,
    } if detail_res else None

    return {
        "configured": True, "domain": dom, "months": any_r.months,
        "benchmark_return": any_r.benchmark_return, "comparison": comparison, "detail": detail,
    }


def _proposal_store():
    from app.agent_trading.proposals import ProposalStore, resolve_proposals_path
    return ProposalStore(resolve_proposals_path(settings.AGENT_TRADING_PROPOSALS))


def _alert_log():
    from app.agent_trading.alerts import AlertLog, resolve_alerts_path
    return AlertLog(resolve_alerts_path(settings.AGENT_TRADING_ALERTS))


def _agent_store():
    from app.agent_trading.robinhood_agent import EncryptedJsonStore, store_path
    return EncryptedJsonStore(store_path(settings.AGENT_TRADING_AGENT_STORE))


def _live_broker():
    """The armed live broker, or None. Returns a broker ONLY when (a) Tusk Ledger is connected to
    the Robinhood agentic MCP AND (b) AGENT_TRADING_ARMED is explicitly true. Until then Approve
    only *marks* approved — the backend never places. Arming is a deliberate human step."""
    if not settings.AGENT_TRADING_ARMED:
        return None
    from app.agent_trading.robinhood_agent import connection_status, make_broker
    from app.agent_trading.brokers import MODE_LIVE
    store = _agent_store()
    if not connection_status(store)["connected"]:
        return None
    return make_broker(store, mode=MODE_LIVE)


def _read_broker():
    """A READ-ONLY live broker (connected, not necessarily armed). Used to read back order status
    and reconcile fills — reading never needs the arm, so this works even before AGENT_TRADING_ARMED."""
    from app.agent_trading.robinhood_agent import connection_status, make_broker
    from app.agent_trading.brokers import MODE_READ_ONLY
    store = _agent_store()
    if not connection_status(store)["connected"]:
        return None
    return make_broker(store, mode=MODE_READ_ONLY)


_EXECUTED = {"filled", "partially_filled"}
# Terminal states that mean the order ended WITHOUT filling — a GFD limit cancelled at the close
# is the common one. Logged on the timeline (no alert — Robinhood already notifies the user).
_TERMINAL_UNFILLED = {"cancelled", "canceled", "rejected", "expired", "failed", "voided"}


def _emit_cancelled_event(p, oid: str, state: str) -> bool:
    """Log (not alert) that an order ended unfilled, so the timeline reflects reality instead of
    leaving it on QUEUED. Idempotent on the order marker. No alert — the user gets those from
    Robinhood directly."""
    try:
        import datetime as _dt
        from app.agent_trading.events import EventLog
        log = EventLog(_events_path())
        marker = f"order {oid[:8]} unfilled"
        if any(marker in (e.get("detail") or "") for e in log.read_all()):
            return False
        log.append({
            "seq": 9200, "ts": _dt.datetime.now(_dt.timezone.utc).isoformat(),
            "cycle_id": getattr(p, "cycle_id", ""), "type": "cancelled", "status": "warn",
            "label": f"UNFILLED {p.side} {p.ticker}",
            "detail": f"{marker} — {state}; good-for-day order ended without filling",
            "ticker": p.ticker})
        return True
    except Exception:  # noqa: BLE001
        return False


def _emit_executed_event(p, oid: str, *, qty=None, px=None) -> bool:
    """Append a single EXECUTED event for a confirmed fill so the timeline shows the real status.
    Idempotent: a second call for the same order (e.g. the on-approve poll AND the cycle reconcile)
    is a no-op. Returns True only if it actually wrote the event."""
    try:
        import datetime as _dt
        from app.agent_trading.events import EventLog
        log = EventLog(_events_path())
        marker = f"order {oid[:8]} filled"
        if any(marker in (e.get("detail") or "") for e in log.read_all()):
            return False
        log.append({
            "seq": 9100, "ts": _dt.datetime.now(_dt.timezone.utc).isoformat(),
            "cycle_id": getattr(p, "cycle_id", ""), "type": "placed", "status": "ok",
            "label": f"EXECUTED {p.side} {p.ticker}",
            "detail": (marker + (f" · {float(qty):.4f} sh" if qty else "")
                       + (f" @ ${float(px):.2f}" if px else "")),
            "ticker": p.ticker})
        return True
    except Exception:  # noqa: BLE001
        return False


def _backfill_decision_fill(order_id: str, *, price=None, qty=None, state=None) -> bool:
    """Once an order confirms filled, rewrite its decision-log row with the broker's real fill
    price/notional (the place response returned the accepted order at price 0). Atomic rewrite via
    a temp file + os.replace. Idempotent — no write when nothing changed. Returns True if written."""
    from app.services import agent_trading_log as log
    path = _path()
    rows = log.load_rows(path)
    rows, changed = log.backfill_fill(rows, order_id, price=price, qty=qty, state=state)
    if not changed:
        return False
    try:
        import os
        import tempfile
        path.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=str(path.parent), suffix=".tmp")
        with os.fdopen(fd, "w") as fh:
            for r in rows:
                fh.write(json.dumps(r) + "\n")
        os.replace(tmp, path)
        return True
    except Exception:  # noqa: BLE001 — a failed backfill must never break the reconcile
        return False


def _cancel_decision_fill(order_id: str, *, state: str = "cancelled") -> bool:
    """Correct an order's decision-log row to cancelled-unfilled (qty/notional 0) so it stops
    showing a phantom position. Atomic rewrite; idempotent; never breaks the reconcile."""
    from app.services import agent_trading_log as log
    path = _path()
    rows, changed = log.cancel_fill(log.load_rows(path), order_id, state=state)
    if not changed:
        return False
    try:
        import os
        import tempfile
        path.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=str(path.parent), suffix=".tmp")
        with os.fdopen(fd, "w") as fh:
            for r in rows:
                fh.write(json.dumps(r) + "\n")
        os.replace(tmp, path)
        return True
    except Exception:  # noqa: BLE001
        return False


def _reconcile_placed(store, broker=None) -> list[dict]:
    """Read back every PLACED proposal whose order isn't yet known-filled and update its recorded
    state (queued/unconfirmed → filled). Emits a FILLED event the first time a fill is confirmed,
    so the activity timeline stops showing a filled order as merely 'placed'. Read-only; safe to
    call on every cycle. Returns the list of orders whose state advanced."""
    broker = broker if broker is not None else _read_broker()
    if broker is None or not hasattr(broker, "order_status"):
        return []
    updates: list[dict] = []
    for p in store.list("placed"):
        oid = p.placed_ref or ""
        if not oid or ":" in oid:                       # sim placement (venue:ts) — nothing to read back
            continue
        if (p.placed_state or "") in _EXECUTED:         # already known filled
            continue
        try:
            st = broker.order_status(oid)
        except Exception:  # noqa: BLE001 — one bad read must not break the cycle
            continue
        if not (st.get("found") and st.get("state")) or st["state"] == p.placed_state:
            continue
        store.update_placed_state(p.id, st["state"])
        advanced = {"ticker": p.ticker, "order_id": oid, "state": st["state"], "executed": st.get("executed")}
        updates.append(advanced)
        if st.get("executed"):                          # confirmed fill → timeline + true-cost backfill
            _emit_executed_event(p, oid, qty=st.get("filled_qty") or p.qty, px=st.get("avg_price"))
            _backfill_decision_fill(oid, price=st.get("avg_price"),
                                    qty=st.get("filled_qty") or p.qty, state=st.get("state"))
        elif st.get("state") in _TERMINAL_UNFILLED:     # ended unfilled (e.g. GFD cancel) → log, fix position
            _emit_cancelled_event(p, oid, st["state"])
            _cancel_decision_fill(oid, state=st["state"])
    return updates


def _proposal_dict(p) -> dict:
    from dataclasses import asdict
    d = asdict(p)
    oa = d.pop("order_args", None) or {}   # internal placement args — not surfaced to the UI…
    # …except the two fields the approval card needs: the order type and (for a limit) the price
    # cap, so the user can see the most they'll pay (buy) / least they'll accept (sell).
    d["order_type"] = oa.get("type")
    if oa.get("limit_price") is not None:
        d["limit_price"] = oa.get("limit_price")
    return d


@router.get("/connect/status")
def agent_trading_connect_status():
    """Is Tusk Ledger connected to the Robinhood agentic MCP, and in what mode? No network call."""
    from app.agent_trading.robinhood_agent import connection_status
    out = connection_status(_agent_store(), armed=settings.AGENT_TRADING_ARMED)
    out["armed"] = settings.AGENT_TRADING_ARMED
    return out


@router.post("/connect/start")
def agent_trading_connect_start():
    """Run the one-time OAuth consent: opens Robinhood's authorization in YOUR browser, then
    stores the encrypted token and resolves the agentic account. Desktop only. This authorizes
    Tusk Ledger as the agent — it does not arm live trading (that's a separate step)."""
    from app.agent_trading.robinhood_agent import connect_once
    try:
        status = connect_once(_agent_store())
    except ImportError:
        raise HTTPException(status_code=501, detail="The 'mcp' package isn't installed on the backend. Run: pip install mcp")
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"Robinhood connect failed: {e}")
    return {"ok": status.get("connected", False), **status}


@router.post("/connect/ping")
def agent_trading_connect_ping():
    """Live read-only self-check: confirm the stored token works and the agentic account is
    visible. Reads only — places nothing."""
    from app.agent_trading.robinhood_agent import connection_status, make_broker
    from app.agent_trading.brokers import MODE_READ_ONLY, BrokerError
    store = _agent_store()
    if not connection_status(store)["connected"]:
        raise HTTPException(status_code=409, detail="Not connected — click Connect first.")
    try:
        broker = make_broker(store, mode=MODE_READ_ONLY)
        out = broker.ping()
        snap = broker.snapshot()   # real sleeve balance — proves it reads the live account
        out["sleeve_cash"] = round(snap.cash, 2)
        out["sleeve_positions"] = len(snap.positions)
        return out
    except (BrokerError, Exception) as e:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"Ping failed: {e}")


@router.post("/connect/disconnect")
def agent_trading_connect_disconnect():
    """Forget the stored Robinhood token (reverse of Connect). The backend can no longer read or
    place. You should also revoke Tusk Ledger in Robinhood's agent settings."""
    _agent_store().clear()
    return {"ok": True, "connected": False}


@router.get("/proposals")
def agent_trading_proposals(status: str = Query(None, description="filter: pending|approved|rejected|placed|expired")):
    """The human-in-the-loop approval queue: gate-approved orders awaiting your Approve/Reject.
    Read-only. Approving one is a separate, explicit POST — nothing here places a trade."""
    store = _proposal_store()
    return {
        "proposals": [_proposal_dict(p) for p in store.list(status=status)],
        "counts": store.counts(),
        "kill_switch_url": ROBINHOOD_KILL_URL,
    }


@router.post("/proposals/generate")
def agent_trading_generate_proposals(
    cash: float = Query(2000.0, gt=0, description="sim sleeve cash for sizing until the backend is the bound agent"),
    profile: str = Query(None, description="strategy profile (defaults to the active one)"),
    max_price_age_hours: float = Query(48.0, gt=0, description="stale-data gate: skip new buys whose price feed is older than this"),
    db: Session = Depends(get_db),
):
    """Run the Analyst → guardrail gate over the active research universe and queue the
    gate-APPROVED orders for your approval. A stale-data gate runs first: a name is skipped for
    NEW buys if its method inputs are stale (price feed older than ``max_price_age_hours`` or
    research past its review date) — so the agent only acts on fresh data. Held names are exempt
    (exits still fire). Until the backend is the bound agent, sizing uses a simulated cash sleeve.
    It PLACES NOTHING — it only writes the approval queue."""
    import time as _time

    from app.agent_trading.bridge import plan_cycle
    from app.agent_trading.brokers import MODE_READ_ONLY, BrokerError
    from app.agent_trading.candidates import freshness_skips, holdings_from_state, make_candidate_provider
    from app.agent_trading.guardrails import AccountState, GuardrailConfig
    from app.agent_trading.proposals import generate_proposals
    from app.agent_trading.robinhood_agent import connection_status, make_broker
    from app.agent_trading.sizing import SizingConfig, size_decisions
    from app.agent_trading.state import AgentState
    from app.agent_trading.strategy import PROFILES, StrategyConfig
    from app.agent_trading.strategy import propose as propose_strategy
    from app.services import research_store as rs

    dom = rs.get_active_domain() or (rs.list_domains() or [None])[0]
    if not dom:
        return {"configured": False, "domain": None, "queued": 0, "proposals": []}

    active = _store().load().strategy or settings.AGENT_TRADING_STRATEGY
    sel = profile if profile in PROFILES else active
    today = __import__("datetime").date.today().isoformat()

    prices = rs.load_prices(dom) or {}
    entities = (rs.load_domain(dom).get("entities") or [])
    by_ticker = {(e.get("ticker") or "").upper(): e for e in entities if e.get("ticker")}

    # Size against the LIVE sleeve when Tusk Ledger is the connected agent (real cash + positions);
    # only fall back to the sim `cash` when not connected. This is what makes the queue reflect
    # your actual account instead of a placeholder.
    live = connection_status(_agent_store())["connected"]
    holdings: dict = {}
    live_account = "approval-queue"
    reconciled: list = []
    if live:
        broker_ro = make_broker(_agent_store(), mode=MODE_READ_ONLY)
        try:
            snapshot = broker_ro.snapshot()
        except Exception as e:  # noqa: BLE001 — surface a clear error rather than silently simming
            raise HTTPException(status_code=502, detail=f"Couldn't read your live sleeve: {e}")
        holdings = holdings_from_state(snapshot)
        live_account = broker_ro.account_number or "agentic"   # real account in the order args
        # Reconcile any already-placed orders against their live state, so a queued order that has
        # since filled flips to FILLED on the timeline (instead of being stuck on 'placed').
        try:
            reconciled = _reconcile_placed(_proposal_store(), broker_ro)
        except Exception:  # noqa: BLE001
            reconciled = []
        # Refresh the WHOLE universe to LIVE quotes before the Analyst ranks anything, so the
        # consideration (signals, freshness, sizing) runs on current prices — not a daily cache.
        try:
            from app.agent_trading.candidates import overlay_live_prices
            uq = broker_ro.quotes(list(by_ticker.keys()))
            if uq:
                prices = overlay_live_prices(prices, uq, now_epoch=_time.time())
        except Exception:  # noqa: BLE001 — fall back to the cache; never crash the cycle
            pass
    else:
        snapshot = AccountState(cash=cash, positions={}, prices={}, equity_peak=cash, trades_today=0)

    candidates = make_candidate_provider(dom, holdings, today=today, prices_override=prices)([], today)

    # Finnhub estimate-revision tilt: rising analyst estimates lift a name's rotation rank, falling
    # cut it (bounded). Loaded once; also feeds the earnings-blackout gate below. Cold cache → no-op.
    from app.agent_trading.event_risk import apply_revision_tilt, earnings_skips
    from app.services import finnhub as _finnhub
    _fh_cache = _finnhub.load_cache(dom)
    candidates = apply_revision_tilt(candidates, _fh_cache)

    skips = freshness_skips(candidates, prices, by_ticker, now_epoch=_time.time(),
                            today=today, max_price_age_hours=max_price_age_hours)
    fresh = [c for c in candidates if c.held or c.ticker not in skips]

    # Deployment ceiling: when set, cap total invested AND size positions off that budget so it
    # spreads across the strategy's picks (auto-scales when you raise the cap). 0 = unlimited.
    from app.agent_trading.order_policy import OrderPolicy
    cap = settings.AGENT_TRADING_MAX_DEPLOYED or 0.0
    total_val = snapshot.total_value() or 1.0
    strat_cfg = StrategyConfig(profile=sel)
    if cap > 0:
        per_pos = cap / max(1, strat_cfg.max_new_positions)
        frac = min(0.10, per_pos / total_val)
        sizing = SizingConfig(method="fixed_fractional", fraction=frac,
                              max_fraction=min(0.20, max(frac * 1.5, 0.05)))
        grc = GuardrailConfig(max_deployed_notional=cap)
    else:
        sizing = SizingConfig(method="fixed_fractional", fraction=0.10)
        grc = GuardrailConfig()
    # Order type is env-driven (AGENT_TRADING_ORDER_TYPE): "market" = fractional/instant, "limit" =
    # a marketable limit a few bps through last (whole-share, slippage-capped) for the thin juniors.
    from app.agent_trading.order_policy import OrderPolicy
    order_policy = (
        OrderPolicy(order_type="limit", limit_offset_bps=settings.AGENT_TRADING_LIMIT_BPS)
        if str(settings.AGENT_TRADING_ORDER_TYPE).strip().lower() == "limit"
        else None
    )

    # "Don't chase" discipline: defer a new buy that's run too far, too fast (re-check next cycle).
    # Held names exempt so exits still fire. Surfaces in "Not proposed this cycle" with its reason.
    from app.agent_trading.candidates import chase_skips
    chase = chase_skips(fresh, max_chase_momentum=strat_cfg.max_chase_momentum, profile=sel)
    if chase:
        skips = {**skips, **chase}
        fresh = [c for c in fresh if c.held or c.ticker.upper() not in chase]

    # Event-risk gate: defer a NEW buy when the name just filed a capital raise (S-1/S-3/424B
    # dilution) within the lookback — the top drawdown source for pre-revenue juniors. Reads the
    # per-domain EDGAR activity cache; held names are flagged (warning), never force-sold.
    from app.agent_trading.event_risk import event_risk_skips
    erisk = event_risk_skips(fresh, rs.load_edgar(dom), today=today,
                             lookback_days=settings.AGENT_TRADING_DILUTION_LOOKBACK_DAYS)
    if erisk:
        skips = {**skips, **erisk}
        fresh = [c for c in fresh if c.held or c.ticker.upper() not in erisk]

    # Earnings-blackout gate: defer a NEW buy within N days of the name's next print (event risk).
    esk = earnings_skips(fresh, _fh_cache, today=today,
                         blackout_days=settings.AGENT_TRADING_EARNINGS_BLACKOUT_DAYS)
    if esk:
        skips = {**skips, **esk}
        fresh = [c for c in fresh if c.held or c.ticker.upper() not in esk]

    # Candidates already carry live prices (universe was re-quoted above), so the Analyst ranked
    # and the sizer sizes off current prices — no stale-cache gap into a market order.
    decisions = propose_strategy(fresh, strat_cfg)
    decisions = size_decisions(decisions, snapshot, sizing)

    # Tax-friendly rotation: a soft rank-slip exit only fires to FUND a qualifying new buy (held
    # otherwise, to avoid a taxable sale); when capital MUST be freed, the most tax-favorable names
    # go first (harvest losses → long-term gains → short-term); wash-sale-conflicting buys are
    # deferred. Hard exits (quality floor / orphan) are untouched. Pure layer; see rotation_coupling.
    from app.agent_trading.rotation_coupling import acquired_at_from_place_log, couple_rotation_sells
    from app.agent_trading.wash_sale import make_db_wash_sale_lookup
    try:
        _ws = make_db_wash_sale_lookup(db)
    except Exception:  # noqa: BLE001 — wash-sale wiring must never break a cycle
        _ws = None
    _acq: dict = {}
    try:
        _pl = _events_path().parent / "place_log.jsonl"
        if _pl.exists():
            _acq = acquired_at_from_place_log(
                [json.loads(ln) for ln in _pl.read_text().splitlines() if ln.strip()])
    except Exception:  # noqa: BLE001 — holding-period is best-effort
        _acq = {}
    coupling = couple_rotation_sells(
        decisions, snapshot, cap=cap, cash_floor_pct=grc.cash_floor_pct,
        wash_sale_lookup=_ws or (lambda _t, _s: False), acquired_at=_acq, today=today,
        couple=strat_cfg.couple_sells_to_buys, tax_aware=strat_cfg.tax_aware_exit)
    decisions = coupling.decisions
    if coupling.skips():
        skips = {**skips, **coupling.skips()}

    plan = plan_cycle(account_number=(live_account if live else "approval-queue"), snapshot=snapshot,
                      decisions=decisions, config=grc, persisted=AgentState(),
                      order_policy=order_policy, as_of=today)

    cycle_id, queued = generate_proposals(_proposal_store(), plan)
    # Stream the cycle to the live activity timeline (cycle_started → read → per-order gate → done).
    try:
        from app.agent_trading.events import EventLog, plan_to_events
        evs = plan_to_events(plan, cycle_id=cycle_id, cash=snapshot.cash, positions=len(snapshot.positions))
        for t, r in sorted(skips.items()):
            evs.append({"seq": len(evs), "ts": __import__("datetime").datetime.now(
                __import__("datetime").timezone.utc).isoformat(), "cycle_id": cycle_id,
                "type": "skipped", "label": f"Skipped {t}", "status": "warn",
                "detail": r, "ticker": t})
        EventLog(_events_path()).append_all(evs)
    except Exception:  # noqa: BLE001 — activity logging must never break a cycle
        pass
    armed = bool(settings.AGENT_TRADING_ARMED)
    cap_txt = f" · cap ${cap:,.0f}" if cap > 0 else ""
    if not live:
        note = "Not connected — sized against a simulated sleeve. Connect in Accounts to use your real balance."
    elif armed:
        note = f"LIVE & ARMED{cap_txt}. Approving an order PLACES it on your real sleeve (${snapshot.cash:,.0f} cash)."
    else:
        note = f"Live sleeve (${snapshot.cash:,.0f} cash){cap_txt}. Read-only — Approve only marks until you set AGENT_TRADING_ARMED=true."
    return {
        "configured": True, "domain": dom, "profile": sel, "cycle_id": cycle_id,
        "source": "live" if live else "sim", "armed": armed,
        "max_deployed": cap or None,
        "sleeve_cash": round(snapshot.cash, 2),
        "sleeve_positions": len(snapshot.positions),
        "queued": len(queued), "blocked": len(plan.blocked),
        "blocked_detail": [{"ticker": o.decision.ticker,
                            "reason": (o.guardrail.reasons[0] if o.guardrail.reasons else "blocked by gate")}
                           for o in plan.blocked],
        "stale_skipped": [{"ticker": t, "reason": r} for t, r in sorted(skips.items())],
        "proposals": [_proposal_dict(p) for p in queued],
        "reconciled": reconciled,
        "note": note,
    }


@router.post("/proposals/{pid}/approve")
def agent_trading_approve_proposal(pid: str):
    """The user's in-app approval. Marks the proposal APPROVED and, IF a live broker is armed,
    the backend (the bound agent) places it on this approval. With no armed broker (the default),
    it only marks approved — placement is never reachable without this human action."""
    store = _proposal_store()
    p = store.get(pid)
    if p is None:
        raise HTTPException(status_code=404, detail=f"no proposal {pid}")
    # pending → mark approved; already-approved (e.g. a prior placement errored) → retry placement.
    if p.status == "pending":
        try:
            p = store.decide(pid, "approve", by="user")
        except ValueError as e:
            raise HTTPException(status_code=409, detail=str(e))
    elif p.status != "approved":
        raise HTTPException(status_code=409, detail=f"proposal is {p.status}, not actionable")

    broker = _live_broker()
    if broker is None:
        return {"ok": True, "placed": False, "proposal": _proposal_dict(p),
                "note": "Approved. No live broker armed, so nothing was placed."}

    # Armed: place exactly what was approved, honoring pause/halt, alerting on failure. Any error
    # is surfaced as a clean 502 with the cause — never a bare 500.
    from app.agent_trading.execution import place_approved_proposal
    try:
        res = place_approved_proposal(p, broker=broker, proposal_store=store,
                                      state_store=_store(), log_path=_path(), alert_log=_alert_log())
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"Placement error: {type(e).__name__}: {e}")
    # Reflect the placement on the live activity timeline. Three outcomes, three colours:
    #   • executed (filled/partially_filled) → "placed"/ok (green): shares are in hand.
    #   • accepted-but-queued (unconfirmed/queued/new) → "queued"/warn (amber): the order is live
    #     at the broker and will fill shortly — NOT a failure (this is the case the user hit).
    #   • genuinely not placed (broker reject/error) → "blocked"/error (red).
    fill = res.fill or {}
    fstate = str(fill.get("state", "")).lower()
    executed = fstate in ("filled", "partially_filled")
    if res.ok:
        ev_type = "placed" if executed else "queued"
        ev_status = "ok" if executed else "warn"
        verb = "EXECUTED" if executed else "QUEUED"
        ev_label = f"{verb} {p.side} {p.ticker}"
        qty = fill.get("qty")
        ev_detail = (f"order {(fill.get('order_id') or '')[:8]} · {qty} sh"
                     + (f" · {fstate}" if fstate else "")).strip(" ·")
    else:
        ev_type, ev_status = "blocked", "error"
        ev_label = f"{res.status.upper()} {p.ticker}"
        ev_detail = res.reason
    try:
        import datetime as _dt
        from app.agent_trading.events import EventLog
        EventLog(_events_path()).append({
            "seq": 9000, "ts": _dt.datetime.now(_dt.timezone.utc).isoformat(), "cycle_id": p.cycle_id,
            "type": ev_type, "label": ev_label, "status": ev_status,
            "detail": ev_detail, "ticker": p.ticker})
    except Exception:  # noqa: BLE001
        pass
    return {"ok": res.ok, "placed": res.ok, "executed": executed, "state": fstate,
            "status": res.status, "reason": res.reason, "fill": res.fill,
            "proposal": _proposal_dict(store.get(pid) or p)}


@router.get("/proposals/{pid}/order-status")
def agent_trading_order_status(pid: str):
    """Read back the live broker status of a PLACED proposal's order (executed vs still queued).
    A market order is 'unconfirmed' the instant it's placed and flips to 'filled' seconds later;
    the UI polls this to update the badge. Read-only — touches no write tools."""
    store = _proposal_store()
    p = store.get(pid)
    if p is None:
        raise HTTPException(status_code=404, detail=f"no proposal {pid}")
    oid = p.placed_ref or ""
    if not oid or ":" in oid:  # not placed yet, or a sim placement (venue:ts) — nothing to read back
        return {"ok": True, "order_id": oid, "state": p.placed_state or "", "executed": False,
                "found": False, "note": "no live order id to reconcile"}
    broker = _read_broker()    # read-only — reading order status never needs the arm
    if broker is None or not hasattr(broker, "order_status"):
        return {"ok": True, "order_id": oid, "state": p.placed_state or "", "executed": False,
                "found": False, "note": "not connected to Robinhood"}
    try:
        st = broker.order_status(oid)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"Order-status error: {type(e).__name__}: {e}")
    # If it has progressed (e.g. unconfirmed → filled), persist the new state on the proposal AND
    # — when it's now executed — put an EXECUTED event on the timeline (idempotent), so polling a
    # single order keeps the activity feed in sync, not just a full cycle reconcile.
    if st.get("found") and st.get("state") and st["state"] != p.placed_state:
        try:
            store.update_placed_state(pid, st["state"])
        except Exception:  # noqa: BLE001
            pass
        if st.get("executed"):
            _emit_executed_event(p, oid, qty=st.get("filled_qty") or p.qty, px=st.get("avg_price"))
            _backfill_decision_fill(oid, price=st.get("avg_price"),
                                    qty=st.get("filled_qty") or p.qty, state=st.get("state"))
        elif st.get("state") in _TERMINAL_UNFILLED:
            _emit_cancelled_event(p, oid, st["state"])
            _cancel_decision_fill(oid, state=st["state"])
    return {"ok": True, **st}


@router.post("/proposals/reconcile")
def agent_trading_reconcile():
    """Read back ALL placed-but-not-yet-filled orders and advance their state (queued → filled),
    emitting a FILLED event for each confirmed fill. Read-only; the UI calls this on load so the
    timeline self-heals without a full cycle. Returns the orders whose state advanced."""
    updates = _reconcile_placed(_proposal_store())
    return {"ok": True, "reconciled": updates,
            "note": ("Robinhood not connected — nothing to reconcile." if not updates and _read_broker() is None
                     else f"{len(updates)} order(s) advanced.")}


@router.get("/alerts")
def agent_trading_alerts(limit: int = Query(50, ge=1, le=500), unacknowledged_only: bool = Query(False)):
    """Failure alerts (cycle errors, guardrail vetoes, drawdown halt, placement failures) so a
    silent break surfaces. Read-only."""
    log = _alert_log()
    return {"alerts": log.recent(limit=limit, unacknowledged_only=unacknowledged_only),
            "summary": log.summary()}


@router.post("/proposals/{pid}/reject")
def agent_trading_reject_proposal(pid: str):
    """Discard a pending proposal. It will never be placed."""
    try:
        p = _proposal_store().decide(pid, "reject", by="user")
    except KeyError:
        raise HTTPException(status_code=404, detail=f"no proposal {pid}")
    except ValueError as e:
        raise HTTPException(status_code=409, detail=str(e))
    return {"ok": True, "proposal": _proposal_dict(p)}


@router.get("/universe-review")
def agent_trading_universe_review():
    """Keep the candidate LIST fresh: discover names that should be ADDED (new players in the
    theme's sector ETFs, fresh SEC filers in its mining codes) and flag weak/stale names to
    DROP. A review queue — it never mutates your research universe. Read-only."""
    from app.agent_trading.universe_screen import run_universe_review
    from app.services import research_store as rs

    dom = rs.get_active_domain() or (rs.list_domains() or [None])[0]
    if not dom:
        return {"configured": False, "domain": None, "add": [], "add_edgar": [], "drop": []}
    out = run_universe_review(dom)
    out["configured"] = True
    return out


@router.get("/ranking")
def agent_trading_ranking(profile: str = Query(None, description="profile to rank under (defaults to the active one)")):
    """The WHOLE candidate universe ranked under the active Analyst profile, with each name's
    standing and the one thing it needs to make the cut. Answers 'why isn't X being bought?'
    and surfaces the small/lower-ranked players the top-N cut hides. Read-only."""
    from app.agent_trading.strategy import StrategyConfig, rank_universe
    from app.agent_trading.candidates import holdings_from_state, make_candidate_provider
    from app.services import research_store as rs

    dom = rs.get_active_domain() or (rs.list_domains() or [None])[0]
    if not dom:
        return {"configured": False, "domain": None, "profile": None, "ranking": []}

    active = _store().load().strategy or settings.AGENT_TRADING_STRATEGY
    sel = profile if profile in PROFILES else active
    today = __import__("datetime").date.today().isoformat()
    # Overlay LIVE holdings so each row's held/qty is real — that's what makes "where do my
    # positions rank?" answerable. Falls back to no-holdings when Tusk isn't the bound agent.
    holdings: dict = {}
    connected = False
    try:
        broker = _read_broker()
        if broker is not None:
            holdings = holdings_from_state(broker.snapshot())
            connected = True
    except Exception:  # noqa: BLE001 — ranking must still render without a live read
        holdings = {}
    candidates = make_candidate_provider(dom, holdings, today=today)([], today)
    cfg = StrategyConfig(profile=sel)
    rows = [r.__dict__ for r in rank_universe(candidates, cfg)]
    held_rows = [r for r in rows if r["held"]]

    # Rank trend: compare each name to the most recent prior-day snapshot (+N climbed, −N fell),
    # then record today's snapshot (one per day, so reloads don't pile up). Best-effort — a
    # history hiccup must never break the ranking.
    try:
        from app.agent_trading import rank_history as rh
        hpath = _events_path().parent / "rank_history.json"
        hist = rh.load(hpath)
        ranks = {r["ticker"]: r["rank"] for r in rows}
        # First run: pre-seed two flat prior days with today's ranks so the trend shows "no
        # movement" instead of blank, and real movement accrues from here.
        hist = rh.seed_flat(hist, profile=sel, domain=dom, today=today, ranks=ranks, days=2)
        dl = rh.deltas(hist, profile=sel, domain=dom, today=today, ranks=ranks)
        for r in rows:
            r["rank_delta"] = dl.get(r["ticker"])   # +N climbed / −N fell / 0 flat / None = new
        rh.save(hpath, rh.record(hist, profile=sel, domain=dom, today=today, ranks=ranks))
    except Exception:  # noqa: BLE001
        for r in rows:
            r.setdefault("rank_delta", None)

    return {
        "configured": True, "domain": dom, "profile": sel, "universe": len(rows),
        "top_n": cfg.rotation_top_n, "exit_n": cfg.rotation_exit_n,
        "max_new_positions": cfg.max_new_positions, "ranking": rows,
        "connected": connected, "held_count": len(held_rows),
    }


# --------------------------------------------------------------------------- live activity

@router.get("/events")
def agent_trading_events(limit: int = Query(200, ge=1, le=2000)):
    """Recent activity events (polling fallback for the live timeline)."""
    evs = EventLog(_events_path()).read_all()
    return {"events": evs[-limit:]}


@router.get("/stream")
async def agent_trading_stream():
    """SSE stream of agent-activity events — the live "watch it think" feed.

    Replays existing events on connect, then tails the file for new ones. Sends a heartbeat
    comment every ~15s so proxies keep the long-lived connection open. The generator ends
    when the client disconnects or after a safety cap.
    """
    elog = EventLog(_events_path())

    async def gen():
        yield ": connected\n\n"
        # backlog first (perceived-instant fill), then tail
        for e in elog.read_all():
            yield f"data: {json.dumps(e)}\n\n"
        offset = elog.path.stat().st_size if elog.path.exists() else 0
        last_hb = time.time()
        deadline = time.time() + 600  # 10-min safety cap; EventSource auto-reconnects
        while time.time() < deadline:
            new, offset = elog.read_from(offset)
            for e in new:
                yield f"data: {json.dumps(e)}\n\n"
            if time.time() - last_hb > 15:
                yield ": heartbeat\n\n"
                last_hb = time.time()
            await asyncio.sleep(0.4)

    return StreamingResponse(gen(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


# --------------------------------------------------------------------------- loop control

@router.get("/control")
def agent_trading_control():
    """Loop run-state: active / paused / halted, plus the persisted peak. Read-only."""
    return _control_payload(_store())


@router.post("/pause")
def agent_trading_pause():
    """Manually stop the loop from trading (distinct from Robinhood's kill switch, which
    disconnects the agent). Persists ``paused`` so it survives restarts."""
    store = _store()
    store.save(replace(store.load(), paused=True))
    return _control_payload(store)


@router.post("/resume")
def agent_trading_resume():
    """Clear a manual pause. Does NOT clear a drawdown halt — that needs re-arm."""
    store = _store()
    store.save(replace(store.load(), paused=False))
    return _control_payload(store)


@router.post("/strategy")
def agent_trading_set_strategy(profile: str = Query(..., description="Analyst profile")):
    """Set the active Analyst philosophy (persisted in policy state). Read-only setting —
    it changes what the loop *considers*, not whether it can trade."""
    if profile not in PROFILES:
        raise HTTPException(status_code=400, detail=f"unknown profile {profile!r}; pick one of {list(PROFILES)}")
    store = _store()
    store.save(replace(store.load(), strategy=profile))
    return _control_payload(store)


@router.post("/rearm")
def agent_trading_rearm():
    """Human re-arm after a drawdown halt (or pause): clears both flags so the loop may run
    again. The deliberate acknowledgement that you've reviewed why it tripped."""
    store = _store()
    store.rearm()
    return _control_payload(store)


@router.post("/demo-run")
async def agent_trading_demo_run():
    """Emit a sample cycle's events with small delays so the live timeline animates — a
    safe way to SEE the stream without a real run. Writes only to the events file."""
    elog = EventLog(_events_path())
    plan, cash, n_pos = demo_plan()
    cycle_id = f"demo-{int(time.time())}"
    events = plan_to_events(plan, cycle_id=cycle_id, cash=cash, positions=n_pos)
    for e in events:
        elog.append(e)
        await asyncio.sleep(0.45)  # pace it so the UI streams in, step by step
    return {"ok": True, "cycle_id": cycle_id, "emitted": len(events)}
