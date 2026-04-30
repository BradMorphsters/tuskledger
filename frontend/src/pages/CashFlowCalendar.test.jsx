/**
 * Tests for the bill-override pure functions on the cash flow calendar.
 *
 * The override layer is a stable identity (`merchant|date`) plus an
 * apply step. Both are easy to break with a careless refactor — e.g.
 * keying by the displayed date instead of the original would make
 * subsequent drags create new entries instead of updating in place.
 */
import { describe, expect, it } from 'vitest'
import { applyBillOverrides, billKey } from './CashFlowCalendar'

describe('billKey', () => {
  it('combines merchant + date with a pipe', () => {
    expect(billKey({ merchant: 'Comcast', date: '2026-05-12' }))
      .toBe('Comcast|2026-05-12')
  })

  it('is stable across calls (no Date.now or randomness)', () => {
    const e = { merchant: 'Comcast', date: '2026-05-12' }
    expect(billKey(e)).toBe(billKey(e))
  })

  it('treats different merchants as different keys', () => {
    expect(billKey({ merchant: 'A', date: '2026-05-12' }))
      .not.toBe(billKey({ merchant: 'B', date: '2026-05-12' }))
  })
})

describe('applyBillOverrides', () => {
  const events = [
    { merchant: 'Comcast', date: '2026-05-12', amount: 89, type: 'expense' },
    { merchant: 'Verizon', date: '2026-05-15', amount: 70, type: 'expense' },
    { merchant: 'Payroll', date: '2026-05-31', amount: -3200, type: 'income' },
  ]

  it('returns events unchanged (with _originalDate stamped) when no overrides', () => {
    const out = applyBillOverrides(events, {})
    expect(out).toHaveLength(3)
    expect(out[0].date).toBe('2026-05-12')
    expect(out[0]._originalDate).toBe('2026-05-12')
  })

  it('applies overrides to matching events by stable key', () => {
    const overrides = { 'Comcast|2026-05-12': '2026-05-20' }
    const out = applyBillOverrides(events, overrides)
    expect(out[0].date).toBe('2026-05-20')
    // The original date is preserved so the override key stays stable
    // across subsequent drags of the same bill.
    expect(out[0]._originalDate).toBe('2026-05-12')
  })

  it('leaves non-overridden events untouched', () => {
    const overrides = { 'Comcast|2026-05-12': '2026-05-20' }
    const out = applyBillOverrides(events, overrides)
    expect(out[1].date).toBe('2026-05-15')
    expect(out[2].date).toBe('2026-05-31')
  })

  it('preserves all other event fields', () => {
    const overrides = { 'Comcast|2026-05-12': '2026-05-20' }
    const out = applyBillOverrides(events, overrides)
    expect(out[0].amount).toBe(89)
    expect(out[0].merchant).toBe('Comcast')
    expect(out[0].type).toBe('expense')
  })

  it('handles null overrides parameter (treated as empty)', () => {
    const out = applyBillOverrides(events, null)
    expect(out).toHaveLength(3)
    expect(out[0].date).toBe('2026-05-12')
  })

  it('handles undefined overrides parameter', () => {
    const out = applyBillOverrides(events, undefined)
    expect(out).toHaveLength(3)
  })

  it('returns empty array for non-array input (defensive)', () => {
    expect(applyBillOverrides(null, {})).toEqual([])
    expect(applyBillOverrides(undefined, {})).toEqual([])
  })

  it('does not mutate the input events', () => {
    const original = [{ merchant: 'C', date: '2026-05-12' }]
    const snapshot = JSON.stringify(original)
    applyBillOverrides(original, { 'C|2026-05-12': '2026-05-20' })
    expect(JSON.stringify(original)).toBe(snapshot)
  })
})
