/**
 * Skeleton — shimmering placeholder block. Use during data loads.
 *
 *   <Skeleton width="60%" height={20} />
 *   <SkeletonRows rows={4} />
 *
 * Animation lives in index.css (.skeleton, @keyframes skeleton-shimmer).
 */
export default function Skeleton({ width = '100%', height = 14, style }) {
  return (
    <span
      className="skeleton"
      style={{
        display: 'inline-block',
        width,
        height,
        ...style,
      }}
    />
  )
}

/** Convenience: stack of skeleton lines, useful for table-row placeholders. */
export function SkeletonRows({ rows = 3, lineWidth = '100%' }) {
  return (
    <div>
      {Array.from({ length: rows }).map((_, i) => (
        <Skeleton key={i} width={lineWidth} style={{ marginBottom: 10 }} />
      ))}
    </div>
  )
}

/** Card-shaped skeleton with title + a few rows. Use as a placeholder
 *  for any whole-card fetch (Pulse, Forecast, Recent Txns, etc). */
export function SkeletonCard({ titleWidth = '40%', rows = 3, height = 14 }) {
  return (
    <div className="card">
      <div className="card-header">
        <Skeleton width={titleWidth} height={16} />
      </div>
      {Array.from({ length: rows }).map((_, i) => (
        <Skeleton key={i} width={`${100 - i * 10}%`} height={height} style={{ marginBottom: 10, display: 'block' }} />
      ))}
    </div>
  )
}

/** Stat-card skeleton — mimics the .stats-grid layout. */
export function SkeletonStatCard() {
  return (
    <div className="stat-card">
      <Skeleton width="50%" height={11} style={{ marginBottom: 8 }} />
      <Skeleton width="75%" height={28} />
    </div>
  )
}

/** Full grid of N stat-card skeletons. */
export function SkeletonStatsGrid({ count = 4 }) {
  return (
    <div className="stats-grid">
      {Array.from({ length: count }).map((_, i) => <SkeletonStatCard key={i} />)}
    </div>
  )
}

/** Table-body placeholder: N rows of M cells. Drop inside <tbody> while the
 *  first page of rows is in flight so the table never flashes its
 *  "No results" empty state before data has had a chance to arrive. */
export function SkeletonTableRows({ rows = 6, cols = 5, cellPadding = '10px 12px' }) {
  return (
    <>
      {Array.from({ length: rows }).map((_, r) => (
        <tr key={r} aria-hidden="true">
          {Array.from({ length: cols }).map((_, c) => (
            <td key={c} style={{ padding: cellPadding }}>
              <Skeleton width={`${55 + ((r * 7 + c * 13) % 40)}%`} height={12} />
            </td>
          ))}
        </tr>
      ))}
    </>
  )
}

/** Whole-page placeholder for pages that fetch everything up front: a
 *  stats row plus one or two cards. Replaces the bare "Loading…" text
 *  that used to sit in the middle of an otherwise empty page. */
export function SkeletonPage({ stats = 4, cards = 2, rows = 4 }) {
  return (
    <div aria-busy="true" aria-label="Loading">
      {stats > 0 && <SkeletonStatsGrid count={stats} />}
      {Array.from({ length: cards }).map((_, i) => (
        <div key={i} style={{ marginTop: i === 0 && stats > 0 ? 20 : 0, marginBottom: 20 }}>
          <SkeletonCard titleWidth={i === 0 ? '30%' : '40%'} rows={rows} />
        </div>
      ))}
    </div>
  )
}
