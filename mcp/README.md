# tuskledger-mcp

> **Model Context Protocol server for Tusk Ledger.**
> Gives your AI assistant typed access to your local personal finance
> data — without sending anything outside your machine.

## What it is

A small Python package that runs as a [Model Context Protocol](https://modelcontextprotocol.io)
server on your laptop. Once you've added it to your AI client's config
(Claude Desktop, Cursor, Cowork, Claude Code, anything that speaks
MCP), your assistant can call tools like:

- `list_accounts` — every connected account with balance + sync status
- `query_transactions` — filter by date, account, category, etc.
- `search_transactions` — fuzzy text search across merchants and notes
- `get_spending_summary` — totals by category for a date range
- `get_top_merchants` — who you're paying the most
- `get_recurring_subscriptions` — Netflix, gym, etc.
- `get_upcoming_bills` — next 30 days with running balance
- `get_net_worth` — current + 12-month trend
- `get_holdings` — every investment position
- `get_investments_summary` — portfolio roll-up + asset allocation
- `get_retirement_projection` — Monte Carlo summary for your saved scenario
- `run_sync` — trigger a Plaid pull
- `list_stale_accounts` — accounts with stale data

The server talks to your local Tusk Ledger backend on
`http://127.0.0.1:8000`. **No data crosses the internet.** The "MCP
cloud" doesn't exist; this whole thing is one Python process running
on your machine, talking to another Python process on the same machine.

## Why this exists

Tusk Ledger is built for the agent-assisted user — someone who can ask
Claude / Cursor / Cowork to do things they couldn't do alone five years
ago. The MCP server is the highest-leverage move toward that goal:
your assistant gets typed, structured access to your finance data
instead of having to scrape the React UI or guess at the database
schema.

Real-world examples once it's installed:

- *"Categorize the last 6 months of transactions from Whole Foods as
  Groceries instead of Shopping."* → Assistant queries them, you
  confirm, it makes the rule.
- *"What did I spend on coffee last quarter?"* → 3 seconds, no UI clicks.
- *"My net worth dropped this morning — what's causing it?"* →
  Assistant pulls accounts, balances, recent transactions, and
  diagnoses.
- *"Am I on track to max out my HSA this year?"* → Reads HSA bucket
  + YTD contributions + IRS limit, returns the gap.

## Install

### Option A — quick try with `uvx` (no permanent install)

```jsonc
// In your MCP client's config (Claude Desktop, Cursor, etc.)
{
  "mcpServers": {
    "tuskledger": {
      "command": "uvx",
      "args": ["--from", "/path/to/tuskledger/mcp", "tuskledger-mcp"]
    }
  }
}
```

Replace `/path/to/tuskledger/mcp` with the actual path on your machine.
[uvx](https://docs.astral.sh/uv/) (from `pip install uv`) handles the
isolated Python env automatically — nothing pollutes your global Python.

### Option B — pip install into a venv

```bash
cd /path/to/tuskledger/mcp
python -m venv .venv
source .venv/bin/activate
pip install -e .
```

Then point your MCP client's config at the installed binary:

```jsonc
{
  "mcpServers": {
    "tuskledger": {
      "command": "/path/to/tuskledger/mcp/.venv/bin/tuskledger-mcp"
    }
  }
}
```

### Where MCP client configs live

- **Claude Desktop:** `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS)
- **Cursor:** Settings → Features → Model Context Protocol
- **Cowork:** see Anthropic's Cowork docs
- **Claude Code:** project-level `.claude/mcp.json`

After editing the config, restart the client. The server boots when
the client starts and shuts down when it closes.

## Configuration

Two environment variables, both optional:

| Var | Default | Notes |
|---|---|---|
| `TUSKLEDGER_BASE_URL` | `http://127.0.0.1:8000` | Where your Tusk Ledger backend is listening. Override if you've moved the port. |
| `TUSKLEDGER_TIMEOUT_SECONDS` | `10` | Per-request timeout. Bump if your DB is huge and a query takes a while. |

Set them in your MCP client config:

```jsonc
{
  "mcpServers": {
    "tuskledger": {
      "command": "uvx",
      "args": ["--from", "/path/to/tuskledger/mcp", "tuskledger-mcp"],
      "env": {
        "TUSKLEDGER_BASE_URL": "http://127.0.0.1:8000",
        "TUSKLEDGER_TIMEOUT_SECONDS": "30"
      }
    }
  }
}
```

## Auth

This v0 assumes your Tusk Ledger backend is running with
`DEV_BYPASS_AUTH=true` (the common single-machine pattern documented
in the main repo's README). If you've kept auth enabled, the MCP
server's calls will fail with 401s and you'll see the error in your
assistant's response.

Auth-aware support is on the roadmap. Until then, if you want both
auth and MCP, run the backend with `DEV_BYPASS_AUTH=true` *only* when
you're using the assistant, and flip it back when you're done.

## What this server intentionally does NOT do

By design, v0 is **read-mostly**. The server doesn't expose:

- Deleting accounts, transactions, rules, or goals
- Modifying the database schema or running migrations
- Disabling auth or rotating the encryption key
- Touching Plaid access tokens
- Sending data anywhere outside `127.0.0.1`

The reasoning: an AI assistant should be able to help you understand
your data and run safe operations (sync, queries), but irreversible
changes belong in the web UI where you can see what's about to happen.
We may add structured write tools (e.g. "create a rule") in later
versions with explicit confirmation flows, but the bar will stay high.

## Troubleshooting

**`Could not reach Tusk Ledger backend at http://127.0.0.1:8000`** —
Your Tusk Ledger app isn't running. From the main repo: `./start.sh`.

**`401 Unauthorized` from any tool** — Auth is on. See the Auth
section above. Run with `DEV_BYPASS_AUTH=true` for now.

**`404 Not Found`** — The backend doesn't have the endpoint we're
trying to hit. Probably means you're on an older version of Tusk
Ledger. Update the main app, restart your MCP client.

**Tools don't appear in your assistant** — The MCP server failed to
boot. Check your client's MCP server logs (Claude Desktop has a "View
MCP server logs" menu item). Common causes: bad path in the config,
Python not on PATH, `uvx` not installed.

**General health check** — From the main repo: `./tuskledger doctor`.
This is the same diagnostic the MCP server's `run_doctor` tool calls.

## Development

```bash
cd mcp
pip install -e ".[test]"
pytest tests/ -v
```

The tests don't bring up an MCP transport — they exercise the dispatch
layer directly with a mock client. The MCP protocol itself is just a
wrapper.

## Project links

- Main repo: https://github.com/BradMorphsters/tuskledger
- Project site: https://www.tuskledger.com
- For agents browsing externally: https://www.tuskledger.com/llms.txt
- License: MIT
