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
