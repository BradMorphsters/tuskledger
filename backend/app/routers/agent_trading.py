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

from app.config import settings
from app.services import agent_trading_log as log
from app.agent_trading.events import EventLog, demo_plan, plan_to_events

router = APIRouter(prefix="/api/agent-trading", tags=["agent-trading"])

# The owner hits the live kill switch on Robinhood; we only link to it.
ROBINHOOD_KILL_URL = "https://robinhood.com/us/en/agentic-trading/"


def _path():
    return log.resolve_log_path(settings.AGENT_TRADING_LOG)


def _events_path() -> Path:
    if settings.AGENT_TRADING_EVENTS:
        return Path(settings.AGENT_TRADING_EVENTS).expanduser()
    return Path("var/agent_trading/events.jsonl")


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
