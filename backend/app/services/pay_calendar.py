"""Pay-calendar math: business days, bank holidays, and pay-schedule fitting.

Pure functions only (no DB). Used by the recurring detector to tell a
semi-monthly paycheck (the 15th and the last day — 24 a year) from a
bi-weekly one (every other Friday — 26 a year), and to project real future
paydays instead of "last deposit + median gap".

Why this matters:
  * The two schedules have ~15-day gaps, so an interval-only detector files
    semi-monthly pay as bi-weekly and overstates the income by 26/24 − 1 ≈ 8%.
  * Stepping a semi-monthly stream by +15 days drifts off the real paydays
    within a couple of months.
  * Employers move a payday that lands on a weekend or bank holiday to the
    PREVIOUS business day. A bi-weekly schedule therefore produces a third
    paycheck in some months that a naive "every 14 days" projection misses
    (e.g. a Friday Jan 1 payday posts on Dec 31).

Nothing here is specific to one household: the schedule, the paydays and
which way a weekend/holiday payday moves ("before", "after" or "none") are
all learned from deposit history, and the user can override any of them.

Holiday model (configurable, see `configure_holidays`): by default the US
federal holidays the Federal Reserve closes for, with the payroll
"observed" convention (Saturday → Friday, Sunday → Monday). Set
PAY_HOLIDAY_CALENDAR=none for weekends only (e.g. outside the US), and add
local bank holidays with PAY_EXTRA_HOLIDAYS=YYYY-MM-DD,YYYY-MM-DD.
"""
from __future__ import annotations

import calendar
from datetime import date, timedelta
from functools import lru_cache
from typing import Iterable, Optional, Sequence

# Day-of-month sentinel meaning "the last day of the month" (31 clamps to 28/29/30).
LAST_DAY = 31

# Schedule names are the same strings recurring.FREQUENCY_BANDS uses, so they
# flow straight through the existing API responses and UI badges.
WEEKLY = "weekly"
BIWEEKLY = "bi-weekly"
SEMIMONTHLY = "semi-monthly"
MONTHLY = "monthly"

PER_YEAR = {WEEKLY: 52, BIWEEKLY: 26, SEMIMONTHLY: 24, MONTHLY: 12}
# Fewest paychecks any calendar month can contain for each schedule. Income
# you can count on EVERY month = per-check amount × this.
MIN_PER_MONTH = {WEEKLY: 4, BIWEEKLY: 2, SEMIMONTHLY: 2, MONTHLY: 1}

# A deposit may post up to this many days before its scheduled date (banks
# that release ACH credits early) and still count as that payday.
EARLY_POST_TOLERANCE = 2

# What happens when a nominal payday is a weekend/bank holiday.
SHIFT_BEFORE = "before"   # previous business day (most US payroll)
SHIFT_AFTER = "after"     # next business day
SHIFT_NONE = "none"       # deposit posts on the nominal date regardless
SHIFT_RULES = (SHIFT_BEFORE, SHIFT_AFTER, SHIFT_NONE)

HOLIDAY_CALENDARS = ("us", "none")
_holiday_calendar = "us"
_extra_holidays: frozenset = frozenset()
_configured = False


def configure_holidays(calendar_name: str = "us", extra: Iterable[date] = ()) -> None:
    """Pick the bank-holiday calendar used for business-day shifting.

    calendar_name: "us" (US federal / Federal Reserve holidays) or "none"
    (weekends only). `extra` adds local holidays on top of either.
    """
    global _holiday_calendar, _extra_holidays, _configured
    name = (calendar_name or "us").strip().lower()
    _holiday_calendar = name if name in HOLIDAY_CALENDARS else "us"
    _extra_holidays = frozenset(extra)
    _configured = True
    _bank_holidays.cache_clear()


def _ensure_configured() -> None:
    """Load the holiday settings from the app config on first use. Kept lazy
    (and failure-tolerant) so this module stays importable without the app."""
    if _configured:
        return
    try:
        from app.config import settings
        extra = []
        for tok in (getattr(settings, "PAY_EXTRA_HOLIDAYS", "") or "").split(","):
            tok = tok.strip()
            if tok:
                try:
                    extra.append(date.fromisoformat(tok))
                except ValueError:
                    pass
        configure_holidays(getattr(settings, "PAY_HOLIDAY_CALENDAR", "us"), extra)
    except Exception:  # pragma: no cover - app config unavailable
        configure_holidays("us")


# ─── Holidays / business days ────────────────────────────────────────────
def _nth_weekday(year: int, month: int, weekday: int, n: int) -> date:
    """n-th (1-based) `weekday` (Mon=0) of a month; n=-1 means the last one."""
    if n > 0:
        first = date(year, month, 1)
        offset = (weekday - first.weekday()) % 7
        return first + timedelta(days=offset + 7 * (n - 1))
    last = date(year, month, calendar.monthrange(year, month)[1])
    return last - timedelta(days=(last.weekday() - weekday) % 7)


def _observed(d: date) -> date:
    if d.weekday() == 5:  # Saturday → Friday
        return d - timedelta(days=1)
    if d.weekday() == 6:  # Sunday → Monday
        return d + timedelta(days=1)
    return d


def bank_holidays(year: int) -> frozenset[date]:
    """Bank holidays for `year` under the configured calendar (+ extras)."""
    _ensure_configured()
    return _bank_holidays(year, _holiday_calendar, _extra_holidays)



@lru_cache(maxsize=128)
def _bank_holidays(year: int, calendar_name: str, extra: frozenset) -> frozenset[date]:
    extra_this_year = {d for d in extra if d.year == year}
    if calendar_name == "none":
        return frozenset(extra_this_year)
    return frozenset(_us_federal_holidays(year) | extra_this_year)


def _us_federal_holidays(year: int) -> set[date]:
    """US federal (Federal Reserve) holidays for `year`, observed dates.

    Includes the following year's New Year's Day when it is observed on
    Dec 31 of this year (Jan 1 on a Saturday).
    """
    fixed = [(1, 1), (6, 19), (7, 4), (11, 11), (12, 25)]
    days = {_observed(date(year, m, d)) for m, d in fixed}
    days.add(_nth_weekday(year, 1, 0, 3))    # MLK Day
    days.add(_nth_weekday(year, 2, 0, 3))    # Presidents Day
    days.add(_nth_weekday(year, 5, 0, -1))   # Memorial Day
    days.add(_nth_weekday(year, 9, 0, 1))    # Labor Day
    days.add(_nth_weekday(year, 10, 0, 2))   # Columbus / Indigenous Peoples' Day
    days.add(_nth_weekday(year, 11, 3, 4))   # Thanksgiving
    nxt = _observed(date(year + 1, 1, 1))
    if nxt.year == year:
        days.add(nxt)
    return days


def is_business_day(d: date) -> bool:
    return d.weekday() < 5 and d not in bank_holidays(d.year)


def previous_business_day(d: date) -> date:
    """`d` itself if it's a business day, else the closest earlier one."""
    while not is_business_day(d):
        d -= timedelta(days=1)
    return d


def next_business_day(d: date) -> date:
    """`d` itself if it's a business day, else the closest later one."""
    while not is_business_day(d):
        d += timedelta(days=1)
    return d


def adjust_payday(nominal: date, rule: str = SHIFT_BEFORE) -> date:
    if rule == SHIFT_NONE:
        return nominal
    if rule == SHIFT_AFTER:
        return next_business_day(nominal)
    return previous_business_day(nominal)


def clamp_day(year: int, month: int, day: int) -> date:
    return date(year, month, min(day, calendar.monthrange(year, month)[1]))


def _add_months(year: int, month: int, delta: int) -> tuple[int, int]:
    idx = year * 12 + (month - 1) + delta
    return idx // 12, idx % 12 + 1


# ─── Schedule representation ─────────────────────────────────────────────
class PaySchedule:
    """A concrete pay calendar that can list its paydays.

    frequency   — WEEKLY / BIWEEKLY / SEMIMONTHLY / MONTHLY
    anchor      — for weekly/bi-weekly: any NOMINAL (pre-holiday-shift) payday
    days        — for semi-monthly: two days of month (31 = last day);
                  for monthly: one day of month
    shift       — what a weekend/holiday payday does: SHIFT_BEFORE (the
                  previous business day, the common US rule), SHIFT_AFTER
                  (the next business day) or SHIFT_NONE (posts on the
                  nominal date). Learned from history by fit_schedule.
    """

    __slots__ = ("frequency", "anchor", "days", "shift")

    def __init__(self, frequency: str, anchor: Optional[date] = None,
                 days: Sequence[int] = (), shift: str = SHIFT_BEFORE):
        self.frequency = frequency
        self.anchor = anchor
        self.days = tuple(sorted(days))
        self.shift = shift if shift in SHIFT_RULES else SHIFT_BEFORE

    def _adjust(self, nominal: date) -> date:
        return adjust_payday(nominal, self.shift)

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return f"PaySchedule({self.frequency!r}, anchor={self.anchor}, days={self.days})"

    @property
    def per_year(self) -> int:
        return PER_YEAR[self.frequency]

    @property
    def min_per_month(self) -> int:
        return MIN_PER_MONTH[self.frequency]

    def paydays(self, start: date, end: date) -> list[date]:
        """Actual (business-day-adjusted) paydays with start <= d <= end."""
        out: list[date] = []
        if self.frequency in (WEEKLY, BIWEEKLY):
            step = 7 if self.frequency == WEEKLY else 14
            # First nominal date that could adjust into the window (a nominal
            # date near either edge can shift across it, so begin one step
            # early, end one week late, and filter).
            k = (start - self.anchor).days // step - 1
            nominal = self.anchor + timedelta(days=step * k)
            while nominal <= end + timedelta(days=7):
                actual = self._adjust(nominal)
                if start <= actual <= end:
                    out.append(actual)
                nominal += timedelta(days=step)
        else:
            y, m = _add_months(start.year, start.month, -1)
            while date(y, m, 1) <= end + timedelta(days=31):
                for dom in self.days:
                    actual = self._adjust(clamp_day(y, m, dom))
                    if start <= actual <= end:
                        out.append(actual)
                y, m = _add_months(y, m, 1)
        return sorted(set(out))

    def next_payday(self, after: date) -> date:
        """First payday strictly after `after`."""
        days = self.paydays(after + timedelta(days=1), after + timedelta(days=70))
        return days[0]

    def label(self) -> str:
        if self.frequency == SEMIMONTHLY:
            return "Twice a month (" + " & ".join(_dom_label(d) for d in self.days) + ")"
        if self.frequency == MONTHLY:
            return f"Monthly ({_dom_label(self.days[0])})"
        wd = calendar.day_name[self.anchor.weekday()]
        return f"Every other {wd}" if self.frequency == BIWEEKLY else f"Every {wd}"

    def to_dict(self) -> dict:
        return {
            "frequency": self.frequency,
            "anchor": self.anchor.isoformat() if self.anchor else None,
            "days_of_month": list(self.days),
            "label": self.label(),
            "per_year": self.per_year,
            "min_per_month": self.min_per_month,
            "shift": self.shift,
        }


def _dom_label(d: int) -> str:
    if d >= LAST_DAY:
        return "last day"
    suffix = "th" if 10 <= d % 100 <= 20 else {1: "st", 2: "nd", 3: "rd"}.get(d % 10, "th")
    return f"{d}{suffix}"


# ─── Fitting a schedule to observed paydays ──────────────────────────────
def _matches(observed: date, expected: date) -> bool:
    """Observed deposit counts as the expected payday if it posted on it or
    up to EARLY_POST_TOLERANCE days before (early ACH release)."""
    return 0 <= (expected - observed).days <= EARLY_POST_TOLERANCE


def _dom_fit(dates: Sequence[date], doms: Sequence[int], shift: str = SHIFT_BEFORE) -> float:
    """Fraction of `dates` explained by shift-adjusted day-of-month targets,
    plus a small bonus (< 1/len) for dates hit EXACTLY rather than via the
    early-posting tolerance. Each date is compared against targets in the
    previous, same and next month (a 1st-of-month payday can shift back into
    the prior month; a month-end one forward into the next). The bonus
    breaks ties such as "15th & last day" vs "1st & 15th", which both explain
    month-end deposits within a day.
    """
    if not dates:
        return 0.0
    hits = exact = 0
    for d in dates:
        best = None
        for delta in (-1, 0, 1):
            dy, dm = _add_months(d.year, d.month, delta)
            for dom in doms:
                target = adjust_payday(clamp_day(dy, dm, dom), shift)
                if _matches(d, target):
                    lag = (target - d).days
                    best = lag if best is None else min(best, lag)
        if best is not None:
            hits += 1
            exact += best == 0
    n = len(dates)
    return hits / n + (exact / n) / (n + 1)


def _nominal_weekday_anchor(dates: Sequence[date], step: int) -> tuple[Optional[PaySchedule], float]:
    """Best weekly/bi-weekly schedule for `dates` and its fit score.

    Every observed payday is a nominal payday possibly moved a few days by
    the weekend/holiday rule, so candidate anchors are recent observed dates
    moved -3..+3 days. Every shift rule is tried; the winner explains the
    most dates (exact hits break ties, then rule order before/after/none).
    """
    freq = BIWEEKLY if step == 14 else WEEKLY
    best: tuple[Optional[PaySchedule], float] = (None, 0.0)
    n = len(dates)
    for d in dates[-4:]:  # recent dates are the most trustworthy anchors
        for off in (0, 1, 2, 3, -1, -2, -3):
            anchor = d + timedelta(days=off)
            for shift in SHIFT_RULES:
                if shift != SHIFT_NONE and anchor.weekday() >= 5:
                    continue
                if shift == SHIFT_NONE and off:
                    continue
                sched = PaySchedule(freq, anchor=anchor, shift=shift)
                hits = exact = 0
                for obs in dates:
                    k = round((obs - anchor).days / step)
                    expected = sched._adjust(anchor + timedelta(days=step * k))
                    if _matches(obs, expected):
                        hits += 1
                        exact += obs == expected
                # Same exact-hit tie-break bonus as _dom_fit, so the two are comparable.
                score = hits / n + (exact / n) / (n + 1)
                if score > best[1] + 1e-9:
                    best = (sched, score)
    return best


def fit_schedule(dates: Iterable[date], min_fit: float = 0.75) -> Optional[tuple[PaySchedule, float]]:
    """Best-fitting pay schedule for a series of (one-per-day) payday dates.

    Returns (schedule, fit) or None when no schedule explains at least
    `min_fit` of the dates. Needs 3+ dates to call a schedule at all.
    """
    ds = sorted(set(dates))
    if len(ds) < 3:
        return None
    gaps = sorted((b - a).days for a, b in zip(ds, ds[1:]))
    median_gap = gaps[len(gaps) // 2]

    candidates: list[tuple[PaySchedule, float]] = []
    if 5 <= median_gap <= 9:
        sched, fit = _nominal_weekday_anchor(ds, 7)
        if sched:
            candidates.append((sched, fit))
    if 11 <= median_gap <= 18:
        sched, fit = _nominal_weekday_anchor(ds, 14)
        if sched:
            candidates.append((sched, fit))
        # Semi-monthly: search day pairs at least 10 days apart. The last
        # day of the month is expressed as LAST_DAY so it survives Feb.
        best_pair, best_fit, best_shift = None, 0.0, SHIFT_BEFORE
        for shift in SHIFT_RULES:
            for d1 in range(1, 29):
                for d2 in list(range(d1 + 10, 29)) + [LAST_DAY]:
                    if d2 - d1 < 10:
                        continue
                    f = _dom_fit(ds, (d1, d2), shift)
                    if f > best_fit + 1e-9:
                        best_pair, best_fit, best_shift = (d1, d2), f, shift
        if best_pair:
            candidates.append((PaySchedule(SEMIMONTHLY, days=best_pair, shift=best_shift), best_fit))
    if 26 <= median_gap <= 35:
        best_dom, best_fit, best_shift = None, 0.0, SHIFT_BEFORE
        for shift in SHIFT_RULES:
            for dom in list(range(1, 29)) + [LAST_DAY]:
                f = _dom_fit(ds, (dom,), shift)
                if f > best_fit + 1e-9:
                    best_dom, best_fit, best_shift = dom, f, shift
        if best_dom:
            candidates.append((PaySchedule(MONTHLY, days=(best_dom,), shift=best_shift), best_fit))

    if not candidates:
        return None
    # Highest fit wins; on a tie prefer the fixed-interval schedule (bi-weekly
    # over semi-monthly) — a pure 14-day rhythm that ALSO happens to fit a day
    # pair over a short window is far more likely to be bi-weekly, and the
    # extra-paycheck months will reveal it either way.
    order = {WEEKLY: 0, BIWEEKLY: 1, SEMIMONTHLY: 2, MONTHLY: 3}
    candidates.sort(key=lambda c: (-round(c[1], 6), order[c[0].frequency]))
    sched, score = candidates[0]
    fit = min(score, 1.0) if score >= 1.0 else float(int(score * len(ds) + 1e-6)) / len(ds)
    if fit < min_fit:
        return None
    return sched, fit


def month_paydays(schedule: PaySchedule, year: int, month: int) -> list[date]:
    start = date(year, month, 1)
    end = date(year, month, calendar.monthrange(year, month)[1])
    return schedule.paydays(start, end)
