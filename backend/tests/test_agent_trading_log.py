"""Tests for the read-only decision-log views behind the Agent Trading tab.

Pure file parsing — no DB, no app wiring — so these run fast and in isolation. We build
a decision log with the real executor + simulated broker, then assert the derived views.
"""
from __future__ import annotations

import json

from app.agent_trading import (
    AgentTradingExecutor,
    GuardrailConfig,
    SimulatedBroker,
    StubDecisionSource,
)
from app.services import agent_trading_log as atl


def _build_log(tmp_path):
    """Run two sim cycles and return the JSONL log path."""
    log = tmp_path / "decisions.jsonl"
    prices = {"ROAR": 10.0, "HMNI": 25.0}
    script = {
        "ROAR": {"action": "buy", "notional": 80.0, "rationale": "accumulate ROAR"},
        "HMNI": {"action": "buy", "notional": 600.0, "rationale": "oversized — should block"},
    }
    broker = SimulatedBroker(starting_cash=1000.0)
    source = StubDecisionSource(prices, script=script)
    ex = AgentTradingExecutor(broker, source, GuardrailConfig.conservative(), log_path=log)
    ex.run_cycle(["ROAR", "HMNI"], as_of="2026-06-15")
    ex.run_cycle(["ROAR", "HMNI"], as_of="2026-06-16")
    return log


def test_missing_log_is_unconfigured(tmp_path):
    path = tmp_path / "nope.jsonl"
    st = atl.status(path)
    assert st["configured"] is False
    assert st["total_outcomes"] == 0
    assert atl.load_rows(path) == []


def test_status_and_mode(tmp_path):
    log = _build_log(tmp_path)
    st = atl.status(log)
    assert st["configured"] is True
    assert st["mode"] == "simulated"  # SimulatedBroker fills
    assert st["halted"] is False
    assert st["total_outcomes"] == 4  # 2 tickers x 2 cycles


def test_positions_reconstructed_from_fills(tmp_path):
    rows = atl.load_rows(_build_log(tmp_path))
    pos = atl.positions(rows)
    tickers = {p["ticker"] for p in pos}
    assert "ROAR" in tickers            # the passing buy accumulated
    assert "HMNI" not in tickers        # blocked every time — never filled
    roar = next(p for p in pos if p["ticker"] == "ROAR")
    assert roar["qty"] > 0
    assert roar["cost_basis"] > 0


def test_summary_counts(tmp_path):
    rows = atl.load_rows(_build_log(tmp_path))
    s = atl.summary(rows)
    assert s["counts"]["executed"] == 2   # ROAR bought in both cycles
    assert s["counts"]["blocked"] == 2    # HMNI blocked in both cycles
    assert s["open_positions"] == 1
    assert s["net_deployed"] > 0          # net cash put to work


def test_activity_is_newest_first(tmp_path):
    rows = atl.load_rows(_build_log(tmp_path))
    feed = atl.activity(rows, limit=10)
    assert feed[0]["as_of"] == "2026-06-16"   # most recent cycle first
    assert feed[-1]["as_of"] == "2026-06-15"
    # blocked rows carry their veto reasons
    blocked = [a for a in feed if a["status"] == "blocked"]
    assert blocked and blocked[0]["reasons"]


def test_guardrail_breaches_aggregate(tmp_path):
    rows = atl.load_rows(_build_log(tmp_path))
    g = atl.guardrail_breaches(rows)
    assert g["blocked_total"] == 2
    names = {b["check"] for b in g["by_check"]}
    # HMNI trips the per-order cap (and concentration); both should surface
    assert "per_order_notional" in names


def test_load_skips_corrupt_lines(tmp_path):
    log = tmp_path / "decisions.jsonl"
    good = {"as_of": "2026-06-15", "ts": "2026-06-15T00:00:00Z", "halted": False,
            "decision": {"ticker": "ROAR", "action": "buy", "ref_price": 10.0, "rationale": ""},
            "status": "skipped", "guardrail": None, "fill": None, "error": ""}
    log.write_text(json.dumps(good) + "\n{ this is not json }\n")
    rows = atl.load_rows(log)
    assert len(rows) == 1  # the corrupt line is skipped, not fatal
