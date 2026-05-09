"""User-defined categories that augment the hardcoded STANDARD_CATEGORIES list.

Why this exists as a separate table rather than baking categories into
a config file:

  - The Operator wants to add categories the standard list doesn't
    cover ("Pet Care", "Hobbies", "Cabin Maintenance") without
    forking the codebase.
  - Custom categories need to survive app restarts and travel with
    the SQLite DB so backups + the laptop-to-laptop move workflow
    keep them.
  - Transactions reference categories by name (string), not by ID,
    so renaming a category is a separate concern handled at the
    transaction layer when the user wants it.

This model only stores the user's *additions* to the standard list.
The /api/transactions/categories endpoint merges these with
STANDARD_CATEGORIES + CATEGORY_ICONS at read time and returns the
unified list. That keeps the standards in code (where they belong —
they're tied to the Plaid mapper) and the user's customs in the DB
(where they belong — they're per-Operator state).

Deletion is a hard delete in v1. If the Operator deletes "Pet Care",
existing transactions tagged "Pet Care" keep that string in their
custom_category column — they just won't appear in the dropdown
anymore. That's deliberate: silently re-tagging hundreds of
transactions because someone tweaked a label is the wrong default.
The Categories page surfaces "X transactions still reference
deleted category 'Pet Care'" so the Operator can clean up if they
want.
"""
import datetime
from sqlalchemy import Column, DateTime, Integer, String

from app.database import Base


class CustomCategory(Base):
    __tablename__ = "custom_categories"

    id = Column(Integer, primary_key=True, autoincrement=True)
    # Display name. Unique-by-name to prevent duplicates and avoid
    # accidental collisions with STANDARD_CATEGORIES (the merge logic
    # in the router filters those out, but DB-level uniqueness keeps
    # the customs themselves clean).
    name = Column(String, nullable=False, unique=True, index=True)
    # Single-character emoji or short text icon. Defaults to "📦" so
    # a custom category always renders with *something* in the dropdown
    # rather than a blank space when the user doesn't supply one.
    icon = Column(String, nullable=False, default="📦")
    # Display order within the customs section of the dropdown.
    # Lower = earlier. v1 doesn't expose reordering UI; the Operator
    # can edit the row directly via SQL if they care.
    sort_order = Column(Integer, nullable=False, default=100)

    created_at = Column(DateTime, default=datetime.datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.datetime.utcnow, onupdate=datetime.datetime.utcnow)
