"""
In-app "Ask" panel — curated, pre-built questions answered by a local
LLM with pre-computed numbers.

Two endpoints:

    GET  /api/chat/prompts                    → catalog the UI renders as chips
    POST /api/chat/answer                     → run a chosen prompt + horizon
    POST /api/chat/answer?stream=true         → SAME, but Server-Sent Events
                                                  so the frontend can show
                                                  tokens as they arrive

This is a curated companion to the Ollama AI Insights card on the
Dashboard. The Insights card writes one paragraph per day from a fixed
spending bundle; this panel lets the user ask one of N specific
questions on demand and pick a time horizon.

Design contract: the model NEVER chooses the data. Every dollar figure
in the response was computed by a Python handler in
`services/chat_prompts.py`. The model only writes prose around the
JSON it was handed. This is what keeps an 8B local model from being a
liability in a finance app.

Streaming protocol (when ?stream=true):
  Server-Sent Events, each line `data: <json>\\n\\n`. Frames:
    {"meta": {source, model, generated_at, bundle}}   — first frame
    {"delta": "<chunk>"}                               — N times
    {"done": true}                                     — final frame
    {"error": "..."}                                   — on failure
  Demo mode and LLM-disabled mode also stream, but emit the entire
  text in a single `delta` frame so the frontend code path is uniform.

Non-streaming response shapes (default):
  200 {answer, source: "ollama"|"demo", model, generated_at, bundle}
  200 {answer: null, source: "disabled", ...}      — LLM_ENABLED=false
  503                                               — Ollama unreachable

Demo mode (fintrack_mode=demo cookie) returns a canned per-prompt/
per-horizon string from chat_prompts.DEMO_ANSWERS so the panel works
on a machine without Ollama installed (matching the AI Insights card).
"""
from __future__ import annotations

import json
from datetime import datetime
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import StreamingResponse
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


def _sse(payload: dict) -> str:
    """Serialize one SSE frame. Single source of truth for the wire format
    so the frontend parser only needs to handle one shape."""
    return f"data: {json.dumps(payload)}\n\n"


def _streaming_canned_response(text: str, meta: dict):
    """Stream a canned (demo / disabled-mode) string to keep the frontend
    code path uniform between modes. The frontend doesn't need to special-
    case demo mode — it just sees `meta` then a single `delta` then `done`,
    same as a real LLM stream that produced one chunk."""
    def _gen():
        yield _sse({"meta": meta})
        if text:
            yield _sse({"delta": text})
        yield _sse({"done": True})
    return StreamingResponse(_gen(), media_type="text/event-stream")


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
    stream: bool = Query(default=False, description="When true, return Server-Sent Events instead of a single JSON body. The frontend Ask panel uses this to render tokens as they arrive — same wall-clock time, ~10x better perceived latency."),
):
    """Run one curated prompt at one horizon and return the LLM answer.

    Two response modes via the `stream` query param:
      - stream=false (default): single JSON body, same shape as before.
      - stream=true: Server-Sent Events — first frame is `meta` with
        the source/bundle/etc., then N `delta` frames with prose
        chunks, then `done`. Demo and disabled modes still stream so
        the frontend code path is uniform; they just emit the whole
        text in one delta frame.

    Order of operations is shared between modes:
      1. Validate prompt_id + horizon against the registry.
      2. Demo mode → canned answer (no Ollama call).
      3. Build the structured bundle from the DB (the no-hallucination
         invariant lives here — every dollar in the response comes
         from this).
      4. LLM disabled → return bundle with source="disabled" so the
         frontend templated fallback can render the raw numbers.
      5. Ollama pre-flight (fast 503 instead of 60s hang on first
         request).
      6. Call the model. Streaming or block depending on the mode.
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
        canned = demo_answer(body.prompt_id, body.horizon) or \
            "(no demo answer configured for this question)"
        meta = {
            "source": "demo", "model": None,
            "generated_at": now_iso, "bundle": None,
        }
        if stream:
            return _streaming_canned_response(canned, meta)
        return {"answer": canned, **meta}

    # Step 3: build the JSON bundle (this is the part with the actual
    # numbers — every dollar figure in the response originates here).
    bundle = build_bundle(db, body.prompt_id, body.horizon)

    # Step 4: LLM disabled → return bundle without prose. The frontend
    # falls back to a templated one-liner derived from `bundle` so the
    # user still sees the number even without Ollama installed.
    if not settings.LLM_ENABLED:
        meta = {
            "source": "disabled", "model": None,
            "generated_at": now_iso, "bundle": bundle,
        }
        if stream:
            # Stream the meta + an empty delta + done. Frontend treats
            # missing answer as "use templated fallback derived from
            # bundle" — same behavior as the non-streaming path.
            def _gen():
                yield _sse({"meta": meta})
                yield _sse({"done": True})
            return StreamingResponse(_gen(), media_type="text/event-stream")
        return {"answer": None, **meta}

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

    user_prompt = build_user_prompt(body.prompt_id, body.horizon, bundle)
    meta = {
        "source": "ollama", "model": settings.LLM_MODEL,
        "generated_at": now_iso, "bundle": bundle,
    }

    # Step 6a: streaming path. Frontend renders tokens as they arrive.
    if stream:
        def event_stream():
            # Frame 1: metadata. The frontend uses this to populate the
            # raw-numbers disclosure and the "local · llama3.1:8b" tag
            # before any prose has arrived, so the panel doesn't reflow
            # when the first token lands.
            yield _sse({"meta": meta})
            try:
                for chunk in client.complete_stream(CHAT_SYSTEM_PROMPT, user_prompt):
                    yield _sse({"delta": chunk})
            except LLMUnavailable as e:
                # Mid-stream failures emit an error frame rather than
                # raising — the frontend has already started rendering
                # the panel and a thrown exception would orphan the UI.
                yield _sse({"error": str(e)})
                return
            yield _sse({"done": True})
        return StreamingResponse(event_stream(), media_type="text/event-stream")

    # Step 6b: non-streaming path (back-compat / server-side consumers).
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
