import { useEffect, useState } from 'react'
import { Link as RouterLink } from 'react-router-dom'
import { AlertTriangle, ExternalLink, X } from 'lucide-react'
import { getPlaidItemsHealth } from '../api/client'

/**
 * Dashboard banner for bank connections that have stopped updating.
 *
 * A Plaid sync can keep "succeeding" for days on Plaid's cached data while
 * Plaid's own refreshes against a bank fail — often with no item error flag
 * at all — so balances look current while new transactions silently never
 * arrive. The backend classifies each connection from Plaid's /item/get
 * (GET /api/plaid/items/health); this surfaces the ones marked "error" or
 * "stale" before the user discovers the gap themselves.
 *
 * Reads the status cached by the last sync (max_age_minutes) so a Dashboard
 * load doesn't call Plaid once per connection.
 */

// Matches the scheduled sync interval: every sync refreshes the cached status.
const MAX_AGE_MINUTES = 360
const DISMISS_KEY = 'tuskledger.connection-alert-dismissed'

/**
 * Group problem connections by institution (one bank can have several
 * logins) and keep what the banner needs. Pure — exported for tests.
 */
export function summarizeConnectionIssues(items = []) {
  const groups = new Map()
  for (const it of items || []) {
    if (it?.status !== 'error' && it?.status !== 'stale') continue
    const key = `${it.institution_id || ''}|${it.institution_name || ''}`
    const g = groups.get(key) || {
      institutionName: it.institution_name || 'A connected institution',
      institutionId: it.institution_id || null,
      count: 0,
      status: 'stale',
      errorCode: null,
      since: null,
      failing: false,
    }
    g.count += 1
    if (it.status === 'error') {
      g.status = 'error'
      g.errorCode = g.errorCode || it.error?.code || null
    }
    if (it.last_attempt_failed) g.failing = true
    const ok = it.last_successful_update ? Date.parse(it.last_successful_update) : NaN
    if (!Number.isNaN(ok) && (g.since === null || ok < Date.parse(g.since))) {
      g.since = it.last_successful_update
    }
    groups.set(key, g)
  }
  // Errors first: they're the ones the user can usually fix (Reconnect).
  return [...groups.values()].sort((a, b) =>
    a.status === b.status ? a.institutionName.localeCompare(b.institutionName) : (a.status === 'error' ? -1 : 1))
}

/**
 * One sentence per institution. With `named: false` (the banner's headline
 * already names the only affected bank) the sentence skips the name.
 * Pure — exported for tests.
 */
export function describeIssue(issue, { named = true } = {}) {
  const plural = issue.count > 1 ? ` (${issue.count} connections)` : ''
  const lead = named ? `${issue.institutionName}${plural}: ` : ''
  const tail = named ? '' : plural
  if (issue.status === 'error') {
    return `${lead}Plaid reports ${issue.errorCode || 'a connection error'}${tail}. `
      + 'Reconnect it on the Accounts page to resume updates.'
  }
  const since = issue.since
    ? new Date(issue.since).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    : null
  const sentence = `no new data${since ? ` since ${since}` : ''}${tail}`
    + (issue.failing ? ", and Plaid's attempts to reach the bank are failing" : '')
    + '. Transactions after that are missing until the connection recovers.'
  return lead + (named ? sentence : sentence.charAt(0).toUpperCase() + sentence.slice(1))
}

function localDate() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function signature(issues) {
  return issues.map(i => `${i.institutionId || i.institutionName}:${i.status}`).join(',')
}

function readDismissal() {
  try { return JSON.parse(localStorage.getItem(DISMISS_KEY) || 'null') } catch { return null }
}

export default function ConnectionHealthAlert() {
  const [issues, setIssues] = useState([])
  const [dismissed, setDismissed] = useState(false)

  useEffect(() => {
    let cancelled = false
    getPlaidItemsHealth(MAX_AGE_MINUTES)
      .then(res => {
        if (cancelled) return
        const found = summarizeConnectionIssues(res?.items)
        const d = readDismissal()
        // A dismissal lasts for the day, and only for the same set of problems:
        // a different connection breaking later that day shows the banner again.
        setDismissed(!!d && d.date === localDate() && d.sig === signature(found))
        setIssues(found)
      })
      .catch(e => console.warn('Connection health unavailable:', e?.message || e))
    return () => { cancelled = true }
  }, [])

  if (dismissed || issues.length === 0) return null

  const hasError = issues.some(i => i.status === 'error')
  const tone = hasError ? 'red' : 'orange'
  const headline = issues.length === 1
    ? `${issues[0].institutionName} isn't updating`
    : `${issues.length} bank connections aren't updating`

  const dismiss = () => {
    try {
      localStorage.setItem(DISMISS_KEY, JSON.stringify({ date: localDate(), sig: signature(issues) }))
    } catch { /* storage unavailable — dismiss for this page view only */ }
    setDismissed(true)
  }

  return (
    <div
      role="alert"
      style={{
        background: `var(--accent-${tone}-bg)`,
        border: `1px solid var(--accent-${tone}-border)`,
        borderRadius: 8,
        padding: 12,
        marginBottom: 16,
        display: 'flex',
        alignItems: 'flex-start',
        gap: 12,
      }}
    >
      <AlertTriangle size={18} style={{ color: `var(--accent-${tone})`, flexShrink: 0, marginTop: 2 }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ color: `var(--accent-${tone})`, fontWeight: 600, fontSize: 14, marginBottom: 4 }}>
          {headline}
        </div>
        {issues.map(issue => (
          <div
            key={`${issue.institutionId}|${issue.institutionName}`}
            style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.5, marginTop: 2 }}
          >
            {describeIssue(issue, { named: issues.length > 1 })}
            {issue.status === 'stale' && issue.institutionId && (
              <>
                {' '}
                <a
                  href={`https://dashboard.plaid.com/activity/status/institution/${encodeURIComponent(issue.institutionId)}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 3, whiteSpace: 'nowrap' }}
                >
                  Plaid status <ExternalLink size={11} />
                </a>
              </>
            )}
          </div>
        ))}
        <div style={{ marginTop: 8, fontSize: 12 }}>
          <RouterLink to="/connect">Review connections on the Accounts page →</RouterLink>
        </div>
      </div>
      <button
        onClick={dismiss}
        title="Hide until tomorrow"
        aria-label="Hide until tomorrow"
        style={{
          background: 'none', border: 'none', padding: 0, cursor: 'pointer',
          color: 'var(--text-secondary)', flexShrink: 0,
        }}
      >
        <X size={16} />
      </button>
    </div>
  )
}
