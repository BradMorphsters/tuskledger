/**
 * useIsMobile — viewport-width hook for swapping component shapes
 * (chart axis sizing, table-vs-card layouts in JS-controlled cases,
 * legend visibility) when the rendering surface is a phone.
 *
 * Why a hook instead of pure CSS for these cases: Recharts and a
 * handful of other components don't take responsive props — fontSize,
 * tick interval, and legend visibility are JS values passed to the
 * chart at render time. Pure CSS can't reach into them. The hook is
 * the minimum viable bridge: subscribe once to a matchMedia query and
 * re-render on the cross-threshold transition.
 *
 * Default breakpoint matches the rest of the app (`@media
 * (max-width: 768px)` rules in index.css). Pass a custom breakpoint
 * for components that need a different cutoff (e.g. very dense
 * tables that benefit from card layout earlier than 768px).
 *
 * SSR-safe: returns false during initial render when `window` is not
 * available, so server-rendered output never treats the viewport as
 * mobile by default. The first client-side effect updates correctly.
 */
import { useEffect, useState } from 'react'

export function useIsMobile(breakpoint = 768) {
  const [isMobile, setIsMobile] = useState(() => {
    if (typeof window === 'undefined') return false
    return window.matchMedia(`(max-width: ${breakpoint}px)`).matches
  })

  useEffect(() => {
    if (typeof window === 'undefined') return
    const mq = window.matchMedia(`(max-width: ${breakpoint}px)`)
    const handler = (e) => setIsMobile(e.matches)
    // Modern browsers: addEventListener; legacy Safari: addListener
    if (mq.addEventListener) {
      mq.addEventListener('change', handler)
      return () => mq.removeEventListener('change', handler)
    } else {
      mq.addListener(handler)
      return () => mq.removeListener(handler)
    }
  }, [breakpoint])

  return isMobile
}
