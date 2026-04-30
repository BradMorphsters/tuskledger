import { useState, useEffect } from 'react'
import { Calendar, AlertCircle, RotateCcw } from 'lucide-react'
import { getCashflowCalendar } from '../api/client'

/**
 * Bills calendar with drag-to-reschedule.
 *
 * The backend returns predicted recurring events from
 * /api/cashflow-calendar — but those predictions are based on the most
 * recent observed cycle and don't know about ad-hoc shifts the user
 * has negotiated (a credit-card auto-pay moved a week earlier, a
 * landlord agreed to a different mortgage day, etc.).
 *
 * This page lets the user drag any predicted event to a different day
 * to override its rendered date. Overrides persist to localStorage —
 * key is "<merchant>|<original_date>", value is the new date. We never
 * mutate the source data on the backend (predictions regenerate every
 * cycle); the override layer is purely a UI concern, so the user's
 * tweaks survive a page reload but the system can still re-predict
 * cleanly when actual transactions land.
 */
const OVERRIDES_KEY = 'tuskledger.billOverrides.v1'

function loadOverrides() {
  try { return JSON.parse(localStorage.getItem(OVERRIDES_KEY) || '{}') }
  catch { return {} }
}

function saveOverrides(o) {
  localStorage.setItem(OVERRIDES_KEY, JSON.stringify(o))
}

// Exported for unit tests + reuse by other components that need to
// reference a bill by its stable original-prediction identity.
export function billKey(event) {
  return `${event.merchant}|${event.date}`
}

// Apply the user's drag-to-reschedule overrides to a list of events.
// Pure function — takes events + overrides map, returns events with
// `_originalDate` preserved and `date` swapped for the override when
// present. Exported to make the override layer easy to test in
// isolation from the calendar grid render.
export function applyBillOverrides(events, overrides) {
  if (!Array.isArray(events)) return []
  const map = overrides || {}
  return events.map(e => {
    const key = billKey(e)
    const override = map[key]
    return {
      ...e,
      _originalDate: e.date,
      date: override || e.date,
    }
  })
}

export default function CashFlowCalendar() {
  const [events, setEvents] = useState([])
  const [summary, setSummary] = useState(null)
  const [startingCash, setStartingCash] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [overrides, setOverrides] = useState(loadOverrides)
  const [dragOverDate, setDragOverDate] = useState(null)

  useEffect(() => {
    const loadCalendar = async () => {
      try {
        setLoading(true)
        const data = await getCashflowCalendar(30)
        setEvents(data.events || [])
        setSummary(data.summary)
        setStartingCash(data.starting_cash || 0)
        setError(null)
      } catch (err) {
        console.error('Failed to load calendar:', err)
        setError('Unable to load cash flow calendar')
      } finally {
        setLoading(false)
      }
    }
    loadCalendar()
  }, [])

  // Apply overrides to the events. See applyBillOverrides above.
  const effectiveEvents = applyBillOverrides(events, overrides)

  // Group events by date for easy lookup
  const eventsByDate = {}
  effectiveEvents.forEach(event => {
    if (!eventsByDate[event.date]) {
      eventsByDate[event.date] = []
    }
    eventsByDate[event.date].push(event)
  })

  // Compute running balance per date. Walk dates from today forward,
  // applying each day's net (income − expenses) to the rolling cash
  // total. Lets the UI flag low-balance days inline. Income events
  // come back from the backend with positive `amount`; the type
  // field tells us the sign to apply.
  const balanceByDate = {}
  let running = startingCash
  const sortedDateKeys = Object.keys(eventsByDate).sort()
  for (const k of sortedDateKeys) {
    const dayNet = eventsByDate[k].reduce((acc, e) => {
      const amt = Math.abs(e.amount || 0)
      return acc + (e.type === 'income' ? amt : -amt)
    }, 0)
    running = running + dayNet
    balanceByDate[k] = { net: dayNet, balance: running }
  }
  const lowestBalance = Math.min(startingCash, ...Object.values(balanceByDate).map(b => b.balance))

  const fmtMoney = (n) => new Intl.NumberFormat('en-US', {
    style: 'currency', currency: 'USD', maximumFractionDigits: 0,
  }).format(n || 0)

  // Generate calendar grid
  const today = new Date()
  const startDate = new Date(today)
  startDate.setDate(startDate.getDate() - today.getDay()) // Start on Sunday

  const weeks = []
  for (let w = 0; w < 5; w++) {
    const week = []
    for (let d = 0; d < 7; d++) {
      const cellDate = new Date(startDate)
      cellDate.setDate(cellDate.getDate() + w * 7 + d)
      week.push(cellDate)
    }
    weeks.push(week)
  }

  const dateKey = (d) => d.toISOString().split('T')[0]

  const handleDragStart = (e, event) => {
    // Encode the stable original key — we identify the bill by its
    // original predicted date, not the currently-rendered (possibly
    // overridden) date. That way subsequent drags on the same bill
    // continue to update the same override entry.
    e.dataTransfer.setData('text/plain', JSON.stringify({
      key: billKey({ merchant: event.merchant, date: event._originalDate }),
      originalDate: event._originalDate,
    }))
    e.dataTransfer.effectAllowed = 'move'
  }

  const handleDragOver = (e, targetDate) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    setDragOverDate(targetDate)
  }

  const handleDragLeave = () => {
    setDragOverDate(null)
  }

  const handleDrop = (e, targetDate) => {
    e.preventDefault()
    setDragOverDate(null)
    try {
      const { key, originalDate } = JSON.parse(e.dataTransfer.getData('text/plain'))
      // No-op if user dropped on the same day (or back on the original
      // predicted date — clear the override in that case).
      const next = { ...overrides }
      if (targetDate === originalDate) {
        delete next[key]
      } else {
        next[key] = targetDate
      }
      setOverrides(next)
      saveOverrides(next)
    } catch {
      // Malformed payload — silently ignore (browser dropped a file
      // or some other source we don't handle).
    }
  }

  const clearAllOverrides = () => {
    setOverrides({})
    saveOverrides({})
  }

  const overrideCount = Object.keys(overrides).length

  return (
    <div style={{ padding: '20px', maxWidth: 1200 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 24 }}>
        <Calendar size={32} />
        <div style={{ flex: 1 }}>
          <h1 style={{ margin: 0, fontSize: 28, fontWeight: 600 }}>Bills Calendar</h1>
          <p style={{ margin: '4px 0 0 0', fontSize: 13, color: 'var(--text-secondary)' }}>
            Expected cash events in the next 30 days. Drag any bill to a different day to reschedule it.
          </p>
        </div>
        {overrideCount > 0 && (
          <button
            onClick={clearAllOverrides}
            style={{
              display: 'flex', alignItems: 'center', gap: 6,
              padding: '6px 12px', fontSize: 12,
              background: 'var(--bg-input)',
              border: '1px solid var(--border-color, rgba(255,255,255,0.1))',
              borderRadius: 4, color: 'var(--text-secondary)',
              cursor: 'pointer',
            }}
            title="Remove all manual reschedules and revert to predicted dates."
          >
            <RotateCcw size={12} /> Clear {overrideCount} override{overrideCount === 1 ? '' : 's'}
          </button>
        )}
      </div>

      {error && (
        <div style={{
          padding: 12,
          backgroundColor: 'var(--error-light)',
          color: 'var(--error-dark)',
          borderRadius: 6,
          marginBottom: 16,
          display: 'flex',
          alignItems: 'center',
          gap: 8,
        }}>
          <AlertCircle size={18} />
          {error}
        </div>
      )}

      {loading ? (
        <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-secondary)' }}>
          Loading calendar...
        </div>
      ) : (
        <>
          {/* Starting cash + projected low strip */}
          <div style={{
            display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12,
            marginBottom: 16,
          }}>
            <div style={{
              padding: 12, borderRadius: 6,
              background: 'var(--bg-secondary)',
              border: '1px solid var(--border)',
            }}>
              <div style={{ fontSize: 11, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: 0.4 }}>
                Starting cash
              </div>
              <div style={{ fontSize: 20, fontWeight: 700, marginTop: 4 }}>
                {fmtMoney(startingCash)}
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
                checking + savings, today
              </div>
            </div>
            <div style={{
              padding: 12, borderRadius: 6,
              background: 'var(--bg-secondary)',
              border: '1px solid var(--border)',
            }}>
              <div style={{ fontSize: 11, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: 0.4 }}>
                Projected end-of-window
              </div>
              <div style={{
                fontSize: 20, fontWeight: 700, marginTop: 4,
                color: (startingCash + (summary?.net || 0)) >= startingCash ? 'var(--accent-green)' : 'var(--accent-red)',
              }}>
                {fmtMoney(startingCash + (summary?.net || 0))}
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
                after 30d of bills + paychecks
              </div>
            </div>
            <div style={{
              padding: 12, borderRadius: 6,
              background: lowestBalance < 1000 ? 'var(--accent-orange-bg)' : 'var(--bg-secondary)',
              border: `1px solid ${lowestBalance < 1000 ? 'var(--accent-orange-border)' : 'var(--border)'}`,
            }}>
              <div style={{ fontSize: 11, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: 0.4 }}>
                Projected low point
              </div>
              <div style={{
                fontSize: 20, fontWeight: 700, marginTop: 4,
                color: lowestBalance < 1000 ? 'var(--accent-orange)' : 'var(--text-primary)',
              }}>
                {fmtMoney(lowestBalance)}
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
                {lowestBalance < 1000 ? 'tight day ahead — review' : 'on the lowest day in the window'}
              </div>
            </div>
          </div>

          {/* Calendar Grid */}
          <div style={{
            backgroundColor: 'var(--bg-secondary)',
            borderRadius: 8,
            padding: 16,
            marginBottom: 20,
          }}>
            {/* Day headers */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 8, marginBottom: 12 }}>
              {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(day => (
                <div
                  key={day}
                  style={{
                    textAlign: 'center',
                    fontWeight: 600,
                    fontSize: 12,
                    color: 'var(--text-secondary)',
                    paddingBottom: 8,
                    borderBottom: '1px solid var(--border)',
                  }}
                >
                  {day}
                </div>
              ))}
            </div>

            {/* Calendar cells */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 8 }}>
              {weeks.map((week, wIdx) =>
                week.map((d, dIdx) => {
                  const key = dateKey(d)
                  const dayEvents = eventsByDate[key] || []
                  const isToday = dateKey(today) === key
                  const isCurrentMonth = d.getMonth() === today.getMonth()
                  const isDragOver = dragOverDate === key

                  return (
                    <div
                      key={`${wIdx}-${dIdx}`}
                      onDragOver={(e) => handleDragOver(e, key)}
                      onDragLeave={handleDragLeave}
                      onDrop={(e) => handleDrop(e, key)}
                      style={{
                        minHeight: 120,
                        padding: 8,
                        borderRadius: 4,
                        backgroundColor: isDragOver
                          ? 'var(--accent-blue-bg)'
                          : (isCurrentMonth ? 'var(--bg-primary)' : 'var(--bg-tertiary)'),
                        border: isDragOver
                          ? '2px dashed var(--accent-blue)'
                          : (isToday ? '2px solid var(--primary)' : '1px solid var(--border)'),
                        position: 'relative',
                        transition: 'background-color 0.15s, border-color 0.15s',
                      }}
                    >
                      <div
                        style={{
                          fontSize: 12,
                          fontWeight: 600,
                          color: isCurrentMonth ? 'var(--text-primary)' : 'var(--text-secondary)',
                          marginBottom: 4,
                        }}
                      >
                        {d.getDate()}
                      </div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                        {dayEvents.map((event, idx) => {
                          const wasMoved = event._originalDate !== event.date
                          const isIncome = event.type === 'income'
                          return (
                            <div
                              key={idx}
                              draggable
                              onDragStart={(e) => handleDragStart(e, event)}
                              style={{
                                fontSize: 10,
                                padding: '2px 4px',
                                borderRadius: 3,
                                backgroundColor: isIncome ? '#d4edda' : '#f8d7da',
                                color: isIncome ? '#155724' : '#721c24',
                                whiteSpace: 'nowrap',
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                cursor: 'grab',
                                outline: wasMoved ? '1px dashed var(--accent-blue)' : 'none',
                                display: 'flex', justifyContent: 'space-between', gap: 4,
                              }}
                              title={
                                `${event.merchant}: $${event.amount}` +
                                (wasMoved ? ` (moved from ${event._originalDate})` : '') +
                                ' — drag to reschedule'
                              }
                            >
                              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                {wasMoved ? '⇢ ' : ''}{event.merchant.substring(0, 10)}
                              </span>
                              <span style={{ fontWeight: 600, flexShrink: 0 }}>
                                {isIncome ? '+' : '−'}${Math.round(event.amount)}
                              </span>
                            </div>
                          )
                        })}
                      </div>
                      {/* Running balance footer per day — only shown when
                          the day actually had an event (otherwise the
                          balance is unchanged from the prior day, and we
                          skip the visual noise). */}
                      {balanceByDate[key] && (
                        <div style={{
                          marginTop: 4, paddingTop: 3,
                          borderTop: '1px solid var(--border-color, rgba(255,255,255,0.06))',
                          fontSize: 9, fontWeight: 600,
                          color: balanceByDate[key].balance < 1000
                            ? 'var(--accent-red)'
                            : balanceByDate[key].balance < 5000
                              ? 'var(--accent-orange)'
                              : 'var(--text-muted)',
                          textAlign: 'right',
                          fontVariantNumeric: 'tabular-nums',
                        }} title={`Running cash balance after this day's events: ${fmtMoney(balanceByDate[key].balance)}`}>
                          {fmtMoney(balanceByDate[key].balance)}
                        </div>
                      )}
                    </div>
                  )
                })
              )}
            </div>
          </div>

          {/* Summary Panel */}
          {summary && (
            <div style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(3, 1fr)',
              gap: 12,
            }}>
              <div style={{
                padding: 16,
                backgroundColor: 'var(--bg-secondary)',
                borderRadius: 6,
                border: '1px solid var(--border)',
              }}>
                <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 4 }}>
                  Expected Income
                </div>
                <div style={{ fontSize: 20, fontWeight: 600, color: '#28a745' }}>
                  ${summary.total_expected_income.toFixed(2)}
                </div>
              </div>
              <div style={{
                padding: 16,
                backgroundColor: 'var(--bg-secondary)',
                borderRadius: 6,
                border: '1px solid var(--border)',
              }}>
                <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 4 }}>
                  Expected Expenses
                </div>
                <div style={{ fontSize: 20, fontWeight: 600, color: '#dc3545' }}>
                  ${summary.total_expected_expenses.toFixed(2)}
                </div>
              </div>
              <div style={{
                padding: 16,
                backgroundColor: 'var(--bg-secondary)',
                borderRadius: 6,
                border: '1px solid var(--border)',
              }}>
                <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 4 }}>
                  Net (30 days)
                </div>
                <div style={{
                  fontSize: 20,
                  fontWeight: 600,
                  color: summary.net >= 0 ? '#28a745' : '#dc3545',
                }}>
                  ${summary.net.toFixed(2)}
                </div>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}
