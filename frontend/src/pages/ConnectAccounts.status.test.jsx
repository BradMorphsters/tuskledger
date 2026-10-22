import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { AccountStatusControl } from './ConnectAccounts'
import { updateAccount } from '../api/client'

vi.mock('../api/client', () => ({ updateAccount: vi.fn(() => Promise.resolve({})) }))

afterEach(() => vi.clearAllMocks())

const open = { id: 7, status: 'active', closed_at: null }
const closed = { id: 7, status: 'closed', closed_at: '2026-01-20' }

it('asks for a date before closing, then sends status + closed_at', async () => {
  const onUpdated = vi.fn()
  render(<AccountStatusControl account={open} onUpdated={onUpdated} />)
  fireEvent.click(screen.getByText('Close'))
  expect(updateAccount).not.toHaveBeenCalled()
  fireEvent.change(screen.getByLabelText('Closed on'), { target: { value: '2026-01-20' } })
  fireEvent.click(screen.getByText('Confirm'))
  await waitFor(() => expect(onUpdated).toHaveBeenCalled())
  expect(updateAccount).toHaveBeenCalledWith(7, { status: 'closed', closed_at: '2026-01-20' })
})

it('cancel backs out without saving', () => {
  render(<AccountStatusControl account={open} />)
  fireEvent.click(screen.getByText('Close'))
  fireEvent.click(screen.getByText('Cancel'))
  expect(screen.getByText('Close')).toBeTruthy()
  expect(updateAccount).not.toHaveBeenCalled()
})

it('reopens a closed account', async () => {
  const onUpdated = vi.fn()
  render(<AccountStatusControl account={closed} onUpdated={onUpdated} />)
  fireEvent.click(screen.getByText('Reopen'))
  await waitFor(() => expect(onUpdated).toHaveBeenCalled())
  expect(updateAccount).toHaveBeenCalledWith(7, { status: 'active' })
})
