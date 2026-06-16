# Agent Trading — Go-Live Runbook

How to take the agentic-trading sleeve from **read-only + simulated approval queue** (where it
is today) to a **real, human-approved live loop**. Work top to bottom; do not skip a phase.

**Roles.** Steps marked **[YOU]** only you can do (funding, authorizing, arming, approving).
Steps marked **[DEV]** are code/config wiring (can be done for you, but you deploy/run it).
Claude never funds, authorizes, arms, or places — those are always your action.

**The golden rule that doesn't change:** an order is only ever placed by *your app*, on *your
per-order Approve tap*, after it cleared the guardrail gate. Claude is never in the placement
path.

---

## Phase 0 — Decisions & funding (before touching any connection) [YOU]

- [ ] **Fund the agentic sleeve.** Account ••••0005 ("Agentic") is currently $0. Deposit only
      what you can lose entirely. That amount is the whole experiment's blast radius.
- [ ] **Pick the live strategy profile** — `signal_event` / `momentum` / `mean_reversion` /
      `rotation` — set it in the Agent tab. (Backtests are directional, not a promise.)
- [ ] **Lock the guardrail numbers** (`GuardrailConfig`): `per_order_max_notional`,
      `max_position_pct`, `cash_floor_pct`, `max_trades_per_day`, `max_drawdown_pct`. Defaults
      are conservative; tighten to taste.
- [ ] **Order-type policy:** use a marketable **limit** (`OrderPolicy(order_type="limit")`) for
      the thin juniors so you don't get a bad market fill. Pick a `limit_offset_bps` (25 = 0.25%).
- [ ] **Settled-cash:** cash account is T+1. Turn on `require_settled_cash` if you want to forbid
      buying with unsettled proceeds (avoids good-faith violations).
- [ ] **Data keys present:** confirm `MARKETDATA_API_KEY` (Twelve Data) and `QUIVER_API_KEY` are
      set so prices/signals stay fresh — the stale-data gate will skip names whose feed is old.

## Phase 1 — Rebind the agent: disconnect from Claude, connect to the local app [YOU]

> ⚠️ **This is the load-bearing step you flagged.** Robinhood allows **one agent per agentic
> account**. Right now **Claude Desktop** is the bound agent on ••••0005 (that's how the
> read-only dry-runs worked). The local Tusk Ledger app cannot become the agent until Claude is
> disconnected first. You will lose Claude's live reads of the sleeve — that's expected and fine;
> the app becomes the reader and exposes a read-only projection Claude can still see.

- [ ] **Disconnect the Robinhood Trading MCP from Claude.** In Claude Desktop → Settings →
      Connectors (MCP), find **Robinhood Trading** (`agent.robinhood.com/mcp/trading`) and
      **remove / disconnect** it. Confirm it's gone.
- [ ] **(Optional sanity check)** In the Robinhood app/site, open the Agentic account's connected-
      agent setting and confirm no agent is bound (or that the Claude connection is revoked).
- [ ] **Connect Tusk Ledger as the agent.** Authorize the local app against
      `agent.robinhood.com/mcp/trading` via OAuth — you approve in Robinhood's own screen
      (password-free; the app never sees your login). Grant it to the **••••0005** account.
- [ ] **Confirm the bind:** the Agentic account now shows **Tusk Ledger** as its single connected
      agent.

## Phase 2 — Wire the backend execution transport [DEV]

- [ ] Implement the `MCPClient` callable — `(tool_name, args) -> result` — over the OAuth'd
      connection from Phase 1, with **encrypted token storage + refresh** (reuse the
      `.encryption_key` pattern; never commit the token).
- [ ] Construct the broker: `RobinhoodMCPBroker(account_number="<••••0005>", mcp_client=<transport>,
      mode=MODE_READ_ONLY, order_policy=OrderPolicy(...))`.
- [ ] Point `_live_broker()` in `app/routers/agent_trading.py` at this broker (still
      **read-only** for now). Set `AGENT_TRADING_*` env paths if you want non-default locations.

## Phase 3 — Read-only validation on the REAL account [DEV + YOU]

- [ ] `broker.ping()` → confirms connectivity, auth, and that the agentic account is visible.
- [ ] Run `run_live_cycle(...)` with the **read-only** broker. Confirm it reads the real sleeve
      cash/positions and queues sensible proposals. **It places nothing.**
- [ ] Verify the read-only projection shows the real sleeve, the freshness gate behaves, and the
      `/alerts` feed is clean.
- [ ] Let it run in **shadow mode for ~2 weeks**: approve/reject in the app, but with the broker
      still read-only (Approve just marks approved). Compare what it proposed to what actually
      happened in the names. Only proceed if it earns it.

## Phase 4 — Arm and the first tiny live trade [YOU]

- [ ] **Arm it:** switch the broker to `MODE_LIVE`. This is the single most consequential toggle;
      it's deliberately a manual human step.
- [ ] Generate a cycle, then **Approve exactly one small proposal** in the app. Confirm:
      `place_approved_proposal` placed it → fill returned → proposal moved to **placed** → a
      reconcile read matches the broker → it's in the decision log.
- [ ] **Test the brakes:** Pause the loop, Approve a proposal → confirm it's **refused** (not
      placed) and an alert is logged. Re-arm.
- [ ] **Confirm the Robinhood kill switch** location and that it disconnects the agent.

## Phase 5 — Scheduled operation [DEV + YOU]

- [ ] Schedule the **pre-market live cycle** (generates proposals off the real account). Placement
      still requires your Approve each time — the schedule never auto-places.
- [ ] The **daily pre-market sync** (`tuskledger-daily-premarket-sync`) and **weekly universe
      review** (`tuskledger-universe-review-weekly`) are already running.
- [ ] Watch `/alerts` (and the digest) for cycle errors, vetoes, halts, or placement failures.

## Phase 6 — Records & tax [YOU]

- [ ] Track short-term gains (swing trades = ordinary income) and **cross-account wash sales** —
      you hold USAR/COPX/SETM/NB in your main accounts and the sleeve may trade them. The IRS
      aggregates across all your accounts.
- [ ] Keep the decision/approval/fill audit log (already written each cycle).

---

## Kill / rollback (know this before you arm)

1. **In-app pause** — stops placement immediately (approvals get refused). Re-arm to resume.
2. **Drawdown halt** — trips automatically past `max_drawdown_pct`; needs a human re-arm.
3. **Robinhood kill switch** — disconnects the agent at the broker.
4. **Full unwind** — disconnect Tusk Ledger from the agentic account (reverse of Phase 1) and the
   app can no longer place anything.

## What's already built (so you know what's NOT on this list)

Analyst + guardrail gate + sizing, the approval queue (`proposals.py` + Approve/Reject UI),
stale-data gate, limit-order policy, settled-cash check, failure alerts, `place_approved_proposal`
+ `run_live_cycle`, reconcile, state/halt/pause, the read-only projection. All tested against the
simulated broker. The only thing standing between here and live is **Phases 1–4** — the rebind,
the transport, validation, and your arm.
