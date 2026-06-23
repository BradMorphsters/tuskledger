"""'Ask Tusk' assistant — free-form, READ-ONLY, data-grounded insight (the brain behind voice).

`POST /api/assistant/ask` answers a free-form question about the owner's finances. Every figure is
computed by a Python builder (see services/assistant.py); the local model only narrates. There is
no write/action path here by construction. Insight-only, never advice.
"""
from __future__ import annotations

import json
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.database import get_db
from app.services import assistant as asst

router = APIRouter(prefix="/api/assistant", tags=["assistant"])


class Turn(BaseModel):
    who: str = Field("you", max_length=8)   # "you" | "tusk"
    text: str = Field("", max_length=2000)
    model_config = {"extra": "ignore"}


class AskIn(BaseModel):
    question: str = Field(..., min_length=1, max_length=600)
    history: Optional[List[Turn]] = None     # recent turns, for multi-turn follow-ups
    model_config = {"extra": "forbid"}


def _hist(body: "AskIn") -> Optional[list]:
    return [t.model_dump() for t in body.history] if body.history else None


def _sse(obj: dict) -> str:
    return f"data: {json.dumps(obj)}\n\n"


def _chunks(text: str, n: int = 3):
    """Re-emit an already-approved answer in small word groups, so the panel still renders live and
    the voice layer can speak sentence by sentence. We stream the APPROVED string (not raw model
    tokens) so a fabricated figure can never appear mid-stream."""
    words = (text or "").split(" ")
    for i in range(0, len(words), n):
        yield (" " if i else "") + " ".join(words[i:i + n])


@router.post("/ask")
def assistant_ask(body: AskIn, db: Session = Depends(get_db),
                  stream: bool = Query(False)):
    """Free-form, read-only insight via the retrieve-then-narrate brain. Returns
    ``{source, intent, window, answer, rows, found, grounded}``.

    With ``?stream=true`` returns SSE: a ``{meta}`` frame (source/intent/window/grounded), ``{delta}``
    frames re-emitting the approved answer, then ``{done, rows, found}``. The streamed text is always
    the grounded answer — the model never streams raw figures."""
    try:
        result = asst.answer(db, body.question, _hist(body))
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=str(exc))

    if not stream:
        return result

    def gen():
        yield _sse({"meta": {k: result.get(k) for k in ("source", "intent", "window", "grounded")}})
        for c in _chunks(result.get("answer", "")):
            yield _sse({"delta": c})
        yield _sse({"done": True, "rows": result.get("rows", []), "found": result.get("found", True),
                    "intent": result.get("intent"), "window": result.get("window")})

    return StreamingResponse(gen(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@router.get("/briefing")
def assistant_briefing(db: Session = Depends(get_db)):
    """A short, proactive read-only 'morning read' (net worth move, spending, top alert, stale note).
    Shown as the greeting when the Ask panel opens; spoken when a voice session starts."""
    try:
        return asst.briefing(db)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=str(exc))


# ── Feedback loop (thumbs up/down → diagnose → correct on approval) ──────

class FeedbackIn(BaseModel):
    question: str = Field(..., min_length=1, max_length=600)
    answer: str = Field("", max_length=4000)
    rating: str = Field(..., pattern="^(up|down)$")
    intent: Optional[str] = Field(None, max_length=40)
    comment: Optional[str] = Field(None, max_length=600)
    model_config = {"extra": "ignore"}


class CorrectIn(BaseModel):
    # Either an exact intent name OR a plain-language hint ("my biggest debt") — both get routed.
    intent: str = Field(..., min_length=1, max_length=200)
    model_config = {"extra": "forbid"}


@router.post("/feedback")
def assistant_feedback(body: FeedbackIn, db: Session = Depends(get_db)):
    """Record a 👍/👎 on an answer. A 👎 is diagnosed and (when fixable) a grounded correction is
    proposed for your approval. Returns ``{feedback_id, rating, diagnosis?}``."""
    from app.services import assistant_feedback as fb
    try:
        return fb.record(db, body.question, body.answer, body.rating, body.intent, comment=body.comment)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=str(exc))


@router.get("/feedback")
def assistant_feedback_list():
    """Open (un-resolved) down-thumb corrections awaiting your approval."""
    from app.services import assistant_feedback as fb
    return {"pending": fb.pending()}


@router.get("/feedback/intents")
def assistant_feedback_intents():
    """The catalog of retrievers the assistant can route to — for the 'it should have been…' picker."""
    from app.services import assistant_feedback as fb
    return {"intents": fb.intents()}


@router.post("/feedback/{fid}/correct")
def assistant_feedback_correct(fid: str, body: CorrectIn, db: Session = Depends(get_db)):
    """Pick the correct retriever for an open item → preview the grounded re-answer (before approving)."""
    from app.services import assistant_feedback as fb
    res = fb.correct(db, fid, body.intent)
    if res is None:
        raise HTTPException(status_code=404, detail="feedback item not found")
    return res


@router.post("/feedback/{fid}/approve")
def assistant_feedback_approve(fid: str):
    """Approve the correction → learn the routing override so questions like it route correctly."""
    from app.services import assistant_feedback as fb
    res = fb.approve(fid)
    if res is None:
        raise HTTPException(status_code=404, detail="feedback item not found")
    return res


@router.post("/feedback/{fid}/reject")
def assistant_feedback_reject(fid: str):
    from app.services import assistant_feedback as fb
    res = fb.reject(fid)
    if res is None:
        raise HTTPException(status_code=404, detail="feedback item not found")
    return res


# ── On-device voice (optional; Parakeet STT + Kokoro TTS) ────────────────

@router.get("/voice/status")
def voice_status():
    """What voice engines are installed/enabled — the UI shows the mic only when usable."""
    from app.services import voice
    return voice.status()


@router.post("/voice/transcribe")
async def voice_transcribe(request: Request):
    """16-kHz mono WAV (raw body, from the browser) → ``{text}`` via Parakeet. 503 if STT isn't set up."""
    from app.services import voice
    if not voice.status()["stt_available"]:
        raise HTTPException(status_code=503, detail="Speech-to-text not installed (pip install parakeet-mlx).")
    audio = await request.body()
    if not audio:
        raise HTTPException(status_code=400, detail="empty audio body")
    try:
        return {"text": voice.transcribe(audio)}
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"transcription failed: {exc}")


class SpeakIn(BaseModel):
    text: str = Field(..., min_length=1, max_length=4000)
    model_config = {"extra": "forbid"}


@router.post("/voice/speak")
def voice_speak(body: SpeakIn):
    """Text → spoken WAV via Kokoro. 503 if TTS isn't set up."""
    from app.services import voice
    if not voice.status()["tts_available"]:
        raise HTTPException(status_code=503, detail="Text-to-speech not installed (pip install kokoro).")
    try:
        wav = voice.synthesize(body.text)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"speech synthesis failed: {exc}")
    return Response(content=wav, media_type="audio/wav")
