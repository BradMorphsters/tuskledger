# Agent Trading — build-out roadmap

Sprint plan for taking the agentic-trading feature from "sim harness" to a monitored,
live, intelligent loop. Companion to `agent-trading-tab.md` (what it is) and
`agent-trading-logic.md` (how it decides).

**Assumptions:** solo build, ~1-week sprints, experiment-first ordering — *safety before
autonomy before intelligence*. Sprints are sequenced, not calendar-locked; pull the next
one when the prior Definition of Done is green.

**Guiding principles**
- **Two-gate safety.** A model proposal (Gate 1) never reaches the broker without clearing
  the deterministic guardrail gate (Gate 2). Don't weaken this to ship faster.
- **Robinhood is the backbone.** The broker snapshot is the source of truth for
  cash/positions; we persist only policy state (peak, halt). No parallel ledger.
- **The simulator is the test endpoint.** Robinhood has no sandbox — `SimulatedBroker`
  and a read-only live tier are how we test before risking a cent.
- **Fail safe.** A missed cycle is free; a malformed trade isn't. Errors → no trade.

---

## Shipped (baseline)

- **Sim harness** — guardrail gate, executor loop with drawdown halt, simulated + disarmed
  Robinhood brokers, stub/TradingAgents decision sources, CLI runner.
- **Read-only oversight tab** — `/agent-trading` page + API over the decision log.
- **Real §1091 wash-sale check** wired into the gate (reuses `trading_tax.py`).
- **Persistent state + reconciliation** — equity high-water mark + halt survive restarts;
  drift detection vs the broker.
- **Docs + flow diagram.** 39 backend tests + page smoke test green.

---

## Sprint 1 — Connectivity & dry-run (read-only live)

**Goal:** point at the *real* Robinhood account, read everything, trade nothing.

- `RobinhoodMCPBroker` **read-only arming tier** — `snapshot` allowed, `place_order` hard-blocked.
- Real snapshot parsing from the MCP read tools (positions, cash, quotes, order history).
- Connectivity / auth self-check surfaced in the tab.
- Validate `reconcile()` against true account data; surface **drift + mode** (sim /
  read-only / live) in the tab.

**Done when:** the agent reads your live Agentic account, drift shows correctly, and there
is provably no code path that can place an order.

## Sprint 2 — Execution realism & controls

**Goal:** orders are sized deliberately and the lifecycle is handled; a human can stop it.

- **Position sizing** module between decision and order (fixed-fractional / vol-target /
  rebalance-to-weight) — today it's a flat default notional.
- **Order lifecycle:** market-hours gate, order-status polling, partial-fill handling,
  idempotency via client order IDs (a re-run never double-places), symbol validation.
- **Pause / re-arm UI** — persisted halt surfaced in the tab with an explicit re-arm; hard
  "loop disabled" switch independent of Robinhood's kill.

**Done when:** sized orders flow through a realistic lifecycle in sim/read-only, and the
tab can pause and re-arm the loop.

## Sprint 3 — Go live, minimal capital  ★ milestone

**Goal:** the first real trade, fully monitored.

- Arm `place_order` against a **tiny funded account** (~$20–50).
- End-to-end live cycle: notification reconciliation, kill-switch test, log + reconcile
  verified against reality.
- **Scheduler** (APScheduler) + **daily oversight digest** (scheduled task: overnight
  activity, P&L, guardrail breaches, drift, wash-sale flags).

**Done when:** one small real trade executes, is monitored, reconciles, and is killable;
the daily digest runs unattended.

## Sprint 4 — The decision brain (Gate 1)

**Goal:** real proposals instead of the stub.

- Feed **live quotes** into `ref_price` (`market_data.py`) and the account's own
  positions/cash so the source can reason about rebalancing.
- Integrate **TradingAgents** as the decision source — `deep_think_llm` = Opus 4.8,
  `quick_think_llm` = a cheaper model; validate the output→`Decision` mapping.
- **Structured-output contract + schema validation** — malformed model JSON → no trade.
- **Model/version pinning** + full capture of prompt, model, version, rationale per decision.

**Done when:** real proposals flow through both gates in sim → read-only → live-small,
with every decision auditable.

## Sprint 5 — LLM safety hardening

**Goal:** robust to bad inputs and provider failures.

- **Prompt-injection defense** — ingested news/social treated as untrusted; never able to
  instruct the agent. Structural separation of data from instructions.
- **Second-opinion / mandate-conformance check** before an order reaches the gate.
- **Provider fallback** — Opus → Sonnet → skip the cycle; cost/rate limits; optional
  confidence floor.

**Done when:** a poisoned headline or a provider outage degrades safely (no trade), proven
with tests.

## Sprint 6 — Tax, reporting & polish

**Goal:** close the loop on accounting and oversight.

- Fold the Agentic sleeve's realized gains + wash sales into the **Trading Tax page** and
  **Tax Prep Pack**.
- **Activity-feed rationale enrichment** (per-trade "why" via the wash-sale `on_flag` hook
  and decision rationale).
- **Cross-portfolio exposure** — concentration/overlap vs your main holdings.
- **Mobile** read-only view of the tab.

**Done when:** year-end tax is handled from the sleeve and the oversight surface is complete.

## Sprint 7 — Expand (when Robinhood widens the beta)

Options / crypto columns and order types; multiple agentic sleeves / strategies;
backtesting harness for proposed mandates.

---

## Cross-cutting (every sprint)

- **Tests first** for the guardrail gate and any new veto path — it's load-bearing.
- **Observability** — alerts on veto storms, drawdown approach, reconciliation drift,
  broker/model errors.
- **Security** — the MCP connection has read access to *all* Robinhood data; protect the
  host and the arm step; never auto-arm.

## Key risks / dependencies

- **No Robinhood sandbox** — real money is the only live test; mitigated by sim + read-only
  tier + minimal-capital go-live (Sprints 1–3).
- **Model ≠ alpha** — frontier models improve discipline and reliability, not predictive
  edge; size the experiment as risk capital regardless of Sprint 4 quality.
- **Robinhood beta scope** — equities-only today; Sprint 7 is gated on Robinhood, not us.
- **Adapter drift** — TradingAgents output schema varies by version; pin it and keep the
  mapping defensive.
