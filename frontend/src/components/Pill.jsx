/**
 * Pill — small inline status/badge label.
 *
 * Usage:
 *   <Pill>MANUAL</Pill>                         // neutral
 *   <Pill tone="info">↔ Transfer</Pill>         // blue
 *   <Pill tone="warning">35d ago</Pill>         // orange
 *   <Pill tone="success">+$1.13</Pill>          // green
 *   <Pill tone="danger">Overdue</Pill>          // red
 *   <Pill soft>credit card</Pill>               // soft variant — pill-shaped, normal-case
 *
 * Replaces the hand-rolled inline-styled spans throughout the app.
 * Styles live in index.css under .pill / .pill-tone-*.
 */
export default function Pill({
  tone = 'neutral',
  soft = false,
  title,
  children,
  style,
  className = '',
}) {
  const cls = [
    'pill',
    soft ? 'pill-soft' : null,
    `pill-${tone}`,
    className,
  ].filter(Boolean).join(' ')
  return (
    <span className={cls} title={title} style={style}>
      {children}
    </span>
  )
}
