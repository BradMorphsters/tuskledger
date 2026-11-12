import { render, screen } from '@testing-library/react'
import { expect, it } from 'vitest'
import WashSaleWatch from './WashSaleWatch'

const WATCH = {
  as_of: '2026-11-12',
  do_not_rebuy: [
    { symbol: 'AAA', accounts: ['Joint'], sell_date: '2026-11-02', loss: 100, already_washed: 0,
      safe_to_rebuy_on: '2026-12-03', days_left: 21, crosses_year_end: false, estimated: false },
    { symbol: 'XYZ', accounts: ['Brokerage'], sell_date: null, sold_since: '2026-11-05', loss: 200,
      already_washed: 0, safe_to_rebuy_on: '2026-12-13', days_left: 31, crosses_year_end: false, estimated: true },
  ],
  cannot_harvest_yet: [
    { symbol: 'COP', plaid_security_id: 's-cop', accounts: ['Joint'], unrealized_loss: 300,
      last_buy_date: '2026-11-03', bought_in: 'Brokerage', harvest_ok_on: '2026-12-04', days_left: 22, estimated: false },
  ],
  unreported_trades: [
    { kind: 'sell', symbol: 'XYZ', plaid_security_id: 's-xyz', account_id: 1, account_name: 'Brokerage',
      quantity: 10, estimated_proceeds: 800, estimated_gain_loss: -200, term: 'LT', since: '2026-11-05' },
  ],
  data_lag: [{ account_id: 1, account_name: 'Brokerage', trades_through: '2026-11-04', positions_as_of: '2026-11-12' }],
  retirement_accounts: ['Work 401(k)'],
  year_end: { year: 2026, last_day_to_realize: '2026-12-31', rebuy_inside_year_if_sold_by: '2026-11-30', days_left: 49 },
}

it('lists what not to rebuy, what cannot be harvested, and unreported trades', () => {
  render(<WashSaleWatch watch={WATCH} />)
  expect(screen.getByText("Don't buy back")).toBeInTheDocument()
  expect(screen.getByText(/Safe Dec 3, 2026/)).toBeInTheDocument()
  expect(screen.getByText("Can't harvest the loss yet")).toBeInTheDocument()
  expect(screen.getByText(/OK Dec 4, 2026/)).toBeInTheDocument()
  expect(screen.getByText('Sold XYZ')).toBeInTheDocument()
  expect(screen.getByText(/Trade history is behind: Brokerage through/)).toBeInTheDocument()
  expect(screen.getByText(/Buys in Work 401\(k\) count too/)).toBeInTheDocument()
  expect(screen.getByText(/Sell by Nov 30, 2026/)).toBeInTheDocument()
})

it('says so when there is nothing to watch', () => {
  render(<WashSaleWatch watch={{ ...WATCH, do_not_rebuy: [], cannot_harvest_yet: [], unreported_trades: [], data_lag: [], year_end: null }} />)
  expect(screen.getByText(/Nothing to watch right now/)).toBeInTheDocument()
})
