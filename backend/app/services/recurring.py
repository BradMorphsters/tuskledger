"""The canonical recurring-transaction detector.

Before this module existed, analytics.py carried FIVE drifted copies of the
same per-merchant cadence heuristic (detect_recurring, the cash-flow-forecast
events loop, its two variable-spend baseline netting loops, the financial-pulse
bill-stress sum, and the calendar upcoming-events extractor). The copies
diverged in tolerance (25% vs 60% on income), mixed-sign handling, and
seasonality math — audit Passes 1-3 fixed the resulting bugs in place and
deferred THIS consolidation as the structural fix.

The pipeline (canonical semantics, taken from detect_recurring — the most
refined copy):

  group txns by merchant → skip < min_occurrences → skip mixed-sign merchants
  (refunds + purchases isn't a cadence) → median of ABSOLUTE amounts (income is
  stored negative; a signed median would zero out paychecks) → variance
  tolerance by side (outflows tight at 25%; income lumpy — overtime/PTO — at
  60%) → median day-interval into a FREQUENCY_BANDS bucket (income: a fitted pay
  calendar from pay_calendar, which also recognizes semi-monthly pay) →
  seasonality = 3..10 distinct active calendar months AND a real off-season
  gap in the cadence (a young ledger isn't evidence of seasonality).
  Same-day inflows from one payer are coalesced into one paycheck first.

Callers keep their own projection / enrichment / windowing on top; only the
DETECTION lives here, so the five callsites can never drift again.

Sign convention (Plaid): expenses are POSITIVE amounts, income NEGATIVE.
"""
from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass, field
from datetime import date
from datetime import timedelta
from typing import Callable, Iterable, Optional

from app.services.pay_calendar import EARLY_POST_TOLERANCE, PaySchedule, fit_schedule

# (name, lo_days, hi_days, occurrences_per_year) — the single source of truth
# for what counts as a recurring cadence. Moved from routers/analytics.py,
# which now re-exports it for backward compatibility.
FREQUENCY_BANDS = (
    ("weekly", 6, 8, 52),
    ("bi-weekly", 13, 16, 26),
    # "semi-monthly" (24/yr) has no interval band on purpose: its gaps (13-18
    # days) overlap bi-weekly, so it can only be told apart by WHICH days the
    # deposits land on. pay_calendar.fit_schedule does that for income.
    ("monthly", 27, 35, 12),
    ("quarterly", 85, 100, 4),
    ("annual", 350, 380, 1),
)

INCOME_TOLERANCE = 0.60
OUTFLOW_TOLERANCE = 0.25


def classify_frequency(median_interval: float) -> Optional[tuple[str, int]]:
    """(band_name, per_year_multiplier) for a median day-gap, or None."""
    for name, lo, hi, mult in FREQUENCY_BANDS:
        if lo <= median_interval <= hi:
            return name, mult
    return None


@dataclass
class RecurringStream:
    """One merchant's detected recurring pattern. txns are date-sorted."""

    merchant: str
    txns: list = field(repr=False)
    is_income: bool = False
    median_amount: float = 0.0     # ABSOLUTE dollars
    median_interval: int = 0       # days
    frequency: str = ""            # FREQUENCY_BANDS name
    per_year: int = 0
    active_months: tuple[int, ...] = ()   # sorted distinct calendar months
    is_seasonal: bool = False
    # Income only: one (date, total) per payday. A split direct deposit
    # (part to checking, part to savings — or two accounts) is ONE paycheck.
    occurrences: list = field(default_factory=list, repr=False)
    # Income only: the fitted pay calendar (bi-weekly Fridays, the 15th & last day,
    # ...) when one explains the history; None → plain interval stepping.
    schedule: Optional[PaySchedule] = None
    schedule_fit: float = 0.0

    @property
    def annual_multiplier(self) -> int:
        """Occurrences per year, honoring seasonality: a monthly-cadence
        merchant active only Apr-Oct bills len(active_months) times, not 12."""
        if self.is_seasonal and self.per_year == 12:
            return len(self.active_months)
        return self.per_year

    @property
    def monthly_rate(self) -> float:
        """Steady-state dollars per month (annualized / 12)."""
        return self.median_amount * self.annual_multiplier / 12.0

    @property
    def last_date(self) -> date:
        return self.txns[-1].date

    def next_dates(self, start: date, end: date) -> list[date]:
        """Projected occurrence dates in [start, end].

        Streams with a fitted pay calendar use it (business-day and holiday
        adjusted, so semi-monthly pay stays on its days and bi-weekly pay
        picks up its third-paycheck months). Everything else keeps the
        historical "last date + median interval" stepping.
        """
        if self.schedule is not None:
            # A deposit can post a day or two before its payday; don't
            # re-project the payday it already covered.
            start = max(start, self.last_date + timedelta(days=EARLY_POST_TOLERANCE + 1))
            days = self.schedule.paydays(start, end)
            if self.is_seasonal:
                days = [d for d in days if d.month in self.active_months]
            return days
        step = max(int(self.median_interval), 1)
        out: list[date] = []
        d = self.last_date + timedelta(days=step)
        while d <= end:
            if d >= start:
                out.append(d)
            d += timedelta(days=step)
        return out


def _default_key(t) -> str:
    return (t.merchant_name or t.name or "Unknown").strip()


def detect_streams(
    txns: Iterable,
    *,
    merchant_key: Optional[Callable] = None,
    min_occurrences: int = 2,
    income_tolerance: float = INCOME_TOLERANCE,
    outflow_tolerance: float = OUTFLOW_TOLERANCE,
) -> list[RecurringStream]:
    """Detect recurring streams over a pre-filtered transaction window.

    The caller owns the query (date window, is_transfer exclusion, any
    amount-sign pre-filter) and the grouping key — detect_recurring groups by
    normalize_merchant so 'WF HOME MTG TYPE:...' and 'Wf Home Mtg Pay Id:...'
    collapse, while the forecast paths group by raw name (parity with their
    pre-consolidation behavior; flipping them to normalized grouping changes
    forecast numbers and needs its own approval).
    """
    key_fn = merchant_key or _default_key
    by_merchant: dict[str, list] = defaultdict(list)
    for t in txns:
        by_merchant[key_fn(t)].append(t)

    streams: list[RecurringStream] = []
    for merchant, lst in by_merchant.items():
        if len(lst) < min_occurrences:
            continue
        sorted_txns = sorted(lst, key=lambda x: x.date)
        amounts = [t.amount for t in sorted_txns]

        # Mixed-sign merchant (refunds + purchases) — not a cadence. This also
        # protects the income side: a mixed merchant whose magnitudes happen to
        # cluster used to slip through one baseline loop as phantom income.
        if any(a > 0 for a in amounts) and any(a < 0 for a in amounts):
            continue

        is_income = amounts[0] < 0
        if is_income:
            # Coalesce same-day inflows: a paycheck split across accounts (or
            # a small same-day side deposit) arrives as 2+ rows with very
            # different amounts, which failed the tolerance check below and
            # hid the paycheck from every consumer. One payday = one amount.
            per_day: dict = defaultdict(float)
            for t in sorted_txns:
                per_day[t.date] += abs(t.amount)
            occurrences = sorted(per_day.items())
            if len(occurrences) < min_occurrences:
                continue
            abs_amounts = [a for _, a in occurrences]
            dates_ = [d for d, _ in occurrences]
        else:
            occurrences = []
            abs_amounts = [abs(a) for a in amounts]
            dates_ = [t.date for t in sorted_txns]
        median_amount = sorted(abs_amounts)[len(abs_amounts) // 2]
        if median_amount <= 0:
            continue

        tolerance = income_tolerance if is_income else outflow_tolerance
        if not all(abs(a - median_amount) / median_amount < tolerance for a in abs_amounts):
            continue

        intervals = [(dates_[i + 1] - dates_[i]).days for i in range(len(dates_) - 1)]
        if not intervals:
            continue
        # Median (not mean): a seasonal merchant's off-season gap is one huge
        # interval that would drag a mean out of every band.
        sorted_intervals = sorted(intervals)
        median_interval = sorted_intervals[len(sorted_intervals) // 2]

        schedule, schedule_fit = None, 0.0
        if is_income:
            fitted = fit_schedule(dates_)
            if fitted is not None:
                schedule, schedule_fit = fitted
        if schedule is not None:
            frequency, per_year = schedule.frequency, schedule.per_year
        else:
            classification = classify_frequency(median_interval)
            if not classification:
                continue
            frequency, per_year = classification

        active_months = tuple(sorted({d.month for d in dates_}))
        # Seasonal needs EVIDENCE of an off-season: an actual gap in the
        # cadence. Counting distinct months alone made every stream in a
        # ledger younger than 11 months "seasonal" (Jan-Sep history → active
        # months 1-9), which silently dropped mortgage/paycheck events from
        # Oct-Dec forecasts and cut their monthly rate by months/12.
        off_season_gap = max(intervals) > max(2.5 * median_interval, 45)
        is_seasonal = 3 <= len(active_months) <= 10 and off_season_gap

        streams.append(RecurringStream(
            merchant=merchant,
            txns=sorted_txns,
            is_income=is_income,
            median_amount=median_amount,
            median_interval=int(median_interval),
            frequency=frequency,
            per_year=per_year,
            active_months=active_months,
            is_seasonal=is_seasonal,
            occurrences=occurrences,
            schedule=schedule,
            schedule_fit=schedule_fit,
        ))
    return streams
