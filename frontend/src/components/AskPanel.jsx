/**
 * In-app "Ask" panel — a floating button + slide-in panel that lets
 * users click curated questions instead of typing free-form chat.
 *
 * Why a fixed catalog of prompts (not free-form chat):
 *   The local Ollama target is llama3.1:8b. An 8B model isn't reliable
 *   at picking the right aggregation when given an open question. So
 *   the backend exposes a small registry of (prompt_id × horizon)
 *   pairs; each one builds a JSON bundle of pre-computed numbers in
 *   Python and the model just writes prose around them. The panel
 *   surfaces those choices as chips.
 *
 * Two screens, one component:
 *   1. List view  — title + prompt chips, each with horizon selectors.
 *   2. Chat view  — selected prompt as the user message, model answer
 *                   below, plus a "← Back" link to return to the list.
 *
 * Lifecycle is local state (no router): opening the panel slides it in
 * from the right; clicking a chip swaps to the chat view; closing the
 * panel drops everything.
 *
 * Three visual states for an answer:
 *   - loading      → spinner + "Thinking…"
 *   - ready        → prose + (optional) bundle viewer
 *   - error/setup  → human-readable detail from the backend's 503
 *
 * Demo mode + LLM disabled cases are both handled — the backend
 * returns canned text in demo mode, and falls back to a templated
 * answer derived from the bundle when LLM_ENABLED is false. Either
 * way the panel renders something, never an empty state.
 */
import { useEffect, useRef, useState, useCallback } from 'react'
import { Sparkles, X, ArrowLeft, RefreshCw, AlertTriangle } from 'lucide-react'
import { getChatPrompts, streamChatAnswer } from '../api/client'


// ─── Fallback prose when LLM is disabled ──────────────────────────────
//
// When LLM_ENABLED=false, the backend returns the bundle but no
// prose. Rather than show "AI is off" we render a one-liner derived
// from the bundle, so users without Ollama still get a useful answer.
// Keep these honest and minimal — every dollar must come from the
// bundle, never invented.
function fallbackAnswerFromBundle(promptId, bundle) {
  if (!bundle) return null
  const fmt = (n) =>
    typeof n === 'number'
      ? n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })
      : '—'
  if (promptId === 'spending_total') {
    if (bundle.no_data) return `No transactions ${bundle.horizon_label}.`
    const top = bundle.top_categories?.[0]
    const topStr = top ? ` Largest category: ${top.category} (${fmt(top.amount_dollars)}).` : ''
    // Skip the comparison clause when the prior period is unreliable
    // (no data that far back) — same rule the LLM is told to follow.
    let cmpStr = ''
    if (bundle.comparison && !bundle.comparison.prior_period_unreliable) {
      const c = bundle.comparison
      const dir = c.change_dollars >= 0 ? 'up' : 'down'
      cmpStr = ` That's ${dir} ${fmt(Math.abs(c.change_dollars))} vs the prior period.`
    }
    return `${fmt(bundle.total_spent_dollars)} spent ${bundle.horizon_label} across ${bundle.transaction_count} transaction(s).${topStr}${cmpStr}`
  }
  if (promptId === 'net_worth_change') {
    if (bundle.no_data) return 'No net worth snapshots recorded yet.'
    const dirWord = bundle.change_dollars >= 0 ? 'up' : 'down'
    // horizon_label already reads "since the earliest snapshot we have
    // (YYYY-MM-DD)" when truncated, so no extra logic needed.
    return `Net worth is ${fmt(bundle.latest_net_worth_dollars)}, ${dirWord} ${fmt(Math.abs(bundle.change_dollars))} ${bundle.horizon_label}.`
  }
  if (promptId === 'upcoming_bills') {
    if (bundle.no_data) {
      // Make the scope explicit so the user understands why a payment
      // they know is coming (Apple Card, etc.) isn't listed.
      return `No mortgage or credit-card bills with structured Plaid due-date data are scheduled ${bundle.horizon_label}. Manual liabilities like Apple Card or student loans aren't tracked here.`
    }
    return `${bundle.bill_count} bill(s) totaling ${fmt(bundle.total_due_dollars)} due ${bundle.horizon_label} (mortgage + credit cards only — manual liabilities aren't included).`
  }
  if (promptId === 'portfolio_status') {
    if (bundle.no_data) return 'No portfolio holdings recorded yet.'
    const gl = bundle.unrealized_gain_loss_dollars
    const glPct = bundle.unrealized_gain_loss_percent
    const glStr = gl != null
      ? ` Unrealized gain/loss on the invested portion: ${fmt(gl)}${glPct != null ? ` (${glPct}%)` : ''}.`
      : ''
    let cmpStr = ''
    if (bundle.comparison && !bundle.comparison.unavailable) {
      const c = bundle.comparison
      const dir = c.change_dollars >= 0 ? 'up' : 'down'
      cmpStr = ` Total assets ${dir} ${fmt(Math.abs(c.change_dollars))} since ${c.baseline_date} (proxy — includes more than just investments).`
    }
    return `Portfolio value is ${fmt(bundle.total_portfolio_value_dollars)}.${glStr}${cmpStr}`
  }
  if (promptId === 'overspending') {
    if (bundle.no_data && bundle.reason) return bundle.reason
    if (bundle.nothing_to_flag) {
      return `All ${bundle.budget_categories_count} budget categories are on track for ${bundle.horizon_label} (day ${bundle.days_into_month} of ${bundle.days_in_month}). Nothing over budget; nothing at 80%+ of cap.`
    }
    const worst = bundle.categories_over_budget?.[0]
    const overStr = worst ? ` Worst: ${worst.category} is over by ${fmt(worst.over_dollars)} (${worst.percent_used}% of limit).` : ''
    const nearStr = bundle.categories_near_cap_count > 0
      ? ` ${bundle.categories_near_cap_count} other category(ies) at 80%+ of cap.`
      : ''
    return `${bundle.categories_over_count} category(ies) over budget this month — total over: ${fmt(bundle.total_over_dollars)}.${overStr}${nearStr}`
  }
  if (promptId === 'top_merchants') {
    if (bundle.no_data) return `No spending ${bundle.horizon_label}.`
    const t = bundle.top_merchants?.[0]
    const t2 = bundle.top_merchants?.[1]
    const tail = t2 ? ` Next: ${t2.merchant} (${fmt(t2.total_dollars)}).` : ''
    const share = t.share_of_total_pct != null ? ` (${t.share_of_total_pct}% of total)` : ''
    return `Top merchant ${bundle.horizon_label}: ${t.merchant} at ${fmt(t.total_dollars)}${share} across ${t.transaction_count} txns.${tail}`
  }
  if (promptId === 'income_total') {
    if (bundle.no_data) return `No deposits hit your bank accounts ${bundle.horizon_label}.`
    return `${fmt(bundle.total_income_dollars)} in deposits ${bundle.horizon_label} across ${bundle.deposit_count} txns. Note: bank-visible only — pre-tax 401(k) deferrals aren't included.`
  }
  if (promptId === 'stale_accounts') {
    if (bundle.no_data) return `All ${bundle.total_accounts} accounts are up to date.`
    const worst = bundle.stale_accounts?.[0]
    const worstStr = worst ? ` Worst: ${worst.account} (${worst.reason}).` : ''
    return `${bundle.stale_count} of ${bundle.total_accounts} accounts are overdue.${worstStr}`
  }
  if (promptId === 'savings_rate') {
    if (bundle.no_data) return 'No bank-visible income in the trailing 90 days, so a savings rate can\'t be computed.'
    const r = bundle.visible_savings_rate_percent
    return `Your bank-visible savings rate is ${r}% over the trailing 90 days (avg monthly inflow ${fmt(bundle.monthly_inflow_dollars)} − outflow ${fmt(bundle.monthly_outflow_dollars)}). Pre-tax 401(k) deferrals would push the true rate higher.`
  }
  return 'Answer ready (see the data below).'
}


// ─── Floating Ask button + panel container ─────────────────────────────

export default function AskPanel() {
  const [open, setOpen] = useState(false)
  const [view, setView] = useState('list')   // 'list' | 'chat'
  const [active, setActive] = useState(null) // {prompt, horizon}

  // Catalog is fetched once per mount when the panel first opens.
  // Keeping it lazy means we don't pay for the network call until the
  // user actually engages with the feature.
  const [catalog, setCatalog] = useState(null)
  const [catalogError, setCatalogError] = useState(null)

  const fetchCatalogIfNeeded = useCallback(() => {
    if (catalog || catalogError) return
    getChatPrompts()
      .then((data) => setCatalog(data?.prompts || []))
      .catch((err) => setCatalogError(String(err.message || err)))
  }, [catalog, catalogError])

  // ESC closes the panel, even from the chat view. Mounted only when
  // the panel is open so we don't pay for a global listener at idle.
  useEffect(() => {
    if (!open) return
    const onKey = (e) => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  const openPanel = () => {
    setOpen(true)
    setView('list')
    fetchCatalogIfNeeded()
  }

  const closePanel = () => {
    setOpen(false)
    // Don't reset view here — the slide-out animation looks better if
    // contents stay put until off-screen. They'll reset on next open
    // implicitly via setView('list').
  }

  const handlePick = (prompt, horizon) => {
    setActive({ prompt, horizon })
    setView('chat')
  }

  const goBack = () => {
    setView('list')
    setActive(null)
  }

  return (
    <>
      <FloatingAskButton onClick={openPanel} hidden={open} />
      <PanelOverlay open={open} onClose={closePanel}>
        {view === 'list' ? (
          <PromptListView
            catalog={catalog}
            error={catalogError}
            onPick={handlePick}
            onClose={closePanel}
          />
        ) : (
          <ChatView active={active} onBack={goBack} onClose={closePanel} />
        )}
      </PanelOverlay>
    </>
  )
}


// ─── Floating action button (bottom-right corner) ──────────────────────
//
// Sits at the bottom edge; the QuickAddFab is bumped up to live above
// it (see QuickActions.jsx — its bottom value moved from 24 to 92 to
// make room). Right-aligned to match. Hidden while the panel is open so
// the panel's own header is the only target.
//
// Icon-only circle (matches QuickAddFab's silhouette) so the stacked
// pair occupies a narrow 44px right-edge gutter instead of the older
// 80-wide pill.
//
// Cursor-proximity behavior — `useNearCorner` returns true only when
// the mouse is within ~180px of the bottom-right corner. Outside that
// zone the button is rendered at 25% opacity AND with
// `pointer-events: none`, so it visually recedes and, critically,
// stops capturing clicks on the right-aligned page controls beneath
// it (Apply/Delete on Rules rows, etc.). Move the cursor near the
// corner and the button fades back in and becomes clickable. This is
// the actual fix for the "can't hit button without making the browser
// larger" bug — the previous padding-based attempt forced horizontal
// page overflow on narrow viewports.
function FloatingAskButton({ onClick, hidden }) {
  const active = useNearCorner()
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="Ask a question about your finances"
      title="Ask"
      style={{
        position: 'fixed',
        right: 24,
        bottom: 24,                     // bottom edge; FAB is stacked above
        zIndex: 950,                    // below modals (1000+) but above tiles
        display: hidden ? 'none' : 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 52,
        height: 52,
        padding: 0,
        color: '#fff',
        background: 'var(--accent-purple, #7c6cf0)',
        border: 'none',
        borderRadius: '50%',
        boxShadow: '0 6px 20px rgba(124, 108, 240, 0.35)',
        cursor: 'pointer',
        opacity: active ? 1 : 0.25,
        pointerEvents: active ? 'auto' : 'none',
        transition: 'opacity 150ms ease, transform 120ms ease, box-shadow 120ms ease',
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.transform = 'translateY(-1px)'
        e.currentTarget.style.boxShadow = '0 10px 24px rgba(124, 108, 240, 0.45)'
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.transform = 'translateY(0)'
        e.currentTarget.style.boxShadow = '0 6px 20px rgba(124, 108, 240, 0.35)'
      }}
    >
      <Sparkles size={22} />
    </button>
  )
}

// Shared proximity hook — true when the cursor is inside the tight
// rectangle that hugs the stacked floating-button cluster (Ask at
// bottom:24 right:24, QuickAddFab at bottom:92 right:24, both 52px or
// less wide). Outside the cluster zone the buttons run at 25% opacity
// with `pointer-events: none`, so right-aligned page controls beneath
// them (Apply/Delete on Rules rows, table action columns elsewhere)
// receive clicks normally. Zone is intentionally tight — wider zones
// activated the cluster whenever the cursor was anywhere in the
// bottom-right quadrant and re-introduced the original bug.
//
// Touch fallback: pointermove never fires on touch-only devices, so a
// 2-second timer flips `active` to true so the buttons stay reachable
// on tablets/phones (the mobile CSS already provides bottom clearance
// — proximity exists for desktop pointer use).
export function useNearCorner() {
  const [active, setActive] = useState(false)
  useEffect(() => {
    let touchFallback = setTimeout(() => setActive(true), 2000)
    const onMove = (e) => {
      clearTimeout(touchFallback)
      const w = window.innerWidth
      const h = window.innerHeight
      // 80×180 hot zone at bottom-right. Wide enough to cover the
      // 52px button + small approach buffer, but narrow enough to
      // exclude the Apply/Delete column on Rules etc.
      const near = e.clientX > w - 80 && e.clientY > h - 180
      setActive(near)
    }
    window.addEventListener('pointermove', onMove)
    return () => {
      clearTimeout(touchFallback)
      window.removeEventListener('pointermove', onMove)
    }
  }, [])
  return active
}


// ─── Slide-in panel + dimmer ───────────────────────────────────────────

function PanelOverlay({ open, onClose, children }) {
  // CSS transitions handle the slide; mounting the dimmer + panel
  // unconditionally lets the transition run on first open AND close.
  // pointer-events flips with `open` so the dimmer doesn't block clicks
  // when the panel is closed.
  return (
    <>
      <div
        onClick={onClose}
        style={{
          position: 'fixed',
          inset: 0,
          background: 'rgba(0, 0, 0, 0.4)',
          opacity: open ? 1 : 0,
          pointerEvents: open ? 'auto' : 'none',
          transition: 'opacity 200ms ease',
          zIndex: 980,
        }}
      />
      <aside
        role="dialog"
        aria-label="Ask panel"
        aria-hidden={!open}
        style={{
          position: 'fixed',
          top: 0,
          right: 0,
          height: '100vh',
          width: 'min(420px, 100vw)',
          background: 'var(--bg-primary, #1a1a23)',
          borderLeft: '1px solid var(--border-soft, #2a2a35)',
          boxShadow: '-12px 0 32px rgba(0, 0, 0, 0.35)',
          transform: open ? 'translateX(0)' : 'translateX(100%)',
          transition: 'transform 250ms cubic-bezier(0.22, 0.61, 0.36, 1)',
          zIndex: 990,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        {children}
      </aside>
    </>
  )
}


// ─── List view: header + prompt chips with horizon selectors ───────────

function PromptListView({ catalog, error, onPick, onClose }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <PanelHeader title="Ask" subtitle="Pick a question" onClose={onClose} />
      <div style={{ overflowY: 'auto', padding: '8px 16px 16px', flex: 1 }}>
        {error && (
          <div style={{
            margin: '12px 0',
            padding: '10px 12px',
            border: '1px solid rgba(251, 146, 60, 0.3)',
            background: 'rgba(251, 146, 60, 0.06)',
            borderRadius: 8,
            color: 'var(--text-secondary, #c0c0d0)',
            fontSize: 12,
          }}>
            Couldn't load questions: {error}
          </div>
        )}
        {!catalog && !error && <PromptListSkeleton />}
        {catalog && catalog.length === 0 && (
          <div style={{ color: 'var(--text-muted, #8a8a9a)', fontSize: 13, padding: '24px 0' }}>
            No questions configured.
          </div>
        )}
        {catalog && catalog.map((p) => (
          <PromptCard key={p.id} prompt={p} onPick={(h) => onPick(p, h)} />
        ))}
        <p style={{
          marginTop: 20,
          fontSize: 11,
          color: 'var(--text-dim, #6a6a7a)',
          lineHeight: 1.5,
        }}>
          Numbers are computed locally from your data, then a local LLM
          writes the answer. Your data never leaves the machine.
        </p>
      </div>
    </div>
  )
}

function PromptCard({ prompt, onPick }) {
  // The first horizon is selected by default — clicking the question
  // body fires that one. Clicking a different horizon chip below the
  // question fires that one instead. Two-tap minimum is a worse UX.
  const [selected, setSelected] = useState(prompt.horizons[0]?.id || '')

  const fire = (horizonId) => {
    const h = prompt.horizons.find((x) => x.id === horizonId) || prompt.horizons[0]
    onPick(h?.id || horizonId)
  }

  return (
    <div style={{
      marginBottom: 10,
      padding: '12px 14px',
      border: '1px solid var(--border-soft, #2a2a35)',
      borderRadius: 10,
      background: 'var(--bg-elevated, #20202b)',
    }}>
      <button
        type="button"
        onClick={() => fire(selected)}
        style={{
          display: 'block',
          width: '100%',
          textAlign: 'left',
          background: 'transparent',
          border: 'none',
          padding: 0,
          cursor: 'pointer',
          color: 'var(--text-primary, #ececf5)',
          fontSize: 14,
          fontWeight: 500,
          lineHeight: 1.4,
        }}
        title="Ask this question"
      >
        {prompt.label}
      </button>
      {prompt.description && (
        <div style={{
          marginTop: 4,
          fontSize: 12,
          color: 'var(--text-muted, #8a8a9a)',
          lineHeight: 1.4,
        }}>
          {prompt.description}
        </div>
      )}
      <div style={{
        marginTop: 10,
        display: 'flex',
        flexWrap: 'wrap',
        gap: 6,
      }}>
        {prompt.horizons.map((h) => {
          const isSel = h.id === selected
          return (
            <button
              key={h.id}
              type="button"
              onClick={() => {
                setSelected(h.id)
                fire(h.id)
              }}
              style={{
                padding: '4px 10px',
                fontSize: 11,
                fontWeight: 500,
                color: isSel ? '#fff' : 'var(--text-secondary, #c0c0d0)',
                background: isSel ? 'var(--accent-purple, #7c6cf0)' : 'transparent',
                border: `1px solid ${isSel ? 'var(--accent-purple, #7c6cf0)' : 'var(--border-soft, #2a2a35)'}`,
                borderRadius: 999,
                cursor: 'pointer',
                transition: 'background 120ms ease, color 120ms ease',
              }}
            >
              {h.label}
            </button>
          )
        })}
      </div>
    </div>
  )
}

function PromptListSkeleton() {
  return (
    <div>
      {[0, 1, 2, 3].map((i) => (
        <div key={i} style={{
          marginBottom: 10,
          height: 84,
          borderRadius: 10,
          background: 'var(--border-soft, #2a2a35)',
          opacity: 0.4,
        }} />
      ))}
    </div>
  )
}


// ─── Chat view: question + answer + back link ──────────────────────────

function ChatView({ active, onBack, onClose }) {
  // Streaming state machine. Status transitions:
  //   loading  → first chunk arrives → ready (with isStreaming=true)
  //   ready    → done frame arrives  → ready (isStreaming=false)
  //   loading  → error frame         → error
  // The `isStreaming` flag drives the blinking cursor in AssistantMessage
  // and tells the panel "more text is coming, don't show retry button yet."
  const [state, setState] = useState({ status: 'loading' })
  const cancelRef = useRef(null)

  const run = useCallback(() => {
    if (!active) return
    // Abort any in-flight stream from a prior question so retries don't
    // interleave two answers in the same paragraph.
    if (cancelRef.current) cancelRef.current()
    setState({ status: 'loading' })
    let metaSnapshot = null
    let accumulated = ''
    cancelRef.current = streamChatAnswer(
      { promptId: active.prompt.id, horizon: active.horizon },
      {
        onMeta: (meta) => { metaSnapshot = meta },
        onDelta: (chunk) => {
          accumulated += chunk
          setState({
            status: 'ready',
            answer: accumulated,
            source: metaSnapshot?.source,
            model: metaSnapshot?.model,
            generatedAt: metaSnapshot?.generated_at,
            bundle: metaSnapshot?.bundle,
            isStreaming: true,
          })
        },
        onDone: () => {
          // Special case for LLM disabled / demo with empty delta — we
          // never set status to 'ready' through onDelta, so do it here
          // with whatever metadata we got.
          setState((prev) => prev.status === 'ready'
            ? { ...prev, isStreaming: false }
            : {
                status: 'ready',
                answer: accumulated,
                source: metaSnapshot?.source,
                model: metaSnapshot?.model,
                generatedAt: metaSnapshot?.generated_at,
                bundle: metaSnapshot?.bundle,
                isStreaming: false,
              })
          cancelRef.current = null
        },
        onError: (detail) => {
          setState({ status: 'error', detail })
          cancelRef.current = null
        },
      }
    )
  }, [active])

  useEffect(() => {
    run()
    // Aborts the stream if the user navigates away or picks a different
    // prompt before the current answer finishes.
    return () => { if (cancelRef.current) cancelRef.current() }
  }, [run])

  if (!active) return null

  const horizonLabel = active.prompt.horizons.find((h) => h.id === active.horizon)?.label
    || active.horizon
  const questionText = `${active.prompt.label} — ${horizonLabel}`

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <PanelHeader
        title="Ask"
        subtitle={null}
        onClose={onClose}
        leftSlot={
          <button
            type="button"
            onClick={onBack}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
              padding: '4px 8px',
              fontSize: 12,
              color: 'var(--text-muted, #8a8a9a)',
              background: 'transparent',
              border: '1px solid var(--border-soft, #2a2a35)',
              borderRadius: 6,
              cursor: 'pointer',
            }}
            title="Back to questions"
          >
            <ArrowLeft size={12} />
            Questions
          </button>
        }
      />
      <div style={{ overflowY: 'auto', padding: '12px 16px 16px', flex: 1 }}>
        <UserMessage text={questionText} />
        <AssistantMessage state={state} onRetry={run} promptId={active.prompt.id} />
      </div>
    </div>
  )
}

function UserMessage({ text }) {
  return (
    <div style={{
      marginBottom: 16,
      padding: '10px 12px',
      background: 'var(--bg-elevated, #20202b)',
      border: '1px solid var(--border-soft, #2a2a35)',
      borderRadius: 10,
      color: 'var(--text-primary, #ececf5)',
      fontSize: 13,
      lineHeight: 1.45,
    }}>
      {text}
    </div>
  )
}

function AssistantMessage({ state, onRetry, promptId }) {
  if (state.status === 'loading') {
    return (
      <div style={{
        padding: '12px 14px',
        background: 'rgba(124, 108, 240, 0.06)',
        border: '1px solid rgba(124, 108, 240, 0.25)',
        borderRadius: 10,
        color: 'var(--text-secondary, #c0c0d0)',
        fontSize: 13,
        display: 'flex',
        alignItems: 'center',
        gap: 8,
      }}>
        <RefreshCw size={14} style={{ animation: 'spin 1s linear infinite' }} />
        <span>Thinking…</span>
        <style>{`@keyframes spin { from { transform: rotate(0); } to { transform: rotate(360deg); } }`}</style>
        {state.previous?.answer && (
          <div style={{
            marginTop: 8,
            opacity: 0.5,
            fontSize: 12,
            fontStyle: 'italic',
          }}>
            (refreshing previous answer)
          </div>
        )}
      </div>
    )
  }

  if (state.status === 'error') {
    return (
      <div style={{
        padding: '12px 14px',
        background: 'rgba(251, 146, 60, 0.06)',
        border: '1px solid rgba(251, 146, 60, 0.3)',
        borderRadius: 10,
        color: 'var(--text-secondary, #c0c0d0)',
        fontSize: 13,
        lineHeight: 1.45,
      }}>
        <div style={{
          display: 'flex',
          alignItems: 'flex-start',
          gap: 8,
          marginBottom: 8,
        }}>
          <AlertTriangle size={16} style={{ color: 'var(--accent-orange, #fb923c)', flexShrink: 0, marginTop: 2 }} />
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 500, color: 'var(--text-primary, #ececf5)', marginBottom: 4 }}>
              Couldn't get an answer
            </div>
            {state.detail}
          </div>
        </div>
        <button
          type="button"
          onClick={onRetry}
          style={{
            padding: '4px 10px',
            fontSize: 11,
            fontWeight: 600,
            color: 'var(--text-secondary, #c0c0d0)',
            background: 'transparent',
            border: '1px solid var(--border-soft, #2a2a35)',
            borderRadius: 6,
            cursor: 'pointer',
          }}
        >
          Try again
        </button>
      </div>
    )
  }

  // ready
  const isDisabled = state.source === 'disabled'
  // When LLM is off, synthesize a one-liner from the bundle so the
  // panel still answers the question.
  const text = isDisabled
    ? fallbackAnswerFromBundle(promptId, state.bundle)
    : state.answer

  const paragraphs = (text || '').split(/\n\n+/).filter(Boolean)
  const provenance = isDisabled
    ? 'computed locally · LLM disabled'
    : state.source === 'demo'
      ? 'demo data'
      : `local · ${state.model || 'ollama'}`

  return (
    <div style={{
      padding: '12px 14px',
      background: 'rgba(175, 169, 236, 0.04)',
      border: '1px solid rgba(175, 169, 236, 0.3)',
      borderRadius: 10,
    }}>
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        marginBottom: 8,
        fontSize: 10,
        letterSpacing: 1.2,
        textTransform: 'uppercase',
        fontWeight: 600,
        color: 'var(--accent-purple, #7c6cf0)',
      }}>
        <Sparkles size={12} />
        <span>Answer</span>
        <span style={{
          color: 'var(--text-dim, #6a6a7a)',
          fontWeight: 400,
          letterSpacing: 0.4,
          textTransform: 'none',
          fontSize: 11,
          marginLeft: 4,
        }}>
          · {provenance}
        </span>
      </div>
      {paragraphs.map((p, i) => (
        <p key={i} style={{
          margin: 0,
          marginBottom: i < paragraphs.length - 1 ? 8 : 0,
          fontSize: 14,
          lineHeight: 1.55,
          color: 'var(--text-secondary, #c0c0d0)',
        }}>
          {p}
          {/* Blinking caret on the last paragraph while a stream is
              still in flight — visual signal that more text is coming.
              Same pattern as AINarrative.jsx. */}
          {state.isStreaming && i === paragraphs.length - 1 && (
            <span aria-hidden="true" style={{
              display: 'inline-block',
              width: 7, height: 14,
              marginLeft: 2,
              background: 'var(--accent-purple, #7c6cf0)',
              animation: 'ask-blink 1s step-end infinite',
              verticalAlign: 'text-bottom',
            }} />
          )}
        </p>
      ))}
      {/* Trust-but-verify: an expandable raw-numbers block. The model
          only restates these, but power users may want to see the
          underlying bundle. Hidden while still streaming so it doesn't
          flash open with a partial bundle (it shouldn't — bundle is in
          the meta frame — but defensive). */}
      {state.bundle && !state.isStreaming && <BundleDisclosure bundle={state.bundle} />}
      <style>{`
        @keyframes ask-blink {
          0%, 50%   { opacity: 1; }
          50.01%, 100% { opacity: 0; }
        }
      `}</style>
    </div>
  )
}

function BundleDisclosure({ bundle }) {
  const [openDetail, setOpenDetail] = useState(false)
  return (
    <div style={{ marginTop: 10, paddingTop: 8, borderTop: '1px dashed var(--border-soft, #2a2a35)' }}>
      <button
        type="button"
        onClick={() => setOpenDetail((v) => !v)}
        style={{
          padding: '2px 0',
          background: 'transparent',
          border: 'none',
          color: 'var(--text-dim, #6a6a7a)',
          fontSize: 11,
          cursor: 'pointer',
        }}
      >
        {openDetail ? '▾ Hide raw numbers' : '▸ Show raw numbers'}
      </button>
      {openDetail && (
        <pre style={{
          marginTop: 6,
          padding: '8px 10px',
          background: 'var(--bg-elevated, #20202b)',
          border: '1px solid var(--border-soft, #2a2a35)',
          borderRadius: 6,
          fontSize: 11,
          lineHeight: 1.4,
          color: 'var(--text-muted, #8a8a9a)',
          maxHeight: 280,
          overflow: 'auto',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
        }}>
{JSON.stringify(bundle, null, 2)}
        </pre>
      )}
    </div>
  )
}


// ─── Shared header ────────────────────────────────────────────────────

function PanelHeader({ title, subtitle, onClose, leftSlot }) {
  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: 10,
      padding: '14px 16px 12px',
      borderBottom: '1px solid var(--border-soft, #2a2a35)',
    }}>
      {leftSlot}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          fontSize: 12,
          letterSpacing: 1.2,
          textTransform: 'uppercase',
          fontWeight: 600,
          color: 'var(--accent-purple, #7c6cf0)',
        }}>
          <Sparkles size={12} />
          {title}
        </div>
        {subtitle && (
          <div style={{
            marginTop: 2,
            fontSize: 12,
            color: 'var(--text-muted, #8a8a9a)',
          }}>
            {subtitle}
          </div>
        )}
      </div>
      <button
        type="button"
        onClick={onClose}
        aria-label="Close ask panel"
        title="Close"
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 28,
          height: 28,
          padding: 0,
          color: 'var(--text-muted, #8a8a9a)',
          background: 'transparent',
          border: '1px solid var(--border-soft, #2a2a35)',
          borderRadius: 6,
          cursor: 'pointer',
        }}
      >
        <X size={14} />
      </button>
    </div>
  )
}
