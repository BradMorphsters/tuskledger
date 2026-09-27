"""Pay schedules: split deposits, semi-monthly vs bi-weekly, holiday shifts,
extra-paycheck months, overrides. All fixtures are fictional."""
import datetime as dt

import pytest

from app.services import pay_calendar as pc
from app.services.pay_schedule import (
    OverrideError,
    build_income_profile,
    clear_override,
    set_override,
    validate_override,
)
from app.services.recurring import detect_streams

D = dt.date
TODAY = D(2026, 9, 26)


def _paydays(schedule, start=D(2026, 3, 1), end=TODAY):
    return schedule.paydays(start, end)


# Fixtures are GENERATED from generic schedules (not copied from anyone's
# bank feed): an every-other-Friday earner and a 15th-&-last-day earner.
BIWEEKLY_DATES = _paydays(pc.PaySchedule(pc.BIWEEKLY, anchor=D(2026, 3, 6)))
SEMIMONTHLY_DATES = _paydays(pc.PaySchedule(pc.SEMIMONTHLY, days=(15, pc.LAST_DAY)))


@pytest.fixture(autouse=True)
def _us_holidays():
    """Every test starts on the default US calendar, whatever a test changed."""
    pc.configure_holidays("us")
    yield
    pc.configure_holidays("us")


# ─── pay_calendar ────────────────────────────────────────────────────────
def test_bank_holidays_observed_rules():
    h = pc.bank_holidays(2026)
    assert D(2026, 7, 3) in h          # Jul 4 is a Saturday → Friday
    assert D(2026, 6, 19) in h         # Juneteenth
    assert D(2026, 11, 26) in h        # Thanksgiving
    assert D(2027, 1, 1) in pc.bank_holidays(2027)


def test_business_day_shifts_both_directions():
    assert pc.previous_business_day(D(2026, 7, 5)) == D(2026, 7, 2)   # Sun → Fri holiday → Thu
    assert pc.next_business_day(D(2026, 7, 4)) == D(2026, 7, 6)       # Sat → Mon
    assert pc.previous_business_day(D(2026, 9, 25)) == D(2026, 9, 25)
    assert pc.adjust_payday(D(2026, 7, 4), pc.SHIFT_NONE) == D(2026, 7, 4)


def test_holiday_calendar_is_configurable():
    pc.configure_holidays("none")
    assert pc.bank_holidays(2026) == frozenset()
    assert pc.previous_business_day(D(2026, 7, 3)) == D(2026, 7, 3)   # a normal Friday now
    pc.configure_holidays("none", extra=[D(2026, 12, 24)])
    assert pc.previous_business_day(D(2026, 12, 24)) == D(2026, 12, 23)


def test_fixtures_look_like_real_schedules():
    assert len(BIWEEKLY_DATES) == 15 and all(d.weekday() == 4 for d in BIWEEKLY_DATES)
    assert len(SEMIMONTHLY_DATES) == 13


def test_fit_semimonthly_not_biweekly():
    sched, fit = pc.fit_schedule(SEMIMONTHLY_DATES)
    assert sched.frequency == pc.SEMIMONTHLY
    assert sched.days == (15, pc.LAST_DAY)
    assert fit == 1.0
    assert sched.per_year == 24


def test_fit_biweekly():
    sched, fit = pc.fit_schedule(BIWEEKLY_DATES)
    assert sched.frequency == pc.BIWEEKLY
    assert fit == 1.0
    assert sched.anchor.weekday() == 4  # Friday


def test_fit_tolerates_holiday_shifted_paydays():
    # Every-other-Monday pay that hits MLK Day and Presidents Day (paid the
    # Friday before) and Memorial Day.
    sched = pc.PaySchedule(pc.BIWEEKLY, anchor=D(2026, 1, 5))
    dates = _paydays(sched, D(2026, 1, 1), D(2026, 6, 30))
    assert D(2026, 1, 16) in dates and D(2026, 2, 13) in dates
    fitted, fit = pc.fit_schedule(dates)
    assert fitted.frequency == pc.BIWEEKLY and fit == 1.0
    assert fitted.anchor.weekday() == 0


def test_biweekly_holiday_payday_moves_earlier():
    sched = pc.PaySchedule(pc.BIWEEKLY, anchor=D(2027, 1, 1))  # a Friday New Year's Day
    assert pc.month_paydays(sched, 2026, 12)[-1] == D(2026, 12, 31)
    assert pc.month_paydays(sched, 2027, 1) == [D(2027, 1, 15), D(2027, 1, 29)]
    fx, _ = pc.fit_schedule(BIWEEKLY_DATES)
    assert pc.month_paydays(fx, 2026, 12) == [D(2026, 12, 11), D(2026, 12, 24)]  # Christmas


def test_semimonthly_projection_stays_on_its_days():
    sched, _ = pc.fit_schedule(SEMIMONTHLY_DATES)
    days = sched.paydays(D(2026, 9, 27), D(2026, 12, 31))
    assert days == [D(2026, 9, 30), D(2026, 10, 15), D(2026, 10, 30), D(2026, 11, 13),
                    D(2026, 11, 30), D(2026, 12, 15), D(2026, 12, 31)]


def test_fit_learns_next_business_day_rule():
    sched = pc.PaySchedule(pc.SEMIMONTHLY, days=(1, 16), shift=pc.SHIFT_AFTER)
    fitted, fit = pc.fit_schedule(_paydays(sched, D(2026, 1, 1), D(2026, 9, 1)))
    assert fitted.days == (1, 16) and fitted.shift == pc.SHIFT_AFTER and fit == 1.0


def test_fit_learns_weekend_posting_rule():
    saturdays = [D(2026, 8, 1) + dt.timedelta(days=7 * i) for i in range(8)]
    fitted, fit = pc.fit_schedule(saturdays)
    assert fitted.frequency == pc.WEEKLY and fitted.shift == pc.SHIFT_NONE
    assert fitted.next_payday(saturdays[-1]).weekday() == 5


def test_monthly_and_weekly_fit():
    monthly = [pc.previous_business_day(D(2026, m, 1)) for m in range(2, 9)]
    assert pc.fit_schedule(monthly)[0].frequency == pc.MONTHLY
    weekly = [D(2026, 8, 7) + dt.timedelta(days=7 * i) for i in range(8)]
    assert pc.fit_schedule(weekly)[0].frequency == pc.WEEKLY


def test_irregular_dates_do_not_fit():
    dates = [D(2026, 1, 3), D(2026, 1, 19), D(2026, 2, 1), D(2026, 2, 25), D(2026, 3, 9)]
    assert pc.fit_schedule(dates) is None


# ─── recurring detector integration ──────────────────────────────────────
def _add_split_biweekly(factory, checking, savings, big=2000.0, small=600.0,
                        dates=BIWEEKLY_DATES, name="DEPOSIT ACME HOSPITAL TYPE: PAYROLL"):
    for d in dates:
        factory.transaction(account_id=checking.id, amount=-big, date=d, name=name,
                            merchant_name=None, category="Income")
        factory.transaction(account_id=savings.id, amount=-small, date=d, name=name,
                            merchant_name=None, category="Income")


def _add_semimonthly(factory, acct, amount=1500.0, name="DEPOSIT RIVERSIDE SCHOOLS TYPE: PAYROLL"):
    for d in SEMIMONTHLY_DATES:
        factory.transaction(account_id=acct.id, amount=-amount, date=d, name=name,
                            merchant_name=None, category="Income")
        # A small same-day side deposit (e.g. to a savings pocket).
        factory.transaction(account_id=acct.id, amount=-100.0, date=d, name=name,
                            merchant_name=None, category="Income")


def test_split_deposit_is_one_paycheck(db, factory):
    chk = factory.account(name="Checking")
    sav = factory.account(name="Savings", subtype="savings")
    _add_split_biweekly(factory, chk, sav)
    factory.commit()
    from app.models import Transaction
    streams = [s for s in detect_streams(db.query(Transaction).all()) if s.is_income]
    assert len(streams) == 1
    s = streams[0]
    assert s.frequency == "bi-weekly"
    assert s.median_amount == pytest.approx(2600.0)
    assert len(s.occurrences) == len(BIWEEKLY_DATES)


def test_young_ledger_streams_are_not_seasonal(db, factory):
    acct = factory.account()
    for m in range(1, 10):  # Jan-Sep only, no gap
        factory.transaction(account_id=acct.id, amount=900.0, date=D(2026, m, 3),
                            merchant_name="Home Mortgage Co")
    factory.commit()
    from app.models import Transaction
    s = detect_streams(db.query(Transaction).all())[0]
    assert s.is_seasonal is False
    assert s.monthly_rate == pytest.approx(900.0)


def test_real_off_season_gap_is_still_seasonal(db, factory):
    acct = factory.account()
    for y in (2025, 2026):
        for m in range(4, 11):
            factory.transaction(account_id=acct.id, amount=60.0, date=D(y, m, 15),
                                merchant_name="Lawn Care")
    factory.commit()
    from app.models import Transaction
    s = detect_streams(db.query(Transaction).all())[0]
    assert s.is_seasonal is True


# ─── household profile ───────────────────────────────────────────────────
@pytest.fixture
def household(db, factory):
    chk = factory.account(name="Checking")
    sav = factory.account(name="Savings", subtype="savings")
    _add_split_biweekly(factory, chk, sav)
    _add_semimonthly(factory, chk)
    factory.commit()
    return db


def test_profile_detects_both_earners(household):
    p = build_income_profile(household, TODAY)
    freqs = {e["schedule"]["frequency"]: e for e in p["earners"]}
    assert set(freqs) == {"bi-weekly", "semi-monthly"}
    bw, sm = freqs["bi-weekly"], freqs["semi-monthly"]
    assert bw["per_check"] == pytest.approx(2600.0)
    assert bw["normalized_monthly"] == pytest.approx(2600 * 26 / 12, abs=0.01)
    assert bw["baseline_monthly"] == pytest.approx(5200.0)
    assert len(bw["split_deposit"]) == 2
    assert sm["per_check"] == pytest.approx(1600.0)
    assert sm["normalized_monthly"] == pytest.approx(3200.0)
    assert sm["baseline_monthly"] == pytest.approx(3200.0)
    assert bw["next_paydays"][0] == "2026-10-02"
    assert sm["next_paydays"][0] == "2026-09-30"
    assert all(e["status"] == "on_track" for e in p["earners"])
    hh = p["household"]
    assert hh["baseline_monthly"] == pytest.approx(8400.0)
    assert hh["extra_per_year"] == pytest.approx(5200.0)
    assert hh["next_payday"]["date"] == "2026-09-30"


def test_profile_flags_extra_paycheck_months(household):
    p = build_income_profile(household, TODAY)
    extra = {m["month"]: m for m in p["extra_paycheck_months"]}
    assert list(extra) == ["2026-10", "2027-04"]
    assert extra["2026-10"]["dates"] == ["2026-10-30"]
    assert extra["2026-10"]["extra_amount"] == pytest.approx(2600.0)
    months = {m["month"]: m for m in p["months"]}
    assert months["2026-05"]["is_extra_month"] and months["2026-05"]["period"] == "past"
    assert months["2026-10"]["paycheck_count"] == 5  # 3 bi-weekly + 2 semi-monthly
    assert months["2026-12"]["paycheck_count"] == 4
    assert months["2027-01"]["paycheck_count"] == 4
    assert not months["2027-01"]["is_extra_month"]
    cur = p["this_month"]
    assert cur["month"] == "2026-09" and cur["remaining_total"] == pytest.approx(1600.0)  # Sep 30 check


def test_profile_late_and_raise(db, factory):
    acct = factory.account()
    for i, d in enumerate(BIWEEKLY_DATES):
        amt = 2000.0 if i < 10 else 2100.0  # a 5% raise for the last 5 checks
        factory.transaction(account_id=acct.id, amount=-amt, date=d,
                            name="DEPOSIT ACME HOSPITAL TYPE: PAYROLL", merchant_name=None)
    factory.commit()
    # The Oct 2 payday passed with no deposit → late by Oct 7.
    p = build_income_profile(db, D(2026, 10, 7))
    e = p["earners"][0]
    assert e["status"] == "late" and e["expected_missed"] == "2026-10-02"
    assert e["change"]["direction"] == "up"
    assert e["change"]["since"] == BIWEEKLY_DATES[10].isoformat()
    assert e["per_check"] == pytest.approx(2100.0)


def test_profile_ended_stream_excluded_from_totals(db, factory):
    acct = factory.account()
    for d in BIWEEKLY_DATES[:6]:
        factory.transaction(account_id=acct.id, amount=-2000.0, date=d,
                            name="DEPOSIT OLD JOB TYPE: PAYROLL", merchant_name=None)
    factory.commit()
    p = build_income_profile(db, TODAY)
    assert p["earners"][0]["status"] == "ended"
    assert p["household"]["baseline_monthly"] == 0


def test_credit_card_credits_are_not_paychecks(db, factory):
    card = factory.account(name="Card", type="credit", subtype="credit card")
    factory.account(name="Checking")
    for d in BIWEEKLY_DATES:
        factory.transaction(account_id=card.id, amount=-500.0, date=d, merchant_name="Card Rewards")
    factory.commit()
    assert build_income_profile(db, TODAY)["earners"] == []


def test_overrides_nickname_hide_and_schedule(household):
    p = build_income_profile(household, TODAY)
    sm = next(e for e in p["earners"] if e["schedule"]["frequency"] == "semi-monthly")
    set_override(household, sm["key"], {"nickname": "Partner"})
    p = build_income_profile(household, TODAY)
    sm = next(e for e in p["earners"] if e["key"] == sm["key"])
    assert sm["display_name"] == "Partner"
    assert any(u["name"] == "Partner" for u in p["upcoming"])

    set_override(household, sm["key"], {"frequency": "semi-monthly", "days_of_month": [1, 15]})
    sm = next(e for e in build_income_profile(household, TODAY)["earners"] if e["key"] == sm["key"])
    assert sm["schedule_source"] == "custom"
    assert sm["schedule"]["days_of_month"] == [1, 15]

    set_override(household, sm["key"], {"shift": "after"})
    sm = next(e for e in build_income_profile(household, TODAY)["earners"] if e["key"] == sm["key"])
    assert sm["schedule"]["shift"] == "after"
    assert "2026-11-02" in sm["next_paydays"]  # Nov 1 is a Sunday → Monday

    set_override(household, sm["key"], {"hidden": True})
    p = build_income_profile(household, TODAY)
    assert p["household"]["earners"] == 1

    clear_override(household, sm["key"])
    p = build_income_profile(household, TODAY)
    assert p["household"]["earners"] == 2


def test_validate_override_rejects_bad_input():
    with pytest.raises(OverrideError):
        validate_override({"frequency": "fortnightly"})
    with pytest.raises(OverrideError):
        validate_override({"frequency": "semi-monthly", "days_of_month": [15]})
    with pytest.raises(OverrideError):
        validate_override({"per_check": -5})
    with pytest.raises(OverrideError):
        validate_override({"shift": "sideways"})
    assert validate_override({"nickname": "  "}) == {"nickname": None}


# ─── API ─────────────────────────────────────────────────────────────────
class _PinnedDate(dt.date):
    @classmethod
    def today(cls):
        return TODAY


@pytest.fixture
def client(household, monkeypatch):
    from fastapi.testclient import TestClient

    from app.database import get_db, get_real_db
    from app.main import app
    from app.routers import analytics as analytics_router
    from app.routers import income as income_router

    # The endpoints read date.today(); pin it to the fixture's calendar.
    monkeypatch.setattr(income_router, "date", _PinnedDate)
    monkeypatch.setattr(analytics_router, "date", _PinnedDate)

    app.dependency_overrides[get_db] = lambda: household
    app.dependency_overrides[get_real_db] = lambda: household
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.clear()


def test_income_api_roundtrip(client):
    r = client.get("/api/income/schedule")
    assert r.status_code == 200
    body = r.json()
    assert len(body["earners"]) == 2 and len(body["months"]) == 25
    key = next(e["key"] for e in body["earners"] if e["schedule"]["frequency"] == "semi-monthly")

    r = client.put(f"/api/income/earners/{key}", json={"nickname": "Partner"})
    assert r.status_code == 200
    assert any(e["display_name"] == "Partner" for e in r.json()["earners"])

    r = client.put(f"/api/income/earners/{key}", json={"frequency": "biweekly"})
    assert r.status_code == 422

    r = client.delete(f"/api/income/earners/{key}")
    assert all(e["nickname"] is None for e in r.json()["earners"])


def test_forecast_and_calendar_use_real_paydays(client):
    # Every income event must land on a date the fitted calendars produce.
    sched = client.get("/api/income/schedule").json()
    allowed = set()
    for m in sched["months"]:
        allowed |= {p["date"] for p in m["paychecks"]}
    cal = client.get("/api/analytics/cashflow-calendar?days=60").json()
    income_dates = {e["date"] for e in cal["events"] if e["type"] == "income"}
    assert income_dates and income_dates <= allowed
    assert "2026-09-30" in income_dates and "2026-10-02" in income_dates
    fc = client.get("/api/analytics/cash-flow-forecast?days=60").json()
    inflows = {e["date"] for e in fc["upcoming_events"] if e["kind"] == "inflow"}
    assert inflows and inflows <= allowed


# ─── Ask Tusk ────────────────────────────────────────────────────────────
def test_ask_pay_schedule_and_next_paycheck(household):
    from app.services import assistant_retrieval as ret

    r = ret.answer(household, "When is our next 3 paycheck month?", None, today=TODAY)
    assert r["intent"] == "pay_schedule"
    assert "twice a month (15th & last day)" in r["answer"]
    assert "every other friday" in r["answer"]
    assert "next extra-paycheck month is Oct 2026" in r["answer"]

    r = ret.answer(household, "When is my next paycheck?", None, today=TODAY)
    assert r["intent"] == "next_paycheck"
    assert "Sep 30" in r["answer"] and "Then " in r["answer"]


def test_payer_key_merges_reworded_deposits(db, factory):
    """A bank re-wording the same employer's memo must not split the job into
    a live stream plus an 'ended' fragment."""
    acct = factory.account()
    for i, d in enumerate(BIWEEKLY_DATES):
        factory.transaction(account_id=acct.id, amount=-2000.0, date=d,
                            name=f"DEPOSIT ACME HOSPITAL TYPE: PAYROLL ID: {1000 + i}",
                            merchant_name="Acme Hospital Inc" if i < 2 else None)
    factory.commit()
    p = build_income_profile(db, TODAY)
    assert len(p["earners"]) == 1
    assert p["earners"][0]["paychecks_seen"] == len(BIWEEKLY_DATES)


def test_nickname_flows_into_calendar_events(client):
    body = client.get("/api/income/schedule").json()
    key = body["earners"][0]["key"]
    client.put(f"/api/income/earners/{key}", json={"nickname": "Alex"})
    cal = client.get("/api/analytics/cashflow-calendar?days=90").json()
    names = {e["merchant"] for e in cal["events"] if e["type"] == "income"}
    assert "Alex paycheck" in names
