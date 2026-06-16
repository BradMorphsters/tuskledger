"""Tests for failure alerting — pure builders + the jsonl sink."""
from __future__ import annotations

from app.agent_trading.alerts import (
    CRITICAL,
    AlertLog,
    cycle_error,
    drawdown_halt,
    guardrail_block,
    paused_skip,
    placement_failed,
)


def test_emit_read_and_summary(tmp_path):
    log = AlertLog(tmp_path / "a.jsonl")
    log.append(cycle_error("boom"))
    log.append(guardrail_block("NB", ["cap hit"]))
    assert len(log.read_all()) == 2
    s = log.summary()
    assert s == {"total": 2, "critical": 1, "warning": 1, "info": 0, "unacknowledged": 2}


def test_recent_sorts_critical_first(tmp_path):
    log = AlertLog(tmp_path / "a.jsonl")
    log.append(guardrail_block("NB", ["x"]))      # warning
    log.append(placement_failed("MP", "rejected"))  # critical
    rec = log.recent()
    assert rec[0]["kind"] == "placement_failed" and rec[0]["severity"] == CRITICAL


def test_emit_none_is_noop(tmp_path):
    log = AlertLog(tmp_path / "a.jsonl")
    assert log.emit(None) is None
    assert log.read_all() == []


def test_builders_carry_expected_shape():
    a = drawdown_halt(0.20, 0.15)
    assert a.severity == CRITICAL and a.kind == "drawdown_halt" and "20" in a.message
    assert paused_skip("paused").kind == "paused_skip"
    assert placement_failed("MP", "x").ticker == "MP"
