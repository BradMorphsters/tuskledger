"""View-mode toggle — read-only vs edit, per device.

The `tuskledger_view` cookie is read by the read-only middleware in
main.py to decide whether to 403 mutating requests. This router is the
two endpoints that set/unset that cookie.

Why this lives in its own router (instead of, say, demo.py): demo and
view are independent axes. A user's PHONE might be in read-only mode
WHILE pointed at the demo database, or in read-only mode pointed at
real data. They compose freely. Bundling them would make the matrix of
combinations confusing.

Auth: this router is intentionally UNPROTECTED. The mode toggle has
to be reachable from any device without an auth round-trip — otherwise
a phone that just got cookied as read-only would have no way to flip
back if its session expired. Setting the cookie doesn't grant access
to any data on its own; it only changes how the server treats *future*
requests from this device.
"""
from __future__ import annotations

from fastapi import APIRouter, Request, Response


router = APIRouter(prefix="/api/view", tags=["view"])


# Long cookie life — view mode is a device preference, not a security
# control. 90 days means a user who set their phone to read-only six
# weeks ago doesn't randomly lose the setting because they were on
# vacation.
_COOKIE_MAX_AGE = 60 * 60 * 24 * 90


def _set_view_cookie(response: Response, mode: str) -> None:
    """Single source of truth for cookie attributes — share between the
    POST /api/view/{mode} endpoints so they can't drift apart."""
    response.set_cookie(
        key="tuskledger_view",
        value=mode,
        max_age=_COOKIE_MAX_AGE,
        httponly=False,    # frontend reads it to render the read-only banner
        samesite="lax",
        secure=False,      # local-only; tunnels handle TLS termination upstream
    )


@router.post("/readonly")
def set_readonly(response: Response):
    """Flip the calling device into read-only mode. Idempotent — safe
    to hit repeatedly; the cookie just gets re-set with a fresh expiry."""
    _set_view_cookie(response, "readonly")
    return {"status": "ok", "view": "readonly"}


@router.post("/edit")
def set_edit(response: Response):
    """Flip the calling device back into edit mode. Same as deleting
    the cookie — the middleware only blocks when the cookie is exactly
    'readonly'."""
    _set_view_cookie(response, "edit")
    return {"status": "ok", "view": "edit"}


@router.get("/")
def get_view(request: Request):
    """Reports the current device's view mode. The frontend hits this
    on mount to know whether to render the read-only banner and hide
    edit affordances. Falls back to 'edit' (the safer default — a
    forgotten cookie shouldn't silently hide write UI on a laptop)."""
    mode = request.cookies.get("tuskledger_view", "edit")
    if mode not in ("readonly", "edit"):
        mode = "edit"  # corrupt cookie value → assume edit
    return {"view": mode}
