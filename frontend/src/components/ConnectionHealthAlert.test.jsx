import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ConnectionHealthAlert, { summarizeConnectionIssues, describeIssue } from './ConnectionHealthAlert'
import { getPlaidItemsHealth } from '../api/client'

vi.mock('../api/client', () => ({ getPlaidItemsHealth: vi.fn() }))

const stale = (over = {}) => ({
  id: 1,
  institution_name: 'Test Credit Union',
  institution_id: 'ins_1',
  status: 'stale',
  last_successful_update: '2026-03-10T23:00:00Z',
  last_attempt_failed: true,
  error: null,
  ...over,
})

beforeEach(() => { localStorage.clear() })
afterEach(() => { vi.clearAllMocks() })

describe('summarizeConnectionIssues', () => {
  it('ignores healthy and unknown connections', () => {
    expect(summarizeConnectionIssues([
      stale({ status: 'ok' }), stale({ status: 'unknown' }),
    ])).toEqual([])
    expect(summarizeConnectionIssues(undefined)).toEqual([])
  })

  it('groups logins at the same bank and keeps the oldest successful update', () => {
    const [issue, ...rest] = summarizeConnectionIssues([
      stale({ id: 1, last_successful_update: '2026-03-11T01:00:00Z', last_attempt_failed: false }),
      stale({ id: 2, last_successful_update: '2026-03-10T22:00:00Z' }),
      stale({ id: 3, last_successful_update: '2026-03-10T23:00:00Z', last_attempt_failed: false }),
    ])
    expect(rest).toEqual([])
    expect(issue.count).toBe(3)
    expect(issue.since).toBe('2026-03-10T22:00:00Z')
    expect(issue.failing).toBe(true)
  })

  it('puts errors first and carries the error code', () => {
    const issues = summarizeConnectionIssues([
      stale({ institution_name: 'Alpha Bank', institution_id: 'ins_a' }),
      stale({ institution_name: 'Zeta Bank', institution_id: 'ins_z', status: 'error', error: { code: 'ITEM_LOGIN_REQUIRED' } }),
    ])
    expect(issues.map(i => i.institutionName)).toEqual(['Zeta Bank', 'Alpha Bank'])
    expect(issues[0].errorCode).toBe('ITEM_LOGIN_REQUIRED')
  })
})

describe('describeIssue', () => {
  it('explains a stale connection without suggesting Reconnect', () => {
    const [issue] = summarizeConnectionIssues([stale({ id: 1 }), stale({ id: 2 })])
    const text = describeIssue(issue)
    expect(text).toContain('Test Credit Union (2 connections)')
    expect(text).toMatch(/no new data since Mar 1[01]/)
    expect(text).toContain('attempts to reach the bank are failing')
    expect(text).not.toContain('Reconnect')
  })

  it('drops the name when the headline already carries it', () => {
    const [issue] = summarizeConnectionIssues([stale({ id: 1 }), stale({ id: 2 })])
    const text = describeIssue(issue, { named: false })
    expect(text).not.toContain('Test Credit Union')
    expect(text).toMatch(/^No new data since Mar 1[01] \(2 connections\), and Plaid/)
  })

  it('points errors at Reconnect', () => {
    const [issue] = summarizeConnectionIssues([stale({ status: 'error', error: { code: 'ITEM_LOGIN_REQUIRED' } })])
    expect(describeIssue(issue)).toContain('ITEM_LOGIN_REQUIRED')
    expect(describeIssue(issue)).toContain('Reconnect')
  })
})

describe('<ConnectionHealthAlert />', () => {
  const renderAlert = () => render(<MemoryRouter><ConnectionHealthAlert /></MemoryRouter>)

  it('reads the cached health and shows a banner with links', async () => {
    getPlaidItemsHealth.mockResolvedValue({ items: [stale()] })
    renderAlert()
    expect(await screen.findByText("Test Credit Union isn't updating")).toBeTruthy()
    expect(getPlaidItemsHealth).toHaveBeenCalledWith(360)
    expect(screen.getByText(/Plaid status/).closest('a').getAttribute('href'))
      .toBe('https://dashboard.plaid.com/activity/status/institution/ins_1')
    expect(screen.getByText(/Review connections/).closest('a').getAttribute('href')).toBe('/connect')
  })

  it('renders nothing when every connection is healthy', async () => {
    getPlaidItemsHealth.mockResolvedValue({ items: [stale({ status: 'ok' })] })
    const { container } = renderAlert()
    await waitFor(() => expect(getPlaidItemsHealth).toHaveBeenCalled())
    expect(container.innerHTML).toBe('')
  })

  it('stays hidden after dismissal until the set of problems changes', async () => {
    getPlaidItemsHealth.mockResolvedValue({ items: [stale()] })
    const first = renderAlert()
    fireEvent.click(await screen.findByLabelText('Hide until tomorrow'))
    expect(screen.queryByRole('alert')).toBeNull()
    first.unmount()

    renderAlert()
    await waitFor(() => expect(getPlaidItemsHealth).toHaveBeenCalledTimes(2))
    expect(screen.queryByRole('alert')).toBeNull()

    getPlaidItemsHealth.mockResolvedValue({
      items: [stale(), stale({ id: 9, institution_name: 'Other Bank', institution_id: 'ins_9', status: 'error', error: { code: 'ITEM_LOGIN_REQUIRED' } })],
    })
    renderAlert()
    expect(await screen.findByText("2 bank connections aren't updating")).toBeTruthy()
  })

  it('stays quiet when the health check fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    getPlaidItemsHealth.mockRejectedValue(new Error('offline'))
    const { container } = renderAlert()
    await waitFor(() => expect(warn).toHaveBeenCalled())
    expect(container.innerHTML).toBe('')
    warn.mockRestore()
  })
})
