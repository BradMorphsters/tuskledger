/**
 * Tests for PreflightSellModal pure helpers.
 *
 * The modal itself is a thin viewer over server-computed data; the
 * recommendation tier mapping is the only frontend-side logic worth
 * pinning down. The math (wash-sale detection, tax delta, recommendation
 * classification) is covered by test_trading_tax.py.
 */
import { describe, expect, it } from 'vitest'
import { AlertTriangle, AlertCircle, CheckCircle } from 'lucide-react'
import { recommendationStyle } from './PreflightSellModal'

describe('recommendationStyle', () => {
  it('maps "avoid" to red + AlertTriangle', () => {
    const s = recommendationStyle('avoid')
    expect(s.accent).toBe('red')
    expect(s.icon).toBe(AlertTriangle)
    expect(s.label).toMatch(/avoid/i)
  })

  it('maps "caution" to orange + AlertCircle', () => {
    const s = recommendationStyle('caution')
    expect(s.accent).toBe('orange')
    expect(s.icon).toBe(AlertCircle)
    expect(s.label).toMatch(/caution/i)
  })

  it('maps "proceed" to green + CheckCircle', () => {
    const s = recommendationStyle('proceed')
    expect(s.accent).toBe('green')
    expect(s.icon).toBe(CheckCircle)
    expect(s.label).toMatch(/safe/i)
  })

  it('falls back to the safe (proceed) style for unknown values', () => {
    // Defensive: if backend returns a tier we don't recognize, render
    // the calmest variant rather than crashing or showing a scary banner.
    expect(recommendationStyle('???').accent).toBe('green')
    expect(recommendationStyle(undefined).accent).toBe('green')
    expect(recommendationStyle(null).accent).toBe('green')
  })
})
