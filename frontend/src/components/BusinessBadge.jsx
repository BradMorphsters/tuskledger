/**
 * Colored badge showing business name. Used across all pages.
 */

export const ICON_MAP = {
  briefcase: '💼',
  store: '🏪',
  building: '🏢',
  truck: '🚚',
  code: '💻',
  camera: '📸',
  palette: '🎨',
  wrench: '🔧',
  heart: '❤️',
  star: '⭐',
  coffee: '☕',
  home: '🏠',
  elephant: '🐘',
}

export const BUSINESS_COLORS = [
  '#6366f1', // indigo
  '#f43f5e', // rose
  '#10b981', // emerald
  '#f59e0b', // amber
  '#3b82f6', // blue
  '#8b5cf6', // violet
  '#ec4899', // pink
  '#14b8a6', // teal
  '#f97316', // orange
  '#06b6d4', // cyan
]

export default function BusinessBadge({ business, size = 'sm' }) {
  if (!business) return null

  const sizes = {
    sm: { fontSize: 10, padding: '2px 7px', gap: 3 },
    md: { fontSize: 12, padding: '3px 10px', gap: 4 },
  }
  const s = sizes[size] || sizes.sm

  return (
    <span
      className="business-badge"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: s.gap,
        fontSize: s.fontSize,
        fontWeight: 600,
        padding: s.padding,
        borderRadius: 999,
        backgroundColor: `${business.color}22`,
        color: business.color,
        border: `1px solid ${business.color}44`,
        whiteSpace: 'nowrap',
      }}
    >
      <span style={{ fontSize: s.fontSize + 2 }}>
        {ICON_MAP[business.icon] || '💼'}
      </span>
      {business.name}
    </span>
  )
}
