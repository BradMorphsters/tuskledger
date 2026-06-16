"""Make the Tusk Ledger backend its OWN agent on the Robinhood agentic MCP.

This is the "Auth with Tusk" piece: instead of Claude being the bound agent, the backend
connects to ``https://agent.robinhood.com/mcp/trading`` as a first-class MCP client (streamable
HTTP + OAuth). The user clicks **Connect** in the app → the backend opens Robinhood's consent in
the browser (password-free) → the OAuth token is stored **encrypted** (reusing the app's Fernet
key) → from then on the backend reads the sleeve and (only once the user arms it) places orders
the user approved. Claude is never in this path.

Layering, so the testable parts don't need the `mcp` package installed:
* :class:`EncryptedJsonStore` + :func:`connection_status` + :func:`parse_tool_result` —
  pure-ish, unit-tested, no `mcp` import.
* :func:`make_mcp_client` / :func:`connect_once` — the live SDK flow, imported lazily; validated
  on the user's machine (the OAuth consent can't run headless from a test).
* :func:`make_broker` — wraps the call transport in the existing ``RobinhoodMCPBroker`` (which
  stays DISARMED/READ_ONLY until the user arms MODE_LIVE).
"""
from __future__ import annotations

import json
import logging
import os
import stat
import threading
from pathlib import Path
from typing import Optional

from app.services import crypto

# Each read/write opens a short-lived streamable-HTTP MCP session and closes it; on close the SDK
# sends a session-termination request that Robinhood answers 400 (it doesn't support explicit
# teardown). The tool call already succeeded — this is harmless cleanup noise — so drop just that
# one warning to keep the server log readable. Other warnings from the logger pass through.
class _DropSessionTerminationWarning(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:  # noqa: A003
        return "Session termination failed" not in record.getMessage()


logging.getLogger("mcp.client.streamable_http").addFilter(_DropSessionTerminationWarning())

TRADING_MCP_URL = "https://agent.robinhood.com/mcp/trading"
CALLBACK_PORT = 3030
CLIENT_NAME = "Tusk Ledger"


def store_path(configured: str = "") -> Path:
    if configured:
        return Path(configured).expanduser()
    return Path("var/agent_trading/rh_agent.json.enc")


# --------------------------------------------------------------------------- encrypted store

class EncryptedJsonStore:
    """A small encrypted JSON blob on disk (Fernet via the app key). Holds the OAuth tokens +
    client registration + the resolved agentic account number. No `mcp` types here so it tests
    without the SDK."""

    def __init__(self, path: str | Path):
        self.path = Path(path)

    def read(self) -> dict:
        if not self.path.exists():
            return {}
        try:
            return json.loads(crypto.decrypt_token(self.path.read_text()) or "{}")
        except Exception:
            return {}

    def write(self, data: dict) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text(crypto.encrypt_token(json.dumps(data)))
        try:
            self.path.chmod(stat.S_IRUSR | stat.S_IWUSR)  # 0600
        except (OSError, NotImplementedError):
            pass

    def update(self, **kv) -> dict:
        d = self.read()
        d.update(kv)
        self.write(d)
        return d

    def clear(self) -> None:
        try:
            self.path.unlink()
        except FileNotFoundError:
            pass


def _mask(acct: Optional[str]) -> Optional[str]:
    if not acct:
        return None
    s = str(acct)
    return "••••" + s[-4:] if len(s) >= 4 else s


def connection_status(store: EncryptedJsonStore, *, armed: bool = False) -> dict:
    """What the Accounts card shows. No network call — just what's stored."""
    d = store.read()
    connected = bool(d.get("tokens"))
    return {
        "connected": connected,
        "account": _mask(d.get("account_number")),
        "mode": ("live" if armed else "read_only") if connected else "disconnected",
        "connected_at": d.get("connected_at"),
        "mcp_url": TRADING_MCP_URL,
    }


# --------------------------------------------------------------------------- result parsing

def parse_tool_result(result) -> dict:
    """Normalize an MCP ``call_tool`` result into the plain dict the broker parses. Robinhood
    returns its JSON either as ``structuredContent`` or as a JSON string in a text content
    block. Tolerant of an already-plain dict (test fakes)."""
    if isinstance(result, dict):
        return result
    sc = getattr(result, "structuredContent", None)
    if isinstance(sc, dict) and sc:
        return sc
    texts: list[str] = []
    for block in (getattr(result, "content", None) or []):
        text = getattr(block, "text", None)
        if text:
            try:
                return json.loads(text)
            except (json.JSONDecodeError, TypeError):
                texts.append(str(text))
    # Non-JSON content or an error result — preserve the message instead of swallowing it to {},
    # so a rejected order surfaces its reason (e.g. "market closed", "not fractionable").
    joined = " ".join(texts).strip()
    if getattr(result, "isError", False) or joined:
        return {"_error": joined or "tool returned an error with no detail"}
    return {}


# --------------------------------------------------------------------------- live SDK flow (lazy)

def _sdk_token_storage(store: EncryptedJsonStore):
    """Adapt the encrypted dict store to the SDK's async TokenStorage. Imported lazily."""
    from mcp.client.auth import TokenStorage
    from mcp.shared.auth import OAuthClientInformationFull, OAuthToken

    class _Storage(TokenStorage):
        async def get_tokens(self):
            t = store.read().get("tokens")
            return OAuthToken.model_validate(t) if t else None

        async def set_tokens(self, tokens) -> None:
            store.update(tokens=tokens.model_dump(mode="json"))

        async def get_client_info(self):
            c = store.read().get("client_info")
            return OAuthClientInformationFull.model_validate(c) if c else None

        async def set_client_info(self, client_info) -> None:
            store.update(client_info=client_info.model_dump(mode="json"))

    return _Storage()


def _oauth_provider(store: EncryptedJsonStore, *, redirect_handler, callback_handler):
    from mcp.client.auth import OAuthClientProvider
    from mcp.shared.auth import OAuthClientMetadata

    metadata = OAuthClientMetadata.model_validate({
        "client_name": CLIENT_NAME,
        "redirect_uris": [f"http://localhost:{CALLBACK_PORT}/callback"],
        "grant_types": ["authorization_code", "refresh_token"],
        "response_types": ["code"],
    })
    return OAuthClientProvider(
        server_url=TRADING_MCP_URL.replace("/mcp/trading", ""),
        client_metadata=metadata,
        storage=_sdk_token_storage(store),
        redirect_handler=redirect_handler,
        callback_handler=callback_handler,
    )


def make_mcp_client(store: EncryptedJsonStore):
    """A sync ``(tool, args) -> dict`` callable backed by the stored OAuth token (no re-consent).
    Opens a short-lived streamable-HTTP session per call. Lazy SDK import."""
    import asyncio

    async def _redirect(_url):  # already authorized — no interaction expected here
        raise RuntimeError("not connected — run Connect first")

    async def _callback():
        raise RuntimeError("not connected — run Connect first")

    def call(tool: str, args: dict) -> dict:
        from mcp.client.session import ClientSession
        from mcp.client.streamable_http import streamablehttp_client

        async def _run():
            auth = _oauth_provider(store, redirect_handler=_redirect, callback_handler=_callback)
            async with streamablehttp_client(url=TRADING_MCP_URL, auth=auth) as (r, w, _sid):
                async with ClientSession(r, w) as session:
                    await session.initialize()
                    return await session.call_tool(tool, args or {})

        return parse_tool_result(asyncio.run(_run()))

    return call


def connect_once(store: EncryptedJsonStore, *, timeout: int = 300) -> dict:
    """Run the one-time OAuth consent (opens the browser), then resolve + persist the agentic
    account number. Returns the new status. Lazy SDK import; this is the live step the user
    drives — it can't run headless. Mirrors the official simple-auth-client localhost callback."""
    import asyncio
    import time
    import webbrowser
    from http.server import BaseHTTPRequestHandler, HTTPServer
    from urllib.parse import parse_qs, urlparse

    from mcp.client.session import ClientSession
    from mcp.client.streamable_http import streamablehttp_client

    captured: dict = {"code": None, "state": None, "error": None}

    class _Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            q = parse_qs(urlparse(self.path).query)
            if "code" in q:
                captured["code"], captured["state"] = q["code"][0], q.get("state", [None])[0]
                body = b"<h1>Tusk Ledger connected.</h1><p>You can close this tab.</p>"
            else:
                captured["error"] = q.get("error", ["unknown"])[0]
                body = b"<h1>Authorization failed.</h1>"
            self.send_response(200)
            self.send_header("Content-type", "text/html")
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *a):  # quiet
            pass

    httpd = HTTPServer(("localhost", CALLBACK_PORT), _Handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()

    async def _redirect(url):
        webbrowser.open(url)

    async def _callback():
        start = time.time()
        while time.time() - start < timeout:
            if captured["code"]:
                return captured["code"], captured["state"]
            if captured["error"]:
                raise RuntimeError(f"OAuth error: {captured['error']}")
            await asyncio.sleep(0.1)
        raise TimeoutError("timed out waiting for Robinhood authorization")

    async def _run():
        auth = _oauth_provider(store, redirect_handler=_redirect, callback_handler=_callback)
        async with streamablehttp_client(url=TRADING_MCP_URL, auth=auth) as (r, w, _sid):
            async with ClientSession(r, w) as session:
                await session.initialize()
                return parse_tool_result(await session.call_tool("get_accounts", {}))

    try:
        accounts = _run_async(_run)
    finally:
        httpd.shutdown()

    # resolve the single agentic-allowed account from the accounts list
    rows = (accounts.get("data") or accounts).get("accounts") if isinstance(accounts, dict) else None
    agentic = next((str(a.get("account_number")) for a in (rows or []) if a.get("agentic_allowed")), None)
    import datetime as _dt
    store.update(account_number=agentic, connected_at=_dt.datetime.now(_dt.timezone.utc).isoformat())
    return connection_status(store)


def _run_async(coro_fn):
    import asyncio
    return asyncio.run(coro_fn())


def make_broker(store: EncryptedJsonStore, *, mode: str, account_number: str = ""):
    """Wrap the stored-token call transport in the existing RobinhoodMCPBroker at ``mode``.
    Arming MODE_LIVE is a deliberate human step (an env flag), never the app's own decision."""
    from .brokers import RobinhoodMCPBroker
    acct = account_number or store.read().get("account_number") or ""
    return RobinhoodMCPBroker(account_number=acct, mcp_client=make_mcp_client(store), mode=mode)
