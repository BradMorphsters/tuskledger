"""Tests for the agent-activity event stream (the live-UI feed)."""
from __future__ import annotations

from app.agent_trading.events import EventLog, demo_plan, make_event, plan_to_events


def test_plan_to_events_full_sequence():
    plan, cash, n_pos = demo_plan()
    evs = plan_to_events(plan, cycle_id="cyc-1", cash=cash, positions=n_pos)
    types = [e["type"] for e in evs]
    assert types[0] == "cycle_started"
    assert types[-1] == "cycle_completed"
    assert "approved" in types and "blocked" in types
    # the gate checks show up as sub-events so the timeline can expand them
    assert any(e["type"] == "gate_check" for e in evs)
    # seq is monotonic
    assert [e["seq"] for e in evs] == list(range(len(evs)))
    # the approved + blocked events carry their ticker for chips
    assert any(e["type"] == "approved" and e.get("ticker") == "F" for e in evs)
    assert any(e["type"] == "blocked" and e.get("ticker") == "NVDA" for e in evs)


def test_blocked_events_have_blocked_status():
    plan, cash, n = demo_plan()
    evs = plan_to_events(plan, cycle_id="c", cash=cash, positions=n)
    blocked = [e for e in evs if e["type"] == "blocked"]
    assert blocked and all(e["status"] == "blocked" for e in blocked)


def test_event_log_roundtrip_and_tail(tmp_path):
    log = EventLog(tmp_path / "events.jsonl")
    assert log.read_all() == []
    log.append(make_event("c", 0, "cycle_started", "start", "running"))
    off = (tmp_path / "events.jsonl").stat().st_size
    log.append(make_event("c", 1, "approved", "APPROVED buy F", "ok", ticker="F"))
    # read_from the prior offset returns only the new event (the tail behavior SSE uses)
    new, _ = log.read_from(off)
    assert len(new) == 1 and new[0]["type"] == "approved"
    assert len(log.read_all()) == 2


def test_demo_plan_shape():
    plan, cash, n = demo_plan()
    assert cash == 500.0 and n == 0
    assert len(plan.approved) == 1 and len(plan.blocked) == 1
