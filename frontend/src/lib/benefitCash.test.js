import { describe, it, expect } from 'vitest'
import {
  isDcfsaAccount,
  isCashWalletAccount,
  isOtherCashAccount,
  inferPaychecksPerYear,
  summarizeDcfsa,
} from './benefitCash'

const fsa = { id: 1, type: 'depository', subtype: 'fsa', name: 'Benefit FSA' }
const wallet = { id: 2, type: 'depository', subtype: 'cash management', name: 'Wallet' }
const checking = { id: 3, type: 'depository', subtype: 'checking', name: 'Checking' }
const savings = { id: 4, type: 'depository', subtype: 'savings', name: 'Savings' }
const hsa = { id: 5, type: 'investment', subtype: 'hsa', name: 'HSA' }

describe('account classification', () => {
  it('detects a DCFSA by subtype or by name', () => {
    expect(isDcfsaAccount(fsa)).toBe(true)
    expect(isDcfsaAccount({ type: 'depository', subtype: null, name: 'Dependent Care FSA 2027' })).toBe(true)
    expect(isDcfsaAccount({ type: 'depository', subtype: 'other', custom_name: 'DCFSA' })).toBe(true)
    expect(isDcfsaAccount(checking)).toBe(false)
    expect(isDcfsaAccount(hsa)).toBe(false)
  })
  it('detects cash wallets', () => {
    expect(isCashWalletAccount(wallet)).toBe(true)
    expect(isCashWalletAccount(checking)).toBe(false)
  })
  it('other cash = wallets + FSAs, never checking/savings/investments', () => {
    expect([fsa, wallet, checking, savings, hsa].filter(isOtherCashAccount).map((a) => a.id)).toEqual([1, 2])
  })
})

describe('inferPaychecksPerYear', () => {
  it('needs two dates', () => {
    expect(inferPaychecksPerYear(['2026-01-05'])).toBe(null)
  })
  it('semimonthly (5th/20th)', () => {
    expect(inferPaychecksPerYear(['2026-01-05', '2026-01-20', '2026-02-05', '2026-02-20'])).toBe(24)
  })
  it('biweekly', () => {
    expect(inferPaychecksPerYear(['2026-01-02', '2026-01-16', '2026-01-30'])).toBe(26)
  })
  it('weekly and monthly', () => {
    expect(inferPaychecksPerYear(['2026-01-02', '2026-01-09', '2026-01-16'])).toBe(52)
    expect(inferPaychecksPerYear(['2026-01-15', '2026-02-15', '2026-03-15'])).toBe(12)
  })
})

describe('summarizeDcfsa', () => {
  const contrib = (date) => ({ date, amount: -100 })
  const claim = (date, amount) => ({ date, amount })
  const txns = [
    contrib('2026-01-05'), contrib('2026-01-20'), contrib('2026-02-05'), contrib('2026-02-20'),
    claim('2026-02-21', 250),
    contrib('2025-12-20'),            // prior plan year — ignored
    claim('2025-12-30', 999),         // prior plan year — ignored
  ]
  it('sums funded and claimed for the plan year only', () => {
    const s = summarizeDcfsa(txns, 2026)
    expect(s.funded).toBe(400)
    expect(s.claimed).toBe(250)
    expect(s.contributions).toBe(4)
    expect(s.lastContribution).toBe('2026-02-20')
  })
  it('projects the election from per-check × cadence, rounded to $10', () => {
    const s = summarizeDcfsa(
      ['2026-01-02', '2026-01-16', '2026-01-30'].map((d) => ({ date: d, amount: -115.38 })),
      2026,
    )
    expect(s.perCheck).toBe(115.38)
    expect(s.paychecksPerYear).toBe(26)
    expect(s.projectedElection).toBe(3000)
  })
  it('handles no data', () => {
    const s = summarizeDcfsa([], 2026)
    expect(s).toMatchObject({ funded: 0, claimed: 0, perCheck: 0, paychecksPerYear: null, projectedElection: 0 })
  })
})
