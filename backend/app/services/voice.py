"""On-device voice I/O for the 'Ask Tusk' assistant — Parakeet STT + Kokoro TTS (Apple Silicon).

Everything stays local: speech in via NVIDIA Parakeet (``parakeet-mlx``, runs on the Neural
Engine), speech out via Kokoro-82M (``kokoro``/MLX). Both are OPTIONAL — imported lazily and cached
so a machine without them just degrades to text (``status()`` reports what's available, and the
endpoints return a clean 503 the UI can handle). The browser records 16-kHz mono WAV so no ffmpeg
is needed on the backend.

Install (Apple Silicon Mac):
    pip install parakeet-mlx soundfile numpy        # STT
    pip install kokoro soundfile                     # TTS  (mlx-audio also works)
Then set VOICE_ENABLED=true in backend/.env and restart.
"""
from __future__ import annotations

import io
import threading
from typing import Optional

from app.config import settings

# Cache the loaded models — first call pays the load cost, the rest are warm.
_stt_model = None
_tts_pipeline = None
_lock = threading.Lock()

STT_MODEL = "mlx-community/parakeet-tdt-0.6b-v2"
TTS_VOICE_DEFAULT = "af_heart"


def _have(mod: str) -> bool:
    import importlib.util
    return importlib.util.find_spec(mod) is not None


def status() -> dict:
    """What's installed/enabled — the UI uses this to show a voice button or a 'set up voice' hint."""
    return {
        "enabled": bool(settings.VOICE_ENABLED),
        "stt_available": _have("parakeet_mlx"),
        "tts_available": _have("kokoro") or _have("mlx_audio"),
        "stt_model": STT_MODEL,
        "tts_voice": settings.VOICE_TTS_VOICE or TTS_VOICE_DEFAULT,
    }


def _load_stt():
    global _stt_model
    if _stt_model is None:
        with _lock:
            if _stt_model is None:
                from parakeet_mlx import from_pretrained  # type: ignore
                _stt_model = from_pretrained(STT_MODEL)
    return _stt_model


def transcribe(wav_bytes: bytes) -> str:
    """WAV bytes (16-kHz mono from the browser) → text, via Parakeet on the Neural Engine."""
    import tempfile

    model = _load_stt()
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=True) as f:
        f.write(wav_bytes)
        f.flush()
        result = model.transcribe(f.name)
    return (getattr(result, "text", None) or (result.get("text") if isinstance(result, dict) else "") or "").strip()


def _load_tts():
    global _tts_pipeline
    if _tts_pipeline is None:
        with _lock:
            if _tts_pipeline is None:
                from kokoro import KPipeline  # type: ignore
                _tts_pipeline = KPipeline(lang_code="a")   # 'a' = American English
    return _tts_pipeline


def synthesize(text: str, *, voice: Optional[str] = None) -> bytes:
    """Text → 24-kHz mono WAV bytes, via Kokoro-82M. Concatenates the per-sentence chunks."""
    import numpy as np
    import soundfile as sf

    pipeline = _load_tts()
    voice = voice or settings.VOICE_TTS_VOICE or TTS_VOICE_DEFAULT
    chunks = [audio for _gs, _ps, audio in pipeline(text, voice=voice)]
    if not chunks:
        return b""
    audio = np.concatenate([np.asarray(c, dtype=np.float32) for c in chunks])
    buf = io.BytesIO()
    sf.write(buf, audio, 24000, format="WAV", subtype="PCM_16")
    return buf.getvalue()
