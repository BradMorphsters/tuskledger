"""Ask Tusk feedback loop — capture → diagnose → correct (on approval) → learned routing override."""
from __future__ import annotations

import pytest

from app.config import settings
from app.services import assistant_feedback as fb
from app.services import assistant_retrieval as ret


@pytest.fixture(autouse=True)
def _isolated_store(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "ASSISTANT_FEEDBACK_DIR", str(tmp_path))
    monkeypatch.setattr(settings, "LLM_ENABLED", False)   # deterministic: no model judge
    fb.reset_cache()
    yield
    fb.reset_cache()


def test_thumbs_up_just_logs(db):
    out = fb.record(db, "what's my net worth", "About $100.", "up")
    assert out["rating"] == "up"
    assert "diagnosis" not in out
    assert fb.pending() == []                 # up-thumbs don't open a correction


def test_down_on_refusal_is_coverage_gap(db):
    out = fb.record(db, "what's the weather", "I can't get that from your data.", "down", intent=None)
    assert out["diagnosis"]["type"] == "coverage_gap"
    assert len(fb.pending()) == 1


def test_down_on_grounded_answer_is_review(db):
    out = fb.record(db, "what's my net worth", "Your net worth is about $100.", "down", intent="net_worth")
    assert out["diagnosis"]["type"] == "grounded_review"


def test_correct_then_approve_creates_override_and_changes_routing(db):
    # A question that naturally does NOT route to net_worth...
    q = "how am I doing financially"
    assert ret.route(q) != "net_worth"
    # user down-thumbs the answer, then describes what they meant in PLAIN LANGUAGE (routed for them).
    fid = fb.record(db, q, "Some off answer.", "down", intent=None)["feedback_id"]
    res = fb.correct(db, fid, "what's my net worth")     # free-text hint, not an intent name
    assert res["intent"] == "net_worth" and "preview" in res
    ap = fb.approve(fid)
    assert ap["applied_intent"] == "net_worth"
    # the override is learned + persisted, and answer() now routes via it.
    fb.reset_cache()
    assert fb.learned_override(q) == "net_worth"
    assert ret.answer(db, q)["intent"] == "net_worth"
    assert fb.pending() == []                 # resolved


def test_correct_rejects_unknown_intent(db):
    fid = fb.record(db, "huh", "x", "down", intent=None)["feedback_id"]
    res = fb.correct(db, fid, "not_a_real_intent")
    assert "error" in res


def test_reject_resolves_without_override(db):
    fid = fb.record(db, "how am I doing", "x", "down", intent=None)["feedback_id"]
    assert fb.reject(fid) == {"ok": True}
    assert fb.learned_override("how am I doing") is None
    assert fb.pending() == []


def test_intents_catalog_nonempty():
    cat = fb.intents()
    names = {c["intent"] for c in cat}
    assert "net_worth" in names and "holdings" in names
    assert all(c["description"] for c in cat)        # every retriever has a one-line doc
