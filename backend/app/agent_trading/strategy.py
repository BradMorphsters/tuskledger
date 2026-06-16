"""The Analyst — a configurable, rules-based decision source (Gate 1).

This is the part that decides *what to consider* for purchase. It's deliberately a
transparent rule engine (not a black box): each Decision carries a rationale naming the
signals that fired. The trading *philosophy* is a setting — pick one of the standard
profiles and the same engine applies that profile's entry/exit rules:

* ``signal_event``   — buy on your Quiver signals (congressional / insider / gov-contract
  buying) in quality names; exit when the signal decays or the thesis weakens.
* ``momentum``       — buy strength (uptrend + positive momentum); exit when the trend breaks.
* ``mean_reversion`` — buy quality names that pulled back inside an uptrend; exit on the bounce.
* ``rotation``       — hold the top-N scored names; rotate out of names that drop out.

It is long-only and swing/position-oriented by design (see the system's trading-style map):
US equities, days-to-weeks holds, no shorting, no intraday churn.

Pure and deterministic over a list of :class:`Candidate` feature rows. A separate adapter
(``StrategyDecisionSource`` + a candidate provider) joins your live research / signals /
market-data into Candidates — that wiring is the only non-pure part.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Callable, Optional, Sequence

from .decisions import Decision

PROFILES = ("signal_event", "momentum", "mean_reversion", "rotation")


@dataclass(frozen=True)
class StrategyConfig:
    """The Analyst's settings. ``profile`` is the standard philosophy; the rest tune it."""

    profile: str = "signal_event"
    research_floor: float = 0.50      # min quality/thesis score to buy or keep holding
    signal_threshold: float = 0.60    # signal_event: signal strength to enter
    signal_exit: float = 0.30         # signal_event: signal decay that triggers an exit
    momentum_threshold: float = 0.0   # momentum: min trailing return to enter (fraction)
    pullback_pct: float = 0.05        # mean_reversion: min pullback from recent high to enter
    target_pct: float = 0.15          # take-profit (all profiles)
    stop_pct: float = 0.08            # stop-loss (all profiles)
    max_new_positions: int = 3        # cap new buys per cycle
    rotation_top_n: int = 5           # rotation basket size
    require_theme_tailwind: bool = False  # if on, no new buys while the sector is in a downtrend

    def __post_init__(self):
        if self.profile not in PROFILES:
            raise ValueError(f"unknown strategy profile {self.profile!r}; pick one of {PROFILES}")


@dataclass(frozen=True)
class Candidate:
    """One name's features for a cycle — the normalized input the rules read. The live
    adapter fills these from research scores, Quiver signals, and market data."""

    ticker: str
    price: float
    research_score: float = 0.0   # 0..1 quality / thesis strength (research layer)
    signal_score: float = 0.0     # composite public-activity signal (Quiver), ~0..1
    momentum: float = 0.0         # trailing return, fraction (e.g. 0.08 = +8%)
    trend_up: bool = False        # price above its long moving average
    pullback: float = 0.0         # fraction below recent high (0..1)
    rotation_score: float = 0.0   # sector-rotation temperature (optional)
    theme_momentum: float = 0.0   # sector/commodity tailwind (avg proxy-ETF 3-mo return)
    theme_trend_up: bool = False  # is the underlying sector in an uptrend
    held_qty: float = 0.0
    avg_cost: float = 0.0

    @property
    def held(self) -> bool:
        return self.held_qty > 0

    def unrealized_pct(self) -> float:
        if self.held and self.avg_cost > 0:
            return (self.price - self.avg_cost) / self.avg_cost
        return 0.0


def _buy(c: Candidate, why: str) -> Decision:
    # size is left to the sizer (Gate between here and the guardrails); rationale is the "why"
    return Decision(c.ticker, "buy", c.price, target_notional=None, rationale=why)


def _sell(c: Candidate, why: str) -> Decision:
    return Decision(c.ticker, "sell", c.price, target_notional=None, rationale=why)


def _exit_reason(c: Candidate, cfg: StrategyConfig) -> Optional[str]:
    up = c.unrealized_pct()
    if up <= -cfg.stop_pct:
        return f"stop-loss hit ({up:.0%})"
    if up >= cfg.target_pct:
        return f"target reached (+{up:.0%})"
    if c.research_score < cfg.research_floor:
        return f"thesis weakened (score {c.research_score:.2f} < {cfg.research_floor:.2f})"
    if cfg.profile == "signal_event" and c.signal_score < cfg.signal_exit:
        return f"signal decayed ({c.signal_score:.2f} < {cfg.signal_exit:.2f})"
    if cfg.profile == "momentum" and not c.trend_up:
        return "trend broke (price below its moving average)"
    return None


def _entry(c: Candidate, cfg: StrategyConfig) -> Optional[str]:
    """Return a rationale if this non-held name is a buy under the profile, else None."""
    if c.research_score < cfg.research_floor:
        return None  # quality gate applies to every profile
    if cfg.require_theme_tailwind and not c.theme_trend_up:
        return None  # don't fight the sector — no new buys while the theme is in a downtrend
    if cfg.profile == "signal_event":
        if c.signal_score >= cfg.signal_threshold:
            return (f"signal {c.signal_score:.2f} ≥ {cfg.signal_threshold:.2f} "
                    f"(insider/congress/gov buying), quality {c.research_score:.2f}")
    elif cfg.profile == "momentum":
        if c.trend_up and c.momentum >= cfg.momentum_threshold:
            return f"uptrend + momentum {c.momentum:+.1%}, quality {c.research_score:.2f}"
    elif cfg.profile == "mean_reversion":
        if c.trend_up and c.pullback >= cfg.pullback_pct:
            return f"quality name pulled back {c.pullback:.0%} inside an uptrend (buy the dip)"
    return None


def _rank(c: Candidate, cfg: StrategyConfig) -> float:
    if cfg.profile == "momentum":
        return c.momentum
    if cfg.profile == "mean_reversion":
        return c.pullback
    return c.signal_score  # signal_event


def propose(candidates: Sequence[Candidate], cfg: StrategyConfig) -> list[Decision]:
    """Apply the active profile's rules. Returns buy/sell Decisions with rationale; names
    that are neither bought nor sold are simply held (no Decision). Pure."""
    if cfg.profile == "rotation":
        return _rotation(candidates, cfg)

    decisions: list[Decision] = []
    # exits first
    for c in candidates:
        if c.held:
            why = _exit_reason(c, cfg)
            if why:
                decisions.append(_sell(c, why))
    sold = {d.ticker for d in decisions}
    # entries (non-held), ranked, capped
    entries = [(c, why) for c in candidates
               if not c.held and c.ticker not in sold and (why := _entry(c, cfg))]
    entries.sort(key=lambda x: _rank(x[0], cfg), reverse=True)
    for c, why in entries[:cfg.max_new_positions]:
        decisions.append(_buy(c, why))
    return decisions


def _rotation(candidates: Sequence[Candidate], cfg: StrategyConfig) -> list[Decision]:
    score = lambda c: (c.rotation_score or c.research_score)
    eligible = [c for c in candidates if c.research_score >= cfg.research_floor]
    target = {c.ticker for c in sorted(eligible, key=score, reverse=True)[:cfg.rotation_top_n]}
    decisions: list[Decision] = []
    for c in candidates:
        if c.held and c.ticker not in target:
            decisions.append(_sell(c, f"rotated out of the top {cfg.rotation_top_n}"))
    bought = 0
    for c in sorted(eligible, key=score, reverse=True):
        if c.ticker in target and not c.held and bought < cfg.max_new_positions:
            decisions.append(_buy(c, f"rotated in — score {score(c):.2f}"))
            bought += 1
    return decisions


# candidate_provider(watchlist, as_of) -> list[Candidate]. The live one joins research /
# Quiver signals / market_data; injected so the engine above stays pure + testable.
CandidateProvider = Callable[[Sequence[str], str], list[Candidate]]


class StrategyDecisionSource:
    """A DecisionSource (Gate 1) driven by :func:`propose` over a configured profile."""

    def __init__(self, config: StrategyConfig, candidate_provider: CandidateProvider):
        self.config = config
        self.candidate_provider = candidate_provider

    def get_decisions(self, watchlist: Sequence[str], as_of: str) -> list[Decision]:
        candidates = self.candidate_provider(watchlist, as_of)
        return propose(candidates, self.config)
