"""Mint-style category mapping for Plaid transaction categories."""

# Map Plaid personal_finance_category primary values to friendly Mint-style categories
PLAID_TO_CATEGORY = {
    "INCOME": "Income",
    "TRANSFER_IN": "Income",
    "BANK_FEES": "Fees & Charges",
    "ENTERTAINMENT": "Entertainment",
    "FOOD_AND_DRINK": "Food & Dining",
    "GENERAL_MERCHANDISE": "Shopping",
    "GENERAL_SERVICES": "Services",
    "GOVERNMENT_AND_NON_PROFIT": "Government & Taxes",
    "HOME_IMPROVEMENT": "Home",
    "LOAN_PAYMENTS": "Loan Payments",
    "MEDICAL": "Health & Medical",
    "PERSONAL_CARE": "Personal Care",
    "RENT_AND_UTILITIES": "Bills & Utilities",
    "TRANSPORTATION": "Transportation",
    "TRAVEL": "Travel",
    "TRANSFER_OUT": "Transfer",
    "OTHER": "Miscellaneous",
    # Money arriving FROM a loan (HELOC draw, refinance proceeds). Not
    # income and not spending — it's the other side of a liability. Used
    # to fall through to the title-cased fallback ("Loan Disbursements"),
    # a category nothing else in the app knows about.
    "LOAN_DISBURSEMENTS": "Transfer",
}

# Names that other importers (the CSV classifier, older Apple Card loads,
# hand-typed categories) have produced for categories that already exist
# under a different name in STANDARD_CATEGORIES. Every write path runs
# through canonical_category() so the same spending never lands in two
# near-duplicate buckets — "Food & Drink" beside "Food & Dining" split the
# food total across a category no budget line could see.
#
# Keys are matched case-insensitively. Add an alias here rather than a
# new standard category when the meaning already exists.
CATEGORY_ALIASES = {
    "food & drink": "Food & Dining",
    "food and drink": "Food & Dining",
    "food and dining": "Food & Dining",
    "dining": "Food & Dining",
    "utilities": "Bills & Utilities",
    "bills and utilities": "Bills & Utilities",
    "healthcare": "Health & Medical",
    "health care": "Health & Medical",
    "medical": "Health & Medical",
    "health and medical": "Health & Medical",
    "other": "Miscellaneous",
    "misc": "Miscellaneous",
    "uncategorized": "Miscellaneous",
    "auto and transport": "Auto & Transport",
    "gas": "Gas & Fuel",
    "fuel": "Gas & Fuel",
    "loan disbursements": "Transfer",
    "transfers": "Transfer",
    "gifts and donations": "Gifts & Donations",
    "fees and charges": "Fees & Charges",
    "government and taxes": "Government & Taxes",
}


def canonical_category(name):
    """Fold a category label onto the standard taxonomy.

    Returns the label unchanged when it's already standard (or unknown —
    a user-defined custom category must survive untouched), and the
    standard spelling when it's a known alias. Whitespace is trimmed;
    matching ignores case.
    """
    if not name:
        return name
    cleaned = " ".join(str(name).split())
    if cleaned in STANDARD_CATEGORIES:
        return cleaned
    return CATEGORY_ALIASES.get(cleaned.lower(), cleaned)

# Standard Mint-like categories for the dropdown
STANDARD_CATEGORIES = [
    "Income",
    "Food & Dining",
    "Shopping",
    "Bills & Utilities",
    "Transportation",
    "Entertainment",
    "Health & Medical",
    "Personal Care",
    "Travel",
    "Home",
    "Education",
    "Childcare",
    "Fees & Charges",
    "Loan Payments",
    "Government & Taxes",
    "Services",
    "Transfer",
    "Groceries",
    "Restaurants",
    "Gas & Fuel",
    "Auto & Transport",
    "Clothing",
    "Electronics",
    "Gifts & Donations",
    "Pets",
    "Subscriptions",
    "Miscellaneous",
]

# Category icons (emoji) for display
CATEGORY_ICONS = {
    "Income": "💰",
    "Food & Dining": "🍽️",
    "Shopping": "🛍️",
    "Bills & Utilities": "🏠",
    "Transportation": "🚗",
    "Entertainment": "🎬",
    "Health & Medical": "🏥",
    "Personal Care": "💇",
    "Travel": "✈️",
    "Home": "🏡",
    "Education": "📚",
    "Childcare": "👶",
    "Fees & Charges": "💳",
    "Loan Payments": "🏦",
    "Government & Taxes": "🏛️",
    "Services": "🔧",
    "Transfer": "↔️",
    "Groceries": "🛒",
    "Restaurants": "🍔",
    "Gas & Fuel": "⛽",
    "Auto & Transport": "🚙",
    "Clothing": "👕",
    "Electronics": "📱",
    "Gifts & Donations": "🎁",
    "Pets": "🐾",
    "Subscriptions": "📺",
    "Miscellaneous": "📦",
}


def map_plaid_category(plaid_primary):
    """Map a Plaid primary category to a friendly Mint-style name.

    Unknown Plaid primaries fall back to a title-cased version of the
    code, then through the alias table, so a new Plaid category can't
    quietly create a bucket outside the taxonomy.
    """
    if not plaid_primary:
        return "Miscellaneous"
    mapped = PLAID_TO_CATEGORY.get(plaid_primary.upper())
    if mapped:
        return mapped
    return canonical_category(plaid_primary.replace("_", " ").title())
