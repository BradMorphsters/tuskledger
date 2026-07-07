"""Tests for the backend Robinhood-agent connection — the parts that don't need the `mcp` SDK
or a live OAuth handshake: the encrypted token store, status, MCP result parsing, and broker
wiring (with a fake transport). The live consent flow (connect_once) is validated on the user's
machine and is intentionally not unit-tested here."""
from __future__ import annotations

from app.agent_trading.robinhood_agent import (
    EncryptedJsonStore,
    connection_status,
    describe_exception,
    make_broker,
    parse_tool_result,
)


def test_store_encrypts_roundtrip_and_clear(tmp_path, monkeypatch):
    # use an inline Fernet key so the test doesn't touch a real key file
    from cryptography.fernet import Fernet
    monkeypatch.setenv("FINTRACK_ENCRYPTION_KEY", Fernet.generate_key().decode())
    import app.services.crypto as crypto
    crypto._cipher = None  # reset cached cipher to pick up the env key

    store = EncryptedJsonStore(tmp_path / "rh.json.enc")
    assert store.read() == {}
    store.update(tokens={"access_token": "secret"}, account_number="990000001")
    # on-disk bytes must NOT contain the plaintext secret
    raw = (tmp_path / "rh.json.enc").read_text()
    assert "secret" not in raw and raw.startswith("enc:")
    assert store.read()["tokens"]["access_token"] == "secret"
    store.clear()
    assert store.read() == {}


def test_connection_status_masks_account(tmp_path, monkeypatch):
    from cryptography.fernet import Fernet
    monkeypatch.setenv("FINTRACK_ENCRYPTION_KEY", Fernet.generate_key().decode())
    import app.services.crypto as crypto
    crypto._cipher = None

    store = EncryptedJsonStore(tmp_path / "rh.json.enc")
    assert connection_status(store) == {
        "connected": False, "account": None, "mode": "disconnected",
        "connected_at": None, "mcp_url": "https://agent.robinhood.com/mcp/trading",
    }
    store.update(tokens={"access_token": "x"}, account_number="990000001", connected_at="2026-06-16T00:00:00Z")
    s = connection_status(store, armed=False)
    assert s["connected"] and s["account"] == "••••0001" and s["mode"] == "read_only"
    assert connection_status(store, armed=True)["mode"] == "live"


def test_parse_tool_result_variants():
    assert parse_tool_result({"data": {"x": 1}}) == {"data": {"x": 1}}      # already a dict

    class _Block:
        type = "text"
        text = '{"data": {"accounts": []}}'

    class _Res:
        structuredContent = None
        content = [_Block()]
    assert parse_tool_result(_Res()) == {"data": {"accounts": []}}            # JSON in a text block

    class _Struct:
        structuredContent = {"data": {"ok": True}}
        content = []
    assert parse_tool_result(_Struct()) == {"data": {"ok": True}}            # structuredContent wins


def _exception_group():
    """A real ExceptionGroup wrapping a single cause — the shape anyio raises out of the
    streamable-HTTP task group. Uses the 3.11+ builtin or the 3.10 backport."""
    try:
        EG = ExceptionGroup  # noqa: F821 — builtin on 3.11+
    except NameError:  # pragma: no cover - depends on interpreter version
        from exceptiongroup import ExceptionGroup as EG

    class HTTPStatusError(Exception):
        pass

    inner = HTTPStatusError("Client error '401 Unauthorized' for url 'https://agent.robinhood.com/mcp/trading'")
    return EG("unhandled errors in a TaskGroup", [inner]), inner


def test_describe_exception_unwraps_taskgroup_and_hints_reconnect():
    grp, inner = _exception_group()
    # the opaque group message must NOT leak through
    assert str(grp) == "unhandled errors in a TaskGroup (1 sub-exception)"
    out = describe_exception(grp)
    assert "TaskGroup" not in out
    assert "401 Unauthorized" in out and "HTTPStatusError" in out
    # a 401 gets the reconnect hint
    assert "Disconnect then Connect" in out


def test_describe_exception_dedupes_nested_and_passes_plain_through():
    try:
        EG = ExceptionGroup  # noqa: F821
    except NameError:  # pragma: no cover
        from exceptiongroup import ExceptionGroup as EG
    err = ConnectionError("nodename nor servname provided")
    nested = EG("outer", [EG("inner", [err, err])])
    out = describe_exception(nested)
    assert out == "ConnectionError: nodename nor servname provided"  # de-duped, no hint
    # a plain (non-group) exception is described directly
    assert describe_exception(ValueError("boom")) == "ValueError: boom"


def test_make_broker_uses_stored_account_and_is_read_only(tmp_path, monkeypatch):
    from cryptography.fernet import Fernet
    monkeypatch.setenv("FINTRACK_ENCRYPTION_KEY", Fernet.generate_key().decode())
    import app.services.crypto as crypto
    crypto._cipher = None
    from app.agent_trading.brokers import MODE_READ_ONLY, BrokerError
    from app.agent_trading.guardrails import ProposedOrder

    store = EncryptedJsonStore(tmp_path / "rh.json.enc")
    store.update(tokens={"access_token": "x"}, account_number="990000001")

    # inject a fake transport so we don't need the mcp SDK or network
    monkeypatch.setattr("app.agent_trading.robinhood_agent.make_mcp_client",
                        lambda s: (lambda tool, args: {"data": {"accounts": [
                            {"account_number": "990000001", "agentic_allowed": True}]}}))
    broker = make_broker(store, mode=MODE_READ_ONLY)
    assert broker.account_number == "990000001"
    assert broker.ping()["agentic_account_found"] is True
    # read-only broker must refuse to place
    import pytest
    with pytest.raises(BrokerError):
        broker.place_order(ProposedOrder("NB", "buy", 5.0, notional=100.0))
