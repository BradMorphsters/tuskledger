"""CSV classifier — detect format and classify transactions."""
import re
from datetime import datetime
from typing import Optional, Tuple


def detect_format(headers: list[str]) -> Optional[str]:
    """
    Detect CSV format by column headers.
    Returns: 'lmcu', 'chase', 'generic', or None if unrecognized.
    """
    headers_lower = [h.lower().strip() for h in headers]
    
    # LMCU format: Date, Description, Comments, Check Number, Amount, Balance
    if 'date' in headers_lower and 'amount' in headers_lower and 'balance' in headers_lower:
        if 'description' in headers_lower and 'comments' in headers_lower:
            return 'lmcu'
    
    # Chase: Transaction Date, Post Date, Description, Category, Type, Amount, Memo
    if 'transaction date' in headers_lower and 'post date' in headers_lower:
        if 'description' in headers_lower and 'amount' in headers_lower:
            return 'chase'
    
    # Generic: Date, Description, Amount (minimal)
    if 'date' in headers_lower and 'description' in headers_lower and 'amount' in headers_lower:
        return 'generic'
    
    return None


def parse_date(date_str: str) -> Optional[str]:
    """
    Try to parse date. Return ISO format (YYYY-MM-DD) or None.
    Tries M/D/YYYY and YYYY-MM-DD formats.
    """
    if not date_str or not date_str.strip():
        return None
    
    date_str = date_str.strip()
    
    # Try M/D/YYYY
    try:
        dt = datetime.strptime(date_str, '%m/%d/%Y')
        return dt.strftime('%Y-%m-%d')
    except ValueError:
        pass
    
    # Try YYYY-MM-DD
    try:
        dt = datetime.strptime(date_str, '%Y-%m-%d')
        return dt.strftime('%Y-%m-%d')
    except ValueError:
        pass
    
    return None


def parse_amount(amount_str: str, fmt: str) -> Optional[float]:
    """
    Parse amount from string. Handles different formats.
    
    LMCU: parentheses mean negative (e.g., "(123.45)" = -123.45), $ prefix
    Chase/Generic: plain number or with $ prefix, sign in the number itself
    
    Returns float or None if unparseable.
    """
    if not amount_str or not amount_str.strip():
        return None
    
    amount_str = amount_str.strip()
    
    # Remove $ and whitespace
    amount_str = amount_str.replace('$', '').strip()
    
    # LMCU-style parentheses = negative
    if amount_str.startswith('(') and amount_str.endswith(')'):
        try:
            return -float(amount_str[1:-1])
        except ValueError:
            return None
    
    # Regular number
    try:
        return float(amount_str)
    except ValueError:
        return None


def classify_merchant_and_category(
    description: str,
    merchant_override: Optional[str] = None,
    category_override: Optional[str] = None,
) -> Tuple[str, str]:
    """
    Extract merchant name and guess category from description.
    
    Returns: (merchant_name, category)
    """
    merchant = merchant_override or description or "Unknown"
    
    # Simple category heuristics
    category = category_override or "Other"
    
    desc_lower = (description or "").lower()
    merchant_lower = merchant.lower()
    search_text = desc_lower + " " + merchant_lower
    
    # Grocery/food
    if any(x in search_text for x in ['grocery', 'safeway', 'whole foods', 'trader joe', 'kroger', 'walmart', 'target', 'costco', 'restaurant', 'uber eats', 'doordash', 'grubhub', 'starbucks', 'cafe', 'pizza', 'coffee']):
        category = "Food & Drink"
    # Utilities
    elif any(x in search_text for x in ['electric', 'water', 'gas', 'utility', 'internet', 'comcast', 'at&t', 'verizon']):
        category = "Utilities"
    # Transportation
    elif any(x in search_text for x in ['gas', 'shell', 'chevron', 'exxon', 'uber', 'lyft', 'parking', 'transit', 'fuel', 'car wash']):
        category = "Transportation"
    # Entertainment
    elif any(x in search_text for x in ['movie', 'theater', 'spotify', 'netflix', 'hulu', 'gaming', 'steam', 'playstation']):
        category = "Entertainment"
    # Healthcare
    elif any(x in search_text for x in ['pharmacy', 'cvs', 'walgreens', 'doctor', 'hospital', 'medical', 'dental', 'vision']):
        category = "Healthcare"
    # Shopping
    elif any(x in search_text for x in ['amazon', 'ebay', 'retail', 'mall', 'store', 'shop']):
        category = "Shopping"
    
    return merchant, category


def make_merchant_signature(merchant: str) -> str:
    """
    Create a deduplication signature from merchant name.
    Takes first 20 alphanumeric chars.
    """
    alphanumeric = re.sub(r'[^a-zA-Z0-9]', '', merchant)
    return alphanumeric[:20].lower()
