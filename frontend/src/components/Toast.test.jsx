/**
 * Render tests for the Toast notification system.
 *
 * Exercises the full provider → hook → component path so we have
 * confidence the React side of the test harness is wired correctly,
 * not just the pure-function side. Also pins down the headline UX
 * contracts: undo button shows when onUndo is supplied, dismiss
 * removes from the DOM, the stack caps at MAX_TOASTS.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ToastProvider, useToast } from './Toast'

// Helper component that exposes the toast() function via a button so
// we can trigger it from inside the React tree (the hook can't be
// called outside a component).
function Trigger({ opts, label = 'fire' }) {
  const { toast } = useToast()
  return <button onClick={() => toast(opts)}>{label}</button>
}

describe('ToastProvider + useToast', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('renders nothing initially (empty stack)', () => {
    render(
      <ToastProvider>
        <Trigger opts={{ message: 'never fired' }} />
      </ToastProvider>
    )
    // Only the Trigger button should be in the document.
    expect(screen.getByText('fire')).toBeInTheDocument()
    expect(screen.queryByText('never fired')).not.toBeInTheDocument()
  })

  it('shows a toast when triggered', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    render(
      <ToastProvider>
        <Trigger opts={{ message: 'Saved!', kind: 'success' }} />
      </ToastProvider>
    )
    await user.click(screen.getByText('fire'))
    expect(screen.getByText('Saved!')).toBeInTheDocument()
  })

  it('auto-dismisses after the timeout', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    render(
      <ToastProvider>
        <Trigger opts={{ message: 'transient', timeout: 1000 }} />
      </ToastProvider>
    )
    await user.click(screen.getByText('fire'))
    expect(screen.getByText('transient')).toBeInTheDocument()
    act(() => { vi.advanceTimersByTime(1500) })
    expect(screen.queryByText('transient')).not.toBeInTheDocument()
  })

  it('persists indefinitely when timeout is 0', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    render(
      <ToastProvider>
        <Trigger opts={{ message: 'sticky', timeout: 0 }} />
      </ToastProvider>
    )
    await user.click(screen.getByText('fire'))
    act(() => { vi.advanceTimersByTime(60_000) })
    expect(screen.getByText('sticky')).toBeInTheDocument()
  })

  it('renders an Undo button when onUndo is supplied', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    const onUndo = vi.fn()
    render(
      <ToastProvider>
        <Trigger opts={{
          message: 'Deleted',
          kind: 'undo',
          onUndo,
          timeout: 5000,
        }} />
      </ToastProvider>
    )
    await user.click(screen.getByText('fire'))
    expect(screen.getByText('Undo')).toBeInTheDocument()
  })

  it('calls onUndo and dismisses when Undo is clicked', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    const onUndo = vi.fn()
    render(
      <ToastProvider>
        <Trigger opts={{ message: 'Deleted', onUndo, timeout: 5000 }} />
      </ToastProvider>
    )
    await user.click(screen.getByText('fire'))
    await user.click(screen.getByText('Undo'))
    expect(onUndo).toHaveBeenCalledTimes(1)
    expect(screen.queryByText('Deleted')).not.toBeInTheDocument()
  })

  it('caps the stack at MAX_TOASTS (5)', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    render(
      <ToastProvider>
        <Trigger opts={{ message: 'msg', timeout: 0 }} />
      </ToastProvider>
    )
    // Fire 7 toasts in rapid succession; expect only the last 5 to
    // remain (oldest 2 should have been evicted).
    for (let i = 0; i < 7; i++) {
      await user.click(screen.getByText('fire'))
    }
    expect(screen.getAllByText('msg')).toHaveLength(5)
  })

  it('useToast returns no-op when used outside a provider (does not crash)', () => {
    // Guard against accidental use of useToast in a tree that hasn't
    // mounted ToastProvider — should be a silent no-op, not a thrown
    // error. Catch in production: a feature pages reaches for toast()
    // before App.jsx wraps it in ToastProvider during incremental rollout.
    function Caller() {
      const { toast, dismiss } = useToast()
      // Call both — they should be functions and they should not throw.
      toast({ message: 'noop' })
      dismiss(1)
      return <span>ok</span>
    }
    render(<Caller />)
    expect(screen.getByText('ok')).toBeInTheDocument()
  })
})
