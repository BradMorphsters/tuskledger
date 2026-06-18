"""Tax-friendly rotation: sell-to-fund coupling + tax-aware exit ordering + wash-sale deferral.

These exercise the pure layer in app/agent_trading/rotation_coupling.py that sits between sizing
and the guardrail gate on the rotation profile.
"""
from __future__ import annotations

from app.agent_trading.decisions import Decision
from app.agent_trading.guardrails import AccountState, Position
from app.agent_trading.rotation_coupling import (
    acquired_at_from_place_log,
    couple_rotation_sells,
)


def _state(cash, positions=None, prices=None):
    positions = positions or {}
    prices = prices or {}
    total = cash + sum(p.qty * prices.get(t, p.avg_price) for t, p in positions.items())
    return AccountState(cash=cash, positions=positions, prices=prices, equity_peak=total)


def _buy(tkr, notional):
    return Decision(tkr, "buy", 10.0, target_notional=notional)


def _soft_sell(tkr, notional):
    return Decision(tkr, "sell", 10.0, target_notional=notional, exit_kind="rotate")


def _hard_sell(tkr, notional):
    return Decision(tkr, "sell", 10.0, target_notional=notional, exit_kind="thesis")


# --------------------------------------------------------------------------- coupling

def test_cash_covers_buys_so_soft_sell_is_held():
    """Plenty of cash to fund the new buy → the rank-slipped name is HELD, not sold (no tax hit)."""
    state = _state(cash=1000, positions={"OLD": Position(10, 8)}, prices={"OLD": 10})
    decisions = [_buy("NEW", 100), _soft_sell("OLD", 100)]
    res = couple_rotation_sells(decisions, state, cap=0.0)
    actions = {(d.ticker, d.action) for d in res.decisions}
    assert ("NEW", "buy") in actions
    assert ("OLD", "sell") not in actions          # suppressed
    assert res.funded_sells == []
    assert any(t == "OLD" for t, _ in res.held_back)


def test_no_buys_means_no_soft_sells():
    """A rank slip with nothing to replace it → held. Rotation never sells just to sell."""
    state = _state(cash=50, positions={"OLD": Position(10, 8)}, prices={"OLD": 10})
    res = couple_rotation_sells([_soft_sell("OLD", 100)], state)
    assert res.decisions == []                      # nothing to do
    assert [t for t, _ in res.held_back] == ["OLD"]


def test_hard_exit_always_fires():
    """A below-floor / orphan exit (exit_kind='thesis') is unconditional — cash and buys irrelevant."""
    state = _state(cash=1_000_000, positions={"BAD": Position(10, 8)}, prices={"BAD": 10})
    res = couple_rotation_sells([_hard_sell("BAD", 100)], state)
    assert [(d.ticker, d.action) for d in res.decisions] == [("BAD", "sell")]
    assert res.held_back == []


def test_shortfall_sells_minimum_and_loss_first():
    """Low cash → must free capital. Sell the loss (harvest) first, and only as many names as
    needed to cover the shortfall — keep the rest."""
    state = _state(
        cash=10,
        positions={"WIN": Position(10, 10), "LOSS": Position(10, 10)},
        prices={"WIN": 12, "LOSS": 8},             # WIN +20 gain (val 120), LOSS -20 (val 80)
    )
    decisions = [_buy("NEW", 50), _soft_sell("WIN", 120), _soft_sell("LOSS", 80)]
    res = couple_rotation_sells(decisions, state, cap=0.0, cash_floor_pct=0.05)
    # reserve ≈ 10.5 → deployable cash ≈ 0 → shortfall ≈ 50; LOSS (80) alone covers it.
    assert res.funded_sells == ["LOSS"]
    assert "WIN" in {t for t, _ in res.held_back}    # winner preserved (no gain realized)
    sells = {d.ticker for d in res.decisions if d.action == "sell"}
    assert sells == {"LOSS"}


def test_tax_order_loss_then_longterm_then_shortterm():
    """When everything must be sold, ordering is loss → long-term gain → short-term gain."""
    state = _state(
        cash=1,
        positions={"LOSS": Position(10, 10), "LT": Position(10, 10), "ST": Position(10, 10)},
        prices={"LOSS": 9, "LT": 11, "ST": 12},
    )
    decisions = [_buy("NEW", 10_000),               # huge need → forces selling all three
                 _soft_sell("ST", 120), _soft_sell("LT", 110), _soft_sell("LOSS", 90)]
    acquired = {"LT": "2023-01-01"}                  # LT held > 1yr; ST/LOSS unknown → short-term
    res = couple_rotation_sells(decisions, state, today="2026-06-17", acquired_at=acquired)
    assert res.funded_sells == ["LOSS", "LT", "ST"]


def test_washsale_buy_is_deferred_and_does_not_force_a_sell():
    """A buy that would trip a 30-day wash sale is deferred — and since it's gone, it can't drag a
    soft sell along to fund it."""
    state = _state(cash=5, positions={"OLD": Position(10, 8)}, prices={"OLD": 10})
    decisions = [_buy("NEW", 100), _soft_sell("OLD", 100)]
    ws = lambda tkr, side: tkr == "NEW" and side == "buy"
    res = couple_rotation_sells(decisions, state, wash_sale_lookup=ws)
    assert [t for t, _ in res.deferred_buys] == ["NEW"]
    assert res.funded_sells == []                    # no buy left to fund → no sell
    assert [t for t, _ in res.held_back] == ["OLD"]
    assert res.decisions == []                        # NEW deferred, OLD held


def test_washsale_flagged_loss_is_deprioritised():
    """A loss sale that would itself trip a wash sale is demoted below a clean long-term gain, so
    the clean name is sold first when only one is needed."""
    state = _state(
        cash=1,
        positions={"WSLOSS": Position(10, 10), "LTGAIN": Position(10, 10)},
        prices={"WSLOSS": 9, "LTGAIN": 11},
    )
    decisions = [_buy("NEW", 60), _soft_sell("WSLOSS", 90), _soft_sell("LTGAIN", 110)]
    ws = lambda tkr, side: tkr == "WSLOSS" and side == "sell"
    res = couple_rotation_sells(decisions, state, today="2026-06-17",
                                acquired_at={"LTGAIN": "2023-01-01"}, wash_sale_lookup=ws)
    assert res.funded_sells == ["LTGAIN"]            # clean gain chosen over the wash-flagged loss
    assert "WSLOSS" in {t for t, _ in res.held_back}


def test_couple_false_is_passthrough():
    state = _state(cash=5, positions={"OLD": Position(10, 8)}, prices={"OLD": 10})
    decisions = [_buy("NEW", 100), _soft_sell("OLD", 100)]
    res = couple_rotation_sells(decisions, state, couple=False)
    assert res.decisions == decisions


def test_original_order_preserved():
    state = _state(cash=1000, positions={"OLD": Position(10, 8)}, prices={"OLD": 10})
    decisions = [_hard_sell("BAD", 50), _buy("NEW", 100), _soft_sell("OLD", 100)]
    res = couple_rotation_sells(decisions, state)
    # OLD held (cash covers NEW); BAD + NEW remain in their original order.
    assert [d.ticker for d in res.decisions] == ["BAD", "NEW"]


# --------------------------------------------------------------------------- place-log dates

def test_acquired_at_from_place_log_takes_earliest_buy_and_skips_errors():
    rows = [
        {"ts": 1_781_636_981.0, "args": {"symbol": "USAR", "side": "buy", "quantity": "4.5"},
         "raw": {"data": {"order": {"id": "x"}}}},
        {"ts": 1_781_700_000.0, "args": {"symbol": "USAR", "side": "buy", "quantity": "1.0"},
         "raw": {"data": {"order": {"id": "y"}}}},              # later — should be ignored
        {"ts": 1_781_636_709.0, "args": {"symbol": "USAR", "side": "buy", "quantity": "4.5"},
         "raw": {"_error": "blocked"}},                         # errored — should be skipped
        {"ts": 1_781_638_983.0, "args": {"symbol": "PPTA", "side": "buy", "quantity": "6.4"},
         "raw": {"data": {"order": {"id": "z"}}}},
        {"ts": 1_781_900_000.0, "args": {"symbol": "PPTA", "side": "sell", "quantity": "6.4"},
         "raw": {"data": {"order": {"id": "s"}}}},              # a sell — not an acquisition
    ]
    acq = acquired_at_from_place_log(rows)
    assert set(acq) == {"USAR", "PPTA"}
    # earliest *successful* USAR buy is ts 1_781_636_981 (the errored earlier one is skipped)
    assert acq["USAR"] == "2026-06-16"
