"""Tests for services/tax.py.

Pure-function tests — no DB, no fixtures. Catches regressions in the
bracket math itself (which is easy to get wrong silently — wrong tax
on a $300k income still looks reasonable to a casual reviewer).
"""
import math
import pytest

from app.services.tax import (
    filing_constants,
    ltcg_tax,
    ordinary_tax,
    rmd_divisor,
    ss_taxable,
)


# ─── Ordinary income brackets ──────────────────────────────────────


def test_ordinary_tax_zero_income():
    assert ordinary_tax(0) == 0
    assert ordinary_tax(-1000) == 0


def test_ordinary_tax_first_bracket_only_mfj():
    """$10k income, all under 10% bracket → $1000 tax."""
    assert ordinary_tax(10_000, filing="mfj") == pytest.approx(1_000, rel=0.001)


def test_ordinary_tax_spans_multiple_brackets_mfj():
    """$100k MFJ should hit 10%, 12%, and a touch of 22%.
    First $23,850 @ 10% = $2,385
    Next $73,100 ($96,950 - $23,850) @ 12% = $8,772
    Last $3,050 ($100,000 - $96,950) @ 22% = $671
    Total = $11,828
    """
    expected = 23_850 * 0.10 + (96_950 - 23_850) * 0.12 + (100_000 - 96_950) * 0.22
    assert ordinary_tax(100_000, filing="mfj") == pytest.approx(expected)


def test_ordinary_tax_single_brackets_compress_vs_mfj():
    """Single brackets are roughly half as wide as MFJ. Same income
    should produce more tax under single filing — this is the 'survivor
    penalty' the projection models when survivor_at_user_age fires."""
    income = 80_000
    mfj_tax = ordinary_tax(income, filing="mfj")
    single_tax = ordinary_tax(income, filing="single")
    assert single_tax > mfj_tax


# ─── LTCG (long-term capital gains) ─────────────────────────────────


def test_ltcg_zero_is_zero():
    assert ltcg_tax(0, ordinary_taxable=50_000) == 0


def test_ltcg_full_zero_bracket_mfj():
    """MFJ couple with $50k ordinary + $40k LTCG = $90k AGI, all under
    the $96,700 zero-bracket threshold → $0 LTCG tax. This is the
    early-retiree win the simulator captures."""
    assert ltcg_tax(40_000, ordinary_taxable=50_000, filing="mfj") == 0


def test_ltcg_overflow_into_15_bracket():
    """Same MFJ, but LTCG pushes AGI past $96,700. Excess gets 15%.
    Ordinary $50k → $46.7k of room in 0% bracket → $46.7k LTCG free.
    Remaining $13.3k LTCG @ 15% = $1,995"""
    result = ltcg_tax(60_000, ordinary_taxable=50_000, filing="mfj")
    expected = (60_000 - (96_700 - 50_000)) * 0.15
    assert result == pytest.approx(expected)


def test_ltcg_above_zero_bracket_entirely():
    """$200k ordinary + $50k LTCG → entirely in 15% bracket."""
    result = ltcg_tax(50_000, ordinary_taxable=200_000, filing="mfj")
    assert result == pytest.approx(50_000 * 0.15)


# ─── Social Security taxation (IRS Pub 915) ────────────────────────


def test_ss_taxable_below_first_base_is_zero_mfj():
    """Combined income (other + half SS) under $32k MFJ → 0% taxable."""
    # $5k SS + $20k other = $5k/2 + $20k = $22.5k combined < $32k base
    assert ss_taxable(5_000, other_income=20_000, filing="mfj") == 0


def test_ss_taxable_in_50pct_tier_mfj():
    """Combined between $32k and $44k → up to 50% of excess taxable."""
    # $20k SS + $25k other = $10k + $25k = $35k combined
    # Excess over $32k = $3k → 50% × $3k = $1.5k taxable
    result = ss_taxable(20_000, other_income=25_000, filing="mfj")
    assert result == pytest.approx(1_500, rel=0.01)


def test_ss_taxable_85pct_cap_mfj():
    """High income → caps at 85% of total benefits regardless."""
    # $20k SS + $200k other → way above 85% threshold
    result = ss_taxable(20_000, other_income=200_000, filing="mfj")
    assert result == pytest.approx(20_000 * 0.85)


def test_ss_taxable_zero_benefits():
    assert ss_taxable(0, other_income=100_000) == 0


# ─── RMD divisors ──────────────────────────────────────────────────


def test_rmd_divisor_below_73_is_zero():
    """No RMD required before age 73."""
    assert rmd_divisor(50) == 0
    assert rmd_divisor(72) == 0


def test_rmd_divisor_at_73():
    """First RMD year — divisor 27.4 per IRS Uniform Lifetime Table."""
    assert rmd_divisor(73) == 27.4


def test_rmd_divisor_decreases_with_age():
    """Older age → smaller divisor → larger required distribution."""
    assert rmd_divisor(80) < rmd_divisor(73)
    assert rmd_divisor(90) < rmd_divisor(80)


def test_rmd_divisor_handles_extreme_age():
    """Beyond table cap (115) shouldn't crash — uses cap value."""
    assert rmd_divisor(150) > 0  # doesn't crash


# ─── Filing constants accessor ─────────────────────────────────────


def test_filing_constants_returns_5tuple():
    brackets, ltcg_brackets, std_ded, base1, base2 = filing_constants("mfj")
    assert len(brackets) > 0
    assert len(ltcg_brackets) > 0
    assert std_ded > 0
    assert base1 < base2


def test_mfj_std_deduction_is_double_single():
    """MFJ standard deduction is exactly 2× single — IRS convention."""
    _, _, mfj_std, _, _ = filing_constants("mfj")
    _, _, single_std, _, _ = filing_constants("single")
    assert mfj_std == single_std * 2
