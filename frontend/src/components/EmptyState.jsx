/**
 * EmptyState — icon-led message for "no data yet" sections.
 *
 *   <EmptyState
 *     icon={<Inbox size={24} />}
 *     title="No transactions yet"
 *     description="Connect an account and your transactions will land here."
 *     action={<button onClick={...}>Connect Account</button>}
 *   />
 */
export default function EmptyState({ icon, title, description, action, compact = false }) {
  return (
    <div className="empty-state" style={compact ? { padding: '32px 16px' } : undefined}>
      {icon && <div className="empty-state__icon">{icon}</div>}
      {title && <h3>{title}</h3>}
      {description && <p style={{ maxWidth: 360, margin: '0 auto', fontSize: 'var(--text-sm)' }}>{description}</p>}
      {action && <div style={{ marginTop: 16 }}>{action}</div>}
    </div>
  )
}
