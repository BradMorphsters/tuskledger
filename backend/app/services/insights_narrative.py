"""
Build a one-paragraph plain-English narrative of this month's finances
for the Dashboard "AI insights" card, using a local Ollama model.

The split of responsibilities here is deliberate and load-bearing:

    1. We compute every number the narrative could mention in Python,
       in `build_insights_bundle()`. Totals, deltas, top merchants,
       category leaders — all derived from the database here, in code,
       with assertions and tests.

    2. The model only writes prose AROUND those numbers. The prompt is
       structured so the model is given the structured bundle as input
       and told explicitly: do not invent numbers, only restate the ones
       you were given.

This is the rule that keeps a 7B-class local model from being a
credibility risk in a finance app. A model writing free-form about
"$1,247 spent on coffee" when the real number is $312 would be a
single-screenshot disaster. By pre-computing every number and giving
the model a tightly-scoped writing job, the worst case becomes "the
prose is mediocre" — which is recoverable and nowhere near as bad as
hallucinated dollar figures in a tax-aware finance tool.

A few non-obvious decisions:

  * The bundle is kept small (under ~50 lines of JSON) so the
    prompt fits comfortably in a 4K context with room for the system
    instruction and the model's response. Smaller is also faster — a
    7B model on Apple Silicon takes meaningfully longer when the input
    grows, and a Dashboard card that takes 30s to render isn't useful.

  * The system prompt is opinionated about tone (concise, factual, no
    advice) and length (2-3 short paragraphs). Without those guard
    rails local models drift into either bullet lists or financial-
    advisor disclaimer language, neither of which fits the card.

  * Demo mode returns a canned narrative without calling Ollama, so the
    card can be screenshotted for marketing material on a machine that
    doesn't even have Ollama installed.
"""
from __future__ import annotations

import json
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import date, timedelta
from typing import Optional

from sqlalchemy.orm import Session

from app.models import Transaction
from app.services.transaction_view import expand


SYSTEM_PROMPT = """You are a concise financial analyst writing a short
narrative for the user's personal finance dashboard. You will be given
a JSON object of pre-computed facts about a recent spending period.

Hard rules — these are not suggestions:
  - ONLY use numbers that appear verbatim in the provided JSON. Do not
    estimate, extrapolate, or invent any dollar figures.
  - The baseline in the JSON is ALWAYS a trailing 3-month average. It
    is NEVER a year-over-year or "last year's" comparison. Never use
    the phrases "last year", "year over year", or "annual baseline".
    Refer to the baseline as the "trailing 3-month average" or
    similar.
  - Do not give financial advice. Do not warn about budgeting. Do not
    recommend categories to cut. Just describe what is happening.
  - 2 to 3 short paragraphs total. Plain English, no bullet lists,
    no markdown, no headings.
  - Refer to the user as "you".
  - The JSON's "period_label" field tells you what period the facts
    cover. Use that exact label in your opening sentence so the user
    knows whether the narrative is about the current month or the
    previous full month (a fallback we use when the current month is
    too sparse to be interesting).
  - If a category is up vs the trailing baseline, mention what's
    driving it if the JSON tells you (e.g. top merchants in that
    category). Otherwise just note the change.
  - If there is nothing notable in a section (no anomalies, flat
    spending), say so briefly rather than padding.

Open with the headline number for the period, then 1-2 sentences on
what shifted vs the trailing 3-month baseline, then close with the
most notable single merchant or anomaly. End. Do not write a sign-off.
"""


# Demo narrative shown when the request is in demo mode. Intentionally
# slightly varied wording across paragraphs so screenshots don't look
# like obvious template text. Numbers below match the demo seed data
# (see backend/scripts/seed_demo.py for the source of truth — if you
# change the seed materially, update this string too).
DEMO_NARRATIVE = (
    "You spent $4,287 month-to-date, running about 12% below your "
    "trailing 3-month baseline. The drop is concentrated in Shopping "
    "(-$340) and Travel (-$210) — both categories you went heavy on in "
    "March that have settled back to their usual pace.\n\n"
    "Food & Dining is the one category up meaningfully (+$84), driven "
    "almost entirely by three weekend Whole Foods runs. Subscription "
    "spend is flat. Recurring bills are tracking on schedule with no "
    "surprise increases this cycle.\n\n"
    "The standout single transaction this month is a $487 Stripe "
    "deposit — your second-largest business inflow since February. "
    "Nothing else jumps out as anomalous."
)


@dataclass
class CategorySlice:
    """One category's period vs baseline summary, plus its top contributors."""
    category: str
    period_amount: float
    baseline_amount: float        # always trailing 3-month average for this same window
    delta_amount: float           # period - baseline (positive = spending up)
    delta_pct: Optional[float]    # None when baseline is 0 (avoid div-by-zero)
    top_merchants: list[str] = field(default_factory=list)


@dataclass
class InsightsBundle:
    """Structured summary the model writes prose around. Stable shape;
    add fields as new sections of the narrative grow, never rename.

    Two flavors of period are possible (controlled by build_insights_bundle):
      - 'mtd'             — month-to-date for the current calendar month.
                            Used in the normal case.
      - 'previous_month'  — the entire previous calendar month. Used as a
                            fallback when the current month is too sparse
                            to be worth narrating about (start of month,
                            day 1-4 with little or no synced data yet).
    """
    period_label: str             # e.g. "April 2026" or "April 2026 (last full month)"
    period_kind: str              # "mtd" | "previous_month"
    period_total_spending: float
    baseline_total_spending: float    # trailing 3-month avg, same window shape
    period_vs_baseline_delta: float
    period_vs_baseline_pct: Optional[float]
    categories_up: list[CategorySlice]      # biggest movers, capped at 3
    categories_down: list[CategorySlice]    # ditto
    notable_largest_transaction: Optional[dict]  # {merchant, amount, date}
    notes: list[str] = field(default_factory=list)

    def as_prompt_json(self) -> str:
        """Serialise to the compact JSON shape the prompt expects.

        Key naming is deliberate: every dollar field includes the words
        "for_period" and the baseline field includes
        "trailing_3_month_average" so a small local model has no
        ambiguity about what the comparison actually is. Earlier
        labels like 'baseline_avg' got hallucinated by 8B models as
        'last year's baseline,' which is wrong and would torch a
        finance product on day one.
        """
        def cat(s: CategorySlice) -> dict:
            return {
                "category": s.category,
                "spending_for_period": round(s.period_amount),
                "trailing_3_month_average": round(s.baseline_amount),
                "change_dollars": round(s.delta_amount),
                "change_percent": round(s.delta_pct, 1) if s.delta_pct is not None else None,
                "top_merchants_in_category": s.top_merchants,
            }

        payload = {
            "period_label": self.period_label,
            "period_kind": self.period_kind,
            "baseline_definition": (
                "trailing 3-month average for the same kind of window "
                "(month-to-date OR full previous month, matching period_kind). "
                "This is NEVER a year-over-year comparison."
            ),
            "total_spending_for_period": round(self.period_total_spending),
            "total_spending_trailing_3_month_average": round(self.baseline_total_spending),
            "total_spending_change_dollars": round(self.period_vs_baseline_delta),
            "total_spending_change_percent": (
                round(self.period_vs_baseline_pct, 1)
                if self.period_vs_baseline_pct is not None else None
            ),
            "categories_spending_up_vs_baseline": [cat(s) for s in self.categories_up],
            "categories_spending_down_vs_baseline": [cat(s) for s in self.categories_down],
            "notable_largest_transaction": self.notable_largest_transaction,
            "notes": self.notes,
        }
        return json.dumps(payload, indent=2)


# Threshold for switching to the previous-month fallback. The card is
# useless on May 1 when the only thing it can say is "$0 spent so far,
# no change vs $0 baseline." If we're under this many days into the
# month AND have under this many synced transactions, summarise the
# prior full month instead. Tuned to flip back to MTD around the 5th of
# the month for typical sync cadences (most accounts have multi-day
# transaction lag).
_SPARSE_MAX_DAYS_ELAPSED = 4
_SPARSE_MAX_TXN_COUNT = 5


def _query_period_spending(db: Session, period_start: date, period_end: date):
    """Return all spending transactions in [period_start, period_end]
    (inclusive, both ends). Excludes transfers and income."""
    return db.query(Transaction).filter(
        Transaction.date >= period_start,
        Transaction.date <= period_end,
        Transaction.amount > 0,
        Transaction.is_transfer.is_(False),
    ).all()


def _aggregate_by_category(txns) -> tuple[dict, dict]:
    """Group txns into (by_cat, by_cat_merchant) dicts. Pure helper.

    Routed through transaction_view.expand so split transactions are
    attributed to each split's category rather than the parent's
    (audit fix — this was the last aggregation ignoring splits).
    """
    by_cat: dict[str, float] = defaultdict(float)
    by_cat_merch: dict[str, dict[str, float]] = defaultdict(lambda: defaultdict(float))
    for line in expand(txns):
        by_cat[line.category] += line.amount
        merch = (line.merchant or "Unknown").strip()
        by_cat_merch[line.category][merch] += line.amount
    return by_cat, by_cat_merch


def _month_bounds(any_day: date) -> tuple[date, date]:
    """(first day of month, last day of month) containing any_day."""
    start = date(any_day.year, any_day.month, 1)
    if any_day.month < 12:
        next_start = date(any_day.year, any_day.month + 1, 1)
    else:
        next_start = date(any_day.year + 1, 1, 1)
    end = next_start - timedelta(days=1)
    return start, end


def _shift_months(d: date, offset: int) -> date:
    """First day of the month `offset` months before d (offset > 0 = backwards)."""
    m = d.month - offset
    y = d.year
    while m <= 0:
        m += 12
        y -= 1
    while m > 12:
        m -= 12
        y += 1
    return date(y, m, 1)


def build_insights_bundle(db: Session, *, today: Optional[date] = None) -> InsightsBundle:
    """Pull the structured facts the narrative will be built from.

    Two paths:

    1. Normal (MTD): compare month-to-date spending against the trailing
       3-month average at the SAME fraction of the month. This mirrors
       the math /api/analytics/insights uses for the rule-based cards
       so the narrative and the cards underneath it agree.

    2. Sparse-month fallback: when the current month has fewer than
       _SPARSE_MAX_TXN_COUNT synced transactions AND we're under
       _SPARSE_MAX_DAYS_ELAPSED days in, summarise the previous full
       calendar month instead. Compare it against the trailing 3
       full months before that. The card always has something useful
       to say; once data syncs in (usually by day 5), it flips back
       to MTD mode automatically.
    """
    today = today or date.today()
    mtd_start, _ = _month_bounds(today)
    days_elapsed = (today - mtd_start).days + 1

    # Pre-flight: is the current month sparse enough that MTD would be
    # useless? Cheap count-only query to decide.
    cur_txn_count = db.query(Transaction).filter(
        Transaction.date >= mtd_start,
        Transaction.date <= today,
        Transaction.amount > 0,
        Transaction.is_transfer.is_(False),
    ).count()

    is_sparse = cur_txn_count < _SPARSE_MAX_TXN_COUNT and days_elapsed <= _SPARSE_MAX_DAYS_ELAPSED

    if is_sparse:
        # Fallback path: summarise the previous full month.
        prev_month_anchor = mtd_start - timedelta(days=1)  # last day of prior month
        period_start, period_end = _month_bounds(prev_month_anchor)
        period_kind = "previous_month"
        period_label = f"{period_start.strftime('%B %Y')} (last full month)"
        # Baseline: prior 3 FULL months before the period.
        baseline_month_starts = [_shift_months(period_start, n) for n in (1, 2, 3)]
        baseline_month_ends = [_month_bounds(s)[1] for s in baseline_month_starts]
    else:
        # Normal MTD path.
        period_start = mtd_start
        period_end = today
        period_kind = "mtd"
        period_label = today.strftime("%B %Y")
        # Baseline: prior 3 months at the same fraction-of-month as today.
        _, this_month_end = _month_bounds(today)
        days_in_month = (this_month_end - mtd_start).days + 1
        fraction = days_elapsed / days_in_month if days_in_month else 0
        baseline_month_starts = [_shift_months(mtd_start, n) for n in (1, 2, 3)]
        baseline_month_ends = [
            s + timedelta(days=int(((_month_bounds(s)[1] - s).days + 1) * fraction) - 1)
            for s in baseline_month_starts
        ]

    # Collect period spending.
    period_txns = _query_period_spending(db, period_start, period_end)
    period_by_cat, period_by_cat_merch = _aggregate_by_category(period_txns)

    # Collect baseline samples (one per prior month).
    baseline_by_cat_samples: dict[str, list[float]] = defaultdict(list)
    for b_start, b_end in zip(baseline_month_starts, baseline_month_ends):
        sample = _query_period_spending(db, b_start, b_end)
        sample_by_cat, _ = _aggregate_by_category(sample)
        # Pad zeros for categories present in period but missing from
        # this baseline month, so we don't bias the average.
        for cat in period_by_cat:
            baseline_by_cat_samples[cat].append(sample_by_cat.get(cat, 0.0))

    baseline_by_cat = {
        cat: (sum(samples) / len(samples)) if samples else 0.0
        for cat, samples in baseline_by_cat_samples.items()
    }

    # Build category slices.
    slices: list[CategorySlice] = []
    for cat, period_amt in period_by_cat.items():
        baseline = baseline_by_cat.get(cat, 0.0)
        delta = period_amt - baseline
        pct = ((period_amt / baseline) - 1) * 100 if baseline > 0 else None
        top_merchants = sorted(
            period_by_cat_merch[cat].items(), key=lambda kv: kv[1], reverse=True
        )[:3]
        slices.append(CategorySlice(
            category=cat,
            period_amount=period_amt,
            baseline_amount=baseline,
            delta_amount=delta,
            delta_pct=pct,
            top_merchants=[m for m, _ in top_merchants],
        ))

    # Threshold the movers to avoid narrating $5 wobbles.
    significant = [s for s in slices if abs(s.delta_amount) >= 25.0]
    significant.sort(key=lambda s: abs(s.delta_amount), reverse=True)
    categories_up = [s for s in significant if s.delta_amount > 0][:3]
    categories_down = [s for s in significant if s.delta_amount < 0][:3]

    notable = None
    if period_txns:
        big = max(period_txns, key=lambda t: t.amount)
        notable = {
            "merchant": (big.merchant_name or big.name or "Unknown").strip(),
            "amount": round(big.amount),
            "date": big.date.isoformat(),
        }

    period_total = sum(period_by_cat.values())
    baseline_total = sum(baseline_by_cat.values())
    delta = period_total - baseline_total
    pct = ((period_total / baseline_total) - 1) * 100 if baseline_total > 0 else None

    notes: list[str] = []
    if is_sparse:
        notes.append(
            f"The current month ({today.strftime('%B %Y')}) has only "
            f"{cur_txn_count} synced transaction(s) so far — this narrative "
            f"covers the previous full month instead, which is more useful."
        )
    elif not period_txns:
        notes.append(f"No transactions in {period_label} yet.")
    elif period_kind == "mtd" and days_elapsed < 7:
        notes.append(f"Only {days_elapsed} day(s) into the month — patterns may shift.")

    return InsightsBundle(
        period_label=period_label,
        period_kind=period_kind,
        period_total_spending=period_total,
        baseline_total_spending=baseline_total,
        period_vs_baseline_delta=delta,
        period_vs_baseline_pct=pct,
        categories_up=categories_up,
        categories_down=categories_down,
        notable_largest_transaction=notable,
        notes=notes,
    )


def build_user_prompt(bundle: InsightsBundle) -> str:
    """Build the user-message half of the chat completion.

    Keeps the JSON tightly scoped and labels it as "facts" so smaller
    local models don't try to re-derive the numbers.
    """
    return (
        f"Here are the pre-computed facts about a recent spending "
        f"period (period_label='{bundle.period_label}', "
        f"period_kind='{bundle.period_kind}'). Restate ONLY these "
        f"numbers — do not compute new ones. The baseline in this "
        f"JSON is a TRAILING 3-MONTH AVERAGE, not a year-over-year "
        f"comparison. Use the period_label verbatim in your opening "
        f"sentence.\n\n"
        f"```json\n{bundle.as_prompt_json()}\n```\n\n"
        f"Write the dashboard narrative now."
    )
