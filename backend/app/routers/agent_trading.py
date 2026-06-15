"""Agent Trading tab — read-only API over the agentic-trading decision log.

Phase 1 (see ``docs/agent-trading-tab.md``): the tab is a supervisory cockpit, not an
executor. Every endpoint here is read-only; it parses the decision log the experiment
harness writes and never places, cancels, or sizes a trade. The live kill switch lives
on Robinhood and is surfaced to the UI as a deep link, not reimplemented.

Degrades gracefully: with no log yet, ``/status`` reports ``configured: false`` and the
rest return empty shapes, so the tab renders a clean "no runs yet" state.
"""
from __future__ import annotations

from fastapi import APIRouter, Query

from app.config import settings
from app.services import agent_trading_log as log

router = APIRouter(prefix="/api/agent-trading", tags=["agent-trading"])

# The owner hits the live kill switch on Robinhood; we only link to it.
ROBINHOOD_KILL_URL = "https://robinhood.com/us/en/agentic-trading/"


def _path():
    return log.resolve_log_path(settings.AGENT_TRADING_LOG)


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
