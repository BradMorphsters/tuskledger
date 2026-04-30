"""Tests for /analytics/retirement-projection.

Smoke + invariant tests for the headline retirement projection. Doesn't
attempt to validate every output field of the 1000-line endpoint, but
verifies:
  - Empty DB (no investment accounts) → projection runs, returns
    starting balance of 0, doesn't crash.
  - Pension reduces effective FI number vs. base FI number.
  - SS haircut reduces effective income.
  - Required vs. on_track relationship is consistent.
  - Two-phase simulation always produces year_by_year of expected length.
"""
import datetime
from sqlalchemy.orm import Session

from app.routers.retirement import retirement_projection


def test_projection_with_empty_db(db: Session):
    """No accounts → starting balance 0, FI number based purely on
    desired_income/wd_rate, no crash."""
    result = retirement_projection(
        current_age=39, retirement_age=65,
        desired_annual_income=80_000, db=db,
    )
    assert result["current_assets"] == 0.0
    assert result["fi_number"] == 80_000 / 0.04  # = 2,000,000
    # Projection still runs — accumulation_years=26, withdrawal=45.
    assert len(result["year_by_year"]) == 26 + 45


def test_projection_with_assets_grows_over_time(db: Session, factory):
    """A portfolio with starting balance and contributions should show
    monotonic growth during the accumulation phase."""
    factory.account(
        name="401k", type="investment", subtype="401k",
        current_balance=200_000.0,
    )
    factory.commit()
    # Mark as tax_deferred so it counts toward investable assets.
    from app.models import Account
    db.query(Account).update({Account.tax_bucket: "tax_deferred"})
    db.commit()

    result = retirement_projection(
        current_age=39, retirement_age=65,
        desired_annual_income=80_000,
        annual_contribution=20_000,
        db=db,
    )
    assert result["current_assets"] == 200_000.0
    accumulation_rows = [
        r for r in result["year_by_year"] if r["phase"] == "accumulating"
    ]
    # First year balance should be higher than starting (return + contribution).
    assert accumulation_rows[0]["balance"] > 200_000
    # Final accumulation year should be much higher.
    assert accumulation_rows[-1]["balance"] > accumulation_rows[0]["balance"]


def test_pension_reduces_effective_fi_number(db: Session):
    """Adding a pension should reduce effective_fi_number vs. base
    fi_number (the portfolio only has to fund the gap)."""
    no_pension = retirement_projection(
        current_age=50, retirement_age=65,
        desired_annual_income=80_000,
        db=db,
    )
    with_pension = retirement_projection(
        current_age=50, retirement_age=65,
        desired_annual_income=80_000,
        pension_annual=30_000,
        pension_start_age=65,
        db=db,
    )
    # Base FI is identical — same desired income.
    assert no_pension["fi_number"] == with_pension["fi_number"]
    # But effective FI shrinks because pension covers part of spending.
    assert with_pension["effective_fi_number"] < no_pension["effective_fi_number"]


def test_ss_haircut_reduces_at_start_value(db: Session):
    """SS reduction percent should reduce the at-start value of every
    SS stream proportionally — used to model Trust Fund depletion."""
    full = retirement_projection(
        current_age=50, retirement_age=65,
        desired_annual_income=80_000,
        ss_annual=30_000, ss_start_age=67,
        db=db,
    )
    haircut = retirement_projection(
        current_age=50, retirement_age=65,
        desired_annual_income=80_000,
        ss_annual=30_000, ss_start_age=67,
        ss_reduction_pct=0.23,  # SSA Trustees' depletion scenario
        db=db,
    )
    # 23% haircut should bring at-start from ~30k to ~23.1k.
    assert abs(full["ss_at_start"] - 30_000) < 1
    assert abs(haircut["ss_at_start"] - (30_000 * 0.77)) < 1


def test_year_by_year_length_matches_accumulation_plus_horizon(db: Session):
    """Sanity: chart horizon now ties to max_sustainable_target_age
    (default 105) instead of a fixed 45-yr post-retirement window. The
    accumulation_years + horizon should reach exactly target_age."""
    result = retirement_projection(
        current_age=30, retirement_age=60,
        desired_annual_income=60_000,
        db=db,
    )
    last_age = result["year_by_year"][-1]["age"]
    # Default max_sustainable_target_age is 105, so the chart should
    # extend to that age (or just past it, since horizon = target - last
    # retirement + 1 with a 30-year floor).
    assert last_age >= 105


def test_year_by_year_horizon_floors_at_30(db: Session):
    """If the user picks an unreasonably low target age, the chart
    floor (30 years) prevents a useless stub."""
    result = retirement_projection(
        current_age=55, retirement_age=60,
        desired_annual_income=60_000,
        max_sustainable_target_age=70,  # absurdly low
        db=db,
    )
    last_age = result["year_by_year"][-1]["age"]
    # 30-year floor: 60 + 30 = 90 minimum, even though target_age=70.
    assert last_age >= 89


def test_invalid_retirement_age_raises_400(db: Session):
    """Retirement age ≤ current age is nonsensical and should 400."""
    import pytest
    from fastapi import HTTPException
    with pytest.raises(HTTPException) as exc_info:
        retirement_projection(
            current_age=65, retirement_age=60,
            desired_annual_income=80_000,
            db=db,
        )
    assert exc_info.value.status_code == 400


def test_monte_carlo_returns_aggregated_results(db: Session):
    """When monte_carlo_runs > 0, the response should include a
    monte_carlo dict with success_probability and percentile bands."""
    result = retirement_projection(
        current_age=50, retirement_age=65,
        desired_annual_income=80_000,
        monte_carlo_runs=20,  # small N for speed
        db=db,
    )
    assert result["monte_carlo"] is not None
    mc = result["monte_carlo"]
    assert mc["n_runs"] == 20
    assert 0.0 <= mc["success_probability"] <= 1.0
    assert len(mc["year_by_year_pct"]) > 0
    # Each percentile row has the expected p10..p90 keys.
    first = mc["year_by_year_pct"][0]
    for key in ("balance_p10", "balance_p25", "balance_p50", "balance_p75", "balance_p90"):
        assert key in first


# ─── 4-bucket aggregation + per-account Roth split ──────────────────


def test_buckets_aggregate_into_four_categories(db: Session, factory):
    """tax_deferred, roth, taxable, hsa — each account's tax_bucket
    routes its balance into the corresponding bucket key in the
    response. excluded skips entirely."""
    factory.account(name="401k", type="investment", current_balance=100_000)
    factory.account(name="Roth IRA", type="investment", current_balance=40_000)
    factory.account(name="Brokerage", type="investment", current_balance=20_000)
    factory.account(name="HSA", type="investment", current_balance=15_000)
    factory.account(name="Borrowed", type="investment", current_balance=50_000)
    factory.commit()
    from app.models import Account
    db.query(Account).filter_by(name="401k").update({"tax_bucket": "tax_deferred"})
    db.query(Account).filter_by(name="Roth IRA").update({"tax_bucket": "roth"})
    db.query(Account).filter_by(name="Brokerage").update({"tax_bucket": "taxable"})
    db.query(Account).filter_by(name="HSA").update({"tax_bucket": "hsa"})
    db.query(Account).filter_by(name="Borrowed").update({"tax_bucket": "excluded"})
    db.commit()

    result = retirement_projection(
        current_age=39, retirement_age=65,
        desired_annual_income=60_000, db=db,
    )
    buckets = result["buckets"]
    assert buckets["tax_deferred"] == 100_000
    assert buckets["roth"] == 40_000
    assert buckets["taxable"] == 20_000
    assert buckets["hsa"] == 15_000
    # excluded: shows up in excluded_total, NOT in buckets sum.
    assert result["excluded_total"] == 50_000
    assert result["current_assets"] == 175_000  # 100+40+20+15, no excluded


def test_roth_split_pct_routes_fraction_to_roth_bucket(db: Session, factory):
    """When an account is tagged tax_deferred with roth_split_pct=0.6,
    60% of its balance lands in the roth bucket and 40% in tax_deferred.
    Models 401(k)s with mixed pre-tax + Roth contributions."""
    factory.account(name="Mixed 401k", type="investment", current_balance=100_000)
    factory.commit()
    from app.models import Account
    db.query(Account).update({
        "tax_bucket": "tax_deferred",
        "roth_split_pct": 0.6,
    })
    db.commit()

    result = retirement_projection(
        current_age=39, retirement_age=65,
        desired_annual_income=60_000, db=db,
    )
    assert result["buckets"]["roth"] == 60_000
    assert result["buckets"]["tax_deferred"] == 40_000
    # Total still 100k — split, not duplicated.
    assert result["current_assets"] == 100_000


# ─── Roth conversion ladder ─────────────────────────────────────────


def test_roth_conversion_shifts_td_to_roth(db: Session, factory):
    """Activating a Roth conversion ladder should reduce the TD bucket
    and increase the Roth bucket over the conversion window. Lifetime
    tax may go up or down depending on bracket math, but the bucket
    movement must happen."""
    factory.account(name="401k", type="investment", current_balance=500_000)
    factory.commit()
    from app.models import Account
    db.query(Account).update({"tax_bucket": "tax_deferred"})
    db.commit()

    no_conv = retirement_projection(
        current_age=55, retirement_age=60,
        desired_annual_income=80_000,
        db=db,
    )
    with_conv = retirement_projection(
        current_age=55, retirement_age=60,
        desired_annual_income=80_000,
        roth_conversion_amount=20_000,
        roth_conversion_start_age=60,
        roth_conversion_end_age=65,
        db=db,
    )
    # Comparison block must be present whenever the strategy is active.
    assert with_conv["roth_comparison"] is not None
    rc = with_conv["roth_comparison"]
    # 6 years of ~$20k conversions = ~$120k total moved.
    assert 80_000 < rc["total_converted"] < 130_000
    # Both end-balance values populated.
    assert rc["with_strategy_end_balance"] is not None
    assert rc["baseline_end_balance"] is not None


# ─── HSA contribution flow + medical draw ──────────────────────────


def test_hsa_contribution_lands_in_hsa_bucket_not_td(db: Session, factory):
    """Bug fix verification: hsa_annual_contribution must increase the
    HSA bucket each accumulation year, NOT the tax_deferred bucket. If
    this regresses, every HSA-saving user's bucket totals get
    corrupted silently."""
    factory.account(name="HSA", type="investment", current_balance=10_000)
    factory.commit()
    from app.models import Account
    db.query(Account).update({"tax_bucket": "hsa"})
    db.commit()

    no_hsa_contrib = retirement_projection(
        current_age=39, retirement_age=56,
        desired_annual_income=80_000, db=db,
    )
    with_hsa_contrib = retirement_projection(
        current_age=39, retirement_age=56,
        desired_annual_income=80_000,
        hsa_annual_contribution=5_000,  # 17 years × $5k
        db=db,
    )
    # The accumulation row at retirement should show the HSA bucket
    # significantly larger when contributions are active.
    no_ret_row = next(r for r in no_hsa_contrib["year_by_year"] if r["age"] == 56)
    with_ret_row = next(r for r in with_hsa_contrib["year_by_year"] if r["age"] == 56)
    assert with_ret_row["balance_hsa"] > no_ret_row["balance_hsa"] + 70_000  # ~85k+ delta minimum
    # And tax_deferred should NOT be inflated by the HSA contribution
    # (this was the bug — it would have grown TD instead of HSA).
    # TD only grows from market returns here, so the difference should
    # be roughly zero (within rounding).
    assert abs(with_ret_row["balance_tax_deferred"] - no_ret_row["balance_tax_deferred"]) < 100


def test_hsa_pays_healthcare_bridge_tax_free(db: Session, factory):
    """Healthcare bridge cost should be funded from the HSA bucket
    BEFORE taxable / TD draws. The hsa_medical_draw field tallies how
    much was paid tax-free across the run."""
    factory.account(name="HSA", type="investment", current_balance=80_000)
    factory.account(name="401k", type="investment", current_balance=400_000)
    factory.commit()
    from app.models import Account
    db.query(Account).filter_by(name="HSA").update({"tax_bucket": "hsa"})
    db.query(Account).filter_by(name="401k").update({"tax_bucket": "tax_deferred"})
    db.commit()

    result = retirement_projection(
        current_age=55, retirement_age=56,
        desired_annual_income=80_000,
        healthcare_pre_medicare=15_000,
        db=db,
    )
    # Bridge years 56-64 (9 yrs of healthcare) at $15k/yr × growth
    # → HSA covers ~$135k+ tax free.
    total_hsa_med = result["total_hsa_medical_paid"]
    assert total_hsa_med > 50_000  # substantial fraction of bridge funded by HSA


# ─── Step events: contribution + spending shifts ────────────────────


def test_contribution_step_increases_savings_at_age(db: Session, factory):
    """A contribution step at age X should bump the per-year contributed
    amount by the delta starting that year. Mortgage payoff is the
    canonical use case."""
    factory.account(name="401k", type="investment", current_balance=200_000)
    factory.commit()
    from app.models import Account
    db.query(Account).update({"tax_bucket": "tax_deferred"})
    db.commit()

    import json
    result = retirement_projection(
        current_age=39, retirement_age=65,
        desired_annual_income=80_000,
        annual_contribution=20_000,
        step_events_json=json.dumps([
            {"age": 50, "kind": "contribution", "delta": 24_000,
             "duration_years": 0, "label": "mortgage payoff"},
        ]),
        db=db,
    )
    # Year before the step: should be ~base (with wage growth).
    row_49 = next(r for r in result["year_by_year"] if r["age"] == 49)
    # Year after the step: should be base + ~$24k.
    row_50 = next(r for r in result["year_by_year"] if r["age"] == 50)
    assert row_50["contributed"] - row_49["contributed"] > 23_000


def test_spending_step_with_duration_expires(db: Session, factory):
    """A spending step with duration_years=4 should add to spending
    for 4 years, then expire. Models college costs."""
    factory.account(name="401k", type="investment", current_balance=2_000_000)
    factory.commit()
    from app.models import Account
    db.query(Account).update({"tax_bucket": "tax_deferred"})
    db.commit()

    import json
    result = retirement_projection(
        current_age=55, retirement_age=56,
        desired_annual_income=80_000,
        step_events_json=json.dumps([
            {"age": 60, "kind": "spending", "delta": 30_000,
             "duration_years": 4, "label": "college"},
        ]),
        db=db,
    )
    # During the college window (60-63), effective spending is bumped.
    # After it expires (age 64+), back to baseline.
    rows = {r["age"]: r for r in result["year_by_year"]}
    in_college = rows[60]["effective_spending"]
    after_college = rows[64]["effective_spending"]
    # In-college should be ~$30k higher than after.
    assert in_college - after_college > 25_000


# ─── One-time events: positive=expense, negative=inflow ────────────


def test_negative_one_time_event_lands_in_taxable(db: Session, factory):
    """Inheritance modeled as a negative one-time amount should add
    to the taxable bucket in that year — federally tax-free for the
    recipient, just a deposit."""
    factory.account(name="Brokerage", type="investment", current_balance=20_000)
    factory.commit()
    from app.models import Account
    db.query(Account).update({"tax_bucket": "taxable"})
    db.commit()

    import json
    no_inh = retirement_projection(
        current_age=55, retirement_age=56,
        desired_annual_income=80_000, db=db,
    )
    with_inh = retirement_projection(
        current_age=55, retirement_age=56,
        desired_annual_income=80_000,
        one_time_expenses_json=json.dumps([
            {"age": 60, "amount": -200_000, "label": "inheritance"},
        ]),
        db=db,
    )
    # End balance should be substantially higher with the inheritance.
    end_no = no_inh["year_by_year"][-1]["balance"]
    end_with = with_inh["year_by_year"][-1]["balance"]
    # $200k inflow at age 60 + ~40 years of compounding at 2.5% real
    # ≈ $537k. Allow generous range.
    assert end_with - end_no > 200_000


# ─── Max sustainable bisection ──────────────────────────────────────


def test_max_sustainable_returns_safe_amount(db: Session, factory):
    """Bisection should return a value that runs the portfolio close to
    zero at target age WITHOUT causing income shortfall. The conservative
    `lo` bound guarantees no over-spend."""
    factory.account(name="401k", type="investment", current_balance=1_500_000)
    factory.commit()
    from app.models import Account
    db.query(Account).update({"tax_bucket": "tax_deferred"})
    db.commit()

    result = retirement_projection(
        current_age=55, retirement_age=60,
        desired_annual_income=80_000,
        max_sustainable_target_age=100,
        compute_max_sustainable=True,
        db=db,
    )
    ms = result["max_sustainable"]
    assert ms is not None
    assert ms["status"] == "ok"
    assert ms["amount"] > 0
    # Headroom direction matches whether current desired is above or
    # below the bisected max.
    assert ms["headroom"] == ms["amount"] - 80_000
    # After-tax avg is reported too.
    assert ms["after_tax_avg"] > 0
    assert ms["after_tax_avg"] < ms["amount"]  # tax always bites at least a little
