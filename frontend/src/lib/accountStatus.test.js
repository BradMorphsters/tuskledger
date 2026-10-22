import { describe, expect, it } from 'vitest'
import { accountLabel, isClosed, openAccounts } from './accountStatus'

const open = { id: 1, name: 'CHECKING', custom_name: 'Main', status: 'active' }
const legacy = { id: 2, name: 'SAVINGS' }               // pre-0022 payload: no status field
const closed = { id: 3, name: 'OLD CHECKING', status: 'closed', closed_at: '2026-01-20' }

describe('accountStatus', () => {
  it('only status "closed" counts as closed', () => {
    expect(isClosed(open)).toBe(false)
    expect(isClosed(legacy)).toBe(false)
    expect(isClosed(closed)).toBe(true)
    expect(isClosed(undefined)).toBe(false)
  })
  it('openAccounts drops closed ones and tolerates null', () => {
    expect(openAccounts([open, legacy, closed]).map(a => a.id)).toEqual([1, 2])
    expect(openAccounts(null)).toEqual([])
  })
  it('accountLabel prefers the alias and marks closed accounts', () => {
    expect(accountLabel(open)).toBe('Main')
    expect(accountLabel(closed)).toBe('OLD CHECKING (closed)')
  })
})
