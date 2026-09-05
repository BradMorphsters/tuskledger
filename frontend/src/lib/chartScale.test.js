import { describe, it, expect } from 'vitest'
import { niceStep, niceDomain, currencyTickFormatter } from './chartScale'

describe('niceStep', () => {
  it('snaps up to 1/2/2.5/5 times a power of ten', () => {
    expect(niceStep(1)).toBe(1)
    expect(niceStep(1.5)).toBe(2)
    expect(niceStep(2.4)).toBe(2.5)
    expect(niceStep(3)).toBe(5)
    expect(niceStep(7)).toBe(10)
    expect(niceStep(3700)).toBe(5000)
    expect(niceStep(12000)).toBe(20000)
  })

  it('never returns zero or NaN for junk input', () => {
    expect(niceStep(0)).toBe(1)
    expect(niceStep(-5)).toBe(1)
    expect(niceStep(NaN)).toBe(1)
  })
})

describe('niceDomain', () => {
  it('zooms in on a small move over a large balance', () => {
    // Typical shape: a ~$500k balance moving ~$10k over 30 days.
    const { domain, zoomed } = niceDomain([490123.45, 495000, 500987.65])
    expect(zoomed).toBe(true)
    expect(domain[0]).toBeGreaterThan(450000)   // NOT anchored at zero
    expect(domain[0]).toBeLessThan(490123.45)   // still contains the data
    expect(domain[1]).toBeGreaterThanOrEqual(500987.65)
  })

  it('gives the data most of the plot area', () => {
    const values = [490123.45, 500987.65]
    const { domain } = niceDomain(values)
    const dataSpan = 500987.65 - 490123.45
    const axisSpan = domain[1] - domain[0]
    // Data should fill well over half the axis — the whole point.
    expect(dataSpan / axisSpan).toBeGreaterThan(0.5)
  })

  it('always contains every value it was given', () => {
    const values = [310555.55, 380000, 500987.65, 420000]
    const { domain } = niceDomain(values)
    for (const v of values) {
      expect(v).toBeGreaterThanOrEqual(domain[0])
      expect(v).toBeLessThanOrEqual(domain[1])
    }
  })

  it('does not dip below zero when every value is non-negative', () => {
    const { domain, zoomed } = niceDomain([0, 500, 1200])
    expect(domain[0]).toBe(0)
    expect(zoomed).toBe(false)
  })

  it('allows a negative floor when the data actually goes negative', () => {
    const { domain } = niceDomain([-42000, -10000, 5000])
    expect(domain[0]).toBeLessThanOrEqual(-42000)
    expect(domain[1]).toBeGreaterThanOrEqual(5000)
  })

  it('opens a window around a perfectly flat series', () => {
    const { domain, span } = niceDomain([500000, 500000, 500000])
    expect(span).toBe(0)
    expect(domain[0]).toBeLessThan(500000)
    expect(domain[1]).toBeGreaterThan(500000)
  })

  it('handles a single point', () => {
    const { domain } = niceDomain([498765.43])
    expect(domain[0]).toBeLessThan(498765.43)
    expect(domain[1]).toBeGreaterThan(498765.43)
  })

  it('ignores nulls and undefined from gap-y overlay series', () => {
    const { min, max } = niceDomain([null, 100, undefined, 300, NaN])
    expect(min).toBe(100)
    expect(max).toBe(300)
  })

  it('returns a safe domain for an empty series', () => {
    const { domain } = niceDomain([])
    expect(domain[0]).toBeLessThan(domain[1])
  })

  it('never returns an inverted domain', () => {
    for (const vals of [[0], [1e-9, 2e-9], [-3, -3], [1e9, 1e9 + 0.01]]) {
      const { domain } = niceDomain(vals)
      expect(domain[1]).toBeGreaterThan(domain[0])
    }
  })
})

describe('currencyTickFormatter', () => {
  it('uses whole thousands across a wide axis', () => {
    expect(currencyTickFormatter(320000)(475000)).toBe('$475k')
  })

  it('adds a decimal when whole-k ticks would collide', () => {
    // ~$4k of range: every tick would read "$498k" without this.
    const fmt = currencyTickFormatter(4000)
    expect(fmt(498000)).toBe('$498.0k')
    expect(fmt(499500)).toBe('$499.5k')
  })

  it('drops to plain dollars on a very tight axis', () => {
    expect(currencyTickFormatter(800)(498765)).toBe('$498,765')
  })

  it('switches to millions on a very wide axis', () => {
    expect(currencyTickFormatter(3_000_000)(2_400_000)).toBe('$2.4M')
  })

  it('keeps the sign on negative ticks', () => {
    expect(currencyTickFormatter(320000)(-42000)).toBe('-$42k')
  })
})
