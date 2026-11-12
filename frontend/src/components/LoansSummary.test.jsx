import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import LoansSummary, {
  fmtDuration, fmtMonthYear, burdenTone, summaryOverrides, planChartRows, yearTicks, layerChartRows, layerLabel,
} from './LoansSummary'

vi.mock('../api/client', () => ({ getLoansSummary: vi.fn() }))
import { getLoansSummary } from '../api/client'

describe('helpers', () => {
  it('formats durations', () => {
    expect(fmtDuration(null)).toBe('—')
    expect(fmtDuration(0)).toBe('now')
    expect(fmtDuration(11)).toBe('11 mo')
    expect(fmtDuration(24)).toBe('2 yr')
    expect(fmtDuration(27)).toBe('2 yr 3 mo')
  })
  it('formats month-year without time-zone drift', () => {
    expect(fmtMonthYear('2030-01-01')).toBe('Jan 2030')
    expect(fmtMonthYear(null)).toBe('—')
  })
  it('rates payment burden', () => {
    expect(burdenTone(null)).toBe(null)
    expect(burdenTone(0.1)).toBe('good')
    expect(burdenTone(0.25)).toBe('ok')
    expect(burdenTone(0.4)).toBe('warn')
  })
  it('passes only usable overrides for loans that need them', () => {
    const ov = {
      a: { rate: '0.05', payment: '200' },
      b: { rate: 0.04, payment: 100 },     // has stored terms
      c: { rate: '', payment: '50' },      // incomplete
    }
    expect(summaryOverrides(ov, id => id !== 'b')).toEqual({ a: { rate: 0.05, payment: 200 } })
  })
  it('builds stacked layer rows and always keeps the final month', () => {
    const series = [1, 2, 3].map(m => ({ date: `2030-0${m}-01`, layers: [10 - m, 5] }))
    expect(layerChartRows(series, 2, 2)).toEqual([
      { date: '2030-01-01', L0: 9, L1: 5 },
      { date: '2030-03-01', L0: 7, L1: 5 },
    ])
  })
  it('labels layers with the rate, splitting a loan with several rates', () => {
    expect(layerLabel({ name: 'Student', rate: 0.0655 }, 2)).toBe('Student · 6.55%')
    expect(layerLabel({ name: 'Car', rate: 0.035 }, 1)).toBe('Car (3.5%)')
  })
  it('puts one x-axis tick per year', () => {
    const rows = ['2029-11-01', '2029-12-01', '2030-01-01', '2030-02-01'].map(date => ({ date }))
    expect(yearTicks(rows)).toEqual(['2029-11-01', '2030-01-01'])
  })
  it('merges plan series, padding finished plans with zero', () => {
    const rows = planChartRows({
      current: [{ date: '2030-01-01', balance: 10 }, { date: '2030-02-01', balance: 5 }],
      avalanche: [{ date: '2030-01-01', balance: 8 }],
    })
    expect(rows).toEqual([
      { date: '2030-01-01', current: 10, avalanche: 8 },
      { date: '2030-02-01', current: 5, avalanche: 0 },
    ])
  })
})

const plan = (k, interest, saved) => ({
  strategy: k, months: 24, debt_free_date: '2030-01-01', total_interest: interest,
  interest_saved: saved, months_saved: saved ? 6 : undefined,
  payoff_order: [{ id: 'x', name: 'Car loan', months: 24, date: '2030-01-01' }],
})
const SUMMARY = {
  totals: {
    balance: 12000, monthly_payment: 700, monthly_principal_interest: 600, monthly_escrow: 100,
    weighted_rate: 0.05, interest_remaining: 900, debt_free_date: '2030-01-01',
    months_to_debt_free: 30, loan_count: 2, monthly_income: 5000, payments_share_of_income: 0.14,
  },
  next_payoff: null,
  payment_steps: [{ id: 'x', name: 'Car loan', months: 20, date: '2029-01-01', frees_per_month: 300, escrow_continues: 0, total_after: 400 }],
  loans: [{ id: 'x', name: 'Car loan', balance: 5000, share_of_debt: 0.42, rate: 0.06, monthly_payment: 300,
    escrow: 0, interest_remaining: 400, payoff_date: '2029-01-01', pieces: 1 }],
  plans: { current: plan('current', 900), avalanche: plan('avalanche', 700, 200), snowball: plan('snowball', 750, 150) },
  series: { current: [], avalanche: [], snowball: [] },
  excluded: [{ id: 'y', name: 'Family loan', reason: 'none' }],
}

describe('LoansSummary', () => {
  beforeEach(() => { getLoansSummary.mockReset(); localStorage.clear() })

  it('shows totals, escrow split, best plan and loans left out', async () => {
    getLoansSummary.mockResolvedValue(SUMMARY)
    render(<LoansSummary />)
    await waitFor(() => expect(screen.getByText('Total owed')).toBeTruthy())
    expect(screen.getAllByText('$12,000').length).toBeGreaterThan(0)
    expect(screen.getByText('$600 P&I + $100 escrow')).toBeTruthy()
    expect(screen.getByText('14%')).toBeTruthy()
    expect(screen.getByText('BEST')).toBeTruthy()
    expect(screen.getByText(/Not counted: Family loan/)).toBeTruthy()
  })

  it('shows where the extra goes, by rate, with a timeline', async () => {
    const layers = [
      { key: 'x|0.07', name: 'Student', rate: 0.07, balance: 3000 },
      { key: 'y|0.04', name: 'Car loan', rate: 0.04, balance: 9000 },
    ]
    const phases = [
      { layer: 'x|0.07', name: 'Student', rate: 0.07, from_month: 1, to_month: 10, from_date: '2027-01-01', to_date: '2027-10-01' },
      { layer: 'y|0.04', name: 'Car loan', rate: 0.04, from_month: 11, to_month: 20, from_date: '2027-11-01', to_date: '2028-08-01' },
    ]
    const withLayers = k => ({ ...SUMMARY.plans[k], layers, extra_phases: phases })
    const pts = [1, 2, 3].map(m => ({ date: `2027-0${m}-01`, balance: 12000 - m, layers: [3000 - m, 9000] }))
    getLoansSummary.mockResolvedValue({
      ...SUMMARY,
      plans: { current: SUMMARY.plans.current, avalanche: withLayers('avalanche'), snowball: withLayers('snowball') },
      series: { current: pts, avalanche: pts, snowball: pts },
    })
    render(<LoansSummary />)
    await waitFor(() => expect(screen.getByText('Where the extra goes')).toBeTruthy())
    const timeline = screen.getByRole('list', { name: 'Extra payment timeline' })
    expect(timeline.textContent).toContain('Extra goes to Student (7%)')
    expect(timeline.textContent).toContain('Then Car loan (4%)')
  })

  it('renders nothing when there are no loans at all', async () => {
    getLoansSummary.mockResolvedValue({ ...SUMMARY, totals: { ...SUMMARY.totals, loan_count: 0 }, excluded: [] })
    const { container } = render(<LoansSummary />)
    await waitFor(() => expect(getLoansSummary).toHaveBeenCalled())
    await waitFor(() => expect(container.textContent).toBe(''))
  })
})
