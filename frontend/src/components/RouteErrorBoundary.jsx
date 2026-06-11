/**
 * RouteErrorBoundary — catches render crashes in the page below it so a
 * single broken page degrades to a friendly card instead of white-screening
 * the entire app (which is exactly what a missed-rename ReferenceError did
 * to the Dashboard once).
 *
 * Keyed remount: App passes `resetKey={location.pathname}` so navigating
 * to a different page automatically clears the error state and tries the
 * fresh page — no stuck error after the user clicks another nav item.
 *
 * Pairs with CopyToAssistant so the error (message + stack + route) is one
 * click away from being a perfect prompt for an AI assistant.
 */
import { Component } from 'react'
import CopyToAssistant from './CopyToAssistant'

export default class RouteErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { error: null, errorInfo: null }
  }

  static getDerivedStateFromError(error) {
    return { error }
  }

  componentDidCatch(error, errorInfo) {
    this.setState({ errorInfo })
    // Keep a console trail for devtools users.
    console.error('Page crashed:', error, errorInfo?.componentStack)
  }

  componentDidUpdate(prevProps) {
    // Navigating to a different route resets the boundary.
    if (prevProps.resetKey !== this.props.resetKey && this.state.error) {
      this.setState({ error: null, errorInfo: null })
    }
  }

  render() {
    const { error, errorInfo } = this.state
    if (!error) return this.props.children

    return (
      <div style={{
        maxWidth: 560,
        margin: '64px auto',
        padding: 24,
        background: 'var(--bg-card)',
        border: '1px solid var(--accent-red-border)',
        borderRadius: 12,
      }}>
        <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 8 }}>
          This page hit an error
        </div>
        <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 4 }}>
          The rest of the app is fine — pick another page from the sidebar,
          or reload to retry this one.
        </div>
        <pre style={{
          fontSize: 12,
          color: 'var(--accent-red)',
          background: 'var(--bg-input)',
          border: '1px solid var(--border)',
          borderRadius: 8,
          padding: '10px 12px',
          margin: '12px 0',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          maxHeight: 160,
          overflow: 'auto',
        }}>
          {String(error?.message || error)}
        </pre>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <button className="btn btn-primary" onClick={() => window.location.reload()}>
            Reload page
          </button>
          <CopyToAssistant
            title="A page in Tusk Ledger crashed"
            error={String(error?.message || error)}
            context={{
              location: window.location.pathname,
              userAction: 'Navigated to this page; it crashed while rendering.',
              componentStack: (errorInfo?.componentStack || '').split('\n').slice(0, 8).join('\n'),
            }}
          />
        </div>
      </div>
    )
  }
}
