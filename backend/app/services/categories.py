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
}

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
    """Map a Plaid primary category to a friendly Mint-style name."""
    if not plaid_primary:
        return "Miscellaneous"
    return PLAID_TO_CATEGORY.get(plaid_primary.upper(), plaid_primary.replace("_", " ").title())
