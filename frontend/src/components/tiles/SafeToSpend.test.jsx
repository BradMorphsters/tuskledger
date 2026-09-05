import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SafeToSpend } from './SafeToSpend'
import { getSafeToSpend } from '../../api/client'

vi.mock('../../api/client', () => ({ getSafeToSpend: vi.fn() }))

afterEach(() => vi.clearAllMocks())

it('labels a mixed budget horizon and shows backend notes without a no-budget contradiction', async () => {
  getSafeToSpend.mockResolvedValue({
    safe_to_spend: 450,
    spendable_cash: 1000,
    bills_due: 100,
    budget_remaining_pro_rata: 450,
    budget_source: 'mixed',
    next_paycheck_date: '2026-09-12',
    next_paycheck_source: 'recurring_income',
    bills: [],
    notes: ['No budget and no spending history yet — nothing counted toward usual spending before payday.'],
  })

  render(<SafeToSpend />)
  await waitFor(() => expect(screen.getByText('Uses available budgets and spending history across months. See breakdown for assumptions.')).toBeInTheDocument())
  expect(screen.getByText(/Uses available budgets/)).toBeInTheDocument()
  expect(screen.queryByText(/No budget set/)).not.toBeInTheDocument()

  fireEvent.click(screen.getByRole('button', { name: /Show breakdown/ }))
  expect(screen.getByText('− Usual spending (mixed sources)')).toBeInTheDocument()
  expect(screen.getByText('No budget and no spending history yet — nothing counted toward usual spending before payday.')).toBeInTheDocument()
})
