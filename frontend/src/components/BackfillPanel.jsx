import { useState } from 'react'
import { History, Loader2, CheckCircle, AlertCircle, Info } from 'lucide-react'
import { backfillTransactions } from '../api/client'
import { toLocalISODate } from '../lib/format'

/**
 * One-off historical backfill UI. Calls POST /api/plaid/backfill with a
 * date range and optional institution filter, then renders per-item
 * results inline.
 *
 * Why this exists: Plaid's /transactions/sync only delivers transactions
 * Plaid hadn't yet sent the next time you call it — once your cursor
 * advances past a period, sync won't re-deliver those rows. This panel
 * exposes the gap-filler endpoint that hits /transactions/get directly
 * for an explicit date range, independent of the cursor.
 *
 * Idempotent on the backend (dedupes by Plaid transaction ID), so
 * re-running the same range never double-inserts.
 */
export default function BackfillPanel({ items = [] }) {
  // Default to the previous calendar month — by far the most common case
  // (you've discovered last month was incomplete and want to top it up).
  const [{ start, end }, setRange] = useState(() => defaultPreviousMonth())
  const [itemId, setItemId] = useState('')   // '' = all institutions
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState(null)
  const [error, setError] = useState(null)

  const handleRun = async () => {
    setError(null)
    setResult(null)
    if (!start || !end) {
      setError('Pick a start and end date')
      return
    }
    if (end < start) {
      setError('End date must be on or after start date')
      return
    }
    setRunning(true)
    try {
      const response = await backfillTransactions({
        start, end,
        itemId: itemId || undefined,
      })
      setResult(response)
    } catch (e) {
      setError(e.message || 'Backfill failed')
    } finally {
      setRunning(false)
    }
  }

  // Quick-select preset shortcuts. Most backfills are "the last full
  // month" or "this quarter" so we avoid forcing the user to fiddle
  // with a date picker for the obvious cases.
  const setPreset = (preset) => {
    const today = new Date()
    if (preset === 'last_month') {
      setRange(defaultPreviousMonth())
    } else if (preset === 'this_month') {
      const first = new Date(today.getFullYear(), today.getMonth(), 1)
      setRange({ start: iso(first), end: iso(today) })
    } else if (preset === 'last_90d') {
      const ago = new Date(today)
      ago.setDate(ago.getDate() - 90)
      setRange({ start: iso(ago), end: iso(today) })
    } else if (preset === 'last_year') {
      const start = new Date(today.getFullYear() - 1, 0, 1)
      const end = new Date(today.getFullYear() - 1, 11, 31)
      setRange({ start: iso(start), end: iso(end) })
    }
  }

  return (
    <div className="card" style={{ marginBottom: 24 }}>
      <div className="card-header">
        <span className="card-title" style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          <History size={16} style={{ color: 'var(--accent-blue)' }} />
          Backfill historical transactions
        </span>
        <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
          one-off pull · safe to re-run
        </span>
      </div>

      <div style={{
        background: 'rgba(96, 165, 250, 0.06)',
        border: '1px solid rgba(96, 165, 250, 0.2)',
        borderRadius: 8,
        padding: '10px 12px',
        marginBottom: 16,
        display: 'flex',
        alignItems: 'flex-start',
        gap: 10,
        fontSize: 13,
        color: 'var(--text-secondary)',
      }}>
        <Info size={14} style={{ color: 'var(--accent-blue)', flexShrink: 0, marginTop: 2 }} />
        <div>
          Use this when an old period is missing transactions — the regular sync
          only sees what Plaid hasn't already delivered. This pulls a specific
          date range directly. Already-imported transactions are skipped, so
          re-running the same range is harmless.
        </div>
      </div>

      {/* Quick-select preset row */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 12, flexWrap: 'wrap' }}>
        <PresetBtn onClick={() => setPreset('last_month')}>Last month</PresetBtn>
        <PresetBtn onClick={() => setPreset('this_month')}>Month-to-date</PresetBtn>
        <PresetBtn onClick={() => setPreset('last_90d')}>Last 90 days</PresetBtn>
        <PresetBtn onClick={() => setPreset('last_year')}>Last full year</PresetBtn>
      </div>

      {/* Date range + institution filter */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1.5fr', gap: 10, alignItems: 'end' }}>
        <Field label="Start">
          <input
            type="date"
            value={start}
            onChange={e => setRange(prev => ({ ...prev, start: e.target.value }))}
            disabled={running}
            style={inputStyle}
          />
        </Field>

        <Field label="End">
          <input
            type="date"
            value={end}
            onChange={e => setRange(prev => ({ ...prev, end: e.target.value }))}
            disabled={running}
            style={inputStyle}
          />
        </Field>

        <Field label="Institution">
          <select
            value={itemId}
            onChange={e => setItemId(e.target.value)}
            disabled={running || items.length === 0}
            style={inputStyle}
          >
            <option value="">All institutions ({items.length})</option>
            {items.map(it => (
              <option key={it.id} value={it.id}>
                {it.institution_name || `Item ${it.id}`}
              </option>
            ))}
          </select>
        </Field>
      </div>

      <div style={{ marginTop: 12 }}>
        <button
          className="btn btn-primary"
          onClick={handleRun}
          disabled={running}
          style={{ minWidth: 130, height: 36 }}
        >
          {running ? (
            <>
              <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} />
              Pulling…
            </>
          ) : (
            <>
              <History size={14} />
              Backfill
            </>
          )}
        </button>
      </div>

      {/* Errors */}
      {error && (
        <div style={{
          marginTop: 14, padding: '10px 12px',
          background: 'rgba(248, 113, 113, 0.08)',
          border: '1px solid rgba(248, 113, 113, 0.3)',
          borderRadius: 8, fontSize: 13,
          display: 'flex', alignItems: 'center', gap: 8,
          color: 'var(--accent-red)',
        }}>
          <AlertCircle size={14} />
          {error}
        </div>
      )}

      {/* Per-item backfill results */}
      {result && <ResultsTable result={result} />}

      {/* Inline keyframes — Lucide doesn't ship a spinning variant. */}
      <style>{`
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
      `}</style>
    </div>
  )
}


function ResultsTable({ result }) {
  const total = result.total_inserted ?? 0
  return (
    <div style={{ marginTop: 16 }}>
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        marginBottom: 10,
        fontSize: 14,
        color: total > 0 ? 'var(--accent-green)' : 'var(--text-secondary)',
      }}>
        <CheckCircle size={14} />
        {total > 0
          ? `Inserted ${total} new transaction${total !== 1 ? 's' : ''} for ${result.start_date} → ${result.end_date}.`
          : `No new transactions for ${result.start_date} → ${result.end_date} — looks like everything was already in sync.`}
      </div>

      <div className="table-wrapper">
        <table style={{ fontSize: 13 }}>
          <thead>
            <tr>
              <th>Institution</th>
              <th style={{ textAlign: 'right' }}>Fetched</th>
              <th style={{ textAlign: 'right' }}>Inserted</th>
              <th style={{ textAlign: 'right' }}>Already had</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {(result.items || []).map((row, i) => (
              <tr key={i}>
                <td>{row.institution || '—'}</td>
                <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                  {row.fetched ?? '—'}
                </td>
                <td style={{
                  textAlign: 'right',
                  fontVariantNumeric: 'tabular-nums',
                  color: (row.inserted || 0) > 0 ? 'var(--accent-green)' : undefined,
                  fontWeight: (row.inserted || 0) > 0 ? 500 : 400,
                }}>
                  {row.inserted ?? 0}
                </td>
                <td style={{
                  textAlign: 'right',
                  fontVariantNumeric: 'tabular-nums',
                  color: 'var(--text-muted)',
                }}>
                  {row.skipped_existing ?? '—'}
                </td>
                <td>
                  <StatusPill status={row.status} reason={row.reason || row.error} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}


function StatusPill({ status, reason }) {
  const tone = status === 'ok' ? 'success'
    : status === 'skipped' ? 'neutral'
    : 'danger'
  const label = status === 'ok' ? 'OK'
    : status === 'skipped' ? 'Skipped'
    : 'Error'
  const bg = tone === 'success' ? 'rgba(52,211,153,0.12)'
    : tone === 'neutral' ? 'rgba(156,163,175,0.12)'
    : 'rgba(248,113,113,0.12)'
  const color = tone === 'success' ? 'var(--accent-green)'
    : tone === 'neutral' ? 'var(--text-muted)'
    : 'var(--accent-red)'

  // `reason` may be a string (legacy/unstructured) or a dict from
  // parse_plaid_error: {code, type, message, display_message,
  // suggested_action}. Pick the most user-readable thing we have, in
  // priority order. Hover shows the long form.
  const summary = formatErrorSummary(reason)
  const tooltip = formatErrorTooltip(reason)

  return (
    <span title={tooltip || undefined} style={{
      display: 'inline-block',
      padding: '2px 8px',
      borderRadius: 12,
      fontSize: 11,
      fontWeight: 500,
      background: bg,
      color,
      whiteSpace: 'nowrap',
      maxWidth: 320,
      overflow: 'hidden',
      textOverflow: 'ellipsis',
    }}>
      {label}{summary ? ` · ${summary}` : ''}
    </span>
  )
}

function formatErrorSummary(reason) {
  if (!reason) return ''
  if (typeof reason === 'string') {
    // Old-style raw string. Trim aggressively — old behavior dumped
    // entire HTTP transcripts here.
    return reason.length > 80 ? reason.slice(0, 77) + '…' : reason
  }
  // Structured Plaid error. Prefer code (stable + searchable) plus a
  // short hint mapped from the code itself.
  if (reason.code) return `${reason.code}${HINTS_BY_CODE[reason.code] ? ' — ' + HINTS_BY_CODE[reason.code] : ''}`
  return reason.display_message || reason.message || 'unknown error'
}

function formatErrorTooltip(reason) {
  if (!reason || typeof reason === 'string') return reason || ''
  // Stack the structured fields top-to-bottom so the hover is the full
  // diagnostic story without HTML — title attributes don't render markup.
  const lines = []
  if (reason.code) lines.push(`Code: ${reason.code}`)
  if (reason.type) lines.push(`Type: ${reason.type}`)
  if (reason.message) lines.push(`Message: ${reason.message}`)
  if (reason.suggested_action) lines.push(`Suggested: ${reason.suggested_action}`)
  if (reason.request_id) lines.push(`Request: ${reason.request_id}`)
  return lines.join('\n')
}

// Friendly one-liners for the error codes most likely to surface from
// /transactions/refresh and /transactions/get. The Plaid docs are
// thorough but the page-load is slow and the user wants the hint inline.
const HINTS_BY_CODE = {
  PRODUCTS_NOT_SUPPORTED: 'this institution doesn\'t support refresh',
  INVALID_PRODUCT: 'item wasn\'t initialized with this product — re-link to enable',
  PRODUCT_NOT_READY: 'Plaid is still pulling history; try again in a minute',
  ITEM_LOGIN_REQUIRED: 're-link this institution to refresh credentials',
  TRANSACTIONS_REFRESH_REQUEST_LIMIT: 'rate limit hit; try again later',
  ADDITION_LIMIT_EXCEEDED: 'too many refreshes today on this item',
  INSTITUTION_DOWN: 'bank is temporarily unavailable',
  INSTITUTION_NOT_RESPONDING: 'bank didn\'t respond; try again',
  NO_ACCOUNTS: 'item has no transactions-eligible accounts',
  RATE_LIMIT_EXCEEDED: 'too many calls; try again later',
}


// ─── small bits ─────────────────────────────────────────────
const inputStyle = {
  width: '100%',
  padding: '7px 10px',
  fontSize: 13,
  border: '1px solid var(--border-color, rgba(255,255,255,0.1))',
  borderRadius: 6,
  background: 'var(--bg-input, rgba(255,255,255,0.04))',
  color: 'inherit',
  height: 36,
  boxSizing: 'border-box',
}

function Field({ label, children }) {
  return (
    <div>
      <div style={{
        fontSize: 11,
        color: 'var(--text-muted)',
        textTransform: 'uppercase',
        letterSpacing: 0.4,
        marginBottom: 4,
      }}>{label}</div>
      {children}
    </div>
  )
}

function PresetBtn({ onClick, children }) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: '5px 10px',
        fontSize: 12,
        background: 'rgba(255,255,255,0.04)',
        border: '1px solid rgba(255,255,255,0.08)',
        borderRadius: 14,
        color: 'var(--text-secondary)',
        cursor: 'pointer',
      }}
    >
      {children}
    </button>
  )
}

function iso(d) {
  return toLocalISODate(d)
}

function defaultPreviousMonth() {
  const today = new Date()
  // First day of the previous month
  const start = new Date(today.getFullYear(), today.getMonth() - 1, 1)
  // Last day of the previous month = day 0 of this month
  const end = new Date(today.getFullYear(), today.getMonth(), 0)
  return { start: iso(start), end: iso(end) }
}
