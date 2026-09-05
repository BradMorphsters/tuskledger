/**
 * LoadError — inline "couldn't load" notice with a Retry button.
 *
 * Several pages used to swallow fetch failures (`.catch(() => {})`) and
 * quietly render their empty state, so a backend hiccup looked exactly
 * like "you have no transactions". Loading, empty and failed must be
 * three visibly different things. Use this for the third.
 *
 *   <LoadError what="transactions" onRetry={load} />
 */
import { RefreshCw } from 'lucide-react'

export default function LoadError({ what = 'this data', detail, onRetry, compact = false }) {
  return (
    <div role="alert" style={{
      display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
      padding: compact ? '10px 12px' : '14px 16px',
      background: 'var(--accent-red-bg, rgba(248,113,113,0.08))',
      border: '1px solid var(--accent-red-border, rgba(248,113,113,0.3))',
      borderRadius: 8, fontSize: 13, color: 'var(--text-secondary)',
    }}>
      <span style={{ flex: 1, minWidth: 200 }}>
        Couldn't load {what}.{detail ? ` ${detail}` : ' The backend may be restarting — it usually comes back within a few seconds.'}
      </span>
      {onRetry && (
        <button className="btn btn-secondary" onClick={onRetry}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 12px', fontSize: 12 }}>
          <RefreshCw size={13} /> Retry
        </button>
      )}
    </div>
  )
}
