/**
 * Tests for the localStorage wrappers + the useStoredState hook.
 *
 * Coverage focus: the never-throws contract, defaults on missing keys,
 * defaults on corrupted JSON, and the hook's persistence + lazy-init
 * + functional-updater behavior.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { loadJSON, saveJSON, removeKey, useStoredState } from './storage'

describe('loadJSON', () => {
  it('returns the parsed value when present', () => {
    localStorage.setItem('k', JSON.stringify({ a: 1 }))
    expect(loadJSON('k')).toEqual({ a: 1 })
  })

  it('returns the default when the key is missing', () => {
    expect(loadJSON('absent', 'fallback')).toBe('fallback')
  })

  it('returns null by default when the key is missing', () => {
    expect(loadJSON('absent')).toBe(null)
  })

  it('returns the default on corrupted JSON (never throws)', () => {
    localStorage.setItem('garbage', '{not json')
    expect(loadJSON('garbage', [])).toEqual([])
  })

  it('returns the default if localStorage.getItem throws', () => {
    // Some browsers throw on getItem in private mode.
    const orig = Storage.prototype.getItem
    Storage.prototype.getItem = vi.fn(() => { throw new Error('Quota') })
    try {
      expect(loadJSON('any', 'fallback')).toBe('fallback')
    } finally {
      Storage.prototype.getItem = orig
    }
  })
})

describe('saveJSON', () => {
  it('returns true on success and persists the value', () => {
    expect(saveJSON('k', { hello: 'world' })).toBe(true)
    expect(JSON.parse(localStorage.getItem('k'))).toEqual({ hello: 'world' })
  })

  it('returns false on quota errors (never throws)', () => {
    const orig = Storage.prototype.setItem
    Storage.prototype.setItem = vi.fn(() => { throw new Error('QuotaExceeded') })
    try {
      expect(saveJSON('k', 'v')).toBe(false)
    } finally {
      Storage.prototype.setItem = orig
    }
  })
})

describe('removeKey', () => {
  it('removes the key', () => {
    localStorage.setItem('k', 'v')
    expect(removeKey('k')).toBe(true)
    expect(localStorage.getItem('k')).toBe(null)
  })

  it('returns true even for keys that don\'t exist', () => {
    expect(removeKey('never-set')).toBe(true)
  })
})

describe('useStoredState', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('uses the default value when the key is missing', () => {
    const { result } = renderHook(() => useStoredState('k1', 'default'))
    expect(result.current[0]).toBe('default')
  })

  it('hydrates from existing localStorage on first mount', () => {
    localStorage.setItem('k2', JSON.stringify({ count: 5 }))
    const { result } = renderHook(() => useStoredState('k2', { count: 0 }))
    expect(result.current[0]).toEqual({ count: 5 })
  })

  it('persists updates to localStorage', () => {
    const { result } = renderHook(() => useStoredState('k3', 0))
    act(() => result.current[1](42))
    expect(result.current[0]).toBe(42)
    expect(JSON.parse(localStorage.getItem('k3'))).toBe(42)
  })

  it('supports the functional-updater form (like useState)', () => {
    const { result } = renderHook(() => useStoredState('k4', 1))
    act(() => result.current[1](prev => prev + 10))
    expect(result.current[0]).toBe(11)
  })

  it('falls back to default when stored value is the JSON literal null', () => {
    // Bug fix: null stored explicitly used to be returned, which
    // crashed callers that did `...stored` (spread on null is a TypeError).
    localStorage.setItem('k5', 'null')
    const { result } = renderHook(() => useStoredState('k5', { safe: true }))
    expect(result.current[0]).toEqual({ safe: true })
  })

  it('supports lazy initializer functions for expensive defaults', () => {
    const expensive = vi.fn(() => ({ computed: true }))
    const { result } = renderHook(() => useStoredState('k6', expensive))
    expect(result.current[0]).toEqual({ computed: true })
    // Lazy initializer should run exactly once (on first render).
    expect(expensive).toHaveBeenCalledTimes(1)
  })

  it('survives corrupted stored JSON by using the default', () => {
    localStorage.setItem('k7', '{not valid')
    const { result } = renderHook(() => useStoredState('k7', 'safe'))
    expect(result.current[0]).toBe('safe')
  })
})
