"""Golden routing eval — the CI gate that keeps Ask Tusk coverage from regressing.

`assistant_golden.GOLDEN` is the curated 'common questions per tile' set. This asserts the
deterministic keyword router stays at/above a coverage threshold (and prints the exact misses on
failure), and that seeding the golden overrides guarantees every curated question routes correctly.
"""
from __future__ import annotations

import pytest

from app.config import settings
from app.services import assistant_feedback as fb
from app.services import assistant_golden as golden
from app.services import assistant_retrieval as ret

# The keyword router should handle the curated commons directly. (Misses still work at runtime via
# the override seed / LLM router, but we want the deterministic floor high and non-regressing.)
THRESHOLD = 0.97


def test_golden_keyword_router_coverage():
    pairs = golden.flat()
    misses = [(q, want, ret.route(q)) for q, want in pairs if ret.route(q) != want]
    pct = 1 - len(misses) / len(pairs)
    assert pct >= THRESHOLD, (
        f"Golden routing dropped to {pct:.0%} (< {THRESHOLD:.0%}). Misses:\n"
        + "\n".join(f"  {q!r} → want {want}, got {got}" for q, want, got in misses)
    )


def test_every_golden_intent_is_a_real_retriever():
    for q, intent in golden.flat():
        assert intent in ret.RETRIEVERS, f"{q!r} maps to unknown intent {intent!r}"


def test_seeding_guarantees_every_golden_question(tmp_path, monkeypatch):
    # Seed the golden overrides into an isolated store, then confirm each routes via the override.
    monkeypatch.setattr(settings, "ASSISTANT_FEEDBACK_DIR", str(tmp_path))
    fb.reset_cache()
    golden.seed_overrides()
    fb.reset_cache()
    for q, intent in golden.flat():
        assert fb.learned_override(q) == intent, f"override for {q!r} should be {intent}"
