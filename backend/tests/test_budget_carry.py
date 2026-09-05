"""Tests for the automatic budget carry-forward (services/budget_carry.py)
and the GET /budgets/{month}/{year} lazy path."""
import datetime

from sqlalchemy import Index
from sqlalchemy.orm import Session

from app.models import Budget, BudgetCategory
from app.services.budget_carry import (
    carry_forward_budget,
    ensure_current_month_budget,
    latest_budget_before,
)


def _budget(db: Session, month: int, year: int, lines: dict[str, float], total: float | None = None) -> Budget:
    b = Budget(month=month, year=year, total_limit=total)
    for cat, limit in lines.items():
        b.categories.append(BudgetCategory(category=cat, limit_amount=limit))
    db.add(b)
    db.commit()
    db.refresh(b)
    return b


def test_no_history_means_nothing_to_carry(db: Session):
    assert carry_forward_budget(db, 9, 2026) is None
    assert db.query(Budget).count() == 0


def test_existing_month_is_returned_untouched(db: Session):
    sept = _budget(db, 9, 2026, {"Groceries": 650.0})
    got = carry_forward_budget(db, 9, 2026)
    assert got.id == sept.id
    assert got.inherited_from_budget_id is None
    assert db.query(Budget).count() == 1


def test_clones_latest_prior_month_with_all_lines(db: Session):
    _budget(db, 6, 2026, {"Groceries": 450.0, "Shopping": 1200.0}, total=8_000.0)
    aug = _budget(db, 8, 2026, {"Groceries": 500.0, "Shopping": 1500.0, "Travel": 300.0}, total=9_000.0)

    sept = carry_forward_budget(db, 9, 2026)

    assert sept is not None
    assert (sept.month, sept.year) == (9, 2026)
    assert sept.inherited_from_budget_id == aug.id       # August, not June
    assert sept.total_limit == 9_000.0
    got = {c.category: c.limit_amount for c in sept.categories}
    assert got == {"Groceries": 500.0, "Shopping": 1500.0, "Travel": 300.0}
    # The source is untouched (deep copy, not a move).
    db.refresh(aug)
    assert len(aug.categories) == 3


def test_crosses_a_year_boundary(db: Session):
    dec = _budget(db, 12, 2026, {"Groceries": 520.0})
    jan = carry_forward_budget(db, 1, 2027)
    assert jan.inherited_from_budget_id == dec.id


def test_latest_budget_before_ignores_same_and_later_months(db: Session):
    _budget(db, 9, 2026, {"A": 1.0})
    _budget(db, 10, 2026, {"A": 1.0})
    jul = _budget(db, 7, 2026, {"A": 1.0})
    assert latest_budget_before(db, 9, 2026).id == jul.id
    assert latest_budget_before(db, 7, 2026) is None


def test_ensure_current_month_uses_today(db: Session):
    _budget(db, 8, 2026, {"Groceries": 500.0})
    today = datetime.date(2026, 9, 5)
    got = ensure_current_month_budget(db, today=today)
    assert (got.month, got.year) == (9, 2026)
    # Idempotent: a second call finds the row instead of cloning again.
    again = ensure_current_month_budget(db, today=today)
    assert again.id == got.id
    assert db.query(Budget).filter_by(month=9, year=2026).count() == 1


def test_lost_race_returns_the_winner(db: Session, monkeypatch):
    """With the unique (month, year) index in place, two callers that both
    decide to clone can't both succeed. The loser must return the winner's
    row instead of raising."""
    from sqlalchemy.orm import sessionmaker
    from app.services import budget_carry

    # conftest's create_all doesn't include the alembic-only index; add it
    # so this test exercises production's constraint.
    Index("ux_budgets_month_year", Budget.month, Budget.year, unique=True).create(db.get_bind())
    _budget(db, 8, 2026, {"Groceries": 500.0})

    # Interleave the "winner": right after this caller's existence check
    # misses and it goes looking for a source month, another session
    # commits a September budget. StaticPool shares one connection, so a
    # second Session sees and writes the same in-memory DB.
    Other = sessionmaker(bind=db.get_bind())
    real_latest = budget_carry.latest_budget_before
    winner_id = {}

    def latest_with_interleaved_winner(session, month, year):
        other = Other()
        try:
            w = Budget(month=9, year=2026)
            w.categories.append(BudgetCategory(category="Groceries", limit_amount=999.0))
            other.add(w)
            other.commit()
            winner_id["id"] = w.id
        finally:
            other.close()
        return real_latest(session, month, year)

    monkeypatch.setattr(budget_carry, "latest_budget_before", latest_with_interleaved_winner)

    got = budget_carry.carry_forward_budget(db, 9, 2026)

    assert got.id == winner_id["id"]
    assert got.categories[0].limit_amount == 999.0          # the winner's numbers, not a clone
    assert db.query(Budget).filter_by(month=9, year=2026).count() == 1


def test_get_route_lazily_creates_only_the_current_month(db: Session, monkeypatch):
    from fastapi import HTTPException
    from app.routers import budgets as budgets_router

    _budget(db, 8, 2026, {"Groceries": 500.0})

    class _Today(datetime.date):
        @classmethod
        def today(cls):
            return cls(2026, 9, 5)
    monkeypatch.setattr(budgets_router.datetime, "date", _Today)

    # Current month: created on demand and labelled with its source.
    out = budgets_router.get_budget(9, 2026, db=db)
    assert out.inherited_from_month == 8
    assert out.inherited_from_year == 2026
    assert [c.category for c in out.categories] == ["Groceries"]

    # A past month with no budget stays a 404 — we never rewrite history.
    try:
        budgets_router.get_budget(7, 2026, db=db)
        assert False, "expected 404"
    except HTTPException as e:
        assert e.status_code == 404
    # A future month too.
    try:
        budgets_router.get_budget(10, 2026, db=db)
        assert False, "expected 404"
    except HTTPException as e:
        assert e.status_code == 404


def test_saving_the_month_clears_the_inherited_marker(db: Session):
    from app.routers import budgets as budgets_router
    from app.schemas.schemas import BudgetIn, BudgetCategoryIn

    aug = _budget(db, 8, 2026, {"Groceries": 500.0})
    sept = carry_forward_budget(db, 9, 2026)
    assert sept.inherited_from_budget_id == aug.id

    body = BudgetIn(month=9, year=2026, total_limit=9_500.0,
                    categories=[BudgetCategoryIn(category="Groceries", limit_amount=550.0)])
    out = budgets_router.create_or_update_budget(body, db=db)
    assert out.inherited_from_budget_id is None
    assert out.inherited_from_month is None
    db.refresh(sept)
    assert sept.inherited_from_budget_id is None
    assert sept.categories[0].limit_amount == 550.0
