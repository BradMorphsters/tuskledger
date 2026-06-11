/**
 * useFocusTrap — keyboard focus trap for modal dialogs.
 *
 * When `open` is true:
 *   - Remembers the previously-focused element so focus can be restored
 *     on close (no "lost focus" after dismissing a modal).
 *   - Focuses the first focusable element in the container on open,
 *     unless `autoFocus` is false (use that when the caller manages
 *     initial focus itself, e.g. CommandPalette keeps focus on its
 *     query input via a separate ref).
 *   - Traps Tab / Shift+Tab so focus cycles within the container instead
 *     of escaping to the page behind the modal.
 *
 * Usage:
 *   const containerRef = useRef(null)
 *   useFocusTrap(containerRef, isOpen)
 *   // or, to skip auto-focus-first:
 *   useFocusTrap(containerRef, isOpen, { autoFocus: false })
 *
 * Returns nothing — the hook operates purely via side-effects.
 *
 * No external dependencies.
 */
import { useEffect, useRef } from 'react'

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ')

function getFocusable(container) {
  if (!container) return []
  return Array.from(container.querySelectorAll(FOCUSABLE)).filter(
    el => !el.closest('[aria-hidden="true"]')
  )
}

/**
 * @param {React.RefObject} containerRef  Ref attached to the dialog container element.
 * @param {boolean}         open          Whether the dialog is open.
 * @param {object}          [options]
 * @param {boolean}         [options.autoFocus=true]  Focus the first focusable element on open.
 */
export function useFocusTrap(containerRef, open, { autoFocus = true } = {}) {
  // Keep a stable ref to the element that was focused before the dialog
  // opened so we can return focus to it on close.
  const previousFocusRef = useRef(null)

  useEffect(() => {
    if (!open) {
      // Restore focus to whatever had it before the dialog opened.
      if (previousFocusRef.current && typeof previousFocusRef.current.focus === 'function') {
        previousFocusRef.current.focus()
      }
      previousFocusRef.current = null
      return
    }

    // Record the current active element so we can restore it.
    previousFocusRef.current = document.activeElement

    // Focus the first focusable element inside the container.
    if (autoFocus) {
      // Defer one frame so the container is painted and focusable.
      const raf = requestAnimationFrame(() => {
        const focusable = getFocusable(containerRef.current)
        if (focusable.length > 0) {
          focusable[0].focus()
        }
      })
      return () => cancelAnimationFrame(raf)
    }
  // containerRef.current is intentionally omitted — the ref object is
  // stable; we only care about the `open` transition.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, autoFocus])

  // Tab / Shift+Tab trap — bind while open, clean up on close.
  useEffect(() => {
    if (!open) return

    const handleKeyDown = (e) => {
      if (e.key !== 'Tab') return

      const focusable = getFocusable(containerRef.current)
      if (focusable.length === 0) return

      const first = focusable[0]
      const last = focusable[focusable.length - 1]

      if (e.shiftKey) {
        // Shift+Tab: if we're on the first element, wrap to last.
        if (document.activeElement === first) {
          e.preventDefault()
          last.focus()
        }
      } else {
        // Tab: if we're on the last element, wrap to first.
        if (document.activeElement === last) {
          e.preventDefault()
          first.focus()
        }
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])
}
