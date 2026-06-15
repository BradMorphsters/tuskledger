"""Decision sources — where trade proposals come from.

A decision source answers one question: "given this watchlist, on this date, what should
we consider trading?" It returns :class:`Decision` rows. The executor turns each into a
:class:`~app.agent_trading.guardrails.ProposedOrder`, gates it, and (if it passes) sends
it to the broker.

Two implementations:

* :class:`StubDecisionSource` — deterministic, dependency-free proposals so the whole
  loop runs in CI and on a laptop with no API keys. Useful for testing the *gate*.
* :class:`TradingAgentsDecisionSource` — adapter for the open-source TradingAgents
  framework (``pip install tradingagents``). Lazily imported so the harness has no hard
  dependency on it. Its own risk-team → portfolio-manager gate is the first filter;
  ours is the second.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Optional, Protocol, Sequence


@dataclass(frozen=True)
class Decision:
    """A single proposal from a decision source.

    ``action`` is buy/sell/hold; ``hold`` rows are carried through for the log but never
    become orders. ``target_notional`` is how many dollars to deploy (the executor falls
    back to a default sizing if absent). ``confidence`` is 0..1 and is logged, not gated
    (you can add a confidence floor to the guardrail config later if you want one).
    """

    ticker: str
    action: str  # "buy" | "sell" | "hold"
    ref_price: float
    target_notional: Optional[float] = None
    confidence: float = 0.0
    rationale: str = ""


class DecisionSource(Protocol):
    def get_decisions(self, watchlist: Sequence[str], as_of: str) -> list[Decision]: ...


# --------------------------------------------------------------------------- stub

class StubDecisionSource:
    """Deterministic proposals for sim runs and tests.

    Strategy is intentionally trivial and explainable: for each ticker it proposes a
    small buy at the provided price. Prices and actions can be scripted per ticker so a
    test can drive specific guardrail paths (e.g. force an over-cap order).
    """

    def __init__(
        self,
        prices: dict[str, float],
        *,
        default_notional: float = 100.0,
        script: Optional[dict[str, dict]] = None,
    ):
        self._prices = {k.upper(): float(v) for k, v in prices.items()}
        self._default_notional = default_notional
        self._script = {k.upper(): v for k, v in (script or {}).items()}

    def get_decisions(self, watchlist: Sequence[str], as_of: str) -> list[Decision]:
        out: list[Decision] = []
        for raw in watchlist:
            tkr = raw.upper()
            price = self._prices.get(tkr)
            if price is None:
                continue
            spec = self._script.get(tkr, {})
            out.append(
                Decision(
                    ticker=tkr,
                    action=spec.get("action", "buy"),
                    ref_price=price,
                    target_notional=spec.get("notional", self._default_notional),
                    confidence=spec.get("confidence", 0.6),
                    rationale=spec.get("rationale", f"stub: routine accumulate {tkr}"),
                )
            )
        return out


# --------------------------------------------------------------------------- tradingagents

class TradingAgentsDecisionSource:
    """Adapter for TauricResearch/TradingAgents (Apache-2.0).

    Lazily constructs a ``TradingAgentsGraph`` and maps its decision to our
    :class:`Decision`. The framework is research-grade and self-describes as *not*
    financial advice; here it is strictly a signal generator feeding our guardrail gate.

    Install separately::

        pip install tradingagents     # plus an LLM provider key, e.g. ANTHROPIC_API_KEY

    The output schema of ``.propagate()`` varies across versions, so the mapping is kept
    defensive and easy to adjust.
    """

    def __init__(self, *, config: Optional[dict] = None, default_notional: float = 100.0):
        self._config = config
        self._default_notional = default_notional
        self._graph = None

    def _ensure_graph(self):
        if self._graph is None:
            try:
                from tradingagents.graph.trading_graph import TradingAgentsGraph
                from tradingagents.default_config import DEFAULT_CONFIG
            except ImportError as exc:  # pragma: no cover - optional dependency
                raise RuntimeError(
                    "TradingAgents is not installed. `pip install tradingagents` and set "
                    "an LLM provider key, or use StubDecisionSource for the experiment."
                ) from exc
            cfg = {**DEFAULT_CONFIG, **(self._config or {})}
            self._graph = TradingAgentsGraph(debug=False, config=cfg)
        return self._graph

    def get_decisions(self, watchlist: Sequence[str], as_of: str) -> list[Decision]:  # pragma: no cover - needs LLM
        graph = self._ensure_graph()
        out: list[Decision] = []
        for raw in watchlist:
            tkr = raw.upper()
            _, decision = graph.propagate(tkr, as_of)
            out.append(self._map(tkr, decision))
        return out

    def _map(self, ticker: str, decision) -> Decision:  # pragma: no cover - needs LLM
        # ``decision`` may be a dict or a string depending on version; be defensive.
        action, ref_price, confidence, rationale = "hold", 0.0, 0.0, str(decision)
        if isinstance(decision, dict):
            action = str(decision.get("action", decision.get("decision", "hold"))).lower()
            ref_price = float(decision.get("price", decision.get("ref_price", 0.0)) or 0.0)
            confidence = float(decision.get("confidence", 0.0) or 0.0)
            rationale = str(decision.get("reasoning", decision.get("rationale", "")))
        else:
            text = str(decision).lower()
            for word in ("buy", "sell", "hold"):
                if word in text:
                    action = word
                    break
        return Decision(
            ticker=ticker,
            action=action,
            ref_price=ref_price,
            target_notional=self._default_notional,
            confidence=confidence,
            rationale=rationale[:500],
        )
