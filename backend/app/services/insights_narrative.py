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


SYSTEM_PROMPT = """You are a concise financial analyst writing a short
narrative for the user's personal finance dashboard. You will be given
a JSON object of pre-computed facts about the current month's spending.

Hard rules:
  - ONLY use numbers that appear verbatim in the provided JSON. Do not
    estimate, extrapolate, or invent any dollar figures.
  - Do not give financial advice. Do not warn about budgeting. Do not
    recommend categories to cut. Just describe what is happening.
  - 2 to 3 short paragraphs total. Plain English, no bullet lists,
    no markdown, no headings.
  - Refer to the user as "you".
  - If a category is up vs the trailing baseline, mention what's
    driving it if the JSON tells you (e.g. top merchants in that
    category). Otherwise just note the change.
  - If there is nothing notable in a section (no anomalies, flat
    spending), say so briefly rather than padding.

Open with the headline number for this month, then 1-2 sentences on
what shifted vs the baseline, then close with the most notable single
merchant or anomaly. End. Do not write a sign-off.
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
    """One category's MTD vs baseline summary, plus its top contributors."""
    category: str
    mtd_amount: float
    baseline_amount: float
    delta_amount: float       # mtd - baseline (positive = spending up)
    delta_pct: Optional[float]  # None when baseline is 0 (avoid div-by-zero)
    top_merchants: list[str] = field(default_factory=list)


@dataclass
class InsightsBundle:
    """Structured summary the model writes prose around. Stable shape;
    add fields as new sections of the narrative grow, never rename.
    """
    month_label: str                       # "April 2026"
    mtd_total_spending: float
    baseline_total_spending: float
    mtd_vs_baseline_delta: float
    mtd_vs_baseline_pct: Optional[float]
    categories_up: list[CategorySlice]     # biggest movers, capped at 3
    categories_down: list[CategorySlice]   # ditto
    notable_largest_transaction: Optional[dict]  # {merchant, amount, date}
    notes: list[str] = field(default_factory=list)  # human-readable hints

    def as_prompt_json(self) -> str:
        """Serialise to the compact JSON shape the prompt expects.

        Round dollar figures to whole dollars before embedding in the
        prompt: cents add token noise without adding insight, and the
        narrative will say "about $4,287" anyway. Percentages keep one
        decimal so "+12.4%" reads naturally.
        """
        def cat(s: CategorySlice) -> dict:
            return {
                "category": s.category,
                "this_month": round(s.mtd_amount),
                "baseline_avg": round(s.baseline_amount),
                "change_dollars": round(s.delta_amount),
                "change_percent": round(s.delta_pct, 1) if s.delta_pct is not None else None,
                "top_merchants": s.top_merchants,
            }

        payload = {
            "month": self.month_label,
            "spending_this_month": round(self.mtd_total_spending),
            "spending_baseline_avg": round(self.baseline_total_spending),
            "spending_change_dollars": round(self.mtd_vs_baseline_delta),
            "spending_change_percent": (
                round(self.mtd_vs_baseline_pct, 1)
                if self.mtd_vs_baseline_pct is not None else None
            ),
            "categories_spending_up": [cat(s) for s in self.categories_up],
            "categories_spending_down": [cat(s) for s in self.categories_down],
            "notable_largest_transaction": self.notable_largest_transaction,
            "notes": self.notes,
        }
        return json.dumps(payload, indent=2)


def build_insights_bundle(db: Session, *, today: Optional[date] = None) -> InsightsBundle:
    """Pull the structured facts the narrative will be built from.

    Mirrors the math used by the existing rule-based insights endpoint
    (`/api/analytics/insights`) but rolls the whole month into a single
    bundle instead of card-by-card. Reusing the same baseline (trailing
    3-month average at the same fraction of the month) means the
    narrative agrees with the cards underneath it — which matters,
    because users will glance at both at the same time.
    """
    today = today or date.today()
    month_label = today.strftime("%B %Y")
    mtd_start = date(today.year, today.month, 1)
    if today.month < 12:
        next_month_start = date(today.year, today.month + 1, 1)
    else:
        next_month_start = date(today.year + 1, 1, 1)
    days_in_month = (next_month_start - mtd_start).days
    days_elapsed = (today - mtd_start).days + 1
    fraction_of_month = days_elapsed / days_in_month if days_in_month else 0

    # Current month-to-date spending, by category and by merchant.
    cur_txns = db.query(Transaction).filter(
        Transaction.date >= mtd_start,
        Transaction.date <= today,
        Transaction.amount > 0,
        Transaction.is_transfer.is_(False),
    ).all()

    cur_by_cat: dict[str, float] = defaultdict(float)
    cur_by_cat_merch: dict[str, dict[str, float]] = defaultdict(lambda: defaultdict(float))
    for t in cur_txns:
        cat = t.custom_category or t.category or "Uncategorized"
        cur_by_cat[cat] += t.amount
        merch = (t.merchant_name or t.name or "Unknown").strip()
        cur_by_cat_merch[cat][merch] += t.amount

    # Baseline: same fraction-of-month spend across the prior 3 months,
    # averaged. This is the same definition `/api/analytics/insights`
    # uses; keep them aligned.
    baseline_by_cat_samples: dict[str, list[float]] = defaultdict(list)
    for offset in range(1, 4):
        m = today.month - offset
        y = today.year
        while m <= 0:
            m += 12
            y -= 1
        m_start = date(y, m, 1)
        m_end = date(y, m + 1, 1) if m < 12 else date(y + 1, 1, 1)
        m_days = (m_end - m_start).days
        cutoff = m_start + timedelta(days=int(m_days * fraction_of_month))
        sample = db.query(Transaction).filter(
            Transaction.date >= m_start,
            Transaction.date <= cutoff,
            Transaction.amount > 0,
            Transaction.is_transfer.is_(False),
        ).all()
        sample_by_cat: dict[str, float] = defaultdict(float)
        for t in sample:
            cat = t.custom_category or t.category or "Uncategorized"
            sample_by_cat[cat] += t.amount
        # Add zero entries for categories present in current but absent
        # in this baseline month, so the average isn't biased by missing
        # data points.
        for cat in cur_by_cat:
            baseline_by_cat_samples[cat].append(sample_by_cat.get(cat, 0.0))

    baseline_by_cat = {
        cat: (sum(samples) / len(samples)) if samples else 0.0
        for cat, samples in baseline_by_cat_samples.items()
    }

    # Build slices for every category we have data on, sort by absolute
    # change, take top 3 in each direction.
    slices: list[CategorySlice] = []
    for cat, mtd in cur_by_cat.items():
        baseline = baseline_by_cat.get(cat, 0.0)
        delta = mtd - baseline
        pct = ((mtd / baseline) - 1) * 100 if baseline > 0 else None
        # Top 3 contributing merchants for this category (by spend).
        top_merchants = sorted(
            cur_by_cat_merch[cat].items(), key=lambda kv: kv[1], reverse=True
        )[:3]
        slices.append(CategorySlice(
            category=cat,
            mtd_amount=mtd,
            baseline_amount=baseline,
            delta_amount=delta,
            delta_pct=pct,
            top_merchants=[m for m, _ in top_merchants],
        ))

    # Filter out categories where the absolute delta is below $25 — too
    # small to be worth narrating around.
    significant = [s for s in slices if abs(s.delta_amount) >= 25.0]
    significant.sort(key=lambda s: abs(s.delta_amount), reverse=True)
    categories_up = [s for s in significant if s.delta_amount > 0][:3]
    categories_down = [s for s in significant if s.delta_amount < 0][:3]

    # Single largest transaction this month — gives the narrative one
    # concrete merchant to land on.
    notable = None
    if cur_txns:
        big = max(cur_txns, key=lambda t: t.amount)
        notable = {
            "merchant": (big.merchant_name or big.name or "Unknown").strip(),
            "amount": round(big.amount),
            "date": big.date.isoformat(),
        }

    mtd_total = sum(cur_by_cat.values())
    baseline_total = sum(baseline_by_cat.values())
    delta = mtd_total - baseline_total
    pct = ((mtd_total / baseline_total) - 1) * 100 if baseline_total > 0 else None

    notes = []
    if not cur_txns:
        notes.append("No transactions this month yet.")
    if days_elapsed < 5:
        notes.append(
            f"Only {days_elapsed} day(s) into the month — patterns may shift."
        )

    return InsightsBundle(
        month_label=month_label,
        mtd_total_spending=mtd_total,
        baseline_total_spending=baseline_total,
        mtd_vs_baseline_delta=delta,
        mtd_vs_baseline_pct=pct,
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
        "Here are the pre-computed facts about this month's spending. "
        "Restate ONLY these numbers — do not compute new ones.\n\n"
        f"```json\n{bundle.as_prompt_json()}\n```\n\n"
        "Write the dashboard narrative now."
    )
