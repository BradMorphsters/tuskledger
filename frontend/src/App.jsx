import { Routes, Route, NavLink, useLocation } from 'react-router-dom'
import {
  LayoutDashboard,
  ArrowLeftRight,
  PiggyBank,
  Trophy,
  TrendingUp,
  LineChart,
  Link2,
  RefreshCw,
  RotateCcw,
  BarChart3,
  Lightbulb,
  Briefcase,
  Filter,
  LogOut,
  ShieldCheck,
  Compass,
  Sun,
  Moon,
  Plus,
  Command,
  CreditCard,
  Receipt,
  Menu,
  Smartphone,
} from 'lucide-react'
import { useEffect, useState, useCallback } from 'react'

import Dashboard from './pages/Dashboard'
import Transactions from './pages/Transactions'
import Budgets from './pages/Budgets'
import Goals from './pages/Goals'
import NetWorth from './pages/NetWorth'
import Loans from './pages/Loans'
import Retirement from './pages/Retirement'
import TaxPrepPack from './pages/TaxPrepPack'
import CashFlow from './pages/CashFlow'
import CashFlowCalendar from './pages/CashFlowCalendar'
import ConnectAccounts from './pages/ConnectAccounts'
import Investments from './pages/Investments'
import TradingTaxPage from './pages/TradingTaxPage'
import Rules from './pages/Rules'
import SpendingIncome from './pages/SpendingIncome'
import Insights from './pages/Insights'
import BusinessPage from './pages/Business'
import Login from './pages/Login'
import Setup from './pages/Setup'
import PairPhone from './pages/PairPhone'
import { triggerSync, getAuthStatus, logout, refreshDemoData, setMode } from './api/client'
import { useTheme, ThemeToggle, QuickAddFab, CommandPalette } from './components/QuickActions'
import { BudgetAlertsMonitor, BudgetAlertsToggle } from './components/BudgetAlertsMonitor'
import AskPanel from './components/AskPanel'
import { useReadOnlyMode, ReadOnlyBanner } from './components/ReadOnlyMode'

export default function App() {
  const [syncing, setSyncing] = useState(false)
  const [refreshingDemo, setRefreshingDemo] = useState(false)
  const [authState, setAuthState] = useState({ loading: true })
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [quickAddTrigger, setQuickAddTrigger] = useState(0)
  // Read-only mode (per device, set via cookie). When true, hide all
  // edit affordances — QuickAddFab, sync button, etc. — so the phone
  // UX matches what the backend will allow. The backend middleware
  // is the safety net; this is the UX layer.
  const { readOnly, setMode: setViewModeLocal } = useReadOnlyMode()
  // Mobile drawer state — only matters at < 768px (CSS hides the
  // hamburger on wider viewports). Closes automatically when the route
  // changes so tapping a nav item dismisses the drawer.
  const [mobileNavOpen, setMobileNavOpen] = useState(false)
  const location = useLocation()
  const { theme, toggle: toggleTheme } = useTheme()

  // Cmd-K / Ctrl-K opens the command palette globally. Captured at the
  // window level so any focused input releases focus to the palette.
  useEffect(() => {
    const handler = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault()
        setPaletteOpen(o => !o)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  // Auto-close the mobile drawer when the route changes (so tapping a
  // nav link dismisses it). Also closes on Escape for keyboard users.
  useEffect(() => {
    setMobileNavOpen(false)
  }, [location.pathname])
  useEffect(() => {
    if (!mobileNavOpen) return
    const onKey = (e) => { if (e.key === 'Escape') setMobileNavOpen(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [mobileNavOpen])

  // Command palette → action handler. Routes already navigate themselves;
  // these are the non-route actions that need parent-level handling.
  const handlePaletteAction = useCallback((action) => {
    if (action === 'theme') toggleTheme()
    if (action === 'quick-add') setQuickAddTrigger(t => t + 1)  // forces FAB modal open via key change
  }, [toggleTheme])

  const refreshAuth = async () => {
    try {
      const status = await getAuthStatus()
      setAuthState({ loading: false, ...status })
    } catch (err) {
      setAuthState({ loading: false, setup_required: true, authenticated: false })
    }
  }

  useEffect(() => {
    refreshAuth()
  }, [])

  const handleSync = async () => {
    setSyncing(true)
    try {
      await triggerSync()
    } catch (e) {
      console.error('Sync failed:', e)
    } finally {
      setSyncing(false)
    }
  }

  const handleLogout = async () => {
    try {
      await logout()
    } catch (e) {
      // even if the call fails (e.g. offline), clear local auth state
    }
    setAuthState({ loading: false, setup_required: false, authenticated: false })
  }

  const handleRefreshDemo = async () => {
    if (!window.confirm(
      'Reset all demo data?\n\n' +
      'This wipes the demo database and regenerates 12 months of synthetic ' +
      'transactions, holdings, and balances. Anything you customized in the ' +
      'demo (categories, splits, business tags) will be lost.\n\n' +
      'Your real tuskledger.db is NOT affected.'
    )) return
    setRefreshingDemo(true)
    try {
      await refreshDemoData()
      // Hard reload so every page re-fetches against the regenerated DB.
      window.location.reload()
    } catch (e) {
      console.error('Demo refresh failed:', e)
      alert('Demo refresh failed: ' + (e.message || 'unknown error'))
      setRefreshingDemo(false)
    }
  }

  const handleSwitchMode = async (target) => {
    if (authState.demo_mode === (target === 'demo')) return  // already there
    // Guardrail: switching FROM demo back TO real mid-demo would
    // suddenly show real account balances on screen, which is the exact
    // scenario the user wants to avoid when showing the app to someone.
    // Confirm the intent explicitly before flipping.
    if (target === 'real' && authState.demo_mode) {
      const ok = window.confirm(
        'Switch back to REAL data?\n\n' +
        'Your real account balances, transactions, and net worth will be ' +
        'visible on screen immediately. If you\'re currently demoing the app ' +
        'to someone, click Cancel.'
      )
      if (!ok) return
    }
    try {
      await setMode(target)
      window.location.reload()
    } catch (e) {
      console.error('Mode switch failed:', e)
      alert('Could not switch mode: ' + (e.message || 'unknown error'))
    }
  }

  // Loading state
  if (authState.loading) {
    return (
      <div className="auth-screen">
        <div className="auth-card">
          <div className="auth-header">
            <ShieldCheck size={32} className="auth-icon" />
            <p className="auth-subtitle">Loading…</p>
          </div>
        </div>
      </div>
    )
  }

  // Pre-auth screens (Setup or Login). Both get a "Try the demo →" button
  // so a fresh user can play with synthetic data without setting up MFA.
  if (authState.setup_required || !authState.authenticated) {
    return (
      <>
        {authState.setup_required
          ? <Setup onAuthenticated={refreshAuth} />
          : <Login onAuthenticated={refreshAuth} />}
        <div style={{
          position: 'fixed', bottom: 24, left: '50%', transform: 'translateX(-50%)',
          background: 'rgba(251,146,60,0.10)',
          border: '1px solid rgba(251,146,60,0.35)',
          borderRadius: 8,
          padding: '10px 18px',
          display: 'flex', alignItems: 'center', gap: 12,
          fontSize: 13,
          zIndex: 100,
        }}>
          <span style={{ color: 'var(--text-secondary)' }}>
            First time? Skip the setup and explore with synthetic data.
          </span>
          <button
            onClick={() => handleSwitchMode('demo')}
            style={{
              background: 'var(--accent-orange, #fb923c)',
              color: '#0d0e14',
              border: 'none',
              borderRadius: 6,
              padding: '6px 14px',
              fontSize: 12,
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            Try the demo →
          </button>
        </div>
      </>
    )
  }

  // Authenticated — render the app
  const navItems = [
    { to: '/', icon: LayoutDashboard, label: 'Dashboard' },
    { to: '/spending', icon: BarChart3, label: 'Spending & Income' },
    { to: '/transactions', icon: ArrowLeftRight, label: 'Transactions' },
    { to: '/budgets', icon: PiggyBank, label: 'Budgets' },
    { to: '/goals', icon: Trophy, label: 'Goals' },
    { to: '/net-worth', icon: TrendingUp, label: 'Net Worth' },
    { to: '/loans', icon: CreditCard, label: 'Loans' },
    { to: '/retirement', icon: Compass, label: 'Retirement' },
    { to: '/cash-flow', icon: TrendingUp, label: 'Cash Flow' },
    { to: '/bills-calendar', icon: BarChart3, label: 'Bills Calendar' },
    { to: '/investments', icon: LineChart, label: 'Investments' },
    { to: '/trading-tax', icon: Receipt, label: 'Trading Tax' },
    { to: '/insights', icon: Lightbulb, label: 'Insights' },
    { to: '/business', icon: Briefcase, label: 'Business' },
    { to: '/tax-prep', icon: Receipt, label: 'Tax Prep' },
    { to: '/rules', icon: Filter, label: 'Rules' },
    { to: '/connect', icon: Link2, label: 'Accounts' },
    { to: '/pair-phone', icon: Smartphone, label: 'Pair phone' },
  ]

  return (
    <div className="app-layout">
      {/* Read-only banner — only renders when this device's view cookie
          is "readonly". Sits above everything else so the visual context
          is unmissable; explains why edit affordances are gone. */}
      <ReadOnlyBanner show={readOnly} onModeChange={setViewModeLocal} />
      {/* Mobile-only top app bar. CSS hides the whole bar above 768px.
          Wraps the hamburger + brand together so the navigation chrome
          looks intentional rather than a floating orphan, and the page
          title below has room to breathe instead of sliding under the
          hamburger. */}
      <header className="mobile-app-bar">
        <button
          type="button"
          className="mobile-nav-toggle"
          onClick={() => setMobileNavOpen(o => !o)}
          aria-label={mobileNavOpen ? 'Close navigation' : 'Open navigation'}
        >
          <Menu size={20} />
        </button>
        <span className="mobile-app-bar-brand">Tusk Ledger</span>
      </header>
      {/* Backdrop scrim — only renders + activates when the drawer is
          open. Click outside the sidebar dismisses. */}
      <div
        className={`mobile-nav-scrim${mobileNavOpen ? ' open' : ''}`}
        onClick={() => setMobileNavOpen(false)}
      />
      <aside className={`sidebar${mobileNavOpen ? ' open' : ''}`}>
        <div className="sidebar-logo">Tusk Ledger</div>
        <nav className="sidebar-nav">
          {navItems.map(({ to, icon: Icon, label }) => (
            <NavLink
              key={to}
              to={to}
              end={to === '/'}
              className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}
            >
              <Icon size={18} />
              {label}
            </NavLink>
          ))}
        </nav>
        {!readOnly && (
          <button
            className={`sync-btn${syncing ? ' syncing' : ''}`}
            onClick={handleSync}
          >
            <RefreshCw size={14} className={syncing ? 'spinning' : ''} />
            {syncing ? 'Syncing...' : 'Sync Now'}
          </button>
        )}

        <div className="sidebar-user">
          {/* Real / Demo segmented toggle — always visible, lets you flip
              the database the UI is reading from without restarting. */}
          <div
            title="Switch which database you're viewing. Real and demo data live in separate SQLite files; switching only changes what's displayed."
            style={{
              display: 'flex',
              padding: 2,
              marginBottom: 8,
              background: 'var(--bg-elevated, rgba(255,255,255,0.04))',
              border: '1px solid var(--border)',
              borderRadius: 6,
              fontSize: 11,
              fontWeight: 600,
            }}
          >
            {[
              { key: 'real', label: 'Real' },
              { key: 'demo', label: 'Demo' },
            ].map(opt => {
              const active = (opt.key === 'demo') === !!authState.demo_mode
              return (
                <button
                  key={opt.key}
                  onClick={() => handleSwitchMode(opt.key)}
                  style={{
                    flex: 1,
                    padding: '5px 8px',
                    background: active
                      ? (opt.key === 'demo' ? 'rgba(251,146,60,0.18)' : 'var(--bg-hover)')
                      : 'transparent',
                    color: active
                      ? (opt.key === 'demo' ? 'var(--accent-orange, #fb923c)' : 'var(--text-primary)')
                      : 'var(--text-muted)',
                    border: 'none',
                    borderRadius: 4,
                    cursor: active ? 'default' : 'pointer',
                    transition: 'all 0.15s',
                    letterSpacing: 0.3,
                    textTransform: 'uppercase',
                  }}
                >
                  {opt.label}
                </button>
              )
            })}
          </div>

          {authState.demo_mode && (
            <button
              onClick={handleRefreshDemo}
              disabled={refreshingDemo}
              title="Wipe and regenerate the demo dataset (12 months of fresh synthetic data anchored to today)."
              style={{
                marginBottom: 8,
                width: '100%',
                padding: '6px 10px',
                background: 'transparent',
                color: 'var(--text-secondary)',
                border: '1px solid var(--border)',
                borderRadius: 4,
                fontSize: 11,
                cursor: refreshingDemo ? 'wait' : 'pointer',
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 6,
                transition: 'background 0.15s, color 0.15s',
              }}
              onMouseEnter={e => {
                if (!refreshingDemo) {
                  e.currentTarget.style.background = 'var(--bg-hover)'
                  e.currentTarget.style.color = 'var(--text-primary)'
                }
              }}
              onMouseLeave={e => {
                e.currentTarget.style.background = 'transparent'
                e.currentTarget.style.color = 'var(--text-secondary)'
              }}
            >
              <RotateCcw size={11} className={refreshingDemo ? 'spinning' : ''} />
              {refreshingDemo ? 'Refreshing…' : 'Refresh demo data'}
            </button>
          )}

          {/* Theme toggle + Cmd-K hint + budget alerts toggle.
              Small global controls at the bottom of the sidebar
              above the user row. */}
          <div style={{
            display: 'flex', justifyContent: 'space-between',
            alignItems: 'center', gap: 6, marginBottom: 8, flexWrap: 'wrap',
          }}>
            <ThemeToggle theme={theme} toggle={toggleTheme} />
            <BudgetAlertsToggle />
            <button
              onClick={() => setPaletteOpen(true)}
              title="Open command palette"
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 4,
                padding: '5px 8px', background: 'transparent',
                color: 'var(--text-muted)',
                border: '1px solid var(--border)', borderRadius: 4,
                fontSize: 11, cursor: 'pointer',
              }}
            >
              <Command size={11} /> K
            </button>
          </div>

          <div className="sidebar-user-row">
            <ShieldCheck size={12} className="mfa-badge" />
            <span>
              {authState.demo_mode ? 'Demo · ' : 'MFA active · '}
              {authState.username || 'operator'}
            </span>
          </div>
          {!authState.demo_mode && (
            <button className="sidebar-logout" onClick={handleLogout}>
              <LogOut size={14} />
              Sign out
            </button>
          )}
        </div>
      </aside>

      <main className="main-content">
        {/* Demo-mode banner — persistent, cannot be dismissed accidentally.
            The whole point is that anyone screenshotting / showing the app
            to someone has unmistakable confirmation it's synthetic data
            on screen. Orange chosen to align with the existing "Demo"
            sidebar pill and stand out from any normal accent color. */}
        {authState.demo_mode && (
          <div
            role="status"
            aria-label="Demo mode active"
            style={{
              marginBottom: 16,
              padding: '10px 16px',
              borderRadius: 8,
              background: 'rgba(251, 146, 60, 0.12)',
              border: '1px solid rgba(251, 146, 60, 0.45)',
              borderLeft: '4px solid var(--accent-orange, #fb923c)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 12,
              fontSize: 13,
              color: 'var(--text-primary)',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  padding: '3px 10px',
                  background: 'var(--accent-orange, #fb923c)',
                  color: '#0d0e14',
                  fontWeight: 700,
                  fontSize: 11,
                  letterSpacing: 0.5,
                  textTransform: 'uppercase',
                  borderRadius: 4,
                }}
              >
                Demo Mode
              </span>
              <span>
                You're viewing <strong>synthetic data</strong> — accounts,
                balances, and transactions are generated for demonstration. Your
                real tuskledger.db is untouched.
              </span>
            </div>
            <button
              onClick={() => handleSwitchMode('real')}
              style={{
                padding: '5px 12px',
                fontSize: 12,
                fontWeight: 600,
                background: 'transparent',
                border: '1px solid var(--accent-orange, #fb923c)',
                color: 'var(--accent-orange, #fb923c)',
                borderRadius: 4,
                cursor: 'pointer',
                whiteSpace: 'nowrap',
              }}
              title="Switch back to your real data — you'll be asked to confirm first."
            >
              Exit demo →
            </button>
          </div>
        )}
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/spending" element={<SpendingIncome />} />
          <Route path="/transactions" element={<Transactions />} />
          <Route path="/budgets" element={<Budgets />} />
          <Route path="/goals" element={<Goals />} />
          <Route path="/net-worth" element={<NetWorth />} />
          <Route path="/loans" element={<Loans />} />
          <Route path="/retirement" element={<Retirement />} />
          <Route path="/tax-prep" element={<TaxPrepPack />} />
          <Route path="/cash-flow" element={<CashFlow />} />
          <Route path="/bills-calendar" element={<CashFlowCalendar />} />
          <Route path="/investments" element={<Investments />} />
          <Route path="/trading-tax" element={<TradingTaxPage />} />
          <Route path="/insights" element={<Insights />} />
          <Route path="/business" element={<BusinessPage />} />
          <Route path="/rules" element={<Rules />} />
          <Route path="/connect" element={<ConnectAccounts />} />
          <Route path="/pair-phone" element={<PairPhone />} />
        </Routes>
      </main>

      {/* Global floating UI: quick-add FAB + command palette. The FAB
          uses quickAddTrigger as its `key` so the palette's "Add
          transaction" action remounts and pops the modal open.
          Hidden in read-only mode — adding transactions on the phone
          is the v3 problem (real sync). v1 is read-only consumption. */}
      {!readOnly && (
        <QuickAddFab key={`fab-${quickAddTrigger}`} onSaved={() => {
          // Could trigger a refresh of the current page's data; for now
          // just rely on the user navigating to Transactions to see it.
        }} />
      )}
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        onAction={handlePaletteAction}
      />
      {/* Budget alerts monitor — silent component that polls every 5
          minutes and fires browser notifications at 75/90/100% of any
          budget category. No UI of its own; toggled by the bell button
          in the sidebar. */}
      <BudgetAlertsMonitor />
      {/* Ask panel — floating bottom-right button that opens a slide-in
          panel of curated questions answered by the local LLM with
          pre-computed numbers. Mounted globally so it's available on
          every page. (Only renders for authenticated users — this
          render branch already gates on authState.authenticated.) */}
      <AskPanel />
    </div>
  )
}
