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
    # "Don't chase": defer a NEW buy whose trailing (~3-mo) return is ABOVE this ceiling — it has
    # run too far, too fast, so wait for it to cool rather than pay the spike. Still a momentum
    # buy (uptrend required); this only caps the top end. 0 = disabled. Held names are exempt so
    # exits always fire. Applies to the momentum/rotation profiles (where momentum drives entries).
    max_chase_momentum: float = 0.40
    pullback_pct: float = 0.05        # mean_reversion: min pullback from recent high to enter
    target_pct: float = 0.15          # take-profit (all profiles)
    stop_pct: float = 0.08            # stop-loss (all profiles)
    max_new_positions: int = 3        # cap new buys per cycle
    rotation_top_n: int = 5           # rotation basket size (buy into the top N)
    rotation_exit_n: int = 8          # hysteresis: only SELL a held name once it falls below
                                      # this (wider) rank — holds through small slips, no whipsaw
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
    if cfg.profile == "rotation":
        return c.rotation_score or c.research_score
    return c.signal_score  # signal_event


def _blocked_reason(c: Candidate, cfg: StrategyConfig) -> str:
    """For a non-held name that didn't trigger: the one thing it needs to make the cut."""
    if c.research_score < cfg.research_floor:
        return f"quality {c.research_score:.2f} below the {cfg.research_floor:.2f} floor"
    if cfg.require_theme_tailwind and not c.theme_trend_up:
        return "sector is in a downtrend (theme-tailwind gate is on)"
    if cfg.profile == "momentum":
        if not c.trend_up:
            return "not in an uptrend (price below its moving average)"
        return f"momentum {c.momentum:+.1%} below the {cfg.momentum_threshold:+.1%} entry"
    if cfg.profile == "mean_reversion":
        if not c.trend_up:
            return "not in an uptrend yet"
        return f"only {c.pullback:.0%} off its high — needs a {cfg.pullback_pct:.0%} dip to buy"
    if cfg.profile == "signal_event":
        return f"signal {c.signal_score:.2f} below the {cfg.signal_threshold:.2f} entry"
    return "no entry trigger fired"


@dataclass(frozen=True)
class RankedName:
    """One name's standing in the full universe this cycle — the transparency row behind
    'why isn't X being bought?'. Covers EVERY candidate, not just the ones that act."""

    ticker: str
    rank: int
    score: float            # the metric this profile ranks by (thesis / momentum / pullback / signal)
    research_score: float
    held: bool
    action: Optional[str]   # "buy" / "sell" / None — what the loop does with it THIS cycle
    status: str             # in_basket | buffer | below_cutoff | qualifies | capped | blocked | exit | held
    note: str               # plain-English why, and what it would take to make the cut
    held_qty: float = 0.0   # current position size (0 when not held)
    avg_cost: float = 0.0


def rank_universe(candidates: Sequence[Candidate], cfg: StrategyConfig) -> list[RankedName]:
    """Rank and annotate the WHOLE candidate list under the active profile — so a small/
    lower-ranked name's exact standing is visible, not hidden behind the top-N cut. Pure.

    Every name in the universe is scored and placed every cycle; this just exposes where each
    one sits and the single thing it needs to get bought. ``rotation`` is rank-gated (top-N),
    so a small name makes the cut only by climbing; the trigger profiles (momentum /
    mean_reversion / signal_event) are NOT rank-gated — a small name makes the cut purely on
    its own trigger, capped per cycle by ``max_new_positions``."""
    acts = {d.ticker: d for d in propose(candidates, cfg)}
    ranked = sorted(candidates, key=lambda c: _rank(c, cfg), reverse=True)
    out: list[RankedName] = []
    for i, c in enumerate(ranked, 1):
        d = acts.get(c.ticker)
        action = d.action if d else None
        if cfg.profile == "rotation":
            if c.research_score < cfg.research_floor:
                status, note = "blocked", f"quality {c.research_score:.2f} below the {cfg.research_floor:.2f} floor"
            elif i <= cfg.rotation_top_n:
                status, note = "in_basket", f"top {cfg.rotation_top_n} by thesis — owned/bought"
            elif i <= cfg.rotation_exit_n:
                status = "buffer"
                note = f"rank {i}: kept if already held, not a new buy (anti-churn buffer to {cfg.rotation_exit_n})"
            else:
                status = "below_cutoff"
                note = f"rank {i}: needs to climb into the top {cfg.rotation_top_n} to be bought"
        else:
            if action == "sell":
                status, note = "exit", d.rationale
            elif action == "buy":
                status, note = "qualifies", d.rationale
            elif c.held:
                status, note = "held", "thesis intact — no exit trigger"
            elif _entry(c, cfg):
                status = "capped"
                note = f"qualifies, but beyond this cycle's cap of {cfg.max_new_positions} new buys — buys a later cycle"
            else:
                status, note = "blocked", _blocked_reason(c, cfg)
        out.append(RankedName(
            ticker=c.ticker, rank=i, score=round(_rank(c, cfg), 4),
            research_score=round(c.research_score, 3), held=c.held,
            action=action, status=status, note=note,
            held_qty=round(c.held_qty, 6), avg_cost=round(c.avg_cost, 4),
        ))
    return out


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
    """Hold the top-N by thesis (conviction × upside × conviction-trend), with hysteresis:
    BUY into the top ``rotation_top_n``, but only SELL a held name once it falls below the
    wider ``rotation_exit_n``. That gap is the anti-churn buffer — a name slipping from #5 to
    #6 is *held*, not sold into the dip; it's only rotated out when it clearly drops out."""
    score = lambda c: (c.rotation_score or c.research_score)
    eligible = [c for c in candidates if c.research_score >= cfg.research_floor]
    ranked = sorted(eligible, key=score, reverse=True)
    buy_set = {c.ticker for c in ranked[:cfg.rotation_top_n]}                       # entries
    keep_set = {c.ticker for c in ranked[:max(cfg.rotation_exit_n, cfg.rotation_top_n)]}  # held tolerance

    decisions: list[Decision] = []
    for c in candidates:
        if c.held and c.ticker not in keep_set:
            if c.research_score < cfg.research_floor:
                why = (f"exiting — quality {c.research_score:.2f} below the {cfg.research_floor:.2f} "
                       f"floor (or not in the active universe)")
            else:
                why = f"rotated out — fell below the top {cfg.rotation_exit_n}"
            decisions.append(_sell(c, why))
    bought = 0
    for c in ranked:
        if c.ticker in buy_set and not c.held and bought < cfg.max_new_positions:
            decisions.append(_buy(c, f"rotated in — thesis score {score(c):.2f}"))
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
