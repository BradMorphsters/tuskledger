# Connecting to Robinhood Agentic Trading — read-only first

Sprint 1 runbook. Goal: point at the **real** Robinhood Agentic account, read everything,
trade nothing. The code is ready (`RobinhoodMCPBroker` with a `read_only` mode that
hard-blocks `place_equity_order` / `cancel_equity_order`). The steps below are **yours** —
the app does not authenticate, create, fund, or place anything on its own.

## What I can and can't do

- **I built:** the read-only broker tier, connectivity check, and a tolerant parser for the
  MCP read payloads, all tested so writes are provably blocked.
- **You do:** create + fund the Agentic account, add the connector, OAuth-authenticate
  (all desktop-only), and run trades when you decide to. I won't do those.

## Tool surface (Robinhood Trading MCP, equities beta)

- **Read (safe):** `get_accounts`, `get_portfolio`, `get_equity_positions`,
  `get_equity_quotes`, `get_equity_orders`, `search`
- **Simulate (safe, non-executing):** `review_equity_order` — returns pre-trade warnings
- **Write (live only):** `place_equity_order`, `cancel_equity_order`

Our `read_only` mode allows the first two groups and blocks the third.

## Step 1 — Open + (later) fund the Agentic account  *(you, desktop)*

You need a primary Robinhood individual investing account in good standing. Connecting the
MCP (next step) auto-opens the Agentic onboarding; follow it on a desktop browser.

- For **read-only validation you don't need to fund it** — `get_accounts` / `get_portfolio`
  / quotes work at $0 (positions will just be empty).
- Funding is required before Sprint 3 (first live trade). When you get there, fund it with
  money you'd shrug off losing (~$20–50). That capped balance is the entire blast radius.

## Step 2 — Connect the MCP to your agent client  *(you, desktop)*

Add the connector to whichever agent client you'll run the loop from:

- **Claude Code:** `claude mcp add robinhood-trading --transport http https://agent.robinhood.com/mcp/trading`
- **Claude Desktop:** Settings → Connectors → Add custom connector → `https://agent.robinhood.com/mcp/trading`
- **Codex / Cursor / Grok:** add the same URL as a Streamable-HTTP / custom MCP connector.

Then authenticate when prompted — it's **OAuth**, so the agent never sees your password.

## Step 3 — Capture the real read-tool output  *(you → me)*

The one thing I can't guess is the exact JSON field names each read tool returns. Our parser
is defensive (it tries several candidate keys), but I want to **pin it to reality**. In your
connected agent session, run the read tools and paste the raw JSON back to me:

> "Call get_accounts, then get_portfolio, then get_equity_positions for my Agentic account,
> then get_equity_quotes for one ticker — show me the raw JSON of each."

Paste those four payloads here. I'll lock `parse_account_state` to the real schema and add a
fixture test so it can't silently drift.

Redact account numbers if you like — I only need the **shape** (key names, nesting), not the
values.

## Step 4 — Dry-run reads + reconcile  *(me, after step 3)*

With the schema pinned, the `read_only` broker can power `snapshot()` and `reconcile()`
against your real account — confirming auth, parsing, and drift detection with **zero**
ability to trade. The agent runs the read tools; our code does the oversight math. Then the
`/agent-trading` tab shows real balances in read-only mode.

## Safety reminders

- The MCP connection has **read access to *all* your Robinhood accounts**, not just the
  Agentic one. Treat the host machine and the connected session as sensitive; don't connect
  on a shared/unlocked device.
- Stay in `read_only` until we've validated everything. Going `live` is a separate,
  deliberate step (Sprint 3) — and even then it's you arming it, not the app.
- The one-tap **kill switch** in the Robinhood app disconnects the agent instantly. Know
  where it is before you ever fund the account.

## Architecture note — where the loop runs

Two viable shapes, decided after step 3:

1. **In-agent:** the agent client holds *both* MCPs — `robinhood-trading` (reads/trades) and
   `tuskledger-mcp` (guardrails, wash-sale, state). Our broker's `mcp_client` is the agent's
   tool-call transport. Simplest; matches Robinhood's intended model.
2. **Backend client:** a Python OAuth MCP client in the backend calls the endpoint directly.
   More control, but more to build and secure. Only worth it if we want the loop to run
   headless without an agent client open.

Read-only validation works in either; we'll pick based on how you want the live loop to run.
