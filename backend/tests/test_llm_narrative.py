"""
Tests for the local-LLM narrative spike: the Ollama HTTP client and the
insights bundle / prompt builder it consumes.

The headline guarantees these tests lock in:

  1. The Ollama client never raises out of `health()` — health checks
     must always return a bool, even if the network is on fire.

  2. `complete()` raises LLMUnavailable (not the underlying
     httpx.HTTPError) on any transport failure, so the analytics router
     can map every LLM problem to a single 503 branch.

  3. The insights bundle emits ONLY whole-dollar numbers in the JSON it
     hands to the model. This is the load-bearing invariant that keeps
     the model from inventing fractional cents and from being asked to
     do its own arithmetic.

  4. Demo narrative text is canned — no Ollama dependency at all.

  5. The bundle math agrees with the rule-based insights endpoint's
     definition of baseline (trailing 3-month average, same fraction of
     month). We test this indirectly by confirming a known fixture
     produces the expected mover.
"""
from __future__ import annotations

import datetime
from typing import Any

import httpx
import pytest

from app.services import llm_ollama
from app.services.insights_narrative import (
    DEMO_NARRATIVE,
    build_insights_bundle,
    build_user_prompt,
)


# ─── Ollama client ────────────────────────────────────────────────


class _FakeResponse:
    """Just enough of httpx.Response to exercise the parsing branches."""

    def __init__(self, status_code: int, json_body: Any):
        self.status_code = status_code
        self._json = json_body

    def json(self) -> Any:
        return self._json

    def raise_for_status(self) -> None:
        if 400 <= self.status_code < 600:
            raise httpx.HTTPStatusError(
                "boom",
                request=httpx.Request("GET", "http://x"),
                response=httpx.Response(self.status_code),
            )


def test_health_true_when_tags_endpoint_returns_200(monkeypatch):
    monkeypatch.setattr(
        llm_ollama.httpx, "get", lambda *a, **kw: _FakeResponse(200, {"models": []})
    )
    assert llm_ollama.OllamaClient().health() is True


def test_health_false_on_transport_error(monkeypatch):
    """If Ollama isn't running, .health() returns False — never raises."""
    def boom(*a, **kw):
        raise httpx.ConnectError("nope")
    monkeypatch.setattr(llm_ollama.httpx, "get", boom)
    assert llm_ollama.OllamaClient().health() is False


def test_health_false_on_timeout(monkeypatch):
    def boom(*a, **kw):
        raise httpx.TimeoutException("slow")
    monkeypatch.setattr(llm_ollama.httpx, "get", boom)
    assert llm_ollama.OllamaClient().health() is False


def test_has_model_matches_exact_tag(monkeypatch):
    body = {"models": [{"name": "llama3.1:8b"}, {"name": "phi3:mini"}]}
    monkeypatch.setattr(
        llm_ollama.httpx, "get", lambda *a, **kw: _FakeResponse(200, body)
    )
    client = llm_ollama.OllamaClient(model="llama3.1:8b")
    assert client.has_model() is True


def test_has_model_matches_bare_name(monkeypatch):
    """Asking for 'llama3.1' should still find 'llama3.1:latest'."""
    body = {"models": [{"name": "llama3.1:latest"}]}
    monkeypatch.setattr(
        llm_ollama.httpx, "get", lambda *a, **kw: _FakeResponse(200, body)
    )
    client = llm_ollama.OllamaClient(model="llama3.1")
    assert client.has_model() is True


def test_has_model_false_when_not_pulled(monkeypatch):
    body = {"models": [{"name": "phi3:mini"}]}
    monkeypatch.setattr(
        llm_ollama.httpx, "get", lambda *a, **kw: _FakeResponse(200, body)
    )
    client = llm_ollama.OllamaClient(model="llama3.1:8b")
    assert client.has_model() is False


def test_complete_returns_message_content(monkeypatch):
    body = {"message": {"role": "assistant", "content": "  hello world  "}}
    monkeypatch.setattr(
        llm_ollama.httpx, "post", lambda *a, **kw: _FakeResponse(200, body)
    )
    out = llm_ollama.OllamaClient().complete("sys", "user")
    assert out == "hello world"  # whitespace stripped


def test_complete_raises_llmunavailable_on_transport_error(monkeypatch):
    def boom(*a, **kw):
        raise httpx.ConnectError("dead")
    monkeypatch.setattr(llm_ollama.httpx, "post", boom)
    with pytest.raises(llm_ollama.LLMUnavailable):
        llm_ollama.OllamaClient().complete("sys", "user")


def test_complete_raises_llmunavailable_on_http_error(monkeypatch):
    """Ollama returning 500 should surface as LLMUnavailable, not an
    httpx error — so analytics.py can collapse all LLM failures into
    a single 503 mapping at the router boundary."""
    monkeypatch.setattr(
        llm_ollama.httpx, "post", lambda *a, **kw: _FakeResponse(500, {})
    )
    with pytest.raises(llm_ollama.LLMUnavailable):
        llm_ollama.OllamaClient().complete("sys", "user")


def test_complete_raises_when_response_has_no_content(monkeypatch):
    """Empty content == no useful narrative; treat as a failure so the
    Dashboard shows an empty state rather than a blank card."""
    monkeypatch.setattr(
        llm_ollama.httpx,
        "post",
        lambda *a, **kw: _FakeResponse(200, {"message": {"content": ""}}),
    )
    with pytest.raises(llm_ollama.LLMUnavailable):
        llm_ollama.OllamaClient().complete("sys", "user")


# ─── Demo narrative is self-contained ──────────────────────────────


def test_demo_narrative_is_static_string():
    """No template substitution, no DB, no model — just a fixed string
    so marketing screenshots are reproducible without Ollama."""
    assert isinstance(DEMO_NARRATIVE, str)
    assert len(DEMO_NARRATIVE) > 100  # actual content, not a stub
    # No raw f-string leakage
    assert "{" not in DEMO_NARRATIVE
    assert "}" not in DEMO_NARRATIVE


# ─── Insights bundle math + prompt structure ───────────────────────


def _add_txns_for_month(factory, account_id, year, month, *, by_merchant_amount):
    """Helper: drop a list of (day, merchant, amount) into the given month."""
    for day, merchant, amount in by_merchant_amount:
        factory.transaction(
            account_id=account_id,
            amount=amount,
            date=datetime.date(year, month, day),
            merchant_name=merchant,
            name=merchant,
            category="Food & Dining",
        )


def test_bundle_emits_whole_dollars_only(db, factory):
    """The model must never see fractional cents in the prompt JSON.

    Cents are noise — they make the prompt longer without adding any
    insight, and they encourage the model to do its own arithmetic. We
    enforce whole-dollar rounding at the serialiser boundary so callers
    can't accidentally leak cents through.
    """
    acct = factory.account()
    factory.commit()

    today = datetime.date(2026, 4, 30)
    factory.transaction(
        account_id=acct.id,
        amount=87.42,
        date=datetime.date(2026, 4, 28),
        merchant_name="Whole Foods",
        category="Food & Dining",
    )
    factory.commit()

    bundle = build_insights_bundle(db, today=today)
    payload = bundle.as_prompt_json()
    # Every dollar figure should be a bare integer — no decimal points
    # in any of the named numeric fields.
    for line in payload.splitlines():
        if any(key in line for key in (
            '"this_month":', '"baseline_avg":', '"change_dollars":',
            '"spending_this_month":', '"spending_baseline_avg":',
            '"spending_change_dollars":', '"amount":',
        )):
            value = line.rsplit(":", 1)[1].rstrip(",").strip()
            # Allow null and integers, reject anything with a decimal point.
            assert value == "null" or "." not in value, (
                f"Found fractional dollar value in prompt: {line.strip()!r}"
            )


def test_bundle_categories_up_includes_significant_mover(db, factory):
    """A category that's $100 above its trailing baseline shows up in
    categories_up. Threshold is $25, so $100 is clearly past it."""
    acct = factory.account()
    factory.commit()

    today = datetime.date(2026, 4, 15)  # mid-month for stable fraction

    # This month: $200 of Food & Dining at the same merchant
    _add_txns_for_month(
        factory, acct.id, 2026, 4,
        by_merchant_amount=[(5, "Whole Foods", 100), (10, "Whole Foods", 100)],
    )
    # Prior 3 months: ~$50 each at the same point in the month
    for prior_month in (1, 2, 3):
        _add_txns_for_month(
            factory, acct.id, 2026, prior_month,
            by_merchant_amount=[(5, "Whole Foods", 50)],
        )
    factory.commit()

    bundle = build_insights_bundle(db, today=today)
    cat_names_up = [s.category for s in bundle.categories_up]
    assert "Food & Dining" in cat_names_up
    fd = next(s for s in bundle.categories_up if s.category == "Food & Dining")
    # Baseline is ~$50/month avg → MTD $200 → delta $150-ish; allow
    # slack because the fraction-of-month math may include or exclude
    # day 5 depending on rounding.
    assert fd.delta_amount > 100
    assert "Whole Foods" in fd.top_merchants


def test_bundle_handles_empty_db(db):
    """No transactions → bundle still builds, with a 'no transactions'
    note. The endpoint should not blow up on a brand-new DB."""
    today = datetime.date(2026, 4, 15)
    bundle = build_insights_bundle(db, today=today)
    assert bundle.mtd_total_spending == 0
    assert bundle.categories_up == []
    assert bundle.categories_down == []
    assert bundle.notable_largest_transaction is None
    assert any("No transactions" in n for n in bundle.notes)


def test_user_prompt_quotes_the_bundle_json(db):
    """The user prompt must hand the model the bundle as a labeled JSON
    block. If we accidentally pass a Python repr or a flattened string,
    the model has no structured input to write against."""
    today = datetime.date(2026, 4, 15)
    bundle = build_insights_bundle(db, today=today)
    prompt = build_user_prompt(bundle)
    assert "```json" in prompt
    assert '"month": "April 2026"' in prompt
    # Hard rule the prompt enforces — explicit instruction not to
    # invent numbers. If this string disappears, the safety story breaks.
    assert "do not compute" in prompt.lower() or "only these numbers" in prompt.lower()
