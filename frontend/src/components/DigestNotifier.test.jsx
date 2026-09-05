import { render, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import DigestNotifier from './DigestNotifier'
import { getWeeklyDigest } from '../api/client'

vi.mock('../api/client', () => ({ getWeeklyDigest: vi.fn() }))
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.clearAllMocks() })

it('delivers the Sunday digest on Monday and does not repeat on remount', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(2026, 8, 7, 12))
  const notify = vi.fn(function () {})
  notify.permission = 'granted'
  vi.stubGlobal('Notification', notify)
  getWeeklyDigest.mockResolvedValue({ happened: { spend: 100, spend_delta: { pct: null } } })
  const view = render(<DigestNotifier />)
  await waitFor(() => expect(notify).toHaveBeenCalledTimes(1))
  expect(getWeeklyDigest).toHaveBeenCalledWith('2026-09-06')
  view.unmount()
  render(<DigestNotifier />)
  expect(getWeeklyDigest).toHaveBeenCalledTimes(1)
})

it('does not request data or notification permission when permission is absent', () => {
  const notify = vi.fn()
  notify.permission = 'default'
  vi.stubGlobal('Notification', notify)
  render(<DigestNotifier />)
  expect(getWeeklyDigest).not.toHaveBeenCalled()
  expect(notify).not.toHaveBeenCalled()
})
