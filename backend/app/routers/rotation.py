"""Sector rotation watch — aggregate + local-AI synthesis + history."""
from __future__ import annotations

from fastapi import APIRouter, HTTPException

from app.services import research_store as store
from app.services import rotation as rot

router = APIRouter(prefix="/api/rotation", tags=["rotation"])


@router.get("/{domain}")
def rotation_overview(domain: str):
    """Current rotation temperature + the four components + recent history."""
    try:
        agg = rot.compute(domain)
    except store.ResearchNotFound as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    agg["history"] = store.read_rotation(domain)[-60:]
    return agg


@router.get("/{domain}/narrative")
def rotation_narrative(domain: str):
    """Local-AI (Ollama) read of the moving parts, or a computed fallback."""
    try:
        return rot.narrative(domain)
    except store.ResearchNotFound as exc:
        raise HTTPException(status_code=404, detail=str(exc))


@router.post("/{domain}/snapshot")
def rotation_snapshot(domain: str):
    """Append a rotation snapshot to the history (the daily heartbeat)."""
    try:
        return rot.snapshot(domain)
    except store.ResearchNotFound as exc:
        raise HTTPException(status_code=404, detail=str(exc))
