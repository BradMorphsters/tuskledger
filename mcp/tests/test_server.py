"""
Tests for the dispatch layer + tool surface.

These don't bring up an MCP transport — they exercise the dispatch
function directly with a mock client. That's the only logic with
behavioral nuance; the MCP protocol plumbing is just a wrapper.
"""
from __future__ import annotations

from unittest.mock import MagicMock

import pytest

from tuskledger_mcp import server as srv
from tuskledger_mcp.client import TuskLedgerError


# ── Tool surface ──────────────────────────────────────────────────

def test_every_tool_has_a_dispatch_branch():
    """If we add a tool to TOOLS we must add a dispatch case for it."""
    client = MagicMock()
    # Set sensible return values so each call doesn't raise
    for attr in dir(client):
        if not attr.startswith("_"):
            getattr(client, attr).return_value = []
    for tool in srv.TOOLS:
        # Some tools need required args — provide minimal valid ones
        args = {}
        for prop, schema in (tool.inputSchema.get("properties") or {}).items():
            if prop in (tool.inputSchema.get("required") or []):
                # Match the tiny set of required params we have
                if schema.get("type") == "string":
                    args[prop] = "test"
                elif schema.get("type") == "integer":
                    args[prop] = 1
        # Should not raise "Unknown tool"
        try:
            srv._dispatch(tool.name, args, client)
        except TuskLedgerError as e:
            if "Unknown tool" in str(e):
                pytest.fail(f"Tool {tool.name!r} is in TOOLS but has no dispatch branch")


def test_tool_input_schemas_are_valid_json_schema_subset():
    """Quick shape check — caught typos that broke MCP clients silently."""
    for tool in srv.TOOLS:
        s = tool.inputSchema
        assert s.get("type") == "object", f"{tool.name}: top-level type must be 'object'"
        # additionalProperties=False catches accidental extra params
        assert s.get("additionalProperties") is False, (
            f"{tool.name}: set additionalProperties=False so MCP clients "
            f"validate their inputs strictly"
        )


def test_tool_descriptions_look_substantive():
    """LLMs pick tools based on description text. Two-word descriptions
    are a smell. Force at least one full sentence."""
    for tool in srv.TOOLS:
        assert tool.description, f"{tool.name}: missing description"
        assert len(tool.description) >= 50, (
            f"{tool.name}: description is shorter than 50 chars; LLMs "
            f"will struggle to pick this tool correctly"
        )


# ── Dispatch behavior ────────────────────────────────────────────

def test_dispatch_list_accounts_calls_client():
    client = MagicMock()
    client.list_accounts.return_value = [{"id": 1, "name": "Checking"}]
    out = srv._dispatch("list_accounts", {}, client)
    client.list_accounts.assert_called_once_with()
    assert out == [{"id": 1, "name": "Checking"}]


def test_dispatch_query_transactions_strips_empty_params():
    client = MagicMock()
    srv._dispatch("query_transactions", {
        "account_id": 5,
        "category": "",            # empty string → drop
        "start_date": None,         # None → drop
        "end_date": "2026-01-01",
    }, client)
    # Should call with limit defaulted, no empty-string or None values
    call = client.list_transactions.call_args
    kwargs = call.kwargs
    assert kwargs.get("account_id") == 5
    assert kwargs.get("end_date") == "2026-01-01"
    assert "category" not in kwargs
    assert "start_date" not in kwargs
    assert kwargs.get("limit") == 100  # default applied


def test_dispatch_search_transactions_requires_q():
    client = MagicMock()
    with pytest.raises(KeyError):
        srv._dispatch("search_transactions", {}, client)


def test_dispatch_get_net_worth_history_flag():
    client = MagicMock()
    client.net_worth_latest.return_value = {"total": 100}
    client.net_worth_history.return_value = [{"date": "2026-01-01", "total": 100}]

    srv._dispatch("get_net_worth", {}, client)
    client.net_worth_latest.assert_called_once()
    client.net_worth_history.assert_not_called()

    client.reset_mock()
    srv._dispatch("get_net_worth", {"history": True}, client)
    client.net_worth_history.assert_called_once()
    client.net_worth_latest.assert_not_called()


def test_dispatch_unknown_tool_raises_clear_error():
    client = MagicMock()
    with pytest.raises(TuskLedgerError) as excinfo:
        srv._dispatch("frobnicate_the_widget", {}, client)
    assert "Unknown tool" in str(excinfo.value)
    assert "frobnicate_the_widget" in str(excinfo.value)


# ── Result formatter ─────────────────────────────────────────────

def test_format_result_renders_json():
    out = srv._format_result({"a": 1, "b": [2, 3]})
    assert '"a": 1' in out
    assert '"b": [' in out


def test_format_result_handles_non_serializable_via_str():
    """default=str makes us robust to dates / decimals / etc."""
    from datetime import date
    out = srv._format_result({"d": date(2026, 1, 1)})
    assert "2026-01-01" in out
