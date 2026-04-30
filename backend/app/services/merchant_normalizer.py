"""Clean Plaid's raw transaction strings into readable merchant names.

Plaid returns `merchant_name` when it can (e.g. "Starbucks"), but for ACH
transfers, credit-card payments, and utility bills it falls back to the
raw bank description, which looks like:

    WITHDRAWAL CHASE CREDIT CRD TYPE: EPAY ID: *XXXX
      CO: CHASE CREDIT CRD NAME: ACCOUNT HOLDER
      %% ACH ECC WEB %% ACH Trace *XXXXXXXXX

This module collapses that noise into "Chase Credit Card Payment" and
similar, with a registry of known issuers so new ones are easy to add.

`normalize(raw)` is a pure function — no DB access, no caching. It's cheap
to call per-transaction; the Transaction model exposes a `display_name`
property that runs it on the fly so we don't need to backfill a column.
"""
from __future__ import annotations

import re
from typing import Optional


# Known issuer / servicer patterns. First match wins. Patterns are matched
# against the UPPERCASED raw string so keep them uppercase here.
# Each entry: (compiled pattern, replacement friendly name, kind).
# `kind` is informational (e.g. "CC payment", "loan payment") — not
# currently displayed but useful for the transfer detector to cross-reference.
_ISSUER_RULES: list[tuple[re.Pattern, str, str]] = [
    # --- Credit card payments (biller-side strings) ---
    (re.compile(r"\bCHASE CREDIT CRD\b|\bCHASE\s+CC\s+PYMT\b|\bJPMCB\s+CARD\b"), "Chase Credit Card Payment", "cc_payment"),
    # "Apple Card" alone is safe to treat as a CC payment — you can't
    # *spend* at Apple Card, only pay its bill. Same goes for the other
    # bill-only merchant names we allowlist here.
    (re.compile(r"\bAPPLECARD\s*GSBANK\b|\bAPPLE\s+CARD\s+PAYMENT\b|\bAPPLE\s+CARD\b"), "Apple Card Payment", "cc_payment"),
    (re.compile(r"\bAMEX EPAYMENT\b|\bAMERICAN\s+EXPRESS\b|\bAMEX\s+PAYMENT\b"), "American Express Payment", "cc_payment"),
    (re.compile(r"\bCITIBANK\b|\bCITI\s+CARD\b|\bCITI\s+AUTOPAY\b"), "Citi Credit Card Payment", "cc_payment"),
    (re.compile(r"\bCAPITAL\s+ONE\b"), "Capital One Payment", "cc_payment"),
    (re.compile(r"\bDISCOVER\b"), "Discover Payment", "cc_payment"),
    (re.compile(r"\bCARDMEMBER\s+SERV\b|\bCARDMEMBER\s+SERVICES\b"), "Credit Card Payment", "cc_payment"),
    (re.compile(r"\bBARCLAY(S|CARD)\b"), "Barclays Payment", "cc_payment"),
    (re.compile(r"\bSYNCHRONY\b"), "Synchrony Payment", "cc_payment"),
    (re.compile(r"\bWELLS\s*FARGO\s+CARD\b|\bWF\s+CARD\b"), "Wells Fargo Card Payment", "cc_payment"),

    # --- Mortgage payments ---
    # 'WF' is the common ACH abbreviation for Wells Fargo on bank
    # statements ("WF HOME MTG TYPE: AUTO PAY..."). Match it alongside
    # the full name so the merchant collapses cleanly in Top Merchants.
    (re.compile(r"\bWELLS\s*FARGO\s+(HOME\s+)?(MORTGAGE|MTG|HM\s+MTG)\b|\bWF\s+(HOME\s+)?(MORTGAGE|MTG|HM\s+MTG)\b"), "Wells Fargo Mortgage", "loan_payment"),
    (re.compile(r"\bROCKET\s*(MORTGAGE|MTG)\b|\bQUICKEN\s+LOANS\b"), "Rocket Mortgage", "loan_payment"),
    (re.compile(r"\bMR\.?\s*COOPER\b|\bMRCOOPER\b"), "Mr. Cooper Mortgage", "loan_payment"),
    (re.compile(r"\bPENNYMAC\b"), "PennyMac Mortgage", "loan_payment"),
    (re.compile(r"\bFREEDOM\s+MORTGAGE\b"), "Freedom Mortgage", "loan_payment"),
    # NOTE: do NOT add a bare "WELLS FARGO" catch-all — it would mis-flag
    # ATM withdrawals, deposits, and other regular Wells Fargo activity as
    # transfers. Only specific mortgage / card-payment substrings above qualify.

    # --- Loan / student loan servicers ---
    (re.compile(r"\bDEPT\s+EDUCATION\b|\bUS\s+DEPT\s+OF\s+ED\b|\bDEPT\s+OF\s+ED\b"), "Dept of Education", "loan_payment"),
    (re.compile(r"\bMOHELA\b"), "MOHELA Student Loan", "loan_payment"),
    (re.compile(r"\bNELNET\b"), "Nelnet Student Loan", "loan_payment"),
    (re.compile(r"\bAIDVANTAGE\b"), "Aidvantage Student Loan", "loan_payment"),
    (re.compile(r"\bSALLIE\s+MAE\b"), "Sallie Mae", "loan_payment"),

    # --- Internal bank transfers ---
    (re.compile(r"\bTRANSFER\s+TO\s+LOAN\s+\d+\b"), "Internal Transfer to Loan", "internal_transfer"),
    (re.compile(r"\bTRANSFER\s+FROM\s+LOAN\s+\d+\b"), "Internal Transfer from Loan", "internal_transfer"),
    (re.compile(r"\bINTERNAL\s+TRANSFER\b|\bTRANSFER\s+TO\s+(CHECKING|SAVINGS)\b|\bTRANSFER\s+FROM\s+(CHECKING|SAVINGS)\b"), "Internal Transfer", "internal_transfer"),
    (re.compile(r"\bAUTOMATIC\s+PAYMENT\s*-\s*THANK\b"), "Autopay Credit", "cc_payment"),

    # --- Brokerage / investment account funding ---
    # Moving money from your checking account to a brokerage isn't spending —
    # it's an account-to-account transfer, just one Plaid usually can't pair
    # automatically because the brokerage side comes through as an
    # InvestmentTransaction rather than a regular Transaction. These rules
    # catch the ACH legs by issuer name. You can't spend AT a brokerage,
    # only fund or withdraw from one, so a bare match is safe.
    (re.compile(r"\bROBINHOOD\b"), "Robinhood Transfer", "brokerage_transfer"),
    (re.compile(r"\bFIDELITY\b|\bFID\s+BKG\b|\bFID\s+ACH\b"), "Fidelity Transfer", "brokerage_transfer"),
    (re.compile(r"\bVANGUARD\b|\bVGI\s+ACH\b"), "Vanguard Transfer", "brokerage_transfer"),
    (re.compile(r"\bCHARLES\s+SCHWAB\b|\bSCHWAB\s+BROKERAGE\b|\bSCHWAB\s+&\s+CO\b"), "Charles Schwab Transfer", "brokerage_transfer"),
    (re.compile(r"\bE[*\s]?TRADE\b|\bETRADE\b"), "E*TRADE Transfer", "brokerage_transfer"),
    (re.compile(r"\bTD\s+AMERITRADE\b"), "TD Ameritrade Transfer", "brokerage_transfer"),
    (re.compile(r"\bMERRILL\s+(LYNCH|EDGE)\b|\bMLPF&S\b"), "Merrill Transfer", "brokerage_transfer"),
    (re.compile(r"\bWEALTHFRONT\b"), "Wealthfront Transfer", "brokerage_transfer"),
    (re.compile(r"\bBETTERMENT\b"), "Betterment Transfer", "brokerage_transfer"),
    (re.compile(r"\bSOFI\s+INVEST\b"), "SoFi Invest Transfer", "brokerage_transfer"),
    (re.compile(r"\bACORNS\b"), "Acorns Transfer", "brokerage_transfer"),
    (re.compile(r"\bCOINBASE\b"), "Coinbase Transfer", "brokerage_transfer"),
    (re.compile(r"\bGEMINI\s+TRUST\b|\bGEMINI\s+EXCHANGE\b"), "Gemini Transfer", "brokerage_transfer"),
    (re.compile(r"\bKRAKEN\s+EXCHANGE\b|\bPAYWARD\b"), "Kraken Transfer", "brokerage_transfer"),

    # --- Utilities / subscriptions that come through as ACH without a clean merchant name ---
    (re.compile(r"\bCONSUMERS\s+ENERGY\b"), "Consumers Energy", "utility"),
    (re.compile(r"\bDTE\s+ENERGY\b"), "DTE Energy", "utility"),
    (re.compile(r"\bCOMCAST\b|\bXFINITY\b"), "Comcast / Xfinity", "utility"),
    (re.compile(r"\bT[- ]?MOBILE\b"), "T-Mobile", "utility"),
    (re.compile(r"\bVERIZON\b"), "Verizon", "utility"),
    (re.compile(r"\bAT&T\b|\bATT\s+PAYMENT\b"), "AT&T", "utility"),
]


# Noise tokens that appear in ACH descriptions. Stripped during general
# cleanup. Order matters — more-specific first.
_NOISE_PATTERNS: list[re.Pattern] = [
    re.compile(r"%%\s*ACH\s+ECC\s+\w+\s*%%\s*ACH\s+Trace\s*\*?\d+", re.IGNORECASE),
    re.compile(r"%%\s*ACH\s+Trace\s*\*?\d+", re.IGNORECASE),
    re.compile(r"\bACH\s+TRACE\s*\*?\d+", re.IGNORECASE),
    re.compile(r"\bACH\s+TRANSACTION\b", re.IGNORECASE),
    re.compile(r"\bDATA:\s*.+?(?=\s+CO:|\s*$)", re.IGNORECASE),
    re.compile(r"\bNAME:\s*.+?(?=\s+%%|\s*$)", re.IGNORECASE),
    re.compile(r"\bID:\s*\*?\d+"),
    re.compile(r"\bTYPE:\s*\S+"),
    re.compile(r"\bCO:\s*", re.IGNORECASE),
    re.compile(r"\bWEB\s+ID:\s*\S+", re.IGNORECASE),
    re.compile(r"^(WITHDRAWAL|DEPOSIT|DEBIT|CREDIT)\s+", re.IGNORECASE),
    re.compile(r"%%"),
]


def normalize(raw: Optional[str]) -> Optional[str]:
    """Return a readable merchant name for the given raw description.

    Returns None if input is None/empty. Prefers the issuer-rule match
    when one fires, otherwise falls back to a whitespace- and
    metadata-stripped version of the original, title-cased.
    """
    if not raw:
        return raw

    upper = raw.upper()
    for pattern, friendly, _kind in _ISSUER_RULES:
        if pattern.search(upper):
            return friendly

    # General cleanup: remove the ACH/bank noise tokens and collapse whitespace.
    cleaned = raw
    for pat in _NOISE_PATTERNS:
        cleaned = pat.sub(" ", cleaned)
    cleaned = re.sub(r"\s+", " ", cleaned).strip(" -:*")

    if not cleaned:
        return raw  # Nothing left after stripping — safer to return the original.

    # Title-case, but preserve runs that already have mixed case (likely
    # intentional, like "Venmo" or "PayPal"). Only title-case when the
    # string is all-upper or all-lower.
    if cleaned.isupper() or cleaned.islower():
        cleaned = cleaned.title()

    return cleaned


def classify(raw: Optional[str]) -> Optional[str]:
    """Return the 'kind' label from the issuer rules ('cc_payment',
    'loan_payment', 'internal_transfer', 'utility') if one matches,
    otherwise None. Used by the transfer detector.
    """
    if not raw:
        return None
    upper = raw.upper()
    for pattern, _friendly, kind in _ISSUER_RULES:
        if pattern.search(upper):
            return kind
    return None
