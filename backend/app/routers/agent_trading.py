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


def _proposal_dict(p) -> dict:
    from dataclasses import asdict
    d = asdict(p)
    d.pop("order_args", None)  # internal placement args — not surfaced to the UI
    return d


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
):
    """Run the Analyst → guardrail gate over the active research universe and queue the
    gate-APPROVED orders for your approval. Until the backend is the bound Robinhood agent,
    this sizes against a simulated cash sleeve so you can review the flow. It PLACES NOTHING —
    it only writes the approval queue."""
    from app.agent_trading.bridge import plan_cycle
    from app.agent_trading.candidates import make_candidate_provider
    from app.agent_trading.guardrails import AccountState, GuardrailConfig
    from app.agent_trading.proposals import generate_proposals
    from app.agent_trading.sizing import SizingConfig, size_decisions
    from app.agent_trading.state import AgentState
    from app.agent_trading.strategy import PROFILES, StrategyConfig, StrategyDecisionSource
    from app.services import research_store as rs

    dom = rs.get_active_domain() or (rs.list_domains() or [None])[0]
    if not dom:
        return {"configured": False, "domain": None, "queued": 0, "proposals": []}

    active = _store().load().strategy or settings.AGENT_TRADING_STRATEGY
    sel = profile if profile in PROFILES else active
    today = __import__("datetime").date.today().isoformat()

    snapshot = AccountState(cash=cash, positions={}, prices={}, equity_peak=cash, trades_today=0)
    provider = make_candidate_provider(dom, {}, today=today)
    decisions = StrategyDecisionSource(StrategyConfig(profile=sel), provider).get_decisions([], today)
    decisions = size_decisions(decisions, snapshot, SizingConfig(method="fixed_fractional", fraction=0.10))
    plan = plan_cycle(account_number="approval-queue", snapshot=snapshot, decisions=decisions,
                      config=GuardrailConfig(), persisted=AgentState(), as_of=today)

    cycle_id, queued = generate_proposals(_proposal_store(), plan)
    return {
        "configured": True, "domain": dom, "profile": sel, "cycle_id": cycle_id,
        "queued": len(queued), "blocked": len(plan.blocked),
        "proposals": [_proposal_dict(p) for p in queued],
        "note": "Sized against a simulated sleeve. Approve/Reject in-app; placement is wired when the backend becomes the bound agent.",
    }


@router.post("/proposals/{pid}/approve")
def agent_trading_approve_proposal(pid: str):
    """Mark a pending proposal APPROVED (ready to place). This does NOT place the order — the
    bound backend agent does that on this approval; placement is never an agent-callable path."""
    try:
        p = _proposal_store().decide(pid, "approve", by="user")
    except KeyError:
        raise HTTPException(status_code=404, detail=f"no proposal {pid}")
    except ValueError as e:
        raise HTTPException(status_code=409, detail=str(e))
    return {"ok": True, "proposal": _proposal_dict(p),
            "note": "Approved and queued for placement by the bound agent. Nothing has been placed yet."}


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
    from app.agent_trading.candidates import make_candidate_provider
    from app.services import research_store as rs

    dom = rs.get_active_domain() or (rs.list_domains() or [None])[0]
    if not dom:
        return {"configured": False, "domain": None, "profile": None, "ranking": []}

    active = _store().load().strategy or settings.AGENT_TRADING_STRATEGY
    sel = profile if profile in PROFILES else active
    today = __import__("datetime").date.today().isoformat()
    candidates = make_candidate_provider(dom, {}, today=today)([], today)
    cfg = StrategyConfig(profile=sel)
    rows = [r.__dict__ for r in rank_universe(candidates, cfg)]
    return {
        "configured": True, "domain": dom, "profile": sel, "universe": len(rows),
        "top_n": cfg.rotation_top_n, "exit_n": cfg.rotation_exit_n,
        "max_new_positions": cfg.max_new_positions, "ranking": rows,
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
