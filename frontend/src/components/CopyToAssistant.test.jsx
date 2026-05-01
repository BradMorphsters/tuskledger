/**
 * Tests for CopyToAssistant.
 *
 * Most of the meaningful logic is in `buildPrompt` (pure function), so
 * those get the heaviest coverage. The React component itself is mostly
 * a clipboard call and a state flip — small smoke tests cover that.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import CopyToAssistant, { buildPrompt } from './CopyToAssistant'

describe('buildPrompt', () => {
  it('always includes the project header and the AGENTS.md hint', () => {
    const out = buildPrompt({ title: 'X' })
    expect(out).toContain('Tusk Ledger')
    expect(out).toContain('AGENTS.md')
    expect(out).toContain('https://github.com/BradMorphsters/tuskledger')
  })

  it('includes the title verbatim in the situation line', () => {
    const out = buildPrompt({ title: 'Plaid Link will not open on production' })
    expect(out).toContain('Plaid Link will not open on production')
  })

  it('renders the error inside a code fence when present', () => {
    const out = buildPrompt({ title: 'X', error: 'INVALID_LINK_CUSTOMIZATION' })
    expect(out).toMatch(/```\nINVALID_LINK_CUSTOMIZATION\n```/)
  })

  it('truncates extremely long error blobs to keep the prompt manageable', () => {
    const huge = 'x'.repeat(10_000)
    const out = buildPrompt({ title: 'X', error: huge })
    // Should be truncated to <= 4000 chars of error content
    const fenceMatch = out.match(/```\n([\s\S]*?)\n```/)
    expect(fenceMatch).toBeTruthy()
    expect(fenceMatch[1].length).toBeLessThanOrEqual(4000)
  })

  it('renders the user action and location when given', () => {
    const out = buildPrompt({
      title: 'Sync failed',
      location: 'Accounts page',
      userAction: 'clicked Sync Now',
    })
    expect(out).toContain('Where: Accounts page')
    expect(out).toContain('What I was doing: clicked Sync Now')
  })

  it('renders state context as a list of key/value lines', () => {
    const out = buildPrompt({
      title: 'X',
      context: { plaidEnv: 'production', accountsConnected: 0 },
    })
    expect(out).toContain('plaidEnv: production')
    expect(out).toContain('accountsConnected: 0')
  })

  it('serializes nested object values as JSON', () => {
    const out = buildPrompt({
      title: 'X',
      context: { lastError: { code: 'X', detail: 'Y' } },
    })
    expect(out).toContain('lastError: {"code":"X","detail":"Y"}')
  })

  it('redacts keys that look like secrets, even if a caller passes them', () => {
    const out = buildPrompt({
      title: 'X',
      context: {
        plaidEnv: 'production',
        access_token: 'secret-blob',
        api_key: 'another-secret',
        SESSION_SECRET: 'x',
        password: 'p',
      },
    })
    expect(out).toContain('plaidEnv: production')
    expect(out).not.toContain('secret-blob')
    expect(out).not.toContain('access_token')
    expect(out).not.toContain('api_key')
    expect(out).not.toContain('SESSION_SECRET')
    expect(out).not.toContain('password')
  })

  it('skips empty / null / undefined context values', () => {
    const out = buildPrompt({
      title: 'X',
      context: { populated: 'yes', nothing: null, blank: '', missing: undefined },
    })
    expect(out).toContain('populated: yes')
    expect(out).not.toContain('nothing:')
    expect(out).not.toContain('blank:')
    expect(out).not.toContain('missing:')
  })

  it('always includes the safety boundaries the assistant should respect', () => {
    const out = buildPrompt({ title: 'X' })
    // Don't sending data outside the machine
    expect(out).toMatch(/don't .*outside my machine/i)
    // Don't disable auth bypass
    expect(out).toContain('DEV_BYPASS_AUTH')
    // Don't touch the encryption key
    expect(out).toContain('encryption_key')
  })
})

describe('<CopyToAssistant />', () => {
  beforeEach(() => {
    // Stub the clipboard API since jsdom doesn't ship one
    Object.assign(navigator, {
      clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
    })
  })

  it('renders a button with the default label', () => {
    render(<CopyToAssistant title="Test situation" />)
    expect(screen.getByRole('button')).toHaveAccessibleName(
      /copy diagnostic for my assistant/i
    )
  })

  it('writes the built prompt to the clipboard on click', async () => {
    render(
      <CopyToAssistant
        title="Plaid sync failed"
        error="ITEM_LOGIN_REQUIRED"
        location="Accounts"
      />
    )
    fireEvent.click(screen.getByRole('button'))
    expect(navigator.clipboard.writeText).toHaveBeenCalledTimes(1)
    const written = navigator.clipboard.writeText.mock.calls[0][0]
    expect(written).toContain('Plaid sync failed')
    expect(written).toContain('ITEM_LOGIN_REQUIRED')
    expect(written).toContain('Accounts')
  })

  it('flips its label to confirm after a successful copy', async () => {
    render(<CopyToAssistant title="X" />)
    const btn = screen.getByRole('button')
    fireEvent.click(btn)
    // The label updates after the await — wait a tick
    await Promise.resolve()
    await Promise.resolve()
    expect(btn.textContent).toMatch(/copied/i)
  })

  it('fires the optional onCopy callback with the built prompt', async () => {
    const onCopy = vi.fn()
    render(<CopyToAssistant title="X" onCopy={onCopy} />)
    fireEvent.click(screen.getByRole('button'))
    await Promise.resolve()
    await Promise.resolve()
    expect(onCopy).toHaveBeenCalledTimes(1)
    expect(onCopy.mock.calls[0][0]).toContain('Tusk Ledger')
  })
})
