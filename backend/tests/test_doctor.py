"""
Tests for `tuskledger doctor`.

Strategy: each check function is independent and reads the filesystem,
so we exercise them by:
  1. Calling the runner and asserting the JSON shape is stable
     (since AI agents will parse this output)
  2. Spot-checking the env-var parser since it has the most logic
  3. Verifying render_human and render_json don't raise on edge cases

We don't try to stub every filesystem path — the tests run against
the real repo layout, which is the same layout the doctor inspects in
production. That's the point.
"""
from __future__ import annotations

import json

import pytest

from app import cli


# ── Schema / shape ────────────────────────────────────────────────

def test_run_all_checks_returns_a_result_per_check():
    """Each registered check produces exactly one CheckResult."""
    results = cli.run_all_checks()
    assert len(results) == len(cli.ALL_CHECKS)
    for r in results:
        assert isinstance(r, cli.CheckResult)
        assert r.name
        assert r.category
        assert r.status in {"pass", "warn", "fail"}
        assert r.message  # never empty


def test_check_results_are_serializable_to_stable_json():
    """The agent contract: doctor --json output stays parseable + has the documented keys."""
    results = cli.run_all_checks()
    payload = json.loads(cli.render_json(results))

    # Top-level keys
    assert set(payload.keys()) == {"ok", "version", "summary", "checks"}
    assert payload["version"] == cli.DOCTOR_SCHEMA_VERSION
    assert isinstance(payload["ok"], bool)

    # Summary shape
    assert set(payload["summary"].keys()) >= {"total", "pass", "warn", "fail"}
    assert payload["summary"]["total"] == len(payload["checks"])

    # Per-check shape
    for c in payload["checks"]:
        assert set(c.keys()) >= {"name", "category", "status", "message"}
        # fix_hint is optional; must be string or None
        if "fix_hint" in c:
            assert c["fix_hint"] is None or isinstance(c["fix_hint"], str)


def test_summary_counts_match_per_status():
    results = cli.run_all_checks()
    summary = cli.summarize(results)
    actual_pass = sum(1 for r in results if r.status == "pass")
    actual_warn = sum(1 for r in results if r.status == "warn")
    actual_fail = sum(1 for r in results if r.status == "fail")
    assert summary["pass"] == actual_pass
    assert summary["warn"] == actual_warn
    assert summary["fail"] == actual_fail
    assert summary["total"] == actual_pass + actual_warn + actual_fail


def test_human_renderer_produces_non_empty_output():
    results = cli.run_all_checks()
    out = cli.render_human(results)
    assert out
    assert "Tusk Ledger doctor" in out
    # Every check name should appear somewhere
    for r in results:
        assert r.name in out


# ── Individual check edges ────────────────────────────────────────

def test_check_robust_to_exceptions_in_individual_checks(monkeypatch):
    """
    A bad check shouldn't blind the user to all the others. We swap in
    a check that raises and confirm the runner turns it into a fail,
    not a crash.
    """
    def boom():
        raise RuntimeError("simulated crash")

    monkeypatch.setattr(cli, "ALL_CHECKS", [boom])
    results = cli.run_all_checks()
    assert len(results) == 1
    assert results[0].status == "fail"
    assert "simulated crash" in results[0].message
    # Should have a generic name derived from the function
    assert results[0].name


# ── Env-var parser ────────────────────────────────────────────────

def test_env_var_parser_flags_placeholder_values(tmp_path, monkeypatch):
    env_file = tmp_path / ".env"
    env_file.write_text(
        "PLAID_CLIENT_ID=your_client_id\n"
        "PLAID_SECRET=changeme\n"
        "PLAID_ENV=sandbox\n"
    )
    monkeypatch.setattr(cli, "BACKEND_DIR", tmp_path)
    result = cli.check_required_env_vars()
    assert result.status == "fail"
    assert "Placeholder values" in result.message


def test_env_var_parser_passes_with_real_looking_values(tmp_path, monkeypatch):
    env_file = tmp_path / ".env"
    env_file.write_text(
        "# A friendly comment\n"
        "PLAID_CLIENT_ID=65f1c9b234abcde\n"
        'PLAID_SECRET="sandbox-secret-real-value"\n'
        "PLAID_ENV=sandbox\n"
        "OTHER_THING=ignored\n"
    )
    monkeypatch.setattr(cli, "BACKEND_DIR", tmp_path)
    result = cli.check_required_env_vars()
    assert result.status == "pass"


def test_env_var_parser_flags_missing_keys(tmp_path, monkeypatch):
    env_file = tmp_path / ".env"
    env_file.write_text("PLAID_CLIENT_ID=real_value\n")
    monkeypatch.setattr(cli, "BACKEND_DIR", tmp_path)
    result = cli.check_required_env_vars()
    assert result.status == "fail"
    assert "PLAID_SECRET" in result.message
    assert "PLAID_ENV" in result.message


def test_env_var_parser_handles_missing_env_file(tmp_path, monkeypatch):
    monkeypatch.setattr(cli, "BACKEND_DIR", tmp_path)  # no .env
    result = cli.check_required_env_vars()
    assert result.status == "fail"
    # Should defer to the env_file check, not crash
    assert "no .env" in result.message.lower() or "missing" in result.message.lower() or \
        "no .env file" in (result.message or "").lower() or \
        "skipped" in result.message.lower()


# ── End-to-end CLI invocation ─────────────────────────────────────

def test_main_doctor_human_returns_zero_or_one(capsys):
    """
    Sanity: invoking via the CLI module shouldn't crash, regardless of
    what the actual filesystem looks like.
    """
    rc = cli.main(["doctor"])
    out = capsys.readouterr().out
    assert rc in (0, 1)
    assert "Tusk Ledger doctor" in out


def test_main_doctor_json_emits_valid_json(capsys):
    rc = cli.main(["doctor", "--json"])
    out = capsys.readouterr().out
    payload = json.loads(out)
    assert "ok" in payload
    assert "checks" in payload
    assert payload["version"] == cli.DOCTOR_SCHEMA_VERSION
    assert rc in (0, 1)
