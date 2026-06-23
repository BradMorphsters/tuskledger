"""'Ask Tusk' assistant — read-only insight brain + streaming endpoint.

These exercise the Python plumbing that doesn't need the local model: the deterministic
template path, the multi-turn prompt builder, and the SSE streaming framing (LLM forced off so
we hit the deterministic fallback). The on-device LLM/voice are verified on the Mac, not here.
"""
from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient

from app.config import settings
from app.database import get_db, get_real_db
from app.main import app
from app.services import assistant as asst


@pytest.fixture()
def client(db):
    app.dependency_overrides[get_db] = lambda: db
    app.dependency_overrides[get_real_db] = lambda: db
    saved = {"DEV_BYPASS_AUTH": settings.DEV_BYPASS_AUTH, "LLM_ENABLED": settings.LLM_ENABLED}
    settings.DEV_BYPASS_AUTH = True
    settings.LLM_ENABLED = False  # force the deterministic fallback so no model is needed
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.clear()
        for k, v in saved.items():
            setattr(settings, k, v)


def test_persona_shared_across_all_prompts():
    # All four prompt sites must carry the SAME centralized persona (name + read-only guardrails).
    from app.services import assistant as A, assistant_retrieval as R, assistant_persona as P
    for prompt in (A._SYSTEM, A._BRIEF_SYSTEM, R._OPEN_SYSTEM, R._REPHRASE_SYSTEM):
        assert P.NAME in prompt                      # consistent identity
        assert "read-only" in prompt.lower()         # the core guardrail travels with the persona
        assert "buy/sell" in prompt.lower()          # never gives directives
        assert "not advice" in prompt.lower()        # don't append the disclaimer


def test_user_prompt_folds_in_recent_turns():
    snap = {"net_worth_change": {"net_worth": 100.0}}
    hist = [{"who": "you", "text": "what's my net worth"}, {"who": "tusk", "text": "about $100"}]
    p = asst._user_prompt("and last month?", snap, hist)
    assert "recent conversation" in p
    assert "You: what's my net worth" in p
    assert "Tusk: about $100" in p
    assert "Question: and last month?" in p
    # no-history path stays clean
    assert "recent conversation" not in asst._user_prompt("hi", snap, None)


def test_ask_non_stream_routes_and_grounds(client):
    # "net worth" routes to the net_worth retriever (deterministic, no LLM). Empty test DB → a
    # clean "no snapshot yet" answer, never a fabricated figure.
    r = client.post("/api/assistant/ask", json={"question": "What is my net worth?"})
    assert r.status_code == 200
    body = r.json()
    assert body["source"] in ("retrieval", "refusal", "template")
    assert isinstance(body.get("answer"), str) and body["answer"].strip()
    assert body.get("grounded") is True
    assert "rows" in body


def test_ask_accepts_history_field(client):
    # Open-ended follow-up with the LLM off → the guarded brain refuses rather than fabricate.
    r = client.post("/api/assistant/ask", json={
        "question": "and last month?",
        "history": [{"who": "you", "text": "net worth?"}, {"who": "tusk", "text": "about $100k"}],
    })
    assert r.status_code == 200
    assert r.json()["source"] in ("refusal", "retrieval", "template")


def test_briefing_text_reads_real_numbers():
    snap = {
        "net_worth_change": {"latest_net_worth_dollars": 848415.0, "change_dollars": 15000.0,
                             "horizon_label": "over 30 days", "no_data": False},
        "spending_total": {"total_spent_dollars": 4200.0, "horizon_label": "this month", "no_data": False},
        "research": {"alerts": [{"severity": "high", "message": "USAR filed a shelf."}],
                     "data_freshness": {"stale": True}},
    }
    t = asst._briefing_text(snap)
    assert "$848,415" in t and "up $15,000" in t
    assert "$4,200" in t
    assert "USAR filed a shelf." in t
    assert "stale" in t.lower()


def test_briefing_empty_snapshot_is_graceful():
    t = asst._briefing_text({})
    assert "snapshot" in t.lower()


def test_briefing_endpoint_template(client):
    r = client.get("/api/assistant/briefing")
    assert r.status_code == 200
    body = r.json()
    assert body["source"] == "template"
    assert isinstance(body["briefing"], str) and body["briefing"].strip()
    assert "snapshot" in body


def test_ask_stream_emits_meta_delta_done(client):
    with client.stream("POST", "/api/assistant/ask?stream=true",
                       json={"question": "What is my net worth?"}) as r:
        assert r.status_code == 200
        assert "text/event-stream" in r.headers["content-type"]
        frames = []
        for line in r.iter_lines():
            if line and line.startswith("data: "):
                frames.append(json.loads(line[6:]))
    kinds = [next(iter(f)) for f in frames]
    assert kinds[0] == "meta"
    assert "delta" in kinds
    assert kinds[-1] == "done"
    # the final frame carries the retrieval receipts back for the UI
    assert "rows" in frames[-1]
    # the streamed deltas concatenate to a non-empty answer
    text = "".join(f["delta"] for f in frames if "delta" in f)
    assert text.strip()
