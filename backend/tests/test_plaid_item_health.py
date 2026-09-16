"""Plaid connection health: the /item/get summary, an honest balance_as_of,
and the verdict that separates "sync succeeded on Plaid's cached data" from
"the bank data is actually fresh".

Why this exists: when Plaid's scheduled refreshes against an institution
start failing, /accounts/get and /transactions/sync keep answering 200 from
Plaid's cache. Every sync used to stamp balance_as_of = today regardless, so a
week-long outage looked perfectly fresh — green dots on the Accounts page, no
stale-account alert — while new transactions silently never arrived.
"""
from __future__ import annotations

import datetime as dt

import pytest
from fastapi.testclient import TestClient

from app.database import get_db, get_real_db
from app.main import app
from app.models import Account, PlaidItem
from app.services import sync_service
from app.services.plaid_service import summarize_item_status

UTC = dt.timezone.utc
NOW = dt.datetime(2026, 3, 20, 16, 0, tzinfo=UTC)


@pytest.fixture(autouse=True)
def _clear_status_cache():
    """The status cache is module-level; item ids repeat across tests."""
    sync_service._ITEM_STATUS_CACHE.clear()
    yield
    sync_service._ITEM_STATUS_CACHE.clear()


def _iso(d: dt.datetime) -> str:
    return d.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def _raw(txn_ok=None, txn_fail=None, inv_ok=None, inv_fail=None, error=None, status=True):
    """Shape of a real /item/get response body."""
    body = {
        "item": {
            "item_id": "item-x",
            "institution_id": "ins_1",
            "error": error,
            "update_type": "background",
            "consent_expiration_time": None,
            "billed_products": ["transactions"],
        },
        "request_id": "req-1",
    }
    body["status"] = {
        "transactions": {"last_successful_update": txn_ok, "last_failed_update": txn_fail},
        "investments": ({"last_successful_update": inv_ok, "last_failed_update": inv_fail}
                        if (inv_ok or inv_fail) else None),
        "last_webhook": None,
    } if status else None
    return body


LOGIN_REQUIRED = {
    "error_type": "ITEM_ERROR",
    "error_code": "ITEM_LOGIN_REQUIRED",
    "error_message": "the login details of this item have changed",
    "display_message": "Your bank needs you to sign in again.",
}


# ---------------------------------------------------------------------------
# summarize_item_status — pure shape handling
# ---------------------------------------------------------------------------

def test_summarize_healthy_item():
    s = summarize_item_status(_raw(txn_ok="2026-03-20T09:00:00Z", txn_fail="2026-03-01T09:00:00Z"))
    assert s["error"] is None
    assert s["transactions"] == {
        "last_successful_update": "2026-03-20T09:00:00Z",
        "last_failed_update": "2026-03-01T09:00:00Z",
    }
    assert s["investments"] == {"last_successful_update": None, "last_failed_update": None}
    assert s["update_type"] == "background"


def test_summarize_maps_item_error():
    s = summarize_item_status(_raw(txn_ok="2026-03-10T09:00:00Z", error=LOGIN_REQUIRED))
    assert s["error"] == {
        "code": "ITEM_LOGIN_REQUIRED",
        "type": "ITEM_ERROR",
        "message": "the login details of this item have changed",
        "display_message": "Your bank needs you to sign in again.",
    }


def test_summarize_tolerates_null_status_and_empty_body():
    assert summarize_item_status(_raw(status=False))["transactions"]["last_successful_update"] is None
    empty = summarize_item_status({})
    assert empty["error"] is None and empty["investments"]["last_failed_update"] is None


# ---------------------------------------------------------------------------
# plaid_data_as_of — what balance_as_of should say
# ---------------------------------------------------------------------------

TODAY = dt.date(2026, 3, 20)


def test_as_of_is_plaids_last_successful_pull_not_today():
    status = summarize_item_status(_raw(txn_ok="2026-03-12T15:00:00Z", txn_fail="2026-03-20T15:00:00Z"))
    assert sync_service.plaid_data_as_of(status, "depository", TODAY) == dt.date(2026, 3, 12)
    # Loans and cards on the same item come from the same refresh.
    assert sync_service.plaid_data_as_of(status, "loan", TODAY) == dt.date(2026, 3, 12)


def test_as_of_investment_accounts_use_investments_status():
    status = summarize_item_status(_raw(txn_ok="2026-03-01T15:00:00Z", inv_ok="2026-03-19T15:00:00Z"))
    assert sync_service.plaid_data_as_of(status, "investment", TODAY) == dt.date(2026, 3, 19)
    assert sync_service.plaid_data_as_of(status, "depository", TODAY) == dt.date(2026, 3, 1)


def test_as_of_falls_back_to_other_product_then_today():
    inv_only = summarize_item_status(_raw(inv_ok="2026-03-18T15:00:00Z"))
    assert sync_service.plaid_data_as_of(inv_only, "credit", TODAY) == dt.date(2026, 3, 18)
    no_timestamps = summarize_item_status(_raw())
    assert sync_service.plaid_data_as_of(no_timestamps, "depository", TODAY) == TODAY
    assert sync_service.plaid_data_as_of(None, "depository", TODAY) == TODAY


def test_as_of_never_later_than_today():
    status = summarize_item_status(_raw(txn_ok="2026-03-25T15:00:00Z"))
    assert sync_service.plaid_data_as_of(status, "depository", TODAY) == TODAY


# ---------------------------------------------------------------------------
# assess_item_health — the verdict
# ---------------------------------------------------------------------------

def test_health_ok_when_recently_pulled():
    status = summarize_item_status(_raw(txn_ok=_iso(NOW - dt.timedelta(hours=5))))
    h = sync_service.assess_item_health(status, has_cash_accounts=True, now=NOW)
    assert h["status"] == "ok"
    assert h["hours_since_update"] == 5.0
    assert h["last_attempt_failed"] is False


def test_health_stale_when_plaid_stopped_pulling_without_an_error_flag():
    """The failure mode that hid missing transactions: no item error, syncs
    "succeed", but Plaid's last successful pull is a week old and its latest
    attempt failed."""
    status = summarize_item_status(_raw(
        txn_ok=_iso(NOW - dt.timedelta(days=7)),
        txn_fail=_iso(NOW - dt.timedelta(hours=2)),
    ))
    h = sync_service.assess_item_health(status, has_cash_accounts=True, now=NOW)
    assert h["status"] == "stale"
    assert h["last_attempt_failed"] is True
    assert "7 days ago" in h["message"]
    assert "latest attempts are failing" in h["message"]
    assert "Reconnect" not in h["message"]  # re-linking can't fix a Plaid-to-bank fault


def test_health_stale_threshold_boundary_with_failing_attempts():
    recent_fail = _iso(NOW - dt.timedelta(hours=1))
    just_inside = summarize_item_status(_raw(
        txn_ok=_iso(NOW - dt.timedelta(hours=sync_service.ITEM_STALE_AFTER_HOURS)), txn_fail=recent_fail))
    assert sync_service.assess_item_health(just_inside, has_cash_accounts=True, now=NOW)["status"] == "ok"
    past = summarize_item_status(_raw(
        txn_ok=_iso(NOW - dt.timedelta(hours=sync_service.ITEM_STALE_AFTER_HOURS + 1)), txn_fail=recent_fail))
    assert sync_service.assess_item_health(past, has_cash_accounts=True, now=NOW)["status"] == "stale"


def test_slow_cadence_item_without_failures_is_not_stale():
    """A mortgage-only connection can go several days between refreshes with no
    failures at all. That's cadence, not an outage — no banner."""
    slow = summarize_item_status(_raw(
        txn_ok=_iso(NOW - dt.timedelta(days=4)),
        txn_fail=_iso(NOW - dt.timedelta(days=60)),
    ))
    assert sync_service.assess_item_health(slow, has_cash_accounts=True, now=NOW)["status"] == "ok"


def test_silent_gap_eventually_counts_as_stale():
    days = sync_service.ITEM_SILENT_STALE_AFTER_DAYS
    inside = summarize_item_status(_raw(txn_ok=_iso(NOW - dt.timedelta(days=days))))
    assert sync_service.assess_item_health(inside, has_cash_accounts=True, now=NOW)["status"] == "ok"
    past = summarize_item_status(_raw(txn_ok=_iso(NOW - dt.timedelta(days=days, hours=1))))
    h = sync_service.assess_item_health(past, has_cash_accounts=True, now=NOW)
    assert h["status"] == "stale"
    assert "failing" not in h["message"]


def test_health_error_wins_over_recent_timestamp():
    status = summarize_item_status(_raw(txn_ok=_iso(NOW - dt.timedelta(hours=1)), error=LOGIN_REQUIRED))
    h = sync_service.assess_item_health(status, has_cash_accounts=True, now=NOW)
    assert h["status"] == "error"
    assert "ITEM_LOGIN_REQUIRED" in h["message"]
    assert h["error"]["code"] == "ITEM_LOGIN_REQUIRED"


def test_health_investment_only_item_reads_investments_status():
    status = summarize_item_status(_raw(
        txn_ok=_iso(NOW - dt.timedelta(days=30)),
        txn_fail=_iso(NOW - dt.timedelta(hours=2)),
        inv_ok=_iso(NOW - dt.timedelta(hours=3)),
    ))
    assert sync_service.assess_item_health(status, has_cash_accounts=False, now=NOW)["status"] == "ok"
    assert sync_service.assess_item_health(status, has_cash_accounts=True, now=NOW)["status"] == "stale"


def test_health_unknown_cases():
    assert sync_service.assess_item_health(None, has_cash_accounts=True, now=NOW)["status"] == "unknown"
    no_ts = summarize_item_status(_raw())
    assert sync_service.assess_item_health(no_ts, has_cash_accounts=True, now=NOW)["status"] == "unknown"
    failed_check = sync_service.assess_item_health(None, has_cash_accounts=True, now=NOW, check_error="timeout")
    assert failed_check["status"] == "unknown"
    assert "timeout" in failed_check["message"]


# ---------------------------------------------------------------------------
# sync_single_item wiring
# ---------------------------------------------------------------------------

@pytest.fixture
def plaid_item(db):
    item = PlaidItem(
        item_id="test-item-id",
        access_token="enc:v1:placeholder",
        institution_id="ins_1",
        institution_name="Test Bank",
        cursor=None,
    )
    db.add(item)
    db.commit()
    return item


def _patch_sync(monkeypatch, item_status_fn):
    monkeypatch.setattr(sync_service, "get_account_balances", lambda client, token: [{
        "account_id": "acct-1", "name": "Checking", "official_name": None,
        "type": "depository", "subtype": "checking", "mask": "0000",
        "balances": {"current": 500.0, "available": 500.0, "iso_currency_code": "USD"},
    }])
    monkeypatch.setattr(sync_service, "sync_transactions", lambda client, token, cur: {
        "added": [], "modified": [], "removed": [], "cursor": "cur-1",
    })
    monkeypatch.setattr(sync_service, "decrypt_token", lambda t: "access-token")
    monkeypatch.setattr(sync_service, "is_encrypted", lambda t: True)
    monkeypatch.setattr(sync_service, "get_item_status", item_status_fn)


def test_sync_stamps_plaids_refresh_date_and_reports_stale(db, plaid_item, monkeypatch):
    week_ago = dt.datetime.now(UTC) - dt.timedelta(days=7)
    raw = _raw(txn_ok=_iso(week_ago), txn_fail=_iso(dt.datetime.now(UTC) - dt.timedelta(hours=1)))
    _patch_sync(monkeypatch, lambda client, token: summarize_item_status(raw))

    result = sync_service.sync_single_item(db, client=None, item=plaid_item)

    acct = db.query(Account).one()
    assert acct.balance_as_of == week_ago.astimezone().date()
    assert result["health"]["status"] == "stale"


def test_sync_survives_item_status_failure(db, plaid_item, monkeypatch):
    def boom(client, token):
        raise RuntimeError("Plaid /item/get 500: INTERNAL_SERVER_ERROR")
    _patch_sync(monkeypatch, boom)

    result = sync_service.sync_single_item(db, client=None, item=plaid_item)

    assert db.query(Account).one().balance_as_of == dt.date.today()  # old behavior preserved
    assert result["health"]["status"] == "unknown"
    assert plaid_item.cursor == "cur-1"  # the sync itself still completed


# ---------------------------------------------------------------------------
# item_health_report + GET /api/plaid/items/health
# ---------------------------------------------------------------------------

def test_item_health_report_per_item(db, factory, monkeypatch):
    monkeypatch.setattr(sync_service, "decrypt_token", lambda t: "tok-" + t)
    bank = PlaidItem(item_id="i-bank", access_token="bank", institution_name="Test Bank")
    broker = PlaidItem(item_id="i-broker", access_token="broker", institution_name="Test Broker")
    db.add_all([bank, broker])
    db.flush()
    checking = factory.account(name="Checking", plaid_item_id=bank.id)
    factory.account(name="IRA", type="investment", subtype="ira", plaid_item_id=broker.id)
    factory.transaction(account_id=checking.id, date=dt.date(2026, 3, 13))
    factory.transaction(account_id=checking.id, date=dt.date(2026, 3, 11))
    factory.commit()

    responses = {
        "tok-bank": summarize_item_status(_raw(
            txn_ok=_iso(NOW - dt.timedelta(days=8)), txn_fail=_iso(NOW - dt.timedelta(hours=3)))),
        "tok-broker": summarize_item_status(_raw(inv_ok=_iso(NOW - dt.timedelta(hours=6)))),
    }
    report = sync_service.item_health_report(db, client=object(), fetch=lambda c, tok: responses[tok], now=NOW)

    by_name = {r["institution_name"]: r for r in report}
    assert by_name["Test Bank"]["status"] == "stale"
    assert by_name["Test Bank"]["latest_transaction_date"] == "2026-03-13"
    assert by_name["Test Bank"]["account_ids"] == [checking.id]
    assert by_name["Test Broker"]["status"] == "ok"
    assert by_name["Test Broker"]["latest_transaction_date"] is None
    assert by_name["Test Bank"]["checked_at"] == NOW.isoformat()


def test_report_reuses_recent_status_when_max_age_given(db, monkeypatch):
    monkeypatch.setattr(sync_service, "decrypt_token", lambda t: t)
    db.add(PlaidItem(item_id="i1", access_token="t", institution_name="Test Bank", institution_id="ins_1"))
    db.commit()
    stale = summarize_item_status(_raw(
        txn_ok=_iso(NOW - dt.timedelta(days=5)), txn_fail=_iso(NOW - dt.timedelta(hours=1))))
    calls = []

    def fetch(client, token):
        calls.append(token)
        return stale

    def boom(client, token):
        raise AssertionError("should have used the cached status")

    first = sync_service.item_health_report(db, client=object(), fetch=fetch, now=NOW)
    assert first[0]["status"] == "stale" and first[0]["institution_id"] == "ins_1"

    later = NOW + dt.timedelta(hours=5)
    cached = sync_service.item_health_report(
        db, client=object(), fetch=boom, now=later, max_age=dt.timedelta(hours=6))
    assert cached[0]["status"] == "stale"
    assert cached[0]["checked_at"] == NOW.isoformat()
    assert len(calls) == 1

    expired = NOW + dt.timedelta(hours=7)
    fresh = sync_service.item_health_report(
        db, client=object(), fetch=fetch, now=expired, max_age=dt.timedelta(hours=6))
    assert len(calls) == 2
    assert fresh[0]["checked_at"] == expired.isoformat()


def test_sync_fills_status_cache_for_the_dashboard(db, plaid_item, monkeypatch):
    raw = _raw(txn_ok=_iso(dt.datetime.now(UTC) - dt.timedelta(days=6)),
               txn_fail=_iso(dt.datetime.now(UTC) - dt.timedelta(hours=1)))
    _patch_sync(monkeypatch, lambda client, token: summarize_item_status(raw))
    sync_service.sync_single_item(db, client=None, item=plaid_item)

    def boom(client, token):
        raise AssertionError("dashboard read should not call Plaid right after a sync")

    report = sync_service.item_health_report(db, client=object(), fetch=boom, max_age=dt.timedelta(hours=6))
    assert report[0]["status"] == "stale"


def test_item_health_report_marks_failed_check_unknown(db, monkeypatch):
    monkeypatch.setattr(sync_service, "decrypt_token", lambda t: t)
    db.add(PlaidItem(item_id="i1", access_token="t", institution_name="Test Bank"))
    db.commit()

    def boom(client, token):
        raise RuntimeError("network down")
    report = sync_service.item_health_report(db, client=object(), fetch=boom, now=NOW)
    assert report[0]["status"] == "unknown"
    assert "network down" in report[0]["message"]


def test_items_health_route(db, monkeypatch):
    monkeypatch.setattr(sync_service, "decrypt_token", lambda t: t)
    monkeypatch.setattr(sync_service, "get_plaid_client", lambda: object())
    monkeypatch.setattr(sync_service, "get_item_status",
                        lambda client, token: summarize_item_status(_raw(error=LOGIN_REQUIRED)))
    db.add(PlaidItem(item_id="i1", access_token="t", institution_name="Test Bank"))
    db.commit()

    app.dependency_overrides[get_db] = lambda: db
    app.dependency_overrides[get_real_db] = lambda: db
    try:
        res = TestClient(app).get("/api/plaid/items/health")
    finally:
        app.dependency_overrides.clear()

    assert res.status_code == 200, res.text
    body = res.json()
    assert body["stale_after_hours"] == sync_service.ITEM_STALE_AFTER_HOURS
    assert body["silent_stale_after_days"] == sync_service.ITEM_SILENT_STALE_AFTER_DAYS
    assert body["items"][0]["status"] == "error"
    assert body["items"][0]["error"]["code"] == "ITEM_LOGIN_REQUIRED"


def test_items_health_route_max_age_param(db, monkeypatch):
    monkeypatch.setattr(sync_service, "decrypt_token", lambda t: t)
    db.add(PlaidItem(item_id="i1", access_token="t", institution_name="Test Bank"))
    db.commit()
    item_id = db.query(PlaidItem).one().id
    sync_service._remember_item_status(item_id, summarize_item_status(_raw(error=LOGIN_REQUIRED)), None)

    def boom(client, token):
        raise AssertionError("max_age_minutes should have served the cached status")
    monkeypatch.setattr(sync_service, "get_item_status", boom)
    monkeypatch.setattr(sync_service, "get_plaid_client", lambda: object())

    app.dependency_overrides[get_db] = lambda: db
    app.dependency_overrides[get_real_db] = lambda: db
    try:
        client = TestClient(app)
        ok = client.get("/api/plaid/items/health?max_age_minutes=360")
        bad = client.get("/api/plaid/items/health?max_age_minutes=-5")
    finally:
        app.dependency_overrides.clear()

    assert ok.status_code == 200, ok.text
    assert ok.json()["items"][0]["status"] == "error"
    assert bad.status_code == 422
