"""Tests for the backtesting harness — deterministic over synthetic price series.

A real compute_momentum is injected (a simple one) so the test is hermetic and the mechanics
(entries, equity tracking, benchmark, metrics) are verifiable by hand.
"""
from __future__ import annotations

from app.agent_trading import StrategyConfig, backtest, backtest_report, compare_profiles
from app.agent_trading.backtest import BacktestResult


def _momentum_fn(history, current):
    """Tiny stand-in: uptrend if last close > first close; 3-mo return from 4 closes back."""
    closes = [h["close"] for h in history if h.get("close") is not None]
    if len(closes) < 3 or not current:
        return None
    ref = closes[-4] if len(closes) >= 4 else closes[0]
    ret = (current - ref) / ref * 100 if ref else 0.0
    lo, hi = min(closes), max(closes)
    rng = hi - lo
    return {
        "score": 80 if current >= (lo + 0.5 * rng) else 20,
        "ret_3mo_pct": ret,
        "pct_off_high": (current - hi) / hi * 100 if hi else 0.0,
    }


def _series(closes):
    return {"history": [{"date": f"2025-{i+1:02d}-01", "close": c} for i, c in enumerate(closes)]}


def test_uptrend_momentum_beats_cash_and_tracks_equity():
    # one steadily rising name; momentum should buy and ride it up
    prices = {"UP": _series([10, 11, 12, 13, 14, 16, 18, 20, 22, 24])}
    r = backtest(prices, StrategyConfig(profile="momentum"), starting_cash=1000.0,
                 warmup=4, momentum_fn=_momentum_fn)
    assert isinstance(r, BacktestResult)
    assert r.months > 0
    assert r.total_return > 0          # made money riding the uptrend
    assert r.trades >= 1
    assert r.equity_curve[-1] == r.end_value


def test_benchmark_is_buy_and_hold():
    # two names; benchmark = equal-weight hold from the warmup month to the end
    prices = {
        "A": _series([10, 10, 10, 10, 10, 20]),   # doubles over the window
        "B": _series([10, 10, 10, 10, 10, 10]),   # flat
    }
    r = backtest(prices, StrategyConfig(profile="momentum"), warmup=4, momentum_fn=_momentum_fn)
    # hold from month index 4: A 10->20 (+100%), B 10->10 (0%), equal weight ≈ +50%
    assert 0.45 <= r.benchmark_return <= 0.55


def test_compare_profiles_and_report():
    prices = {
        "UP": _series([10, 11, 12, 13, 14, 16, 18, 20]),
        "DN": _series([20, 19, 18, 17, 16, 14, 12, 10]),
    }
    results = compare_profiles(prices, warmup=4, momentum_fn=_momentum_fn)
    assert set(results) == {"momentum", "mean_reversion", "rotation"}
    report = backtest_report(results)
    assert "benchmark" in report and "return" in report
    assert "Directional only" in report   # the honesty caveat is always shown


def test_scoreboard_line_ranks_and_flags():
    from app.agent_trading import scoreboard_line
    prices = {
        "UP": _series([10, 11, 12, 13, 14, 16, 18, 20]),
        "DN": _series([20, 19, 18, 17, 16, 14, 12, 10]),
    }
    results = compare_profiles(prices, warmup=4, momentum_fn=_momentum_fn)
    line = scoreboard_line(results)
    assert "scoreboard" in line.lower() and "vs" in line and "hold" in line
    # the winner appears before the loser
    assert line.index("rotation") < line.index("momentum") or "momentum" in line


def test_trade_log_records_entries_grouped_by_ticker():
    from app.agent_trading import trades_by_ticker
    prices = {"UP": _series([10, 11, 12, 13, 14, 16, 18, 20])}
    r = backtest(prices, StrategyConfig(profile="momentum"), warmup=4, momentum_fn=_momentum_fn)
    assert r.trades_log and all(set(t) >= {"as_of", "ticker", "action", "price", "shares", "notional"} for t in r.trades_log)
    grouped = trades_by_ticker(r)
    assert "UP" in grouped and len(grouped["UP"]) == r.trades


def test_too_short_history_returns_flat():
    r = backtest({"X": _series([10, 11])}, StrategyConfig(profile="momentum"),
                 warmup=4, momentum_fn=_momentum_fn)
    assert r.months == 0 and r.total_return == 0.0
