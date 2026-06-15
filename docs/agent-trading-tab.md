# Agent Trading tab — design outline

**Status:** proposal · **Date:** 2026-06-14 · **Owner:** project owner

A supervisory cockpit in Tusk Ledger for a **Robinhood Agentic Trading** account. The
tab does *not* place trades. Execution happens inside Robinhood's isolated Agentic
account, driven by an external AI agent over Robinhood's Trading MCP. Tusk Ledger's
job is oversight, accounting, guardrail tracking, and tax — the things Robinhood's own
surface doesn't do well.

---

## 1. What Robinhood actually ships

Launched **May 27, 2026**. The mechanics that matter for our design:

- **Isolated account.** An *Agentic account* is a separate self-directed individual
  account (you can hold up to 10 individual accounts incl. this one). You fund it with
  a dedicated budget. **That budget is the only money the agent can ever trade** — the
  blast radius of a bad trade is capped at what you pre-loaded.
- **Read-all, trade-one.** The agent gets **read access to every Robinhood account**
  (numbers, positions, balances, full order history) but can **only place orders in the
  Agentic account**.
- **Execution is via an external agent + MCP**, not Robinhood's app. You connect an
  agent (Claude Desktop, Claude Code, ChatGPT, Codex, Cursor, Grok, or any MCP client)
  to `https://agent.robinhood.com/mcp/trading`. Account creation + auth is **desktop-only**.
- **Beta scope = equities only.** Ordinary stocks. No options/crypto yet.
- **Controls Robinhood gives you:** per-trade push notification, real-time activity
  feed, P&L view, and a **one-tap kill switch** that disconnects the agent instantly.
- **Robinhood's own disclosure:** significant risk incl. *total loss*; agents can
  misread instructions, act on stale data, move fast, and be hard to stop in real time.
  You are legally responsible for every trade.

**Design consequence:** Tusk Ledger is the *system of record and supervision*, not the
executor. This also keeps us on the right side of the rule that the app never places
orders or moves money itself.

---

## 2. Where the tab fits in the data flow

```
                 ┌─────────────────────────┐
   you set ────► │  AI agent (Claude/etc.) │  ← reads context from tuskledger-mcp
   the mandate   │  + robinhood-trading MCP│  ← reads/writes orders to Robinhood
                 └───────────┬─────────────┘
                             │ places trades
                             ▼
                 ┌─────────────────────────┐
                 │ Robinhood Agentic acct  │  (isolated, capped budget)
                 │  positions · orders ·   │
                 │  cash · P&L             │
                 └───────────┬─────────────┘
                             │ Plaid Investments pull (existing pipeline)
                             ▼
                 ┌─────────────────────────┐
                 │  Tusk Ledger            │
                 │  /agent-trading tab     │  ← monitor, guardrails, tax, kill link
                 └─────────────────────────┘
```

**Read path = Plaid, which we already run in production.** The Agentic account is a
self-directed brokerage account, so it surfaces through the existing Plaid Investments
holdings/transactions pipeline. We tag that one account as `is_agentic` and filter the
tab to it. No new brokerage integration required for v1.

**Optional richer feed (v2):** point Tusk Ledger's own MCP client (or a thin poller) at
the agent's run logs / the Robinhood activity feed to capture *rationale per trade*,
which Plaid doesn't carry. Plaid gives us the ground-truth fills; the agent log gives us
the "why."

---

## 3. What the tab shows

Single page at `/agent-trading`, nav label **Agent Trading** (sits next to Investments /
Trading Tax / Signals). Sections top to bottom:

**A. Account header (status bar).**
Funded budget · current value · cash/buying power · today's P&L · cumulative P&L vs.
budget · status pill (`Active` / `Paused` / `Killed` / `Stale data`). Big, unmissable
**Kill switch** button that deep-links to Robinhood's disconnect (we don't reimplement
it — we route you to the real one).

**B. Mandate panel.**
The natural-language instruction(s) currently driving the agent ("rebalance to 20% ROAR
/ 80% HMNI", "buy $100 ROAR on any −2% day"), with a version history and a timestamp of
when each was set. This is *your* logged copy — the source of truth for "what did I
actually authorize," which Robinhood doesn't keep cleanly.

**C. Live activity feed.**
Every order, newest first: time, ticker, side, qty, fill price, resulting position,
and — when available — the agent's stated rationale. Sourced from Plaid investment
transactions, enriched by agent logs.

**D. Positions table.**
Holdings in the Agentic account *only*: qty, cost basis, market value, unrealized P&L,
% of account. Concentration bar so over-weights jump out.

**E. Guardrail monitor.**
The rules you set (see §4). We can't hard-enforce on Robinhood's side, but we
continuously check fills against them and raise alerts + a "recommend kill" banner on
breach. Each guardrail shows green/amber/red with the current value.

**F. Risk & cross-portfolio exposure.**
Sector/concentration of the Agentic sleeve, and — important — **overlap with your main
portfolio**. If the agent piles into a name you already hold heavily elsewhere, your
real exposure is larger than either account shows alone. Reuses the existing research/
holdings layer.

**G. Tax impact.**
Realized gains YTD in the sleeve, short- vs. long-term split, estimated tax owed, and
**wash-sale flags — including cross-account** (the agent can't see that selling X here
while you hold/buy X in your main account triggers a wash sale). Feeds the existing
`get_trading_tax_summary` / Trading Tax page and the year-end Tax Prep Pack.

**H. Controls / actions (links, not executions).**
Kill · Pause (deep-links) · "Sweep profits" reminder · fund/defund reminder · export
activity CSV.

---

## 4. How to manage it successfully (the playbook)

This is the part that decides whether agentic trading is a tool or a liability.

**Capital.** Fund it as a sandbox: only money you can fully lose, separate from
emergency fund and tax reserves. Robinhood caps the blast radius to the funded budget —
respect that cap as your real risk number. Don't top it up reflexively after losses.

**Mandate discipline.** Write explicit, bounded instructions. Prefer
**approval mode** (agent proposes, you confirm) over **autonomous mode** until you've
watched it behave for weeks. Autonomous mode means it can trade without asking — treat
that as a deliberate, revocable decision, not a default.

**Guardrails to set and have the tab watch:**
- Max position size (e.g. ≤ 20% of sleeve in any one ticker).
- Allowlist / blocklist of tickers; no leveraged or inverse ETFs.
- Max trades per day (catches runaway loops).
- Cash floor (never fully invested).
- **Max drawdown kill trigger** (e.g. −15% from peak → you kill it). Decide the number
  *before* you're emotional about it.

**Monitoring cadence.** Robinhood pushes a notification per trade — don't mute them.
Use the tab for the daily read. Add a **scheduled daily digest** (we already run
scheduled tasks): overnight activity, P&L, any guardrail breach, any wash-sale flag,
one-line "all clear or look now."

**Wash sales are the silent tax bug.** The agent optimizes for P&L and is blind to your
other accounts. Selling a loser it doesn't know you also hold (or rebuy within 30 days)
in your main account disallows the loss. The tab's cross-account flag is the main reason
to route this through Tusk Ledger at all.

**Kill criteria, pre-committed.** Define in advance what makes you pull the plug:
drawdown threshold, a trade that violates the mandate, behavior you can't explain,
or news that the strategy's premise broke. Then actually pull it — the kill switch is
one tap.

**Security & access.** Auth lives in your desktop MCP client; the connection has
read access to *all* your Robinhood data, so treat the machine and the agent config as
sensitive. Know how to revoke (disconnect the MCP / kill switch). Don't connect the
trading MCP on a shared or unlocked machine.

**Don't confuse it with advice.** Robinhood's examples are illustrative, not
recommendations; outputs aren't guaranteed; you own every fill. The tab should restate
this where you set a mandate.

---

## 5. Build plan (concrete to this repo)

Mirrors the Signals/Research tab pattern already in the codebase.

**Frontend**
- `frontend/src/pages/AgentTrading.jsx` — the page above.
- `App.jsx`: add `{ to: '/agent-trading', icon: Bot, label: 'Agent Trading' }` to
  `navItems` and a matching `<Route path="/agent-trading" .../>`.
- A smoke test in `pages.smoke.test.jsx` (the null-shape guard pattern).

**Backend**
- `backend/app/routers/agent_trading.py` exposing:
  - `GET /api/agent-trading/summary` — header numbers + status.
  - `GET /api/agent-trading/activity` — normalized fills (Plaid + optional log merge).
  - `GET /api/agent-trading/positions`.
  - `GET /api/agent-trading/guardrails` — config + current evaluation.
  - `GET /api/agent-trading/tax` — realized/unrealized + wash-sale (incl. cross-account).
  - `PUT /api/agent-trading/mandate` and `/guardrails` — store your config (no order side effects).
- Mark the agentic Plaid account with an `is_agentic` flag so every query filters to it.

**MCP (tuskledger-mcp)**
- New read tools so *your* agent can pull its own oversight context before trading:
  `get_agent_account_summary`, `get_agent_activity`, `check_agent_guardrails`,
  `get_agent_wash_sale_risk`. (Bumps tool count → site + marketplace per the usual flow.)
- This is the elegant bit: the same agent that trades via `robinhood-trading` can read
  *your* guardrails and tax state via `tuskledger-mcp` and self-restrain.

**Automation**
- Scheduled daily "agent oversight digest" task (drafts a summary like the X-posting
  task does — review, don't auto-act).

**Explicitly out of scope (by design):** Tusk Ledger never places, cancels, or sizes a
trade and never moves money. The kill/pause buttons deep-link to Robinhood. Everything
here is read, monitor, account, and alert.

---

## 6. Autonomous execution workflow (experiment)

This is the closed loop. It runs without per-trade approval — the safety comes from
the capped Agentic budget plus a **pre-trade guardrail gate that can veto an order
before it reaches the broker.** Robinhood won't enforce our custom rules, so that gate
is load-bearing; it's the line between an experiment and a runaway loop.

```
 schedule ─► decision source ─► guardrail gate ─► broker ─► decision log ─► oversight
            (TradingAgents)    (tuskledger)      (sim|RH)    (jsonl)        (tab/digest)
                                    │ veto
                                    └────────► blocked + logged (no order)
```

One cycle:
1. **Trigger** — scheduled run (e.g. weekdays at open) or manual.
2. **Decision source** emits structured proposals: `{ticker, side, notional, ref_price,
   rationale, confidence}`. v1 uses TradingAgents (its risk-team → portfolio-manager
   gate is the *first* filter). A stub source ships so the loop runs with no API keys.
3. **Guardrail gate** evaluates each proposal against current account state:
   blocklist/allowlist, per-order notional cap, max position %, cash floor, daily-trade
   cap, drawdown high-water mark, and cross-account wash-sale risk. Returns pass + full
   per-check trace, or block + reasons.
4. **Broker** executes only what passed. `SimulatedBroker` fills against `ref_price` and
   tracks cash/positions/peak — this is the experiment default. `RobinhoodMCPBroker`
   maps the order to the Robinhood Trading MCP `place_order` tool; it refuses to run
   unless explicitly **armed** with a live MCP client (the human's step, not the app's).
5. **Decision log** — every proposal, guardrail trace, and fill appended to JSONL; this
   is what the tab's activity feed and the daily digest read.
6. **Drawdown halt** — if equity falls past `max_drawdown_pct` from its peak, the loop
   self-halts and places nothing until you reset it (and hit Robinhood's kill switch).

**Module layout** (`backend/app/agent_trading/`): `guardrails.py` (pure gate),
`brokers.py` (sim + RH stub), `decisions.py` (source adapters), `executor.py` (the loop),
`run_experiment.py` (CLI). All pure-Python and DB-free so it runs standalone in sim mode.

**My boundary:** the app builds, gates, logs, and monitors. It never funds the account,
authenticates the broker, or arms live execution — the human does that. Once armed, the
loop runs on its own; that's the intended autonomy.

## 7. Phasing — experiment first

- **Phase 0 (now):** full loop in **simulated mode**. `SimulatedBroker` + stub or
  TradingAgents decisions, real guardrail gate, decision log, CLI runner. No money, no
  broker connection. Goal: confirm the gate vetoes what it should and the log is legible.
- **Phase 1 (oversight UI):** `/agent-trading` tab reads the decision log + Plaid —
  header, activity, positions, guardrail status, tax/wash-sale, kill deep-link, daily digest.
- **Phase 2 (arm live, small):** swap in `RobinhoodMCPBroker` against a small funded
  Agentic budget; per-trade notifications on; drawdown halt tested for real.
- **Phase 3 (expand):** TradingAgents reflection loop tuned; options/crypto + multiple
  sleeves when Robinhood widens the beta.

---

## Sources
- Robinhood — Agentic Trading overview: https://robinhood.com/us/en/support/articles/agentic-trading-overview/
- Robinhood — Trading with your agent: https://robinhood.com/us/en/support/articles/trading-with-your-agent/
- Robinhood — Agentic Trading product page: https://robinhood.com/us/en/agentic-trading/
- Robinhood newsroom — "Robinhood is Now Open to Agents": https://robinhood.com/us/en/newsroom/robinhood-is-now-open-to-agents/
- TechCrunch — "Robinhood now lets your AI agents trade stocks" (2026-05-27): https://techcrunch.com/2026/05/27/robinhood-now-lets-your-ai-agents-trade-stocks/
