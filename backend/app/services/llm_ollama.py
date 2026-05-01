"""
Thin sync HTTP client for a local Ollama instance.

Ollama runs as a separate background daemon on the user's machine
(installed via `curl -fsSL https://ollama.com/install.sh | sh`). This
module talks to it at http://127.0.0.1:11434 by default and exposes
two operations the rest of the backend cares about:

    health(...)      → bool   — is Ollama running and answering?
    complete(...)    → str    — non-streaming chat completion

We keep the interface narrow on purpose. The "AI narrative" feature on
the Dashboard is the spike use case; if more LLM-powered surfaces show
up we can add streaming or model-introspection helpers without
rewriting the call sites.

Why sync (not async): the rest of FastAPI's analytics endpoints use sync
SQLAlchemy and run in the threadpool. Mixing httpx-async here would buy
nothing while complicating the test mocks.

Why not the official `ollama` Python package: it pulls in pydantic v1
in some versions, owns its own HTTP client, and adds an install we
don't need. The Ollama HTTP API is two endpoints and JSON — easier to
hit directly with `httpx`, easier to mock in tests, easier to swap if
the user points LLM_URL at OpenAI-compatible endpoints later.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

import httpx

# Defaults. Real values are read from app.config.settings at the call
# site, not pinned here — these constants are for tests and for callers
# who want to spin up a one-off client without the global settings.
DEFAULT_URL = "http://127.0.0.1:11434"
DEFAULT_MODEL = "llama3.1:8b"

# Health check timeout is intentionally tiny: the user-facing impact
# of "Ollama not running" should be a fast empty state, not a 5-second
# stall on the Dashboard.
HEALTH_TIMEOUT_S = 2.0

# Completion timeout has to be generous because local 7B-class models
# on Apple Silicon sit in the 10-30 tok/s range — a 250-token narrative
# can easily take 20-25s. We give it room without making the user wait
# forever if the model picked is something the machine can't actually
# run.
COMPLETION_TIMEOUT_S = 60.0


class LLMUnavailable(Exception):
    """Raised when Ollama cannot be reached or returns an error.

    Callers should catch this and fall back to whatever degraded
    experience makes sense (empty narrative card, doctor 'fail' check,
    etc.) — the app never crashes because the LLM isn't there.
    """


@dataclass
class OllamaClient:
    """Configured client. Construct once per request; cheap to make."""

    base_url: str = DEFAULT_URL
    model: str = DEFAULT_MODEL

    def health(self) -> bool:
        """Quick liveness check.

        Hits Ollama's `/api/tags` (lists installed models) because it's
        cheap, doesn't touch the model itself, and confirms both that
        the daemon is up AND that we can actually talk JSON to it.
        Returns True/False rather than raising — health checks should
        never throw.
        """
        try:
            r = httpx.get(f"{self.base_url}/api/tags", timeout=HEALTH_TIMEOUT_S)
            return r.status_code == 200
        except (httpx.HTTPError, httpx.TimeoutException):
            return False

    def has_model(self, model: Optional[str] = None) -> bool:
        """Is the configured (or supplied) model actually pulled locally?

        Ollama is happy to accept a request for a model that isn't
        installed and will start downloading it (multi-GB) inline,
        which would surface to the user as a multi-minute hang on the
        Dashboard. Better to detect this up front and return a clear
        error so the doctor check can recommend `ollama pull <model>`.
        """
        wanted = model or self.model
        try:
            r = httpx.get(f"{self.base_url}/api/tags", timeout=HEALTH_TIMEOUT_S)
            r.raise_for_status()
            installed = {t["name"] for t in r.json().get("models", [])}
        except (httpx.HTTPError, httpx.TimeoutException, KeyError, ValueError):
            return False
        # Ollama tags include the version suffix (e.g. "llama3.1:8b").
        # Match exact tag first, then bare name (covers the case where
        # someone pulled "llama3.1:latest" and asked for "llama3.1").
        if wanted in installed:
            return True
        bare = wanted.split(":", 1)[0]
        return any(name.split(":", 1)[0] == bare for name in installed)

    def complete(self, system: str, user: str) -> str:
        """Non-streaming chat completion.

        Returns the model's full reply as a single string. Raises
        LLMUnavailable on any transport failure, non-200 response, or
        malformed JSON — the caller decides what to show the user.

        We deliberately do NOT stream here. Streaming is a nice polish
        for the front-end (token-by-token reveal) but adds plumbing
        through FastAPI + the React fetch call that's not worth the
        complexity for the spike. If we keep the feature, streaming
        becomes an obvious follow-up.
        """
        payload = {
            "model": self.model,
            "stream": False,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            # Conservative options. Low temperature because the prompt
            # asks the model to interpret structured numbers — we want
            # tight prose, not creative writing.
            "options": {
                "temperature": 0.3,
                "num_predict": 400,
            },
        }
        try:
            r = httpx.post(
                f"{self.base_url}/api/chat",
                json=payload,
                timeout=COMPLETION_TIMEOUT_S,
            )
            r.raise_for_status()
            data = r.json()
        except (httpx.HTTPError, httpx.TimeoutException, ValueError) as e:
            raise LLMUnavailable(f"Ollama request failed: {e}") from e

        # Ollama's /api/chat (non-stream) returns {"message": {"content": "..."}}
        msg = data.get("message") or {}
        content = msg.get("content")
        if not content:
            raise LLMUnavailable(
                f"Ollama returned no content; raw response keys: {list(data)}"
            )
        return content.strip()
