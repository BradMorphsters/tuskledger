"""Tests for the canonical category taxonomy (services/categories.py) and
the importer paths that must honour it."""
from app.services.categories import (
    STANDARD_CATEGORIES,
    canonical_category,
    map_plaid_category,
)
from app.services.csv_classifier import classify_merchant_and_category


def test_standard_names_pass_through():
    for name in STANDARD_CATEGORIES:
        assert canonical_category(name) == name


def test_known_aliases_fold_onto_standard_names():
    assert canonical_category("Food & Drink") == "Food & Dining"
    assert canonical_category("food & drink") == "Food & Dining"
    assert canonical_category("Utilities") == "Bills & Utilities"
    assert canonical_category("Healthcare") == "Health & Medical"
    assert canonical_category("Other") == "Miscellaneous"
    assert canonical_category("Loan Disbursements") == "Transfer"
    assert canonical_category("  Food &   Drink ") == "Food & Dining"


def test_unknown_labels_survive_untouched():
    # A user-defined custom category must not be rewritten.
    assert canonical_category("Cabin Maintenance") == "Cabin Maintenance"
    assert canonical_category(None) is None
    assert canonical_category("") == ""


def test_every_alias_targets_a_standard_category():
    from app.services.categories import CATEGORY_ALIASES
    for target in CATEGORY_ALIASES.values():
        assert target in STANDARD_CATEGORIES, target


def test_plaid_unmapped_primary_goes_through_aliases():
    assert map_plaid_category("LOAN_DISBURSEMENTS") == "Transfer"
    assert map_plaid_category("FOOD_AND_DRINK") == "Food & Dining"
    # Genuinely unknown → readable title-case, still not an alias.
    assert map_plaid_category("SOME_NEW_THING") == "Some New Thing"


def test_csv_classifier_only_emits_standard_categories():
    samples = [
        "STARBUCKS #1234", "DTE ELECTRIC PAYMENT", "SHELL OIL 123",
        "NETFLIX.COM", "CVS PHARMACY", "AMAZON MKTPL", "zzz unknown zzz",
    ]
    for desc in samples:
        _, cat = classify_merchant_and_category(desc)
        assert cat in STANDARD_CATEGORIES, (desc, cat)


def test_csv_category_override_is_canonicalized():
    _, cat = classify_merchant_and_category("WHATEVER", category_override="Food & Drink")
    assert cat == "Food & Dining"
    _, cat = classify_merchant_and_category("WHATEVER", category_override="Pet Care")
    assert cat == "Pet Care"       # custom labels pass through
