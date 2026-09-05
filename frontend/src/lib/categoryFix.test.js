import { describe, it, expect } from 'vitest'
import { buildRulePattern, undoPlan, bulkUndoPlan, describeSuggestion } from './categoryFix'

describe('buildRulePattern', () => {
  it('prefers the normalized display name, lower-cased', () => {
    expect(buildRulePattern({ display_name: 'Coffee Hut', merchant_name: 'COFFEE HUT #12', name: 'COFFEE HUT #12 SPRINGFIELD' })).toBe('coffee hut')
  })
  it('strips store numbers and processor prefixes so the pattern repeats across visits', () => {
    expect(buildRulePattern({ merchant_name: 'COFFEE HUT #12' })).toBe('coffee hut')
    expect(buildRulePattern({ merchant_name: 'SQ *TACO PLANET' })).toBe('taco planet')
    expect(buildRulePattern({ name: 'AMAZON MKTPL*AB12CD34X' })).toBe('amazon mktpl')
    expect(buildRulePattern({ name: 'DD *DOORDASH DONPOCHOM303' })).toBe('doordash donpochom')
  })
  it('falls back through merchant_name to name', () => {
    expect(buildRulePattern({ merchant_name: null, name: 'POS TEA BARN' })).toBe('pos tea barn')
  })
  it('returns null when nothing usable remains', () => {
    expect(buildRulePattern({ name: '#1234' })).toBe(null)
    expect(buildRulePattern({ name: 'AB' })).toBe(null)
    expect(buildRulePattern(null)).toBe(null)
    expect(buildRulePattern({})).toBe(null)
  })
})

describe('undoPlan', () => {
  it('restores prior overrides and clears rows that had none', () => {
    expect(undoPlan([
      { id: 1, prior_custom_category: null },
      { id: 2, prior_custom_category: 'Gifts & Donations' },
    ])).toEqual([
      { id: 1, body: { custom_category: '' } },
      { id: 2, body: { custom_category: 'Gifts & Donations' } },
    ])
  })
  it('handles empty input', () => {
    expect(undoPlan(undefined)).toEqual([])
  })
})

describe('bulkUndoPlan', () => {
  it('reverts category edits to the pre-change override (or clears)', () => {
    expect(bulkUndoPlan([{ id: 1, custom_category: null }, { id: 2, custom_category: 'Travel' }], 'custom_category'))
      .toEqual([{ id: 1, body: { custom_category: '' } }, { id: 2, body: { custom_category: 'Travel' } }])
  })
  it('reverts transfer toggles to the pre-change flag', () => {
    expect(bulkUndoPlan([{ id: 1, is_transfer: false }, { id: 2, is_transfer: true }], 'is_transfer'))
      .toEqual([{ id: 1, body: { is_transfer: false } }, { id: 2, body: { is_transfer: true } }])
  })
})

describe('describeSuggestion', () => {
  it('reads naturally for one and many', () => {
    expect(describeSuggestion({ merchant: 'Coffee Hut', category: 'Food & Dining', count: 1, alreadyCorrect: 0 }))
      .toBe('1 other Coffee Hut transaction is not Food & Dining.')
    expect(describeSuggestion({ merchant: 'Coffee Hut', category: 'Food & Dining', count: 7, alreadyCorrect: 2 }))
      .toBe('7 other Coffee Hut transactions are not Food & Dining (2 already are).')
  })
  it('is null when there is nothing to suggest', () => {
    expect(describeSuggestion({ merchant: 'X', category: 'Y', count: 0 })).toBe(null)
  })
})
