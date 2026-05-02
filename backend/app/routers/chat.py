"""
In-app "Ask" panel — curated, pre-built questions answered by a local
LLM with pre-computed numbers.

Two endpoints:

    GET  /api/chat/prompts       → catalog the UI renders as chips
    POST /api/chat/answer        → run a chosen prompt + horizon

This is a curated companion to the Ollama AI Insights card on the
Dashboard. The Insights card writes one paragraph per day from a fixed
spending bundle; this panel lets the user ask one of N specific
questions on demand and pick a time horizon.

Design contract: the model NEVER chooses the data. Every dollar figure
in the response was computed by a Python handler in
`services/chat_prompts.py`. The model only writes prose around the
JSON it was handed. This is what keeps an 8B local model from being a
liability in a finance app.

Three response shapes the frontend handles:
  200 {answer, source: "ollama"|"demo", model, generated_at, bundle}
  200 {answer: null, source: "disabled", ...}      — LLM_ENABLED=false
  503                                               — Ollama unreachable

Demo mode (fintrack_mode=demo cookie) returns a canned per-prompt/
per-horizon string from chat_prompts.DEMO_ANSWERS so the panel works
on a machine without Ollama installed (matching the AI Insights card).
"""
from __future__ import annotations

from datetime import datetime
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.config import settings
from app.database import get_db
from app.services.chat_prompts import (
    CHAT_SYSTEM_PROMPT,
    build_bundle,
    build_user_prompt,
    demo_answer,
    get_catalog,
    known_horizon_ids,
    known_prompt_ids,
)
from app.services.llm_ollama import LLMUnavailable, OllamaClient


router = APIRouter(prefix="/api/chat", tags=["chat"])


# ─── Request / response shapes ─────────────────────────────────────────

class AnswerRequest(BaseModel):
    """Input for POST /api/chat/answer.

    `extra="forbid"` matches the security pattern we use elsewhere —
    if a future client sends a typo'd field we'd rather fail loudly
    than silently ignore it. Both fields validated below in the
    handler against the registry.
    """
    prompt_id: str = Field(..., min_length=1, max_length=64)
    horizon: str = Field(..., min_length=1, max_length=16)

    model_config = {"extra": "forbid"}


# ─── GET /prompts ──────────────────────────────────────────────────────

@router.get("/prompts")
def list_prompts():
    """Catalog the Ask panel renders as chips.

    Static enough that it could be a constant on the frontend, but
    keeping it server-side means new prompts ship without a frontend
    bump. Cheap call (no DB), no auth-sensitive data.
    """
    return {"prompts": get_catalog()}


# ─── POST /answer ──────────────────────────────────────────────────────

@router.post("/answer")
def get_answer(
    body: AnswerRequest,
    request: Request,
    db: Session = Depends(get_db),
):
    """Run one curated prompt at one horizon and return the LLM answer.

    Order of operations:
      1. Validate prompt_id + horizon against the registry (404 if
         unknown — the frontend should never send these, so this is a
         defense-in-depth check, not a UX path).
      2. If demo mode → return canned answer (no Ollama needed).
      3. Build the structured bundle from the DB.
      4. If LLM_ENABLED=false → return the bundle with a `disabled`
         source so the UI can render the raw numbers itself as a
         fallback. (The AI Insights card returns answer:null in this
         case, but here returning the bundle gives users without
         Ollama some value: they still see the headline number.)
      5. Pre-flight Ollama health + model presence (so users get a
         clean 503 instead of a 60s hang on first request).
      6. Call the model, return the prose + the bundle the prose was
         derived from.

    The bundle is included in the success response so the frontend can
    show the raw numbers underneath the prose if it wants to (helpful
    for verification — "trust but verify the LLM").
    """
    # Step 1: validate the request against the registry.
    if body.prompt_id not in known_prompt_ids():
        raise HTTPException(
            status_code=404,
            detail=f"Unknown prompt_id: {body.prompt_id!r}",
        )
    valid_horizons = known_horizon_ids(body.prompt_id)
    if body.horizon not in valid_horizons:
        raise HTTPException(
            status_code=400,
            detail=(
                f"Invalid horizon {body.horizon!r} for prompt "
                f"{body.prompt_id!r}. Allowed: {sorted(valid_horizons)}"
            ),
        )

    now_iso = datetime.utcnow().isoformat() + "Z"
    is_demo = request.cookies.get("fintrack_mode") == "demo"

    # Step 2: demo short-circuit. Return the canned string regardless of
    # whether Ollama is up — same rationale as AI Insights demo mode.
    if is_demo:
        canned = demo_answer(body.prompt_id, body.horizon)
        return {
            "answer": canned or "(no demo answer configured for this question)",
            "source": "demo",
            "model": None,
            "generated_at": now_iso,
            "bundle": None,
        }

    # Step 3: build the JSON bundle (this is the part with the actual
    # numbers — every dollar figure in the response originates here).
    bundle = build_bundle(db, body.prompt_id, body.horizon)

    # Step 4: LLM disabled → return bundle without prose. The frontend
    # falls back to a templated one-liner derived from `bundle` so the
    # user still sees the number even without Ollama installed.
    if not settings.LLM_ENABLED:
        return {
            "answer": None,
            "source": "disabled",
            "model": None,
            "generated_at": now_iso,
            "bundle": bundle,
        }

    # Step 5: Ollama pre-flight checks. Same logic as the narrative
    # endpoint — fast 503 with actionable detail beats a hang.
    client = OllamaClient(base_url=settings.LLM_URL, model=settings.LLM_MODEL)
    if not client.health():
        raise HTTPException(
            status_code=503,
            detail=(
                f"Ollama not reachable at {settings.LLM_URL}. "
                f"Start it with `ollama serve` or set LLM_ENABLED=false."
            ),
        )
    if not client.has_model(settings.LLM_MODEL):
        raise HTTPException(
            status_code=503,
            detail=(
                f"Ollama is up but model '{settings.LLM_MODEL}' is not pulled. "
                f"Run `ollama pull {settings.LLM_MODEL}` and try again."
            ),
        )

    # Step 6: run the completion. No caching here on purpose — the
    # answers are short and the user expects them to reflect "right
    # now" data when they open the panel. If this becomes a perf
    # problem we can add a (prompt_id, horizon, day) cache like
    # _NARRATIVE_CACHE in analytics.
    user_prompt = build_user_prompt(body.prompt_id, body.horizon, bundle)
    try:
        text = client.complete(CHAT_SYSTEM_PROMPT, user_prompt)
    except LLMUnavailable as e:
        raise HTTPException(status_code=503, detail=str(e)) from e

    return {
        "answer": text,
        "source": "ollama",
        "model": settings.LLM_MODEL,
        "generated_at": now_iso,
        "bundle": bundle,
    }
