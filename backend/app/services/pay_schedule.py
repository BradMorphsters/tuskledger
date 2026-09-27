"""Household income model: who gets paid, on what schedule, and what that
means for each month.

Built on the canonical recurring detector (services/recurring.py), which
coalesces split direct deposits and fits a real pay calendar
(services/pay_calendar.py). This module adds the household layer:

  * one "earner" per paycheck stream (auto-detected; nickname / schedule /
    amount overridable by the user, or hidden),
  * per-check, normalized-monthly and BASELINE monthly income. The baseline
    is what arrives in every single month (bi-weekly and semi-monthly both
    guarantee two checks), which is the number to budget on,
  * a month-by-month paycheck calendar (12 back, 12 forward) that flags
    extra-paycheck months, the third bi-weekly check that lands twice a
    year and should be planned for rather than absorbed,
  * status per earner: on track, late (payday passed with no deposit), or
    ended; plus raise/cut detection from recent paychecks.

Overrides are small JSON documents kept beside the database (one file per
database, so demo-mode edits never touch real data). No schema migration.
"""
from __future__ import annotations

import calendar
import json
import os
import re
import tempfile
import threading
from datetime import date, timedelta
from pathlib import Path
from statistics import median
from typing import Optional

from sqlalchemy.orm import Session

from app.models import Account, Transaction
from app.services.merchant_normalizer import normalize as normalize_merchant
from app.services.pay_calendar import (
    BIWEEKLY,
    EARLY_POST_TOLERANCE,
    LAST_DAY,
    MIN_PER_MONTH,
    MONTHLY,
    PER_YEAR,
    SEMIMONTHLY,
    SHIFT_RULES,
    WEEKLY,
    PaySchedule,
    month_paydays,
)
from app.services.recurring import detect_streams

LOOKBACK_DAYS = 400          # > 1 year, so both bi-weekly extra months show
PAYCHECK_FLOOR = 100.0       # per-check dollars; below is interest/cashback
MONTHS_BACK = 12
MONTHS_FORWARD = 12
RECENT_CHECKS = 3            # "current" per-check amount = median of the last N
CHANGE_THRESHOLD_PCT = 3.0   # smaller moves are noise (hours, withholding)
LATE_GRACE_DAYS = 3
VALID_FREQUENCIES = (WEEKLY, BIWEEKLY, SEMIMONTHLY, MONTHLY)


# ─── Override store ──────────────────────────────────────────────────────
_LOCK = threading.RLock()
_MEMORY_STORES: dict[str, dict] = {}   # in-memory DBs (tests) never hit disk


def _store_path(db: Session) -> Optional[Path]:
    try:
        database = db.get_bind().url.database
    except Exception:  # pragma: no cover - unusual binds
        database = None
    if not database or database == ":memory:":
        return None
    from app.config import settings

    configured = (getattr(settings, "PAY_SCHEDULE_DIR", "") or os.environ.get("PAY_SCHEDULE_DIR") or "").strip()
    base = (Path(os.path.expanduser(configured)) if configured
            else Path(__file__).resolve().parents[2] / "var" / "pay_schedules")
    return base / f"{Path(database).stem}.json"


def _memory_key(db: Session) -> str:
    return str(id(db.get_bind()))


def load_overrides(db: Session) -> dict:
    path = _store_path(db)
    with _LOCK:
        if path is None:
            return json.loads(json.dumps(_MEMORY_STORES.get(_memory_key(db), {})))
        if not path.exists():
            return {}
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return {}
        return data.get("earners", {}) if isinstance(data, dict) else {}


def _save_overrides(db: Session, earners: dict) -> None:
    path = _store_path(db)
    with _LOCK:
        if path is None:
            _MEMORY_STORES[_memory_key(db)] = json.loads(json.dumps(earners))
            return
        path.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=str(path.parent), prefix=".tmp-", suffix=".json")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                json.dump({"version": 1, "earners": earners}, f, indent=2)
            os.replace(tmp, path)
        except BaseException:
            try:
                os.unlink(tmp)
            except OSError:
                pass
            raise


class OverrideError(ValueError):
    pass


def validate_override(payload: dict) -> dict:
    """Clean an override payload. Unknown keys are dropped; None clears."""
    out: dict = {}
    if "nickname" in payload:
        nick = (payload.get("nickname") or "").strip()[:40]
        out["nickname"] = nick or None
    if "hidden" in payload:
        out["hidden"] = bool(payload.get("hidden"))
    if "frequency" in payload:
        freq = payload.get("frequency")
        if freq is not None and freq not in VALID_FREQUENCIES:
            raise OverrideError(f"frequency must be one of {', '.join(VALID_FREQUENCIES)}")
        out["frequency"] = freq
    if "days_of_month" in payload:
        days = payload.get("days_of_month")
        if days is not None:
            if not isinstance(days, list) or not all(isinstance(d, int) and 1 <= d <= LAST_DAY for d in days):
                raise OverrideError("days_of_month must be a list of days 1-31 (31 = last day)")
            days = sorted(set(days))
        out["days_of_month"] = days
    if "anchor" in payload:
        anchor = payload.get("anchor")
        if anchor is not None:
            try:
                anchor = date.fromisoformat(str(anchor)).isoformat()
            except ValueError as exc:
                raise OverrideError("anchor must be an ISO date (a known payday)") from exc
        out["anchor"] = anchor
    if "shift" in payload:
        rule = payload.get("shift")
        if rule is not None and rule not in SHIFT_RULES:
            raise OverrideError(f"shift must be one of {', '.join(SHIFT_RULES)}")
        out["shift"] = rule
    if "per_check" in payload:
        amt = payload.get("per_check")
        if amt is not None:
            try:
                amt = round(float(amt), 2)
            except (TypeError, ValueError) as exc:
                raise OverrideError("per_check must be a number") from exc
            if amt <= 0:
                raise OverrideError("per_check must be positive")
        out["per_check"] = amt
    freq = out.get("frequency")
    days = out.get("days_of_month")
    if freq == SEMIMONTHLY and days is not None and len(days) != 2:
        raise OverrideError("semi-monthly needs exactly two days_of_month")
    if freq == MONTHLY and days is not None and len(days) != 1:
        raise OverrideError("monthly needs exactly one day_of_month")
    return out


def set_override(db: Session, key: str, payload: dict) -> dict:
    clean = validate_override(payload)
    with _LOCK:
        earners = load_overrides(db)
        cur = {**earners.get(key, {}), **clean}
        cur = {k: v for k, v in cur.items() if v is not None and v is not False}
        if cur:
            earners[key] = cur
        else:
            earners.pop(key, None)
        _save_overrides(db, earners)
    return cur


def clear_override(db: Session, key: str) -> None:
    with _LOCK:
        earners = load_overrides(db)
        if earners.pop(key, None) is not None:
            _save_overrides(db, earners)


# ─── Helpers ─────────────────────────────────────────────────────────────
def earner_key(merchant: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", (merchant or "").lower()).strip("-")
    return slug or "income"


def _display_name(t) -> str:
    raw = (t.merchant_name or t.name or "Unknown").strip()
    return normalize_merchant(raw) or raw


def _merchant_key(t) -> str:
    """Group deposits by PAYER, not by exact description: banks re-word the
    same employer's deposits over time (a merchant_name appears, the memo
    truncates differently), which would split one job into a live stream and
    an "ended" fragment. The coarse payer signature from the income trend
    (first two meaningful memo tokens) survives those rewrites."""
    from app.routers.analytics import _payer_key  # lazy: router imports this module lazily too

    return _payer_key(t.name) or _payer_key(t.merchant_name) or _display_name(t)


def _month_key(y: int, m: int) -> str:
    return f"{y:04d}-{m:02d}"


def _add_months(y: int, m: int, delta: int) -> tuple[int, int]:
    idx = y * 12 + (m - 1) + delta
    return idx // 12, idx % 12 + 1


def _schedule_from_override(ov: dict, detected: Optional[PaySchedule],
                            last_paid: date) -> Optional[PaySchedule]:
    freq = ov.get("frequency")
    if not freq:
        if detected is not None and ov.get("shift"):
            return PaySchedule(detected.frequency, anchor=detected.anchor,
                               days=detected.days, shift=ov["shift"])
        return detected
    shift = ov.get("shift") or (detected.shift if detected else None) or SHIFT_RULES[0]
    if freq in (WEEKLY, BIWEEKLY):
        anchor = date.fromisoformat(ov["anchor"]) if ov.get("anchor") else None
        if anchor is None:
            anchor = detected.anchor if (detected and detected.frequency == freq) else last_paid
        return PaySchedule(freq, anchor=anchor, shift=shift)
    days = ov.get("days_of_month")
    if not days:
        if detected and detected.frequency == freq:
            days = list(detected.days)
        elif freq == SEMIMONTHLY:
            days = [15, LAST_DAY]
        else:
            days = [min(last_paid.day, LAST_DAY)]
    return PaySchedule(freq, days=days, shift=shift)


def _account_label(acct: Optional[Account]) -> str:
    if acct is None:
        return "Account"
    name = acct.custom_name or acct.name or "Account"
    return f"{name} ··{acct.mask}" if acct.mask else name


# ─── Main entry point ────────────────────────────────────────────────────
def build_income_profile(db: Session, today: date) -> dict:
    """Everything the Paychecks page, Budgets and Safe-to-spend need."""
    cutoff = today - timedelta(days=LOOKBACK_DAYS)
    dep_ids = {a_id for (a_id,) in db.query(Account.id).filter(Account.type == "depository").all()}
    accounts = {a.id: a for a in db.query(Account).all()}
    txns = (
        db.query(Transaction)
        .filter(
            Transaction.date >= cutoff,
            Transaction.date <= today,
            Transaction.is_transfer.is_(False),
            Transaction.is_refund.is_(False),
            Transaction.amount < 0,
        )
        .order_by(Transaction.date)
        .all()
    )
    # A credit-card statement credit isn't a paycheck; with no depository
    # accounts at all (manual-only setups), keep everything.
    if dep_ids:
        txns = [t for t in txns if t.account_id in dep_ids]

    overrides = load_overrides(db)
    earners: list[dict] = []
    other_income: list[dict] = []

    for s in detect_streams(txns, merchant_key=_merchant_key):
        if not s.is_income:
            continue
        key = earner_key(s.merchant)
        payer = _display_name(s.txns[-1])
        ov = overrides.get(key, {})
        occ = s.occurrences or [(t.date, abs(t.amount)) for t in s.txns]
        amounts = [a for _, a in occ]
        last_paid, last_amount = occ[-1]
        interval = max(int(s.median_interval), 1)

        recent = amounts[-RECENT_CHECKS:]
        per_check_detected = round(median(recent), 2)
        paycheck_like = (
            (s.schedule is not None or s.frequency in VALID_FREQUENCIES)
            and per_check_detected >= PAYCHECK_FLOOR
        )
        if not paycheck_like and not ov.get("frequency"):
            other_income.append({
                "key": key,
                "payer": payer,
                "frequency": s.frequency,
                "typical_amount": round(s.median_amount, 2),
                "monthly": round(s.monthly_rate, 2),
                "last_date": last_paid.isoformat(),
            })
            continue

        schedule = _schedule_from_override(ov, s.schedule, last_paid)
        freq = schedule.frequency if schedule else s.frequency
        per_year = PER_YEAR.get(freq, s.per_year)
        min_per_month = MIN_PER_MONTH.get(freq, 1)
        per_check = ov.get("per_check") or per_check_detected

        # Ended: missed two full cadences plus grace. Kept in the list (so the
        # user sees why it stopped counting) but excluded from every total.
        stale = (today - last_paid).days > 2 * interval + LATE_GRACE_DAYS

        next_paydays: list[date] = []
        expected_missed: Optional[date] = None
        if schedule is not None and not stale:
            start = last_paid + timedelta(days=EARLY_POST_TOLERANCE + 1)
            due = schedule.paydays(start, today + timedelta(days=90))
            # A payday that came and went with no deposit → late.
            overdue = [d for d in due if d < today - timedelta(days=LATE_GRACE_DAYS)]
            if overdue:
                expected_missed = overdue[0]
            next_paydays = [d for d in due if d >= today][:6]
        elif not stale:
            d = last_paid + timedelta(days=interval)
            while d < today:
                d += timedelta(days=interval)
            next_paydays = [d + timedelta(days=interval * i) for i in range(6)]

        status = "ended" if stale else ("late" if expected_missed else "on_track")

        change = None
        if len(amounts) >= RECENT_CHECKS * 2:
            # Recent checks vs up to 6 before them: long enough to see a raise
            # that landed a few paydays ago, short enough to let it age out.
            prior = median(amounts[:-RECENT_CHECKS][-6:])
            if prior > 0:
                pct = (per_check_detected - prior) / prior * 100
                if abs(pct) >= CHANGE_THRESHOLD_PCT:
                    # First paycheck at the new level.
                    since = None
                    for d_, a_ in occ[-(RECENT_CHECKS + 6):]:
                        if abs(a_ - per_check_detected) <= abs(a_ - prior):
                            since = d_
                            break
                    change = {
                        "direction": "up" if pct > 0 else "down",
                        "pct": round(pct, 1),
                        "previous_per_check": round(prior, 2),
                        "since": since.isoformat() if since else None,
                    }

        last_day_txns = [t for t in s.txns if t.date == last_paid]
        deposit_accounts = sorted({t.account_id for t in last_day_txns})
        split = [
            {"account_id": aid, "account": _account_label(accounts.get(aid)),
             "amount": round(sum(abs(t.amount) for t in last_day_txns if t.account_id == aid), 2)}
            for aid in deposit_accounts
        ]

        earners.append({
            "key": key,
            "payer": payer,
            "nickname": ov.get("nickname"),
            "display_name": ov.get("nickname") or payer,
            "hidden": bool(ov.get("hidden")),
            "status": status,
            "expected_missed": expected_missed.isoformat() if expected_missed else None,
            "schedule": ({**schedule.to_dict(), "fit": round(s.schedule_fit, 2) if s.schedule else None}
                         if schedule else {"frequency": freq, "label": freq.replace("-", " ").capitalize(),
                                           "per_year": per_year, "min_per_month": min_per_month,
                                           "anchor": None, "days_of_month": [], "shift": None, "fit": None}),
            "schedule_source": "custom" if (ov.get("frequency") or ov.get("shift")) else ("detected" if s.schedule else "interval"),
            "per_check": round(per_check, 2),
            "per_check_source": "custom" if ov.get("per_check") else "recent_median",
            "last_paid": last_paid.isoformat(),
            "last_amount": round(last_amount, 2),
            "paychecks_seen": len(occ),
            "normalized_monthly": round(per_check * per_year / 12, 2),
            "baseline_monthly": round(per_check * min_per_month, 2),
            "annual": round(per_check * per_year, 2),
            "next_paydays": [d.isoformat() for d in next_paydays],
            "split_deposit": split if len(split) > 1 else [],
            "change": change,
            "history": [{"date": d_.isoformat(), "amount": round(a_, 2)} for d_, a_ in occ[-26:]],
            "_schedule": schedule,
            "_occ": occ,
            "_interval": interval,
        })

    earners.sort(key=lambda e: (e["hidden"], e["status"] == "ended", -e["normalized_monthly"]))
    active = [e for e in earners if not e["hidden"] and e["status"] != "ended"]

    months = _month_grid(active, today)
    upcoming = sorted(
        ({"date": d, "key": e["key"], "name": e["display_name"], "amount": e["per_check"]}
         for e in active for d in e["next_paydays"]),
        key=lambda r: (r["date"], r["name"]),
    )
    this_month = next((m for m in months if m["month"] == _month_key(today.year, today.month)), None)
    extra_months = [m for m in months if m["is_extra_month"] and m["month"] > _month_key(today.year, today.month)]

    household = {
        "earners": len(active),
        "normalized_monthly": round(sum(e["normalized_monthly"] for e in active), 2),
        "baseline_monthly": round(sum(e["baseline_monthly"] for e in active), 2),
        "annual": round(sum(e["annual"] for e in active), 2),
        "extra_per_year": round(sum(e["annual"] - e["baseline_monthly"] * 12 for e in active), 2),
        "next_payday": upcoming[0] if upcoming else None,
    }

    for e in earners:
        e.pop("_schedule", None)
        e.pop("_occ", None)
        e.pop("_interval", None)

    return {
        "as_of": today.isoformat(),
        "household": household,
        "earners": earners,
        "upcoming": upcoming[:12],
        "this_month": this_month,
        "months": months,
        "extra_paycheck_months": [
            {"month": m["month"], "label": m["label"], "extra_checks": m["extra_checks"],
             "extra_amount": m["extra_amount"],
             "dates": [p["date"] for p in m["paychecks"] if p.get("is_extra")]}
            for m in extra_months
        ],
        "other_income": other_income,
        "guidance": _guidance(household, extra_months, active),
    }


def _month_grid(active: list[dict], today: date) -> list[dict]:
    """Per-month paycheck counts: actual deposits for past months, actual +
    projected for the current month, projected for future months."""
    out = []
    cur_key = _month_key(today.year, today.month)
    for delta in range(-MONTHS_BACK, MONTHS_FORWARD + 1):
        y, m = _add_months(today.year, today.month, delta)
        mk = _month_key(y, m)
        m_start = date(y, m, 1)
        m_end = date(y, m, calendar.monthrange(y, m)[1])
        paychecks = []
        extra_checks = 0
        extra_amount = 0.0
        by_earner = {}
        for e in active:
            occ = [(d, a) for d, a in e["_occ"] if m_start <= d <= m_end]
            rows = [{"date": d.isoformat(), "key": e["key"], "name": e["display_name"],
                     "amount": round(a, 2), "received": True} for d, a in occ]
            if mk >= cur_key and e["next_paydays"]:
                # Project only paydays not yet covered by a deposit: on/after
                # today and after the last deposit's early-post window.
                floor = max(today, date.fromisoformat(e["last_paid"])
                            + timedelta(days=EARLY_POST_TOLERANCE + 1))
                sched = e["_schedule"]
                if sched is not None:
                    proj = [d for d in month_paydays(sched, y, m) if d >= floor]
                else:
                    step = timedelta(days=max(e["_interval"], 1))
                    d = date.fromisoformat(e["next_paydays"][0])
                    proj = []
                    while d <= m_end:
                        if d >= m_start and d >= floor:
                            proj.append(d)
                        d += step
                for d in proj:
                    rows.append({"date": d.isoformat(), "key": e["key"], "name": e["display_name"],
                                 "amount": e["per_check"], "received": False})
            first_seen = e["_occ"][0][0] if e["_occ"] else None
            # Months before this earner's history starts aren't "0 checks".
            if first_seen and m_end < first_seen:
                continue
            rows.sort(key=lambda r: r["date"])
            base = e["schedule"]["min_per_month"]
            for i, r in enumerate(rows):
                r["is_extra"] = i >= base and e["schedule"]["frequency"] in (BIWEEKLY, WEEKLY)
            n_extra = max(len(rows) - base, 0) if e["schedule"]["frequency"] in (BIWEEKLY, WEEKLY) else 0
            if n_extra:
                extra_checks += n_extra
                extra_amount += sum(r["amount"] for r in rows if r["is_extra"])
            by_earner[e["key"]] = len(rows)
            paychecks.extend(rows)
        paychecks.sort(key=lambda r: (r["date"], r["name"]))
        total = sum(p["amount"] for p in paychecks)
        received = sum(p["amount"] for p in paychecks if p["received"])
        out.append({
            "month": mk,
            "label": f"{calendar.month_abbr[m]} {y}",
            "period": "past" if mk < cur_key else ("current" if mk == cur_key else "future"),
            "paycheck_count": len(paychecks),
            "count_by_earner": by_earner,
            "expected_total": round(total, 2),
            "received_total": round(received, 2),
            "remaining_total": round(total - received, 2),
            "extra_checks": extra_checks,
            "extra_amount": round(extra_amount, 2),
            "is_extra_month": extra_checks > 0,
            "paychecks": paychecks,
        })
    return out


def _guidance(household: dict, extra_months: list[dict], active: list[dict]) -> list[str]:
    tips = []
    if not active:
        return ["No regular paycheck detected yet. Once two or three paydays have "
                "synced, schedules appear here automatically."]
    tips.append(
        "Budget on the baseline: the income every month is guaranteed to bring. "
        "Bi-weekly and semi-monthly pay both guarantee two checks a month."
    )
    if extra_months:
        names = ", ".join(m["label"] for m in extra_months[:4])
        tips.append(
            f"{len(extra_months)} extra-paycheck month{'s' if len(extra_months) != 1 else ''} "
            f"in the next year ({names}). Give those checks a job ahead of time: "
            "savings, debt, or irregular bills."
        )
    if any(e["schedule"]["frequency"] == SEMIMONTHLY for e in active):
        tips.append(
            "Semi-monthly pay is 24 checks a year, not 26. It lands on the same "
            "days every month (shifted when that day is a weekend or bank holiday)."
        )
    return tips


def payer_label_fn(db: Session):
    """stream -> the user's nickname for that payer, so forecast/calendar
    events say "Alex paycheck" instead of a bank memo. Falls back to the
    stream's own merchant label."""
    overrides = load_overrides(db)

    def label(stream) -> str:
        if not overrides or not stream.txns:
            return stream.merchant
        nick = (overrides.get(earner_key(_merchant_key(stream.txns[-1]))) or {}).get("nickname")
        return f"{nick} paycheck" if nick else stream.merchant

    return label


def next_household_payday(db: Session, today: date) -> Optional[dict]:
    """Earliest upcoming payday across active earners, or None."""
    profile = build_income_profile(db, today)
    return profile["household"]["next_payday"]
