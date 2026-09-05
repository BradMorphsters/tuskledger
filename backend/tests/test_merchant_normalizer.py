"""Tests for merchant_normalizer.normalize on ACH-style bank descriptors.
Fixture strings are synthetic but shaped like real credit-union output."""
from app.services.merchant_normalizer import normalize


def test_payroll_descriptor_rolls_up_to_the_payer():
    a = normalize("DEPOSIT ACME WIDGETS TYPE: PAYROLL ID: *1001 DATA: XXXXXX0001 09 "
                  "CO: ACME WIDGETS %% ACH ECC PPD %% ACH Trace *000000001")
    b = normalize("DEPOSIT ACME WIDGETS TYPE: PAYROLL ID: *1001 DATA: XXXXXX0001 09 "
                  "CO: ACME WIDGETS %% ACH ECC PPD %% ACH Trace *000000002")
    assert a == b == "Acme Widgets"          # trace numbers differ, payer identical


def test_repeated_payer_is_collapsed_once():
    assert normalize("DEPOSIT ACME WIDGETS TYPE: PAYROLL CO: ACME WIDGETS") == "Acme Widgets"


def test_multiword_type_is_stripped():
    assert normalize("DEPOSIT IRS TREAS 310 TYPE: TAX REF ID: *0001 CO: IRS TREAS 310 "
                     "%% ACH ECC PPD %% ACH Trace *000000003") == "Irs Treas 310"
    assert normalize("DEPOSIT ACME WIDGETS TYPE: DIRECT-PAY ID: *1002 CO: ACME WIDGETS "
                     "%% ACH ECC PPD %% ACH Trace *1") == "Acme Widgets"


def test_masked_ids_are_stripped():
    assert normalize("WITHDRAWAL CLUBCO TYPE: 10000001 ID: XXXXXX0002 CO: CLUBCO DATA: F") == "Clubco"


def test_ach_prefix_and_payroll_suffix_match_the_deposit_form():
    assert normalize("ACH/ACME WIDGETS - PAYROLL") == "Acme Widgets"


def test_plain_merchants_untouched():
    assert normalize("Venmo") == "Venmo"
    assert normalize("Costco") == "Costco"
    assert normalize(None) is None
    assert normalize("") == ""


def test_issuer_rules_still_win():
    assert normalize("WITHDRAWAL CHASE CREDIT CRD TYPE: AUTOPAY ID: *0003 CO: CHASE CREDIT CRD "
                     "%% ACH ECC PPD %% ACH Trace *000000004") == "Chase Credit Card Payment"
