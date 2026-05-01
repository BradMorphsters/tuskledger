"""
The MCP server itself. Defines the tool surface and dispatches calls.

Design choices:
  - Read-mostly v0. We don't expose anything destructive (no
    delete-account, no rotate-encryption-key, no disable-auth) even
    though the backend supports those operations. The agent shouldn't
    be able to do irreversible damage without going through the web UI
    where the user can see what's happening.
  - One MCP tool per common question an assistant would actually ask:
    'what accounts are connected?', 'how much did I spend on coffee
    last month?', 'what's coming due in the next two weeks?'. Resist
    the urge to ship every endpoint as a tool — fewer, well-named
    tools beat a long list of grep-able ones.
  - Tool descriptions are prose, not just titles. The LLM picking
    which tool to call uses these descriptions; clear text here
    saves a lot of bad calls.
  - Inputs default to sensible scopes (e.g. transactions default to
    last 90 days) so a tool call without arguments still does
    something useful.
"""
from __future__ import annotations

import asyncio
import json
import logging
import sys
from typing import Any

from mcp.server import Server
from mcp.server.stdio import stdio_server
from mcp.types import Tool, TextContent

from . import __version__
from .client import TuskLedgerClient, TuskLedgerError


# Log to stderr so MCP's stdio transport (stdout-based) stays clean.
logging.basicConfig(level=logging.INFO, stream=sys.stderr)
log = logging.getLogger("tuskledger-mcp")


# ── Tool definitions ─────────────────────────────────────────────
# Each entry: (name, description, JSON Schema for input).
# Keep names lowercase_underscore; descriptions actionable + specific.

TOOLS: list[Tool] = [
    Tool(
        name="list_accounts",
        description=(
            "List every connected account in Tusk Ledger with current "
            "balance, type (checking, savings, credit, investment, loan), "
            "and last-sync timestamp. Use this first to understand what "
            "accounts exist before drilling into transactions or holdings."
        ),
        inputSchema={"type": "object", "properties": {}, "additionalProperties": False},
    ),
    Tool(
        name="list_stale_accounts",
        description=(
            "Return accounts whose data is older than the freshness "
            "threshold (a week for synced accounts, a month for manual). "
            "Useful when the user asks 'why is my net worth wrong?' — "
            "stale balances are usually the cause."
        ),
        inputSchema={"type": "object", "properties": {}, "additionalProperties": False},
    ),
    Tool(
        name="query_transactions",
        description=(
            "List transactions matching optional filters. Returns the most "
            "recent matches first. Common filter combos:\n"
            "  • account_id + start_date + end_date  → 'all transactions in "
            "    my checking account this month'\n"
            "  • category='Coffee' + start_date='2026-01-01'  → 'every "
            "    coffee purchase since New Year'\n"
            "Defaults to no filter (returns the most recent 100 transactions "
            "across all accounts)."
        ),
        inputSchema={
            "type": "object",
            "properties": {
                "account_id": {"type": "integer", "description": "Filter to a single account by id."},
                "category":   {"type": "string",  "description": "Filter to a single category name (exact match)."},
                "start_date": {"type": "string",  "description": "ISO date YYYY-MM-DD; inclusive lower bound."},
                "end_date":   {"type": "string",  "description": "ISO date YYYY-MM-DD; inclusive upper bound."},
                "limit":      {"type": "integer", "description": "Max rows to return (default 100, max 500)."},
            },
            "additionalProperties": False,
        },
    ),
    Tool(
        name="search_transactions",
        description=(
            "Free-text search across transaction names, merchant names, and "
            "notes. Use when the user asks 'find that Whole Foods charge "
            "from last week' or 'when did I last pay Verizon?'. Different "
            "from query_transactions in that this is a fuzzy text search, "
            "not a structured filter."
        ),
        inputSchema={
            "type": "object",
            "required": ["q"],
            "properties": {
                "q":     {"type": "string",  "description": "Search string. Matches partial words, case-insensitive."},
                "limit": {"type": "integer", "description": "Max rows (default 50)."},
            },
            "additionalProperties": False,
        },
    ),
    Tool(
        name="get_spending_summary",
        description=(
            "Aggregated spending totals broken down by category for a date "
            "range. Returns totals + per-category subtotals + counts. "
            "Defaults to the current calendar month if no dates given."
        ),
        inputSchema={
            "type": "object",
            "properties": {
                "start_date":    {"type": "string", "description": "ISO date YYYY-MM-DD."},
                "end_date":      {"type": "string", "description": "ISO date YYYY-MM-DD."},
                "exclude_business": {"type": "boolean", "description": "Drop transactions tagged as business (default false)."},
            },
            "additionalProperties": False,
        },
    ),
    Tool(
        name="get_top_merchants",
        description=(
            "Top N merchants by total spend in a date range. Returns merchant "
            "name, total amount, transaction count, and a sparkline of the "
            "monthly trend. Useful for 'who am I paying the most?'."
        ),
        inputSchema={
            "type": "object",
            "properties": {
                "start_date": {"type": "string",  "description": "ISO date."},
                "end_date":   {"type": "string",  "description": "ISO date."},
                "limit":      {"type": "integer", "description": "How many merchants to return (default 10)."},
            },
            "additionalProperties": False,
        },
    ),
    Tool(
        name="get_recurring_subscriptions",
        description=(
            "List detected recurring subscriptions: Netflix, Spotify, gym, "
            "etc. Returns merchant, cadence (monthly/annual/etc.), last "
            "amount, next expected date, and confidence. The user often "
            "asks 'what subscriptions do I have' — this answers it."
        ),
        inputSchema={"type": "object", "properties": {}, "additionalProperties": False},
    ),
    Tool(
        name="get_upcoming_bills",
        description=(
            "Forward 30-day calendar of expected bills + paychecks with a "
            "running balance. Returns each event's date, amount, source "
            "(merchant or paycheck), and the projected account balance "
            "after that event. Useful for 'is my account going to dip "
            "before payday?'."
        ),
        inputSchema={
            "type": "object",
            "properties": {
                "days": {"type": "integer", "description": "How many days forward to look (default 30)."},
            },
            "additionalProperties": False,
        },
    ),
    Tool(
        name="get_net_worth",
        description=(
            "Current net worth (assets minus liabilities) plus a 12-month "
            "trend. Numbers are point-in-time from the last sync, not "
            "live-computed. Use list_stale_accounts to verify freshness."
        ),
        inputSchema={
            "type": "object",
            "properties": {
                "history": {"type": "boolean", "description": "If true, return the full snapshot history instead of just latest."},
            },
            "additionalProperties": False,
        },
    ),
    Tool(
        name="get_holdings",
        description=(
            "Current investment holdings across every connected brokerage "
            "and 401(k). Returns symbol, account, quantity, current value, "
            "and unrealized gain/loss per position."
        ),
        inputSchema={"type": "object", "properties": {}, "additionalProperties": False},
    ),
    Tool(
        name="get_investments_summary",
        description=(
            "Roll-up of investment portfolio: total value, asset allocation "
            "(stocks/bonds/cash), top 5 holdings, % YTD gain. The 'how are "
            "my investments doing?' answer."
        ),
        inputSchema={"type": "object", "properties": {}, "additionalProperties": False},
    ),
    Tool(
        name="get_retirement_projection",
        description=(
            "Run the multi-decade Monte Carlo retirement simulator with the "
            "user's current saved scenario. Returns probability of success, "
            "depletion age, summary at key milestones (retirement, age 73 "
            "for RMDs, etc.). NOT a real-time edit interface — this just "
            "reports the current saved scenario's outputs."
        ),
        inputSchema={"type": "object", "properties": {}, "additionalProperties": False},
    ),
    Tool(
        name="run_sync",
        description=(
            "Trigger a Plaid sync across all connected items. Same as "
            "clicking 'Sync Now' in the UI. Returns a summary of what was "
            "fetched (accounts updated, transactions added). Safe to call "
            "freely — Plaid dedupes."
        ),
        inputSchema={"type": "object", "properties": {}, "additionalProperties": False},
    ),
]


# ── Tool dispatch ────────────────────────────────────────────────

def _format_result(payload: Any) -> str:
    """
    Pretty-print the payload for the assistant. JSON keeps structure
    intact and is what most LLMs handle best.
    """
    return json.dumps(payload, indent=2, default=str)


def _dispatch(name: str, arguments: dict, client: TuskLedgerClient) -> Any:
    """
    Synchronous dispatcher — one branch per tool. Kept linear and
    boring on purpose: each branch is one or two lines and easy to
    audit.
    """
    a = arguments or {}

    if name == "list_accounts":
        return client.list_accounts()
    if name == "list_stale_accounts":
        return client.list_stale_accounts()

    if name == "query_transactions":
        # Trim None / missing keys so we don't send empty params
        params = {k: v for k, v in a.items() if v not in (None, "")}
        params.setdefault("limit", 100)
        return client.list_transactions(**params)
    if name == "search_transactions":
        return client.search_transactions(q=a["q"], limit=a.get("limit", 50))

    if name == "get_spending_summary":
        return client.spending_summary(**{k: v for k, v in a.items() if v not in (None, "")})
    if name == "get_top_merchants":
        params = {k: v for k, v in a.items() if v not in (None, "")}
        params.setdefault("limit", 10)
        return client.top_merchants(**params)
    if name == "get_recurring_subscriptions":
        return client.recurring_subscriptions()

    if name == "get_upcoming_bills":
        return client.upcoming_bills(**{k: v for k, v in a.items() if v not in (None, "")})

    if name == "get_net_worth":
        return client.net_worth_history() if a.get("history") else client.net_worth_latest()

    if name == "get_holdings":
        return client.holdings()
    if name == "get_investments_summary":
        return client.investments_summary()

    if name == "get_retirement_projection":
        return client.retirement_projection()

    if name == "run_sync":
        return client.trigger_sync()

    raise TuskLedgerError(f"Unknown tool: {name!r}")


# ── Server wiring ────────────────────────────────────────────────

def build_server(client: TuskLedgerClient | None = None) -> Server:
    """
    Construct an MCP Server with the Tusk Ledger tools registered.
    Factored out of main() so tests can build a server instance with a
    mock client.
    """
    server = Server(f"tuskledger-mcp@{__version__}")
    # Default to the production client if none supplied (only tests pass one).
    cli = client or TuskLedgerClient()

    @server.list_tools()
    async def list_tools() -> list[Tool]:
        return TOOLS

    @server.call_tool()
    async def call_tool(name: str, arguments: dict) -> list[TextContent]:
        log.info("tool call: %s args=%s", name, list((arguments or {}).keys()))
        try:
            # The HTTP calls are blocking; offload to a thread so we don't
            # stall the event loop. Backend is on localhost so latency is
            # tiny but doing this correctly keeps the door open for
            # async-aware tools later.
            payload = await asyncio.to_thread(_dispatch, name, arguments, cli)
            return [TextContent(type="text", text=_format_result(payload))]
        except TuskLedgerError as e:
            # Surface the error in a way the assistant can show the user.
            err_payload = {
                "error": True,
                "message": str(e),
                "status": e.status,
                "body": e.body,
                "hint": (
                    "If the backend is unreachable, run `./start.sh` from the "
                    "repo root. If the endpoint returned 404 or 500, run "
                    "`./tuskledger doctor --json` for a structured health check."
                ),
            }
            return [TextContent(type="text", text=_format_result(err_payload))]
        except Exception as e:  # pylint: disable=broad-except
            log.exception("tool %s crashed", name)
            err_payload = {
                "error": True,
                "message": f"Unexpected error in {name!r}: {type(e).__name__}: {e}",
                "hint": "Likely a bug in tuskledger-mcp; please file an issue.",
            }
            return [TextContent(type="text", text=_format_result(err_payload))]

    return server


async def serve_stdio() -> None:
    """Run the MCP server over stdio (for Claude Desktop / Cursor / Cowork)."""
    server = build_server()
    log.info(
        "tuskledger-mcp v%s starting on stdio; talking to backend at %s",
        __version__, TuskLedgerClient().base_url,
    )
    async with stdio_server() as (read, write):
        await server.run(read, write, server.create_initialization_options())
