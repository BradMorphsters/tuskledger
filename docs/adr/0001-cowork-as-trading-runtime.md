# ADR-0001: Cowork as the agentic-trading runtime; Tusk Ledger as logic & governance

**Status:** Accepted
**Date:** 2026-06-15
**Deciders:** Project owner

## Context

The Robinhood Agentic account is live and connected (read-only validated, funded with a small amount).
The connection is a Robinhood **Trading MCP** authenticated via OAuth inside the Claude
Desktop / Cowork session — *not* inside the Tusk Ledger backend. Tusk Ledger already owns
the trading *logic* (decision plumbing) and *governance* (the deterministic guardrail gate,
§1091 wash-sale check, drawdown breaker, state + reconciliation) plus the oversight tab.

The open question: to run a live loop, must the Tusk Ledger backend implement its own
MCP-over-HTTP + OAuth client to talk to Robinhood directly? Or can the **Cowork session be
the communication layer** — holding both connections (Robinhood MCP + Tusk Ledger) and
shuttling I/O — while Tusk Ledger remains the brain and rails?

Forces at play: this is an *experiment* (daily, supervised), not a 24/7 product; OAuth
token handling is the riskiest engineering; two-gate safety (a model proposal never reaches
the broker without clearing a deterministic gate) must be preserved; the oversight tab
already reads the decision log + Plaid, not a live broker feed.

## Decision

**Cowork is the runtime/communication layer. Tusk Ledger stays the logic, governance, and
system-of-record. We do NOT build a direct Tusk-Ledger↔Robinhood MCP client for the
experiment.**

Each cycle, Cowork: (1) reads the Agentic account via the Robinhood MCP read tools,
(2) hands the parsed snapshot + proposed decisions to Tusk Ledger's **deterministic**
`bridge.plan_cycle()`, which runs reconcile + the guardrail gate and returns *approved
order args* (or vetoes), (3) places **only** approved orders via the Robinhood MCP, and
(4) records fills back to the decision log Tusk Ledger's tab reads.

**Non-negotiable:** the governance gate is *code that Cowork executes and obeys*, never the
model's judgement. `plan_cycle()` has no ability to place an order — it only returns args
for approvals. The single code path that can trade lives in Cowork and only ever places
what the gate already approved.

## Options Considered

### Option A: Cowork as runtime (chosen)

| Dimension | Assessment |
|-----------|------------|
| Complexity | Low — no OAuth/MCP client to build; both connections already exist |
| Cost | Low — reuses existing guardrail/state code as a pure library |
| Scalability | Medium — fine for daily/intraday supervised; weak for 24/7 headless |
| Team familiarity | High — same Python, same tab, same decision log |

**Pros:** deletes the riskiest work (OAuth token storage/refresh in FastAPI); works today;
clean separation (Tusk Ledger = brain/rails, Cowork = wiring); oversight tab unaffected
(reads log + Plaid).
**Cons:** autonomy depends on the Desktop app being open + connector authenticated at run
time; larger context = bigger prompt-injection surface; orchestration carries model
nondeterminism unless kept to a thin deterministic script.

### Option B: Backend OAuth MCP client (daemon)

| Dimension | Assessment |
|-----------|------------|
| Complexity | High — implement MCP-over-HTTP + OAuth + secure token lifecycle in FastAPI |
| Cost | High — most engineering + most new attack surface to secure |
| Scalability | High — true headless 24/7, independent of any agent client |
| Team familiarity | Low — new transport/auth code to own and maintain |

**Pros:** deterministic, reproducible, narrow execution path; runs unattended; Tusk Ledger
becomes self-contained.
**Cons:** the hard, risky build; unnecessary for a supervised experiment; holds live
broker credentials in the app.

## Trade-off Analysis

The core trade-off is **time-to-live and lower risk now (A)** vs **unattended autonomy and
reproducibility later (B)**. For an experiment that runs a few times a day under
supervision, A's weaknesses (run-time fragility, nondeterministic orchestration) are
acceptable *provided* the gate stays deterministic code. B's strengths (24/7, narrow
surface) aren't needed yet and cost the most to build and secure. Safety is preserved in
both because the guardrail gate is identical code; A simply moves the *transport* into
Cowork. The decision is therefore a phasing decision, not a safety trade-off — as long as
the non-negotiable holds.

## Consequences

- **Easier:** going live (no OAuth client); iterating (pure-Python gate); the tab needs no
  change (it already reads the log + Plaid).
- **Harder:** unattended reliability (gated on the Desktop app + connector being live);
  keeping the orchestration thin and the trade-capable context minimal.
- **To revisit — graduation criteria to Option B:** move to the backend daemon when you
  want (a) headless 24/7 operation independent of the Desktop app, (b) sub-minute/intraday
  cadence where per-cycle agent spin-up is too slow, or (c) Tusk Ledger to run standalone
  for others. Until one of those is true, stay on A.

## The thin loop (what Cowork runs each cycle)

```
1. READ    portfolio = get_portfolio(acct); positions = get_equity_positions(acct);
           quotes = get_equity_quotes(symbols)              # Robinhood MCP (Cowork)
2. PARSE   snapshot = parse_account_state(portfolio, positions, quotes)   # Tusk Ledger
3. GATE    plan = bridge.plan_cycle(snapshot, decisions, config, persisted_state, ...)
           # deterministic: reconcile + guardrails. Returns approved order_args + vetoes.
           # plan_cycle CANNOT place anything.
4. PLACE   for p in plan.approved: fill = place_equity_order(**p.order_args)  # Cowork
           # only approved orders; nothing else can reach the broker
5. RECORD  bridge.record_cycle(plan, fills, log_path, state_store)           # Tusk Ledger
           # appends to the decision log the /agent-trading tab reads; persists peak/halt
```

Cowork shuttles I/O (steps 1, 4). Tusk Ledger makes every call (steps 2, 3, 5). The only
thing that can place a trade is step 4, and it only ever places what step 3 approved.

## Action Items

1. [x] Build `bridge.plan_cycle()` — reconcile + gate over a Cowork-fetched snapshot;
   emits approved order args, never trades. (Done with this ADR.)
2. [x] `record_cycle()` / log-row serialization so the tab reads bridge runs.
3. [ ] Wrap steps 1–5 as a single Cowork procedure (read-only first: stop after step 3 and
   show the plan; enable step 4 only on an explicit human arm).
4. [ ] Optional scheduled Cowork task for a daily supervised run + digest.
5. [ ] Revisit Option B only if a graduation criterion is met.
