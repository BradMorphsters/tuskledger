"""Bonjour / mDNS advertisement.

Why: when LAN_SYNC_ENABLED is on, the mobile app needs to find the
laptop without the user typing IP addresses. macOS has Bonjour built
in; iOS resolves `_tuskledger._tcp.local.` for us. This module
publishes that record so the phone can browse for it.

Lifecycle: register on FastAPI startup, unregister on shutdown — see
the lifespan handler in main.py. Failures are non-fatal: if zeroconf
isn't installed or the network stack rejects the registration, log a
warning and keep going. The phone will still work via the QR-encoded
host or manual entry.

Concurrency: the actual Zeroconf instantiation + register_service
call runs on a DAEMON THREAD, not on the FastAPI event loop. Reason:
Zeroconf's constructor and register_service can block for seconds
(occasionally indefinitely on flaky macOS network configurations,
e.g. when a captive-portal interface is active or another mDNS
responder is mid-restart). If we ran them inline in the lifespan
handler we'd risk blocking ALL of FastAPI startup behind mDNS — the
HTTP server wouldn't accept requests until Zeroconf decided to
return. A daemon thread isolates that hazard: the worst case becomes
"mobile app can't auto-discover the host", not "the laptop is
unreachable from any client."
"""
from __future__ import annotations

import hashlib
import os
import socket
import threading
from typing import Optional

from app.config import settings


_zeroconf_state = {"zc": None, "info": None, "thread": None}  # populated by start()


SERVICE_TYPE = "_tuskledger._tcp.local."


def _resolve_host_ip() -> Optional[str]:
    """Match the LAN-IP detection in routers/mobile.py — keep in sync."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))
        return s.getsockname()[0]
    except OSError:
        return None
    finally:
        s.close()


def _service_name() -> str:
    """User-visible name shown in Bonjour browsers (e.g. 'Tusk Ledger on macbook-pro')."""
    hostname = socket.gethostname().split(".")[0]
    return f"{settings.APP_NAME} on {hostname}.{SERVICE_TYPE}"


def _register_in_background() -> None:
    """The actual Zeroconf work, run from a daemon thread by start()."""
    try:
        from zeroconf import IPVersion, ServiceInfo, Zeroconf
    except ImportError:
        # zeroconf isn't installed — print a one-liner rather than crash.
        # The mobile app falls back to QR-encoded host or manual entry.
        print(
            "[bonjour] python-zeroconf not installed — skipping mDNS "
            "advertisement. The phone can still pair via QR. "
            "`pip install zeroconf` to enable auto-discovery.",
            flush=True,
        )
        return

    ip = _resolve_host_ip()
    if not ip:
        print(
            "[bonjour] could not detect a LAN IP — skipping mDNS "
            "advertisement. The phone can still pair via QR.",
            flush=True,
        )
        return

    port = int(os.environ.get("TUSKLEDGER_PORT", "8000"))
    # host_id matches /api/mobile/manifest so the phone can verify it
    # discovered the same instance it paired with.
    host_id = hashlib.sha256(
        f"{settings.SESSION_SECRET}:tuskledger-host".encode()
    ).hexdigest()[:16]

    try:
        info = ServiceInfo(
            SERVICE_TYPE,
            _service_name(),
            addresses=[socket.inet_aton(ip)],
            port=port,
            properties={
                # TXT records — keys/values are bytes in zeroconf.
                "host_id": host_id,
                "app": settings.APP_NAME,
                "version": "1",
            },
            server=f"{socket.gethostname().split('.')[0]}.local.",
        )
        zc = Zeroconf(ip_version=IPVersion.V4Only)
        zc.register_service(info)
    except OSError as e:
        # Common cause: another process already registered the same
        # service (multiple uvicorn reloader workers, leftover shutdown).
        # Log and bail — the existing record is fine.
        print(f"[bonjour] register failed: {e!r}; continuing without mDNS.", flush=True)
        return
    except Exception as e:  # noqa: BLE001
        # Anything else weird from zeroconf — log and bail rather than
        # let an exception escape from the daemon thread.
        print(f"[bonjour] unexpected error: {e!r}; continuing without mDNS.", flush=True)
        return

    _zeroconf_state["zc"] = zc
    _zeroconf_state["info"] = info
    print(f"[bonjour] advertising {SERVICE_TYPE} at {ip}:{port}", flush=True)


def start() -> None:
    """Kick off the mDNS advertisement on a daemon thread. Returns
    immediately so FastAPI startup is never blocked by Zeroconf I/O.

    Idempotent — a second call while the first is still pending is a
    no-op. Detected via the thread reference, not the zc handle (the
    handle is set inside the thread once registration succeeds, which
    may not have happened by the time a second start() runs).
    """
    existing = _zeroconf_state.get("thread")
    if existing is not None and existing.is_alive():
        return
    if _zeroconf_state["zc"] is not None:
        return  # already registered from a prior call
    t = threading.Thread(
        target=_register_in_background,
        name="bonjour-register",
        daemon=True,
    )
    _zeroconf_state["thread"] = t
    t.start()


def stop() -> None:
    """Unregister and close. Idempotent."""
    zc = _zeroconf_state.get("zc")
    info = _zeroconf_state.get("info")
    if zc is None:
        return
    try:
        if info is not None:
            zc.unregister_service(info)
        zc.close()
    except Exception as e:  # noqa: BLE001
        print(f"[bonjour] shutdown error (ignored): {e!r}", flush=True)
    finally:
        _zeroconf_state["zc"] = None
        _zeroconf_state["info"] = None
