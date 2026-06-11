/**
 * useAccounts — module-level cached fetch of /accounts/ with 30s TTL
 * and in-flight deduplication.
 *
 * Multiple components mounting simultaneously will share a single in-flight
 * request (the Promise is stored in `pendingFetch`). Subsequent calls within
 * the TTL window return the cached value synchronously without touching the
 * network.
 *
 * Returns { accounts, loading, error, refresh }
 *   accounts  array — current account list (empty array while loading)
 *   loading   boolean — true while the first fetch is in flight
 *   error     Error | null — last error, null when successful
 *   refresh() function — bypass the TTL and force a fresh fetch
 */
import { useState, useEffect, useCallback } from 'react'
import { getAccounts } from '../api/client'

const TTL_MS = 30_000

let cachedAccounts = null      // last successful result
let cacheTimestamp = 0         // when cachedAccounts was stored
let pendingFetch = null        // shared in-flight Promise

/**
 * Fetch accounts, respecting the module-level cache + in-flight dedupe.
 * Pass force=true to skip the TTL check (used by refresh()).
 */
function fetchAccounts(force = false) {
  const now = Date.now()
  if (!force && cachedAccounts !== null && now - cacheTimestamp < TTL_MS) {
    return Promise.resolve(cachedAccounts)
  }
  if (pendingFetch) return pendingFetch
  pendingFetch = getAccounts()
    .then(data => {
      cachedAccounts = data
      cacheTimestamp = Date.now()
      pendingFetch = null
      return data
    })
    .catch(err => {
      pendingFetch = null
      throw err
    })
  return pendingFetch
}

export function useAccounts() {
  const [accounts, setAccounts] = useState(cachedAccounts ?? [])
  const [loading, setLoading] = useState(cachedAccounts === null)
  const [error, setError] = useState(null)

  const load = useCallback((force = false) => {
    // If cache is warm and not forcing, skip the loading flash.
    const now = Date.now()
    if (!force && cachedAccounts !== null && now - cacheTimestamp < TTL_MS) {
      setAccounts(cachedAccounts)
      setLoading(false)
      return
    }
    setLoading(true)
    setError(null)
    fetchAccounts(force)
      .then(data => {
        setAccounts(data)
        setLoading(false)
      })
      .catch(err => {
        setError(err)
        setLoading(false)
      })
  }, [])

  useEffect(() => {
    load(false)
  }, [load])

  const refresh = useCallback(() => load(true), [load])

  return { accounts, loading, error, refresh }
}
