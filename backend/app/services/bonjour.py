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

Address changes: the A record we publish is a snapshot of the LAN IP
at registration time, and Zeroconf binds its sockets to the interface
addresses it enumerated then. When the laptop's DHCP lease moves it to
a new address (sleep/wake, switching networks, router reboot) the old
record keeps pointing at an address nobody answers on, and zeroconf's
socket for the dead address logs, on repeat:

    [zeroconf] Error with socket N (('10.0.0.5', 5353)):
    [Errno 49] Can't assign requested address

python-zeroconf (0.132.x) has no public API to rebind interfaces, so
the same daemon thread stays alive and polls the LAN IP. On a change
it tears the registration down and republishes on the new address.
The poll is a UDP-connect against a well-known address, which sends no
packets and costs nothing measurable, so a short interval is fine.

The same loop retries an initial registration that found no LAN IP —
the backend often starts before Wi-Fi has associated, and the old
behaviour (give up permanently, print one line) meant auto-discovery
stayed dead until the next manual restart.
"""
from __future__ import annotations

import hashlib
import os
import socket
import threading
from typing import Optional

from app.config import settings


_zeroconf_state = {"zc": None, "info": None, "thread": None, "ip": None}


# Signals the watcher thread to exit. Set by stop(), cleared by start().
_stop_event = threading.Event()


SERVICE_TYPE = "_tuskledger._tcp.local."

# How often the watcher re-checks the LAN IP. Short enough that a phone
# reconnecting after a router reboot finds the host quickly; long enough
# to be invisible.
IP_POLL_SECONDS = 20


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


def _host_id() -> str:
    """Matches /api/mobile/manifest so the phone can verify it discovered
    the same instance it paired with. Derived from the session secret, so
    the secret itself never travels in a TXT record."""
    return hashlib.sha256(
        f"{settings.SESSION_SECRET}:tuskledger-host".encode()
    ).hexdigest()[:16]


def _register(ip: str) -> bool:
    """Publish the service at `ip`. Returns True on success.

    Records the live handles in _zeroconf_state so _unregister() and the
    watcher can find them. Never raises: a failure here means "no
    auto-discovery", which the phone recovers from via QR pairing.
    """
    from zeroconf import IPVersion, ServiceInfo, Zeroconf

    port = int(os.environ.get("TUSKLEDGER_PORT", "8000"))
    try:
        info = ServiceInfo(
            SERVICE_TYPE,
            _service_name(),
            addresses=[socket.inet_aton(ip)],
            port=port,
            properties={
                # TXT records — keys/values are bytes in zeroconf.
                "host_id": _host_id(),
                "app": settings.APP_NAME,
                "version": "1",
            },
            server=f"{socket.gethostname().split('.')[0]}.local.",
        )
        zc = Zeroconf(ip_version=IPVersion.V4Only)
        zc.register_service(info)
    except OSError as e:
        # Common causes: another process already registered the same
        # service (multiple uvicorn reloader workers, leftover shutdown),
        # or the address vanished between the poll and the bind.
        print(f"[bonjour] register failed: {e!r}; continuing without mDNS.", flush=True)
        return False
    except Exception as e:  # noqa: BLE001
        # Anything else weird from zeroconf — log and bail rather than
        # let an exception escape from the daemon thread.
        print(f"[bonjour] unexpected error: {e!r}; continuing without mDNS.", flush=True)
        return False

    _zeroconf_state["zc"] = zc
    _zeroconf_state["info"] = info
    _zeroconf_state["ip"] = ip
    print(f"[bonjour] advertising {SERVICE_TYPE} at {ip}:{port}", flush=True)
    return True


def _unregister() -> None:
    """Tear down the current registration. Idempotent, never raises."""
    zc = _zeroconf_state.get("zc")
    info = _zeroconf_state.get("info")
    if zc is None:
        return
    try:
        if info is not None:
            zc.unregister_service(info)
        zc.close()
    except Exception as e:  # noqa: BLE001
        print(f"[bonjour] teardown error (ignored): {e!r}", flush=True)
    finally:
        _zeroconf_state["zc"] = None
        _zeroconf_state["info"] = None
        _zeroconf_state["ip"] = None


def _run() -> None:
    """Daemon-thread body: register, then republish whenever the LAN IP moves.

    Loops until stop() sets _stop_event, so a laptop that changes networks
    three times in a day ends up advertising the right address each time
    instead of leaking dead-socket errors from the first one.
    """
    try:
        from zeroconf import Zeroconf  # noqa: F401  (import probe only)
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

    warned_no_ip = False
    while not _stop_event.is_set():
        ip = _resolve_host_ip()
        current = _zeroconf_state.get("ip")

        if ip is None:
            # No LAN at all. Keep any existing registration in place — a
            # brief Wi-Fi blip shouldn't drop the record — and just wait.
            # Warn once, not every poll.
            if current is None and not warned_no_ip:
                print(
                    "[bonjour] no LAN IP yet — will keep checking. The phone "
                    "can still pair via QR in the meantime.",
                    flush=True,
                )
                warned_no_ip = True
        elif current is None:
            warned_no_ip = False
            _register(ip)
        elif ip != current:
            warned_no_ip = False
            print(
                f"[bonjour] LAN IP changed {current} -> {ip}; republishing.",
                flush=True,
            )
            _unregister()
            _register(ip)

        _stop_event.wait(IP_POLL_SECONDS)

    _unregister()


def start() -> None:
    """Kick off the mDNS advertisement on a daemon thread. Returns
    immediately so FastAPI startup is never blocked by Zeroconf I/O.

    Idempotent — a second call while the first thread is alive is a
    no-op. Detected via the thread reference, not the zc handle (the
    handle is set inside the thread once registration succeeds, which
    may not have happened by the time a second start() runs).
    """
    existing = _zeroconf_state.get("thread")
    if existing is not None and existing.is_alive():
        return
    _stop_event.clear()
    t = threading.Thread(target=_run, name="bonjour-register", daemon=True)
    _zeroconf_state["thread"] = t
    t.start()


def stop() -> None:
    """Signal the watcher to exit and unregister. Idempotent.

    Also unregisters directly rather than relying solely on the watcher
    waking up: shutdown shouldn't wait a poll interval, and the thread
    may already be gone.
    """
    _stop_event.set()
    _unregister()
    _zeroconf_state["thread"] = None
