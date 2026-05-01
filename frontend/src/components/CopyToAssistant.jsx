/**
 * CopyToAssistant — one-click "build a perfect prompt for my AI assistant
 * and put it on my clipboard."
 *
 * The single biggest UX upgrade for the agent-assisted user persona:
 * when something breaks, the user no longer has to figure out what to
 * tell their assistant. They click this button, paste into Claude /
 * Cursor / Cowork, and their assistant has everything it needs to help.
 *
 * Usage:
 *   <CopyToAssistant
 *     title="Plaid Link won't open"
 *     context={{
 *       location: 'Connect Accounts → Plaid Link',
 *       userAction: 'Clicked Connect Account, modal closed immediately',
 *       error: 'INVALID_LINK_CUSTOMIZATION',
 *       state: { plaidEnv: 'production', accountsConnected: 0 },
 *     }}
 *   />
 *
 * Renders as a small chip-style button. On click:
 *   1. Builds a markdown prompt (see `buildPrompt` below)
 *   2. Writes to navigator.clipboard
 *   3. Shows a confirmation tooltip for 2 seconds
 *
 * Privacy: this component never sends data anywhere — it just copies
 * to the clipboard. The agent receives the data only when the user
 * actively pastes. The prompt explicitly tells the assistant not to
 * suggest sending anything outside the user's machine.
 */
import { useState } from 'react'
import { Sparkles, Check } from 'lucide-react'

/**
 * Build the markdown prompt the user will paste.
 * Kept as a pure function so it's testable and snapshot-friendly.
 *
 * @param {object} args
 * @param {string} args.title - One-line description of the situation
 * @param {object} [args.context] - Structured context. Keys are free-form;
 *   this function will format them as a "Recent state" block.
 * @param {string} [args.error] - The raw error message if any
 * @param {string} [args.location] - Where in the app this happened
 * @param {string} [args.userAction] - What the user was trying to do
 */
export function buildPrompt({ title, context = {}, error, location, userAction }) {
  const sections = [
    `I hit a problem in **Tusk Ledger** and I'd like your help debugging it.`,
    '',
    `**Situation:** ${title}`,
    '',
    `**Context**`,
  ]
  if (location) sections.push(`- Where: ${location}`)
  if (userAction) sections.push(`- What I was doing: ${userAction}`)
  sections.push(`- Repo: https://github.com/BradMorphsters/tuskledger`)
  sections.push(`- If you have repo access, read AGENTS.md first — it has the conventions and the known footguns.`)

  if (error) {
    sections.push('')
    sections.push(`**Error**`)
    sections.push('```')
    sections.push(error.toString().slice(0, 4000))
    sections.push('```')
  }

  // State block — only include non-empty / non-secret keys
  const safeKeys = Object.entries(context).filter(([k, v]) => {
    if (v === undefined || v === null || v === '') return false
    // Defense in depth: never include anything that smells like a secret.
    // The component contract says callers shouldn't pass these, but cheap
    // to enforce here too.
    const looksSecret = /(secret|token|password|key|cookie|session|access_token|api_key)/i.test(k)
    return !looksSecret
  })
  if (safeKeys.length > 0) {
    sections.push('')
    sections.push(`**Recent state**`)
    for (const [k, v] of safeKeys) {
      sections.push(`- ${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
    }
  }

  sections.push('')
  sections.push(`**What I want**`)
  sections.push(`1. Explain what this means in plain English`)
  sections.push(`2. Suggest the most likely fix`)
  sections.push(`3. If the fix involves running commands, list them — I'll run them in my terminal`)
  sections.push('')
  sections.push(`**What I don't want**`)
  sections.push(`- Don't suggest sending my data anywhere outside my machine`)
  sections.push(`- Don't disable auth (DEV_BYPASS_AUTH) without confirming with me first`)
  sections.push(`- Don't touch backend/.encryption_key — that file is paired with my SQLite DB`)

  return sections.join('\n')
}

const REDACTED_KEY_PATTERNS = [
  /(secret|token|password|key|cookie|session|access_token|api_key)/i,
]

/**
 * The component itself.
 */
export default function CopyToAssistant({
  title,
  context,
  error,
  location,
  userAction,
  size = 'small',  // 'small' | 'medium'
  variant = 'inline',  // 'inline' | 'block'
  label = 'Copy diagnostic for my assistant',
  onCopy,
}) {
  const [copied, setCopied] = useState(false)

  const handleClick = async () => {
    const prompt = buildPrompt({ title, context, error, location, userAction })
    try {
      await navigator.clipboard.writeText(prompt)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
      if (typeof onCopy === 'function') onCopy(prompt)
    } catch (e) {
      // Clipboard API may fail in non-secure contexts (e.g. http://) —
      // fall back to a textarea + select-all so the user can copy manually.
      // eslint-disable-next-line no-console
      console.warn('Clipboard write failed; falling back to textarea selection.', e)
      const ta = document.createElement('textarea')
      ta.value = prompt
      ta.style.position = 'fixed'
      ta.style.left = '-9999px'
      document.body.appendChild(ta)
      ta.select()
      try {
        document.execCommand('copy')
        setCopied(true)
        setTimeout(() => setCopied(false), 2000)
      } finally {
        document.body.removeChild(ta)
      }
    }
  }

  const padding = size === 'small' ? '6px 10px' : '8px 14px'
  const fontSize = size === 'small' ? 12 : 13
  const iconSize = size === 'small' ? 12 : 14
  const display = variant === 'block' ? 'flex' : 'inline-flex'

  return (
    <button
      type="button"
      onClick={handleClick}
      aria-label={label}
      title={label}
      style={{
        display,
        alignItems: 'center',
        gap: 6,
        padding,
        fontSize,
        fontWeight: 500,
        borderRadius: 8,
        border: '1px solid #2A2D3A',
        background: copied ? 'rgba(52, 211, 153, 0.12)' : 'rgba(175, 169, 236, 0.08)',
        color: copied ? '#34D399' : '#AFA9EC',
        cursor: 'pointer',
        transition: 'background 0.15s ease, color 0.15s ease, border-color 0.15s ease',
        whiteSpace: 'nowrap',
      }}
    >
      {copied ? (
        <>
          <Check size={iconSize} />
          Copied — paste into your assistant
        </>
      ) : (
        <>
          <Sparkles size={iconSize} />
          {label}
        </>
      )}
    </button>
  )
}

// Re-export helpers for direct use (callers building their own UIs).
export { REDACTED_KEY_PATTERNS }
