"""Backtesting harness — does the Analyst's philosophy actually work on your history?

Replays a strategy profile over the cached monthly price history as a monthly-rebalance
simulation: each month it recomputes features from prices *up to that month*, runs the same
`propose()` rules + sizer, applies the fills at that month's close, and tracks the equity
curve. Reports return, max drawdown, and trade count against an equal-weight buy-and-hold
benchmark.

Honest limitations (read these before trusting a number):
* **Monthly granularity** — the price cache is monthly closes, so this validates the
  swing/position horizon, not anything intraday.
* **No historical research/signal scores** — only *current* conviction/signals are stored,
  so the quality gate and `signal_event` can't be replayed without lookahead bias. This
  harness therefore backtests the **price-driven** profiles (momentum / mean_reversion /
  rotation) with the quality gate neutralized; treat results as directional, not gospel.
* **No costs/slippage** modeled; fills at the close. It's a sanity check, not a P&L promise.

Pure and deterministic over plain price dicts — tests with synthetic series.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional

from .guardrails import AccountState, Position
from .sizing import SizingConfig, size_decisions
from .strategy import Candidate, StrategyConfig, propose

# profiles that don't need historical signal/research data
PRICE_PROFILES = ("momentum", "mean_reversion", "rotation")


@dataclass
class BacktestResult:
    profile: str
    months: int
    start_value: float
    end_value: float
    total_return: float          # fraction
    cagr: float                  # annualized fraction
    max_drawdown: float          # fraction (negative)
    trades: int
    benchmark_return: float      # equal-weight buy-and-hold of the universe
    equity_curve: list[float] = field(default_factory=list)
    benchmark_curve: list[float] = field(default_factory=list)  # equal-weight hold, same months
    trades_log: list[dict] = field(default_factory=list)  # {as_of, ticker, action, price, shares, notional}

    def beat_benchmark(self) -> bool:
        return self.total_return > self.benchmark_return


def trades_by_ticker(result: "BacktestResult") -> dict[str, list[dict]]:
    """Group a backtest's simulated trades by ticker (for the per-name drill-down)."""
    out: dict[str, list[dict]] = {}
    for tr in result.trades_log:
        out.setdefault(tr["ticker"], []).append(tr)
    return out


def _series(prices: dict) -> tuple[list[str], dict[str, dict[str, float]]]:
    """Return (sorted month keys, {ticker: {month: close}}) from the cached price format
    ``{ticker: {history: [{date, close, volume}], ...}}``."""
    by_ticker: dict[str, dict[str, float]] = {}
    months: set[str] = set()
    for t, row in prices.items():
        m: dict[str, float] = {}
        for h in (row.get("history") or []):
            d, c = (h.get("as_of") or h.get("date") or h.get("month")), h.get("close")
            if d and isinstance(c, (int, float)):
                m[str(d)] = float(c)
                months.add(str(d))
        if m:
            by_ticker[t.upper()] = m
    return sorted(months), by_ticker


def _max_drawdown(curve: list[float]) -> float:
    peak, mdd = curve[0] if curve else 0.0, 0.0
    for v in curve:
        peak = max(peak, v)
        if peak > 0:
            mdd = min(mdd, (v - peak) / peak)
    return mdd


def _benchmark_curve(months: list[str], series: dict, start_i: int, cash: float) -> list[float]:
    """Equal-weight buy-and-hold equity valued each month (start_i..end). Carries the last
    known price forward for any month a name didn't trade."""
    start = months[start_i]
    names = [t for t, m in series.items() if start in m and m[start] > 0]
    if not names:
        return [cash] * (len(months) - start_i)
    alloc = cash / len(names)
    shares = {t: alloc / series[t][start] for t in names}
    last = {t: series[t][start] for t in names}
    curve: list[float] = []
    for i in range(start_i, len(months)):
        mo = months[i]
        for t in names:
            if mo in series[t]:
                last[t] = series[t][mo]
        curve.append(sum(shares[t] * last[t] for t in names))
    return curve


def _benchmark(months: list[str], series: dict, start_i: int, cash: float) -> float:
    curve = _benchmark_curve(months, series, start_i, cash)
    return curve[-1] / cash - 1.0 if curve and cash else 0.0


def backtest(
    prices: dict,
    config: StrategyConfig,
    *,
    sizing: Optional[SizingConfig] = None,
    starting_cash: float = 1000.0,
    research_scores: Optional[dict[str, float]] = None,
    warmup: int = 4,
    momentum_fn=None,
    cost_bps: float = 10.0,
) -> BacktestResult:
    """Replay ``config.profile`` over the price history. ``research_scores`` defaults to a
    neutral 1.0 per name (the quality gate can't be replayed historically; see module doc).
    ``momentum_fn`` overrides the feature computer (defaults to market_data.compute_momentum)."""
    compute_momentum = momentum_fn
    if compute_momentum is None:
        try:
            from app.services.market_data import compute_momentum
        except Exception:  # pragma: no cover - sandbox/import fallback
            compute_momentum = None

    sizing = sizing or SizingConfig(method="fixed_fractional", fraction=0.20)
    months, series = _series(prices)
    if len(months) <= warmup + 1:
        return BacktestResult(config.profile, 0, starting_cash, starting_cash, 0.0, 0.0, 0.0, 0, 0.0, [])

    rs = research_scores or {}
    cash = starting_cash
    qty: dict[str, float] = {}
    avg: dict[str, float] = {}
    trades = 0
    curve: list[float] = []
    tlog: list[dict] = []

    for i in range(warmup, len(months)):
        month = months[i]
        marks = {t: m[month] for t, m in series.items() if month in m}

        cands: list[Candidate] = []
        for t, price in marks.items():
            hist = [{"close": series[t][mm]} for mm in months[: i + 1] if mm in series[t]]
            feat = compute_momentum(hist, price) if compute_momentum else None
            momentum = (feat.get("ret_3mo_pct") or 0.0) / 100.0 if feat else 0.0
            trend_up = (feat.get("score") or 0) >= 50 if feat else False
            pull = max(0.0, -(feat.get("pct_off_high") or 0.0)) / 100.0 if feat else 0.0
            cands.append(Candidate(
                ticker=t, price=price, research_score=rs.get(t, 1.0), signal_score=0.0,
                momentum=momentum, trend_up=trend_up, pullback=pull,
                rotation_score=rs.get(t, 1.0), held_qty=qty.get(t, 0.0), avg_cost=avg.get(t, 0.0),
            ))

        state = AccountState(
            cash=cash,
            positions={t: Position(qty[t], avg[t]) for t in qty if qty[t] > 0},
            prices=marks, equity_peak=0.0, trades_today=0,
        )
        decisions = size_decisions(propose(cands, config), state, sizing)

        # apply fills at this month's close
        for d in decisions:
            t, price = d.ticker, marks.get(d.ticker)
            if not price or not d.target_notional:
                continue
            if d.action == "buy":
                spend = min(d.target_notional, cash)
                if spend <= 0:
                    continue
                sh = spend / price
                new_q = qty.get(t, 0.0) + sh
                avg[t] = (qty.get(t, 0.0) * avg.get(t, 0.0) + spend) / new_q
                qty[t] = new_q
                cash -= spend + spend * cost_bps / 10000.0   # buy + transaction cost
                trades += 1
                tlog.append({"as_of": month, "ticker": t, "action": "buy",
                             "price": round(price, 4), "shares": round(sh, 4), "notional": round(spend, 2)})
            elif d.action == "sell" and qty.get(t, 0.0) > 0:
                sh = min(qty[t], d.target_notional / price)
                cash += sh * price - (sh * price) * cost_bps / 10000.0   # proceeds − transaction cost
                qty[t] -= sh
                if qty[t] <= 1e-9:
                    qty.pop(t, None); avg.pop(t, None)
                trades += 1
                tlog.append({"as_of": month, "ticker": t, "action": "sell",
                             "price": round(price, 4), "shares": round(sh, 4), "notional": round(sh * price, 2)})

        equity = cash + sum(qty[t] * marks.get(t, avg.get(t, 0.0)) for t in qty)
        curve.append(equity)

    end_val = curve[-1] if curve else starting_cash
    n = len(curve) - 1
    total = end_val / starting_cash - 1.0
    cagr = (end_val / starting_cash) ** (12.0 / n) - 1.0 if n > 0 and end_val > 0 else 0.0
    return BacktestResult(
        profile=config.profile, months=len(curve), start_value=starting_cash, end_value=round(end_val, 2),
        total_return=round(total, 4), cagr=round(cagr, 4), max_drawdown=round(_max_drawdown(curve), 4),
        trades=trades, benchmark_return=round(_benchmark(months, series, warmup, starting_cash), 4),
        equity_curve=[round(x, 2) for x in curve],
        benchmark_curve=[round(x, 2) for x in _benchmark_curve(months, series, warmup, starting_cash)],
        trades_log=tlog,
    )


def compare_profiles(prices: dict, *, profiles=PRICE_PROFILES, **kw) -> dict[str, BacktestResult]:
    return {p: backtest(prices, StrategyConfig(profile=p), **kw) for p in profiles}


def backtest_report(results: dict[str, BacktestResult]) -> str:
    """A compact comparison across profiles vs the buy-and-hold benchmark."""
    if not results:
        return "No price history to backtest."
    any_r = next(iter(results.values()))
    lines = [f"Backtest — {any_r.months} monthly steps · benchmark (equal-weight hold): "
             f"{any_r.benchmark_return:+.1%}"]
    for p, r in sorted(results.items(), key=lambda kv: kv[1].total_return, reverse=True):
        flag = "  ✓ beats hold" if r.beat_benchmark() else ""
        lines.append(f"  {p:14} return {r.total_return:+.1%}  CAGR {r.cagr:+.1%}  "
                     f"maxDD {r.max_drawdown:.1%}  trades {r.trades}{flag}")
    lines.append("Directional only — monthly bars, modeled transaction costs, quality/signal gates neutralized.")
    return "\n".join(lines)


def scoreboard_line(results: dict[str, BacktestResult]) -> str:
    """A one-line ranking for the daily digest: profiles by backtest return vs hold."""
    if not results:
        return ""
    bench = next(iter(results.values())).benchmark_return
    ranked = sorted(results.items(), key=lambda kv: kv[1].total_return, reverse=True)
    parts = [f"{p} {r.total_return:+.0%}{' ✓' if r.beat_benchmark() else ''}" for p, r in ranked]
    return f"Backtest scoreboard (vs {bench:+.0%} hold): " + " · ".join(parts)
