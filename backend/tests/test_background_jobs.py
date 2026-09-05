"""Every background job the app promises is actually registered.

Why this exists: budget alerts shipped reading fields the API never
returned and silently never fired; nothing exercised the wiring. This
test pins the scheduler registration — and the startup hooks — so a
renamed id, a removed add_job, or a job that raises at import shows up
in CI instead of months later.
"""
import importlib
import types


class _FakeScheduler:
    def __init__(self):
        self.jobs = {}

    def add_job(self, func, trigger, *, id, **kw):
        assert callable(func), id
        assert trigger in ("interval", "cron"), (id, trigger)
        if trigger == "interval":
            assert any(k in kw for k in ("hours", "minutes", "seconds")), id
        self.jobs[id] = (func, trigger, kw)

    def start(self):  # pragma: no cover — never called by register_*
        raise AssertionError("register_background_jobs must not start the scheduler")


def _main():
    # app.main builds the FastAPI app at import; that's fine in tests
    # (settings come from .env.example defaults / env) and is exactly what
    # we want to smoke.
    return importlib.import_module("app.main")


def test_every_expected_job_is_registered_exactly_once():
    main = _main()
    sched = _FakeScheduler()
    settings = types.SimpleNamespace(SYNC_INTERVAL_HOURS=6)
    main.register_background_jobs(sched, settings)
    assert set(sched.jobs) == set(main.EXPECTED_JOB_IDS)


def test_budget_carry_forward_is_a_daily_cron_just_after_midnight():
    main = _main()
    sched = _FakeScheduler()
    main.register_background_jobs(sched, types.SimpleNamespace(SYNC_INTERVAL_HOURS=6))
    func, trigger, kw = sched.jobs["budget_carry_forward"]
    assert trigger == "cron" and kw["hour"] == 0 and 0 < kw["minute"] < 30
    assert func is main._carry_forward_budget_job


def test_plaid_sync_interval_follows_settings():
    main = _main()
    sched = _FakeScheduler()
    main.register_background_jobs(sched, types.SimpleNamespace(SYNC_INTERVAL_HOURS=4))
    _, trigger, kw = sched.jobs["plaid_sync"]
    assert trigger == "interval" and kw["hours"] == 4


def test_startup_hook_is_safe_when_db_is_empty(db, monkeypatch):
    """The carry-forward startup hook must never raise — a failure here
    would stop the API from booting."""
    main = _main()
    monkeypatch.setattr(main, "SessionLocal", lambda: db)
    main._carry_forward_budget_job()          # empty DB → nothing to clone → no error
