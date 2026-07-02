/**
 * useLatestRequest — guard against stale async results overwriting fresh ones.
 *
 * Our API client returns plain Promises (not fetch()+AbortSignal), so we
 * can't literally abort the network request. What we *can* do — and what
 * actually matters for correctness — is discard the result of any request
 * that has been superseded by a newer one, so a slow response for an old
 * month / industry / filter never clobbers the current view.
 *
 * This is the reusable form of the `let alive = true; return () => alive = false`
 * liveness flag already used in Research.jsx's EntityDrawer. Each call to
 * `run()` invalidates every earlier in-flight call.
 *
 * Usage — the ergonomic form wraps the whole promise chain:
 *
 *   const runLatest = useLatestRequest()
 *   useEffect(() => {
 *     runLatest(token =>
 *       getThing(arg)
 *         .then(d => { if (token.live) setData(d) })
 *         .catch(() => { if (token.live) setData(null) })
 *     )
 *   }, [arg])
 *
 * `token.live` is false once a newer run() has started (or the component
 * unmounted), so stale resolutions become no-ops. The cleanup returned by
 * run() also flips the token, so returning it from an effect works too.
 */
import { useRef, useEffect, useCallback } from 'react'

export function useLatestRequest() {
  // Holds the token for the most recent request. Bumping it invalidates
  // any earlier request still awaiting resolution.
  const currentRef = useRef(null)

  useEffect(() => {
    // On unmount, invalidate whatever is in flight so we don't setState
    // on an unmounted component.
    return () => { if (currentRef.current) currentRef.current.live = false }
  }, [])

  return useCallback((fn) => {
    // Invalidate the previous request, mint a fresh token.
    if (currentRef.current) currentRef.current.live = false
    const token = { live: true }
    currentRef.current = token
    const maybeCleanup = fn(token)
    // Allow use as an effect body: returning this cleanup flips the token.
    return () => { token.live = false; if (typeof maybeCleanup === 'function') maybeCleanup() }
  }, [])
}
