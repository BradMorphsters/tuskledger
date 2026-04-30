"""Shared FastAPI dependencies."""
from __future__ import annotations

from fastapi import HTTPException, Request, status

from app.config import settings
from app.database import _is_demo_request


def require_auth(request: Request) -> int:
    """Require an authenticated session with MFA verified.

    Returns the authenticated user's ID. Raises 401 otherwise. Use as a
    FastAPI dependency on routers that must be gated behind login+MFA.

    Three short-circuits ahead of the real check:
      1. DEV_BYPASS_AUTH=true — global escape hatch for local iteration.
      2. The request is in demo mode (cookie says so) — synthetic data has
         no privacy concern, no auth needed.
      3. Otherwise, normal session+MFA gating applies.
    """
    if settings.DEV_BYPASS_AUTH:
        return 0
    if _is_demo_request(request):
        return 0
    user_id = request.session.get("user_id")
    mfa_ok = request.session.get("mfa_verified")
    if not user_id or not mfa_ok:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Authentication required.",
        )
    return user_id
