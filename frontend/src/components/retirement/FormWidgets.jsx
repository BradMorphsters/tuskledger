/**
 * FormWidgets — low-level UI primitives used across all form sections
 * in the retirement projection form.
 *
 * Extracted from RetirementProjection.jsx. Pure presentational; no API
 * calls, no external state. Props-driven throughout.
 *
 * Components:
 *   Section      — section wrapper (title + subtitle + border)
 *   FieldGrid    — responsive grid of input fields
 *   PersonHeader — per-person row header (name + age + optional remove)
 *   Field        — labelled input wrapper with optional hint + HelpPopover
 *   HelpPopover  — click-to-show fixed-position help text popover
 */
import { useState, useEffect, useRef } from 'react'

/**
 * Section wrapper — gives the form visual structure with a bold title +
 * muted subtitle, and a divider between sections. Replaces the previous
 * flat field-grid layout where every input was the same visual weight
 * with no grouping cue.
 */
export function Section({ title, subtitle, children }) {
  return (
    <div style={{
      marginBottom: 16,
      paddingTop: 14,
      paddingBottom: 4,
      borderTop: '1px solid rgba(255,255,255,0.06)',
    }}>
      <div style={{ marginBottom: 10 }}>
        <div style={{
          fontSize: 13, fontWeight: 600,
          color: 'var(--text-primary)',
          letterSpacing: 0.2,
          marginBottom: 2,
        }}>
          {title}
        </div>
        {subtitle && (
          <div style={{
            fontSize: 11.5, color: 'var(--text-muted)',
            lineHeight: 1.4,
          }}>
            {subtitle}
          </div>
        )}
      </div>
      {children}
    </div>
  )
}


/**
 * Standard field grid used inside each section. Centralizing the grid
 * config means changing the field min-width or gap doesn't require
 * editing every section block.
 */
export function FieldGrid({ children }) {
  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
      gap: 10,
    }}>
      {children}
    </div>
  )
}


/**
 * Sub-header inside a section that names whose data the row below
 * belongs to (e.g., "You · 49" or "Spouse · 47"). Used in the Social
 * Security section where each spouse gets their own row of inputs and
 * the visual grouping needs to read at a glance.
 *
 * Optional onRemove turns this into a removable row (renders an "×"
 * button on the right). Used to collapse the spouse SS row.
 */
export function PersonHeader({ label, age, onRemove, removeTitle }) {
  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      marginTop: 6,
      marginBottom: 6,
    }}>
      <div style={{
        fontSize: 11, color: 'var(--text-muted)',
        textTransform: 'uppercase', letterSpacing: 0.4,
        fontWeight: 600,
      }}>
        {label}{age !== '' && age !== undefined ? ` · ${age}` : ''}
      </div>
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          title={removeTitle || 'Remove'}
          style={{
            padding: '2px 8px',
            fontSize: 11,
            background: 'transparent',
            border: '1px solid rgba(255,255,255,0.1)',
            color: 'var(--text-muted)',
            borderRadius: 4,
            cursor: 'pointer',
          }}
        >
          × Remove
        </button>
      )}
    </div>
  )
}


export function Field({ label, hint, help, children }) {
  // The label + optional hint sit on a single line. We pin overflow so a
  // long label can never push the hint (or worse, part of the label) onto
  // a second line and shove the input down — that's what the original
  // bug looked like with "ANNUAL CONTRIBUTION $" wrapping.
  // `help` adds a "?" icon with a click-toggleable popover (HelpPopover).
  return (
    <div style={{ minWidth: 0 }}>
      <div style={{
        fontSize: 11, color: 'var(--text-muted)',
        textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 4,
        display: 'flex', alignItems: 'center', gap: 4,
        whiteSpace: 'nowrap', overflow: 'hidden',
      }}>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {label}
        </span>
        {help && <HelpPopover text={help} />}
        {hint && (
          <span style={{
            color: 'var(--accent-blue)', textTransform: 'none', fontSize: 10,
            flexShrink: 0,   // never let the hint be squeezed off
          }}>
            · {hint}
          </span>
        )}
      </div>
      {children}
    </div>
  )
}


/**
 * HelpPopover — click the ? to toggle a small popover with the help
 * text. Replaces the prior `title="..."` hover tooltip which:
 *   1. Only appeared after a 1-2s OS-level hover delay (poor UX),
 *   2. Didn't trigger at all on click or on touch devices,
 *   3. Got clipped by the parent's `overflow: hidden` if shown.
 *
 * Uses position:fixed coordinates derived from the button's bounding
 * rect so the popover escapes the parent's overflow clip and floats
 * above other UI. Closes on outside click or Escape.
 */
export function HelpPopover({ text }) {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState({ top: 0, left: 0 })
  const btnRef = useRef(null)

  useEffect(() => {
    if (!open) return
    const handler = (e) => {
      // Stay open while clicks land on the popover or its trigger.
      if (e.target.closest?.('[data-help-popover]')) return
      setOpen(false)
    }
    const keyHandler = (e) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('click', handler)
    document.addEventListener('keydown', keyHandler)
    return () => {
      document.removeEventListener('click', handler)
      document.removeEventListener('keydown', keyHandler)
    }
  }, [open])

  const toggle = (e) => {
    e.stopPropagation()
    e.preventDefault()
    if (!open && btnRef.current) {
      const rect = btnRef.current.getBoundingClientRect()
      // Anchor below the icon, clamped so it doesn't overflow viewport.
      const POPOVER_W = 340
      const margin = 8
      const left = Math.min(
        rect.left,
        window.innerWidth - POPOVER_W - margin
      )
      setPos({ top: rect.bottom + 4, left: Math.max(margin, left) })
    }
    setOpen(o => !o)
  }

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        onClick={toggle}
        title={text}  // fallback for screen readers + native hover
        data-help-popover
        aria-label="Help"
        style={{
          flexShrink: 0,
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          width: 14, height: 14, borderRadius: '50%',
          fontSize: 9, fontWeight: 700,
          background: open ? 'var(--accent-blue)' : 'rgba(96, 165, 250, 0.2)',
          color: open ? '#0d0e14' : 'var(--accent-blue)',
          border: 'none', padding: 0,
          cursor: 'pointer',
          textTransform: 'none',
          fontFamily: 'inherit',
        }}
      >
        ?
      </button>
      {open && (
        <div
          data-help-popover
          style={{
            position: 'fixed',
            top: pos.top, left: pos.left,
            width: 340,
            padding: '10px 12px',
            background: 'var(--bg-card)',
            border: '1px solid var(--border)',
            borderRadius: 6,
            boxShadow: '0 6px 24px rgba(0,0,0,0.5)',
            zIndex: 1000,
            fontSize: 12, lineHeight: 1.5,
            color: 'var(--text-primary)',
            textTransform: 'none',
            letterSpacing: 0,
            fontWeight: 400,
            whiteSpace: 'normal',
          }}
        >
          {text}
        </div>
      )}
    </>
  )
}
