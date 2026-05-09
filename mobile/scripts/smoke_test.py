#!/usr/bin/env python3
"""End-to-end smoke test for the mobile sync API.

Pretends to be the phone:
  1. POST /api/mobile/pair/start to get a code (via your laptop session)
  2. POST /api/mobile/pair/claim to redeem it for a device token
  3. GET  /api/mobile/manifest to verify the token works
  4. GET  /api/mobile/sync to fetch a delta
  5. Cleanup: revoke the freshly-issued token so we don't litter

Failures print a clear diagnosis ("server down", "auth wrong", "schema
mismatch") rather than a Python stack trace. Exit code 0 = green, 1 =
red.

Usage:
    python3 mobile/scripts/smoke_test.py
    python3 mobile/scripts/smoke_test.py --base-url http://192.168.1.42:8000

By default, hits http://127.0.0.1:8000 — the smoke test is meant to
run on the laptop where the backend already has a session cookie
from your browser. If DEV_BYPASS_AUTH=true is set, no cookie is
needed; otherwise pass --session-cookie or log in via the browser
first and copy the fintrack_session cookie value.

Doesn't require any deps beyond the Python stdlib — runs against
the system Python without virtualenv setup.
"""
from __future__ import annotations

import argparse
import http.client
import json
import os
import sys
import time
from typing import Any
from urllib.parse import urlparse


# ANSI colors — disabled when stdout isn't a TTY (CI logs).
_TTY = sys.stdout.isatty()
def _c(code: str, s: str) -> str:
    return f"\033[{code}m{s}\033[0m" if _TTY else s
GREEN = lambda s: _c("32", s)
RED = lambda s: _c("31", s)
DIM = lambda s: _c("2", s)
BOLD = lambda s: _c("1", s)


class TestFailure(Exception):
    """Raised on any check failure. Caught at top level to print
    a clean diagnosis without a stack trace."""


def _request(
    base_url: str,
    method: str,
    path: str,
    body: Any | None = None,
    headers: dict[str, str] | None = None,
    timeout: float = 6.0,
) -> tuple[int, dict[str, str], dict | None]:
    parsed = urlparse(base_url)
    scheme = parsed.scheme or "http"
    host = parsed.hostname or "127.0.0.1"
    port = parsed.port or (443 if scheme == "https" else 80)

    conn_cls = http.client.HTTPSConnection if scheme == "https" else http.client.HTTPConnection
    conn = conn_cls(host, port, timeout=timeout)
    body_bytes = None
    headers = dict(headers or {})
    if body is not None:
        body_bytes = json.dumps(body).encode()
        headers.setdefault("Content-Type", "application/json")
    try:
        conn.request(method, path, body=body_bytes, headers=headers)
        resp = conn.getresponse()
        raw = resp.read()
    except (ConnectionRefusedError, OSError) as e:
        raise TestFailure(
            f"Could not reach {base_url} — is the backend running with "
            f"`uvicorn app.main:app --host 0.0.0.0 --port 8000`?\n  ({e})"
        )
    finally:
        conn.close()

    parsed_body: dict | None = None
    if raw:
        try:
            parsed_body = json.loads(raw)
        except json.JSONDecodeError:
            parsed_body = {"_raw": raw.decode("utf-8", errors="replace")[:200]}

    return resp.status, dict(resp.getheaders()), parsed_body


def _step(label: str) -> None:
    print(f"  {DIM('→')} {label} ... ", end="", flush=True)


def _ok(detail: str = "") -> None:
    print(GREEN("OK"), DIM(detail) if detail else "")


def _fail(msg: str) -> None:
    print(RED("FAIL"))
    raise TestFailure(msg)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", default="http://127.0.0.1:8000")
    parser.add_argument(
        "--session-cookie",
        default=None,
        help="Value of fintrack_session cookie (only needed if DEV_BYPASS_AUTH is off)",
    )
    parser.add_argument(
        "--keep-token",
        action="store_true",
        help="Don't revoke the test token after success — useful when debugging from another tool.",
    )
    args = parser.parse_args()

    base = args.base_url.rstrip("/")
    auth_headers: dict[str, str] = {}
    if args.session_cookie:
        auth_headers["Cookie"] = f"fintrack_session={args.session_cookie}"

    print(BOLD(f"Tusk Ledger mobile sync smoke test — {base}"))

    # 0. Health check first so a "wrong port" failure is loud.
    _step("GET /api/health")
    status, _, body = _request(base, "GET", "/api/health")
    if status != 200 or not body or body.get("status") != "ok":
        _fail(f"Health check failed: status={status}, body={body}")
    _ok(f"app={body.get('app')!r}")

    # 1. Pair start — this needs auth on a normal install. With
    # DEV_BYPASS_AUTH=true is set, it's a no-op.
    _step("POST /api/mobile/pair/start")
    status, _, body = _request(
        base, "POST", "/api/mobile/pair/start",
        body={}, headers=auth_headers,
    )
    if status == 401:
        _fail(
            "Pair-start returned 401 — backend is requiring auth. "
            "Either set DEV_BYPASS_AUTH=true in backend/.env, or pass "
            "--session-cookie with your fintrack_session value."
        )
    if status != 200 or not body or "code" not in body:
        _fail(f"Pair-start failed: status={status}, body={body}")
    code = body["code"]
    pair_host = body.get("host")
    pair_port = body.get("port")
    qr = body.get("qr_payload", "")
    if not qr.startswith("tuskledger://pair?"):
        _fail(f"qr_payload doesn't look right: {qr!r}")
    if not body.get("qr_data_url", "").startswith("data:image/png;base64,"):
        _fail("qr_data_url missing or wrong format")
    _ok(f"code={code} host={pair_host}:{pair_port}")

    # 2. Pair claim — anonymous, the code IS the auth.
    _step("POST /api/mobile/pair/claim")
    status, _, body = _request(
        base, "POST", "/api/mobile/pair/claim",
        body={"code": code, "label": "smoke-test"},
    )
    if status != 200 or not body or "token" not in body:
        _fail(f"Pair-claim failed: status={status}, body={body}")
    token = body["token"]
    if len(token) < 30:
        _fail(f"Token suspiciously short: {len(token)} chars")
    _ok(f"token={token[:8]}…")

    token_headers = {"X-Device-Token": token}
    device_id: int | None = None

    try:
        # 3. Manifest with the token.
        _step("GET /api/mobile/manifest")
        status, _, body = _request(
            base, "GET", "/api/mobile/manifest",
            headers=token_headers,
        )
        if status != 200 or not body:
            _fail(f"Manifest failed: status={status}, body={body}")
        for key in ("host_id", "hostname", "app_name", "server_time", "schema_version"):
            if key not in body:
                _fail(f"Manifest missing field {key!r}: {body}")
        _ok(f"hostname={body['hostname']!r} schema_version={body['schema_version']}")

        # 4. Wrong token must 401, so we know the auth gate is real.
        _step("GET /api/mobile/manifest with bogus token (must 401)")
        status, _, body = _request(
            base, "GET", "/api/mobile/manifest",
            headers={"X-Device-Token": "obviously-not-a-real-token"},
        )
        if status != 401:
            _fail(f"Bogus token wasn't rejected: status={status}")
        _ok("rejected")

        # 5. Full sync.
        _step("GET /api/mobile/sync (full)")
        t0 = time.monotonic()
        status, _, body = _request(
            base, "GET", "/api/mobile/sync",
            headers=token_headers,
            timeout=15.0,  # full sync may be large
        )
        dt = (time.monotonic() - t0) * 1000
        if status != 200 or not body:
            _fail(f"Sync failed: status={status}, body={body}")
        for key in ("server_time", "full", "accounts", "transactions", "has_more"):
            if key not in body:
                _fail(f"Sync response missing {key!r}: keys={list(body)}")
        if not body["full"]:
            _fail("First sync should be full (no since cursor was sent)")
        accounts = body["accounts"]
        txns = body["transactions"]
        cursor = body["server_time"]
        _ok(
            f"{len(accounts)} accounts, {len(txns)} txns, "
            f"has_more={body['has_more']}, took {dt:.0f}ms"
        )
        if accounts:
            sample = accounts[0]
            for k in ("id", "name", "type"):
                if k not in sample:
                    _fail(f"Account row missing {k!r}: {sample}")
        if txns:
            sample = txns[0]
            for k in ("id", "account_id", "amount", "date"):
                if k not in sample:
                    _fail(f"Transaction row missing {k!r}: {sample}")

        # 6. Incremental sync — pass the cursor we just got. Should be
        # full=false and (probably) zero new rows since nothing changed.
        _step("GET /api/mobile/sync?since=<cursor> (incremental)")
        status, _, body = _request(
            base, "GET", f"/api/mobile/sync?since={cursor}",
            headers=token_headers,
        )
        if status != 200 or not body:
            _fail(f"Incremental sync failed: status={status}, body={body}")
        if body["full"]:
            _fail("Incremental sync should not be full")
        _ok(
            f"delta accounts={len(body['accounts'])}, "
            f"delta txns={len(body['transactions'])}"
        )

        # 7. Confirm device shows up in /devices.
        _step("GET /api/mobile/devices")
        status, _, dev_body = _request(
            base, "GET", "/api/mobile/devices",
            headers=auth_headers,
        )
        if status != 200 or not isinstance(dev_body, list):
            _fail(f"Device list failed: status={status}, body={dev_body}")
        match = next((d for d in dev_body if d.get("label") == "smoke-test"), None)
        if not match:
            _fail("Smoke-test device not found in /devices output")
        device_id = match["id"]
        _ok(f"id={device_id}, paired devices={len(dev_body)}")

    finally:
        if device_id and not args.keep_token:
            _step(f"POST /api/mobile/devices/{device_id}/revoke (cleanup)")
            status, _, _ = _request(
                base, "POST", f"/api/mobile/devices/{device_id}/revoke",
                body={}, headers=auth_headers,
            )
            if status == 200:
                _ok()
            else:
                # Don't fail the whole run on cleanup — it's a hygiene
                # step, not a correctness one. Just warn.
                print(RED(f"WARN ({status})"), "could not revoke; do it manually from the laptop UI.")

    print(GREEN("\n✓ all checks passed"))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except TestFailure as e:
        print()
        print(RED("✗ smoke test failed"))
        print(f"  {e}")
        sys.exit(1)
    except KeyboardInterrupt:
        sys.exit(130)
