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

## Shipped — as of 2026-06-16

The full **read-only** loop is built, connected to the live account, and scheduled.
Nothing can trade; going live remains a deliberate, un-taken step.

- **Sim harness** — deterministic guardrail gate (max position, cash floor, daily-trade cap,
  drawdown breaker, §1091 cross-account wash-sale), executor + drawdown halt, CLI runner.
- **Read-only oversight tab** — `/agent-trading` page + API over the decision log.
- **Live Robinhood connection** — `RobinhoodMCPBroker` with disarmed / read-only / live
  tiers; read tools pinned to the real API schema; account connected + read-only validated.
- **Persistent state + reconciliation** — equity high-water mark + halt survive restarts;
  drift detection vs the broker (Robinhood = source of truth).
- **Cowork↔Tusk Ledger bridge** (ADR-0001) — `plan_cycle` / `plan_strategy_cycle` can
  approve but cannot place; the one-call read-only cycle + the human arm gate.
- **Position sizing** — fixed-fractional / vol-target / rebalance.
- **Order lifecycle** — market-hours gate, symbol validation, idempotent client order IDs,
  partial-fill classification.
- **Configurable Analyst (Gate 1)** — signal-event / momentum / mean-reversion / rotation as
  a **setting**, rules-based + explainable, joined from your live research + Quiver signals +
  market data; switchable from the tab; proven on the real `critical-minerals` universe.
- **Live activity** — SSE "watch it think" timeline + the interactive/alive Trading Floor replay.
- **Controls** — pause / resume / re-arm, persisted.
- **Scheduled read-only digest** — weekday pre-market run that fetches the account, runs the
  Analyst, records the cycle, and reports a digest. Never trades.
- **107 backend + 26 frontend tests green.** Docs: tab, logic, ADR-0001, connect runbook,
  this roadmap.

---

## Sprint 1 — Connectivity & dry-run (read-only live) · ✓ SHIPPED

**Goal:** point at the *real* Robinhood account, read everything, trade nothing.

- `RobinhoodMCPBroker` **read-only arming tier** — `snapshot` allowed, `place_order` hard-blocked.
- Real snapshot parsing from the MCP read tools (positions, cash, quotes, order history).
- Connectivity / auth self-check surfaced in the tab.
- Validate `reconcile()` against true account data; surface **drift + mode** (sim /
  read-only / live) in the tab.

**Done when:** the agent reads your live Agentic account, drift shows correctly, and there
is provably no code path that can place an order.

## Sprint 2 — Execution realism & controls · ✓ SHIPPED

**Goal:** orders are sized deliberately and the lifecycle is handled; a human can stop it.
*(Also shipped beyond plan: SSE activity timeline + the interactive Trading Floor.)*

- **Position sizing** module between decision and order (fixed-fractional / vol-target /
  rebalance-to-weight) — today it's a flat default notional.
- **Order lifecycle:** market-hours gate, order-status polling, partial-fill handling,
  idempotency via client order IDs (a re-run never double-places), symbol validation.
- **Pause / re-arm UI** — persisted halt surfaced in the tab with an explicit re-arm; hard
  "loop disabled" switch independent of Robinhood's kill.

**Done when:** sized orders flow through a realistic lifecycle in sim/read-only, and the
tab can pause and re-arm the loop.

## Sprint 3 — Scheduling + go-live  ★ milestone · ◑ PARTIAL

**Safe half — ✓ shipped:** the **scheduled read-only runner + daily digest**. A weekday
pre-market task fetches the account read-only, runs the Analyst, records the cycle to the
log + event stream, and reports a digest. It cannot trade.

**Live half — deliberately deferred (owner's call):**
- Arm `place_order` against a **tiny funded account** (~$20–50).
- End-to-end live cycle: notification reconciliation, kill-switch test, log + reconcile
  verified against reality.

This is the one remaining gate to real trading, and it is intentionally not taken. Going
live is a separate, explicit human arm — the app never sets it.

## Sprint 4 — The decision brain (Gate 1) · ◑ RULES ANALYST SHIPPED

**Shipped — a real, explainable rules-based Analyst** replaced the stub: signal-event /
momentum / mean-reversion / rotation profiles (a setting), joined from live research +
Quiver signals + market data, wired end-to-end (`plan_strategy_cycle`) and proven on the
real universe. This is a strong, auditable Gate 1 with no LLM and no black box.

**Optional future — the LLM version:**
- Integrate **TradingAgents** as an alternate decision source — `deep_think_llm` = Opus 4.8,
  `quick_think_llm` = cheaper; validate the output→`Decision` mapping.
- **Structured-output contract + schema validation** — malformed model JSON → no trade.
- **Model/version pinning** + full capture of prompt, model, version, rationale per decision.

The rules Analyst is the default; an LLM source would layer in as another profile, gated
identically. (Reminder: model ≠ alpha — the LLM buys reliability, not edge.)

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
