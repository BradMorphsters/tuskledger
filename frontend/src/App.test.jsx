/**
 * Routing-and-auth-gate test for the App shell.
 *
 * The App component reads /api/auth/status on mount and routes to one
 * of three screens based on the response:
 *   - setup_required:true       → <Setup />
 *   - authenticated:false       → <Login />
 *   - authenticated:true        → main app (sidebar + Dashboard)
 *
 * If a React/React-Router/auth-state regression silently breaks that
 * gate, every user lands on the wrong screen on next reload. Hard
 * failure mode worth a regression test.
 *
 * Approach: mock the entire api/client module so App can mount without
 * hitting a real backend. We don't deeply test page contents — we just
 * verify the gate routes to the right top-level screen, which is the
 * contract that matters.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { BrowserRouter } from 'react-router-dom'

// Build a default mock of api/client where every function resolves to
// a benign empty value. Individual tests override getAuthStatus only.
// This stops Dashboard/sidebar mounts from blowing up on missing data.
vi.mock('./api/client', () => ({
  getAuthStatus: vi.fn(),
  triggerSync: vi.fn(() => Promise.resolve({ status: 'ok' })),
  logout: vi.fn(() => Promise.resolve({ ok: true })),
  refreshDemoData: vi.fn(() => Promise.resolve({ status: 'ok' })),
  setMode: vi.fn(() => Promise.resolve({ ok: true })),
  // Catch-all defaults — anything else the page tree might call
  getAccounts: vi.fn(() => Promise.resolve([])),
  getTransactions: vi.fn(() => Promise.resolve([])),
  getNetWorthHistory: vi.fn(() => Promise.resolve([])),
  getLatestNetWorth: vi.fn(() => Promise.resolve({ net_worth: 0 })),
  getIncomeVsSpending: vi.fn(() => Promise.resolve([])),
  getSpendingSummary: vi.fn(() => Promise.resolve({ categories: [], total_spent: 0, business_total: 0 })),
  getInsights: vi.fn(() => Promise.resolve([])),
  getStaleAccounts: vi.fn(() => Promise.resolve([])),
  getRecurring: vi.fn(() => Promise.resolve([])),
  getCategories: vi.fn(() => Promise.resolve([])),
  getRules: vi.fn(() => Promise.resolve([])),
  getMerchantInsights: vi.fn(() => Promise.resolve([])),
  getMonthlyReport: vi.fn(() => Promise.resolve({})),
  getCategoryTrends: vi.fn(() => Promise.resolve({})),
  getSpendingPatterns: vi.fn(() => Promise.resolve({})),
  getTopMerchants: vi.fn(() => Promise.resolve([])),
  getSpendingHeatmap: vi.fn(() => Promise.resolve([])),
  getNetWorthYoy: vi.fn(() => Promise.resolve({})),
  getFinancialPulse: vi.fn(() => Promise.resolve({})),
  getHsaStatus: vi.fn(() => Promise.resolve({})),
  globalSearch: vi.fn(() => Promise.resolve({ transactions: [], accounts: [] })),
  getBudgets: vi.fn(() => Promise.resolve([])),
  getBudget: vi.fn(() => Promise.resolve({ categories: [] })),
}))

// Mock other top-level modules App imports for monitor/toast widgets so
// those don't crash on mount in jsdom.
vi.mock('./components/Toast', () => ({
  ToastProvider: ({ children }) => children,
  useToast: () => ({ push: vi.fn() }),
}))

import App from './App'
import { getAuthStatus } from './api/client'

const wrap = () => render(
  <BrowserRouter>
    <App />
  </BrowserRouter>
)

describe('App auth gating', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('shows the Setup screen when /auth/status reports setup_required', async () => {
    getAuthStatus.mockResolvedValueOnce({
      setup_required: true,
      authenticated: false,
      demo_mode: false,
    })
    wrap()
    // Setup screen has the 'Welcome to Tusk Ledger' h1 — wait for it
    // to appear (the auth fetch is async so we waitFor its result).
    expect(await screen.findByText(/Welcome to Tusk Ledger/i)).toBeInTheDocument()
  })

  it('shows the Login screen when status reports authenticated:false but setup not required', async () => {
    getAuthStatus.mockResolvedValueOnce({
      setup_required: false,
      authenticated: false,
      demo_mode: false,
    })
    wrap()
    // Login renders "Tusk Ledger" as the h1 (no 'Welcome to' prefix).
    // We assert on its presence AND the absence of the Welcome-prefixed
    // copy that would only be there for the Setup screen.
    expect(await screen.findByRole('heading', { name: 'Tusk Ledger' })).toBeInTheDocument()
    expect(screen.queryByText(/Welcome to Tusk Ledger/i)).not.toBeInTheDocument()
  })

  it('renders the main app shell when authenticated', async () => {
    getAuthStatus.mockResolvedValueOnce({
      setup_required: false,
      authenticated: true,
      username: 'operator',
      demo_mode: false,
    })
    wrap()
    // Sidebar logo confirms we got past the gate. We also confirm we
    // are NOT on the Setup or Login screen (those would have prevented
    // the sidebar from mounting).
    await waitFor(() => {
      expect(screen.getByText('Tusk Ledger', { selector: '.sidebar-logo' })).toBeInTheDocument()
    })
    expect(screen.queryByText(/Welcome to Tusk Ledger/i)).not.toBeInTheDocument()
  })

  it('shows demo-mode UI when status reports demo_mode:true', async () => {
    getAuthStatus.mockResolvedValueOnce({
      setup_required: false,
      authenticated: true,
      username: 'demo',
      demo_mode: true,
    })
    wrap()
    // Wait for the gate to settle by finding the sidebar logo first.
    await waitFor(() => {
      expect(screen.getByText('Tusk Ledger', { selector: '.sidebar-logo' })).toBeInTheDocument()
    })
    // The demo banner should appear somewhere on screen — there's a
    // 'DEMO' pill and 'Demo · demo' label per the auth screenshot.
    // We grep for any 'demo' text node, case-insensitive — narrow
    // assertions are fragile to UI tweaks, but presence-vs-absence is stable.
    const demoMentions = screen.queryAllByText(/demo/i)
    expect(demoMentions.length).toBeGreaterThan(0)
  })

  it('falls back to Setup screen if the auth status fetch fails', async () => {
    // Network-down scenario: getAuthStatus rejects. App's catch handler
    // sets setup_required:true so the user lands on Setup rather than a
    // permanently-loading screen.
    getAuthStatus.mockRejectedValueOnce(new Error('network down'))
    wrap()
    expect(await screen.findByText(/Welcome to Tusk Ledger/i)).toBeInTheDocument()
  })
})
