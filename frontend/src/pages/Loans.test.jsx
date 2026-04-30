/**
 * Unit tests for the pure helpers in Loans.jsx.
 *
 * Importing the page module pulls in lucide-react and recharts, but we
 * only exercise the exported helper functions here — no rendering. The
 * point is to lock down the HELOC subtype detection contract (which
 * spans Plaid's inconsistent labels) and the icon routing.
 */
import { describe, expect, it } from 'vitest'
import { Home, Car, GraduationCap, CreditCard, Zap } from 'lucide-react'
import { iconFor, isHelocSubtype } from './Loans'

describe('isHelocSubtype', () => {
  it('matches the bare "heloc" string', () => {
    expect(isHelocSubtype('heloc')).toBe(true)
  })

  it('matches case-insensitively', () => {
    expect(isHelocSubtype('HELOC')).toBe(true)
    expect(isHelocSubtype('Home Equity')).toBe(true)
  })

  it('matches Plaid\'s "home equity" subtype variant', () => {
    expect(isHelocSubtype('home equity')).toBe(true)
  })

  it('matches "home equity line of credit" long form', () => {
    expect(isHelocSubtype('home equity line of credit')).toBe(true)
  })

  it('matches generic "line of credit"', () => {
    // Conservative — any line-of-credit subtype gets HELOC treatment
    // since other LOCs are rare and the two-phase amortization model
    // is still the most useful framing.
    expect(isHelocSubtype('line of credit')).toBe(true)
  })

  it('does NOT match a regular mortgage', () => {
    expect(isHelocSubtype('mortgage')).toBe(false)
  })

  it('does NOT match auto / student / credit card', () => {
    expect(isHelocSubtype('auto')).toBe(false)
    expect(isHelocSubtype('student')).toBe(false)
    expect(isHelocSubtype('credit card')).toBe(false)
  })

  it('handles null/undefined/empty defensively', () => {
    expect(isHelocSubtype(null)).toBe(false)
    expect(isHelocSubtype(undefined)).toBe(false)
    expect(isHelocSubtype('')).toBe(false)
  })

  it('coerces non-string inputs without crashing', () => {
    expect(isHelocSubtype(42)).toBe(false)
  })
})

describe('iconFor', () => {
  it('routes mortgage → Home', () => {
    expect(iconFor('mortgage')).toBe(Home)
  })

  it('routes auto → Car', () => {
    expect(iconFor('auto')).toBe(Car)
  })

  it('routes student → GraduationCap', () => {
    expect(iconFor('student')).toBe(GraduationCap)
  })

  it('routes HELOC subtypes → Zap (the lightning bolt)', () => {
    expect(iconFor('heloc')).toBe(Zap)
    expect(iconFor('home equity')).toBe(Zap)
  })

  it('falls back to CreditCard for unknown subtypes', () => {
    expect(iconFor('personal')).toBe(CreditCard)
    expect(iconFor(undefined)).toBe(CreditCard)
    expect(iconFor('')).toBe(CreditCard)
  })

  it('does not match HELOC partial strings inside unrelated subtypes', () => {
    // Defensive: "auto loan" shouldn't route to HELOC even though it
    // contains the substring "loan". The HELOC matcher only triggers
    // on heloc / home equity / line of credit specifically.
    expect(iconFor('auto loan')).toBe(CreditCard)
  })
})
