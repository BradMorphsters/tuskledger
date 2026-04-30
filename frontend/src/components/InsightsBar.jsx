import { useState, useEffect, useRef } from 'react'
import { X, TrendingUp, Sparkles, AlertCircle } from 'lucide-react'
import { getInsights } from '../api/client'

const STORAGE_KEY = 'insights-dismissed'
const DISMISS_MS = 7 * 24 * 60 * 60 * 1000   // 7 days

// Hash the identifying parts of a card so dismissals survive across server
// reorderings and minor amount drift. Amount rounded to nearest $10 so
// "$47.12" and "$48.30" land on the same key.
function cardKey(card) {
  const m = card.merchant || ''
  const c = card.category || ''
  const a = card.amount ? Math.round(card.amount / 10) * 10 : 0
  return `${card.type}|${m}|${c}|${a}`
}

// Read the persisted dismissal map and prune any entries that have expired.
// Pure — no React state — so callers can use the result synchronously
// without waiting for a setState round-trip.
function loadDismissed() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const data = JSON.parse(raw)
    const now = Date.now()
    const fresh = {}
    for (const [key, expiresAt] of Object.entries(data)) {
      if (expiresAt > now) fresh[key] = expiresAt
    }
    // Persist the pruned set so it doesn't grow forever.
    if (Object.keys(fresh).length !== Object.keys(data).length) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(fresh))
    }
    return fresh
  } catch {
    return {}
  }
}

export default function InsightsBar() {
  const [cards, setCards] = useState([])
  const [loading, setLoading] = useState(true)
  // Hold the dismissed map in a ref instead of state. Dismissal needs to
  // (a) persist to localStorage, (b) hide the card from the visible list,
  // and (c) be available immediately when the next fetch resolves — none
  // of which require triggering a re-render. State here was the source of
  // a stale-closure bug where the in-effect filter saw the initial {}
  // instead of the value we'd just loaded from localStorage.
  const dismissedRef = useRef({})

  useEffect(() => {
    dismissedRef.current = loadDismissed()
    getInsights(5)
      .then(response => {
        const active = (response.cards || []).filter(
          c => !dismissedRef.current[cardKey(c)]
        )
        setCards(active)
      })
      .catch(() => {
        // Silently fail — insights aren't critical to the page.
      })
      .finally(() => setLoading(false))
  }, [])

  const handleDismiss = (card) => {
    const key = cardKey(card)
    const updated = { ...dismissedRef.current, [key]: Date.now() + DISMISS_MS }
    dismissedRef.current = updated
    localStorage.setItem(STORAGE_KEY, JSON.stringify(updated))
    setCards(prev => prev.filter(c => cardKey(c) !== key))
  }

  if (loading || cards.length === 0) {
    return null
  }

  const iconMap = {
    'category_up': TrendingUp,
    'new_merchant': Sparkles,
    'large_transaction': AlertCircle,
  }

  const severityColor = {
    'info': 'var(--text-muted)',
    'warning': 'var(--accent-orange)',
    'alert': 'var(--accent-red)',
  }

  const severityBorder = {
    'info': 'rgba(156, 163, 175, 0.3)',
    'warning': 'rgba(251, 146, 60, 0.3)',
    'alert': 'rgba(248, 113, 113, 0.3)',
  }

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      gap: 8,
      marginBottom: 24,
    }}>
      {cards.map((card, i) => {
        const Icon = iconMap[card.type] || AlertCircle
        const color = severityColor[card.severity] || severityColor['info']
        const border = severityBorder[card.severity] || severityBorder['info']

        return (
          <div
            key={i}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              padding: '10px 12px',
              border: `1px solid ${border}`,
              borderRadius: 8,
              background: 'transparent',
            }}
          >
            <Icon
              size={18}
              style={{
                color,
                flexShrink: 0,
              }}
            />

            <div style={{
              flex: 1,
              minWidth: 0,
            }}>
              <div style={{
                fontSize: 14,
                fontWeight: 500,
                color: 'var(--text-primary)',
                marginBottom: 2,
                lineHeight: 1.3,
              }}>
                {card.title}
              </div>
              <div style={{
                fontSize: 12,
                color: 'var(--text-secondary)',
                lineHeight: 1.3,
              }}>
                {card.subtitle}
              </div>
            </div>

            <button
              onClick={() => handleDismiss(card)}
              title="Dismiss for 7 days"
              style={{
                background: 'none',
                border: 'none',
                padding: 0,
                cursor: 'pointer',
                color: 'var(--text-muted)',
                display: 'flex',
                alignItems: 'center',
                flexShrink: 0,
              }}
            >
              <X size={16} />
            </button>
          </div>
        )
      })}
    </div>
  )
}
