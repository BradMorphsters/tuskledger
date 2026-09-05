import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter } from 'react-router-dom'
import WeeklyDigest from './WeeklyDigest'
import { getSafeToSpend, getWeeklyDigest } from '../api/client'

vi.mock('../api/client', () => ({
  getSafeToSpend: vi.fn(),
  getWeeklyDigest: vi.fn(),
}))

function digest(date, spend = 100) {
  return {
    week_start: '2026-08-26',
    week_end: date,
    happened: {
      spend,
      spend_delta: { amount: 0, pct: null },
      income: 0,
      transaction_count: 0,
      refund_count: 0,
      top_categories: [],
      top_merchants: [],
    },
    notable: { new_merchants: [], large_transactions: [], price_hikes: [] },
    coming: {
      next_paycheck_date: '2026-09-12',
      next_paycheck_source: 'recurring_income',
      bills: [],
    },
    budget_status: null,
    net_worth: {
      date,
      net_worth: spend,
      prior_date: '2026-08-25',
      prior_net_worth: spend - 10,
      delta: 10,
    },
    action_items: {
      unpaired_transfers: { count: 0, url: '/transactions' },
      uncategorized: { count: 0, url: '/transactions' },
    },
  }
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(2026, 8, 5, 12))
  getSafeToSpend.mockResolvedValue(null)
  getWeeklyDigest.mockImplementation(date => Promise.resolve(digest(date)))
})

afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
})

function renderPage(entry = '/digest') {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <WeeklyDigest />
    </MemoryRouter>,
  )
}

describe('WeeklyDigest', () => {
  it('uses a valid nonfuture query date and displays the actual comparison date', async () => {
    renderPage('/digest?week_ending=2026-09-01')

    await waitFor(() => expect(getWeeklyDigest).toHaveBeenCalledWith('2026-09-01'))
    expect(screen.getByLabelText('Week ending')).toHaveValue('2026-09-01')
    expect(screen.getByText(/from Aug 25, 2026/)).toBeInTheDocument()
    expect(screen.getByText('Coming (projection)')).toBeInTheDocument()
    expect(screen.getByText(/Projection uses current bill records; historical snapshots are unavailable/)).toBeInTheDocument()
  })

  it('falls back to today for invalid or future query dates and rejects invalid picker values', async () => {
    renderPage('/digest?week_ending=2026-09-06')

    await waitFor(() => expect(getWeeklyDigest).toHaveBeenCalledWith('2026-09-05'))
    const picker = screen.getByLabelText('Week ending')
    expect(picker).toHaveValue('2026-09-05')
    expect(picker).toHaveAttribute('max', '2026-09-05')

    fireEvent.change(picker, { target: { value: '2026-09-06' } })
    fireEvent.change(picker, { target: { value: '' } })
    expect(picker).toHaveValue('2026-09-05')
    expect(getWeeklyDigest).toHaveBeenCalledTimes(1)
  })

  it('falls back to today for a malformed calendar query date', async () => {
    renderPage('/digest?week_ending=2026-02-30')

    await waitFor(() => expect(getWeeklyDigest).toHaveBeenCalledWith('2026-09-05'))
    expect(screen.getByLabelText('Week ending')).toHaveValue('2026-09-05')
  })

  it('keeps only the newest date request result', async () => {
    const pending = new Map()
    getWeeklyDigest.mockImplementation(date => new Promise(resolve => pending.set(date, resolve)))
    renderPage('/digest?week_ending=2026-09-01')
    await waitFor(() => expect(pending.has('2026-09-01')).toBe(true))

    fireEvent.change(screen.getByLabelText('Week ending'), { target: { value: '2026-09-02' } })
    await waitFor(() => expect(pending.has('2026-09-02')).toBe(true))
    pending.get('2026-09-02')(digest('2026-09-02', 222))
    await waitFor(() => expect(screen.getAllByText(/\$222\.00/).length).toBeGreaterThan(0))

    pending.get('2026-09-01')(digest('2026-09-01', 111))
    await waitFor(() => expect(screen.queryByText(/\$111\.00/)).not.toBeInTheDocument())
    expect(screen.getAllByText(/\$222\.00/).length).toBeGreaterThan(0)
  })
})
