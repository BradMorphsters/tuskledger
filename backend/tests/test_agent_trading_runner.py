"""Tests for the read-only scheduled runner + digest.

The runner ties the Analyst cycle to recording (decision log + event stream) and a digest,
with no broker write. The candidate provider is injected so it runs without research files.
"""
from __future__ import annotations

import json

from app.agent_trading import (
    AgentState,
    Candidate,
    GuardrailConfig,
    SizingConfig,
    StateStore,
    build_digest,
    run_readonly_cycle,
)
from app.agent_trading.bridge import plan_strategy_cycle

PORTFOLIO = {"data": {"cash": "1000", "buying_power": {"buying_power": "1000.0000"}}}
POSITIONS = {"data": {"positions": []}}


def _factory(cands):
    return lambda domain, holdings: (lambda watchlist, as_of: cands)


def test_run_records_log_events_and_returns_digest(tmp_path):
    cands = [Candidate("USAR", price=23.0, research_score=0.92, trend_up=True, momentum=0.53)]
    log = tmp_path / "decisions.jsonl"
    events = tmp_path / "events.jsonl"
    store = StateStore(tmp_path / "state.json")

    out = run_readonly_cycle(
        account_number="test-001", portfolio=PORTFOLIO, positions=POSITIONS,
        domain="critical-minerals", strategy_profile="momentum",
        sizing=SizingConfig(method="fixed_fractional", fraction=0.10),
        config=GuardrailConfig.conservative(), persisted=AgentState(),
        log_path=log, events_path=events, state_store=store,
        account_value=1000.0, as_of="2026-06-16",
        candidate_provider_factory=_factory(cands),
    )

    # plan considered USAR; digest reads cleanly
    assert any(p.order_args["symbol"] == "USAR" for p in out["plan"].approved)
    assert "Would consider" in out["digest"] and "USAR" in out["digest"]
    assert "Read-only — nothing placed" in out["digest"]

    # decision log written (read-only -> 'approved' status, no fill)
    rows = [json.loads(l) for l in log.read_text().splitlines()]
    assert rows and rows[0]["status"] == "approved" and rows[0]["fill"] is None

    # event stream written so the timeline / floor reflect it
    evs = [json.loads(l) for l in events.read_text().splitlines()]
    assert evs[0]["type"] == "cycle_started" and any(e["type"] == "approved" for e in evs)


def test_run_resolves_profile_from_state(tmp_path):
    # no explicit profile -> use the one persisted in state
    store = StateStore(tmp_path / "state.json")
    from dataclasses import replace
    store.save(replace(store.load(), strategy="rotation"))
    out = run_readonly_cycle(
        account_number="test-001", portfolio=PORTFOLIO, positions=POSITIONS,
        domain="d", state_store=store, as_of="2026-06-16",
        candidate_provider_factory=_factory([]),
    )
    assert out["strategy"] == "rotation"


def _mom(history, current):
    closes = [h["close"] for h in history if h.get("close") is not None]
    if len(closes) < 3 or not current:
        return None
    ref = closes[-4] if len(closes) >= 4 else closes[0]
    lo, hi = min(closes), max(closes)
    return {"score": 80 if current >= (lo + hi) / 2 else 20,
            "ret_3mo_pct": (current - ref) / ref * 100 if ref else 0.0,
            "pct_off_high": (current - hi) / hi * 100 if hi else 0.0}


def test_digest_includes_backtest_scoreboard(tmp_path):
    cands = [Candidate("USAR", price=20.0, research_score=0.92, trend_up=True, momentum=0.5)]
    prices = {"USAR": {"history": [{"as_of": f"2025-{i+1:02d}", "close": c}
                                   for i, c in enumerate([10, 11, 12, 13, 14, 16, 18, 20])]}}
    out = run_readonly_cycle(
        account_number="test-001", portfolio=PORTFOLIO, positions=POSITIONS,
        domain="d", strategy_profile="momentum", as_of="2026-06-16",
        candidate_provider_factory=_factory(cands), prices=prices, momentum_fn=_mom,
    )
    assert "scoreboard" in out["digest"].lower() and "hold" in out["digest"].lower()


def test_digest_variants():
    empty = plan_strategy_cycle(
        account_number="x", portfolio=PORTFOLIO, positions=POSITIONS, domain="d",
        config=GuardrailConfig.conservative(), persisted=AgentState(), as_of="2026-06-16",
        candidate_provider_factory=_factory([]),
    )
    d = build_digest(empty, strategy="signal_event", account_value=500.0)
    assert "nothing cleared the rules" in d and "$500.00" in d
