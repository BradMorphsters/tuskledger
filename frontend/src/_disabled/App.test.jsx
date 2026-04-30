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
 * gate, every user lands on the wrong screen on next reload.
 *
 * Approach: mock api/client with a Proxy so any function-shaped property
 * access returns a no-op vi.fn that resolves to {}. This keeps the test
 * resilient to the page tree adding new API calls — adding a new
 * `getThing()` call inside Dashboard shouldn't break this test.
 *
 * We deliberately only assert on the auth-gated SCREEN (Setup, Login),
 * not the contents of the main app. Asserting on Dashboard internals
 * would couple this regression test to every dashboard tweak.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { BrowserRouter } from 'react-router-dom'

// Per-test handle on the mocked getAuthStatus, so each test can set
// what /auth/status returns. The Proxy below routes every other api
// call to a no-op vi.fn() that resolves to {}.
const getAuthStatusMock = vi.fn()

vi.mock('./api/client', () => {
  // A cache so the same property access returns the same vi.fn() —
  // important because Dashboard may call api.x() on mount AND in a
  // useEffect later, and identity matters for some React hooks.
  const cache = {}
  return new Proxy({ __esModule: true }, {
    get(target, prop) {
      if (prop === '__esModule') return true
      if (prop === 'default') return undefined
      if (prop === 'getAuthStatus') return getAuthStatusMock
      if (typeof prop !== 'string') return target[prop]
      if (!cache[prop]) {
        cache[prop] = vi.fn(() => Promise.resolve({}))
      }
      return cache[prop]
    },
  })
})

// Toast provider is a plain pass-through so its push() doesn't crash
// in jsdom on tests that aren't asserting toast behavior.
vi.mock('./components/Toast', () => ({
  ToastProvider: ({ children }) => children,
  useToast: () => ({ push: vi.fn() }),
}))

import App from './App'

const wrap = () => render(
  <BrowserRouter>
    <App />
  </BrowserRouter>
)

describe('App auth gating', () => {
  beforeEach(() => {
    getAuthStatusMock.mockReset()
  })

  it('shows the Setup screen when /auth/status reports setup_required', async () => {
    getAuthStatusMock.mockResolvedValueOnce({
      setup_required: true,
      authenticated: false,
      demo_mode: false,
    })
    wrap()
    expect(await screen.findByText(/Welcome to Tusk Ledger/i)).toBeInTheDocument()
  })

  it('shows the Login screen when status reports authenticated:false but setup not required', async () => {
    getAuthStatusMock.mockResolvedValueOnce({
      setup_required: false,
      authenticated: false,
      demo_mode: false,
    })
    wrap()
    // Login renders a "Tusk Ledger" h1 (no 'Welcome to' prefix). Asserting
    // the heading is enough to confirm the gate routed to Login rather
    // than Setup or the main app.
    expect(await screen.findByRole('heading', { name: 'Tusk Ledger' })).toBeInTheDocument()
    expect(screen.queryByText(/Welcome to Tusk Ledger/i)).not.toBeInTheDocument()
  })

  it('falls back to Setup screen if the auth status fetch fails', async () => {
    // Network-down scenario: getAuthStatus rejects. App's catch handler
    // should land the user on Setup rather than a permanently-loading
    // screen.
    getAuthStatusMock.mockRejectedValueOnce(new Error('network down'))
    wrap()
    expect(await screen.findByText(/Welcome to Tusk Ledger/i)).toBeInTheDocument()
  })
})
