import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { MemoryRouter } from 'react-router-dom'
import Paychecks from './Paychecks'
import { incomePlanFor } from '../components/IncomePlan'
import { getIncomeSchedule, updateEarner } from '../api/client'

vi.mock('../api/client', () => ({
  getIncomeSchedule: vi.fn(),
  updateEarner: vi.fn(),
  resetEarner: vi.fn(),
}))
vi.mock('../components/ReadOnlyMode', () => ({ useReadOnlyMode: () => ({ readOnly: false }) }))

// Fictional household: one bi-weekly earner, one semi-monthly earner.
function earner(over) {
  return {
    key: 'acme', payer: 'Acme Hospital', nickname: null, display_name: 'Acme Hospital',
    hidden: false, status: 'on_track', expected_missed: null,
    schedule: { frequency: 'bi-weekly', label: 'Every other Friday', per_year: 26, min_per_month: 2,
                anchor: '2026-09-18', days_of_month: [], shift: 'before', fit: 1 },
    schedule_source: 'detected', per_check: 2600, per_check_source: 'recent_median',
    last_paid: '2026-09-18', last_amount: 2600, paychecks_seen: 15,
    normalized_monthly: 5633.33, baseline_monthly: 5200, annual: 67600,
    next_paydays: ['2026-10-02', '2026-10-16'],
    split_deposit: [{ account_id: 1, account: 'Checking', amount: 2000 }, { account_id: 2, account: 'Savings', amount: 600 }],
    change: { direction: 'up', pct: 4, previous_per_check: 2500, since: '2026-07-24' },
    history: [],
    ...over,
  }
}

const SCHEDULE = {
  as_of: '2026-09-26',
  household: { earners: 2, normalized_monthly: 8833.33, baseline_monthly: 8400, annual: 106000,
               extra_per_year: 5200, next_payday: { date: '2026-09-30', key: 'riverside', name: 'Partner', amount: 1600 } },
  earners: [
    earner(),
    earner({ key: 'riverside', payer: 'Riverside Schools', nickname: 'Partner', display_name: 'Partner',
             schedule: { frequency: 'semi-monthly', label: 'Twice a month (15th & last day)', per_year: 24, min_per_month: 2,
                         anchor: null, days_of_month: [15, 31], fit: 1 },
             per_check: 1600, baseline_monthly: 3200, normalized_monthly: 3200, annual: 38400,
             split_deposit: [], change: null, next_paydays: ['2026-09-30'] }),
  ],
  upcoming: [{ date: '2026-09-30', key: 'riverside', name: 'Partner', amount: 1600 },
             { date: '2026-10-02', key: 'acme', name: 'Acme Hospital', amount: 2600 }],
  this_month: null,
  months: [
    { month: '2026-09', label: 'Sep 2026', period: 'current', paycheck_count: 4, count_by_earner: {}, expected_total: 8400,
      received_total: 0, remaining_total: 8400, extra_checks: 0, extra_amount: 0, is_extra_month: false, paychecks: [] },
    { month: '2026-10', label: 'Oct 2026', period: 'future', paycheck_count: 5, count_by_earner: {}, expected_total: 11000,
      received_total: 0, remaining_total: 11000, extra_checks: 1, extra_amount: 2600, is_extra_month: true,
      paychecks: [{ date: '2026-10-30', key: 'acme', name: 'Acme Hospital', amount: 2600, received: false, is_extra: true }] },
  ],
  extra_paycheck_months: [{ month: '2026-10', label: 'Oct 2026', extra_checks: 1, extra_amount: 2600, dates: ['2026-10-30'] }],
  other_income: [],
  guidance: ['Budget on the baseline.'],
}

beforeEach(() => {
  getIncomeSchedule.mockResolvedValue(SCHEDULE)
  updateEarner.mockResolvedValue(SCHEDULE)
})
afterEach(() => vi.clearAllMocks())

function renderPage() {
  return render(<MemoryRouter><Paychecks /></MemoryRouter>)
}

it('shows both earners, the baseline, and the extra-paycheck month', async () => {
  renderPage()
  await waitFor(() => expect(screen.getByText('Every other Friday')).toBeInTheDocument())
  expect(screen.getByText('Twice a month (15th & last day)')).toBeInTheDocument()
  expect(screen.getAllByText('$8,400.00').length).toBeGreaterThan(0)
  expect(screen.getByText('Next: Oct 2026')).toBeInTheDocument()
  expect(screen.getByTestId('month-2026-10')).toHaveTextContent('+1 extra check')
  expect(screen.getByText(/Split deposit, counted as one paycheck/)).toBeInTheDocument()
  expect(screen.getByText(/went up 4%/)).toBeInTheDocument()
})

it('saves a nickname and schedule correction', async () => {
  renderPage()
  await waitFor(() => expect(screen.getByLabelText('Edit Acme Hospital')).toBeInTheDocument())
  fireEvent.click(screen.getByLabelText('Edit Acme Hospital'))
  fireEvent.change(screen.getByLabelText('Nickname'), { target: { value: 'Alex' } })
  fireEvent.change(screen.getByLabelText('Pay schedule'), { target: { value: 'semi-monthly' } })
  fireEvent.change(screen.getByLabelText('Payday 1'), { target: { value: '15' } })
  fireEvent.change(screen.getByLabelText('Payday 2'), { target: { value: '31' } })
  fireEvent.change(screen.getByLabelText('Weekend or holiday rule'), { target: { value: 'after' } })
  fireEvent.click(screen.getByText('Save'))
  await waitFor(() => expect(updateEarner).toHaveBeenCalled())
  expect(updateEarner).toHaveBeenCalledWith('acme', {
    nickname: 'Alex', frequency: 'semi-monthly', days_of_month: [15, 31], shift: 'after', per_check: null,
  })
})

it('empty state when no paycheck is detected', async () => {
  getIncomeSchedule.mockResolvedValue({ ...SCHEDULE, earners: [] })
  renderPage()
  await waitFor(() => expect(screen.getByText('No regular paycheck detected yet')).toBeInTheDocument())
})

it('incomePlanFor picks the month row and the next extra month', () => {
  const plan = incomePlanFor(SCHEDULE, 2026, 9)
  expect(plan.baseline).toBe(8400)
  expect(plan.month.paycheck_count).toBe(4)
  expect(plan.nextExtra.label).toBe('Oct 2026')
  expect(incomePlanFor(SCHEDULE, 2026, 10).month.is_extra_month).toBe(true)
  expect(incomePlanFor({ ...SCHEDULE, earners: [] }, 2026, 9)).toBeNull()
})
