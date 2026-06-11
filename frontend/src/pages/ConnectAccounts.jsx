import { useState, useEffect, useCallback } from 'react'
import { usePlaidLink } from 'react-plaid-link'
import { Link2, CheckCircle, AlertCircle, Pencil, Check, X, ChevronDown, ChevronRight, Home, FileEdit, Plus } from 'lucide-react'
import { Link as RouterLink } from 'react-router-dom'
import Pill from '../components/Pill'
import BackfillPanel from '../components/BackfillPanel'
import CSVImportPanel from '../components/CSVImportPanel'
import { useToast } from '../components/Toast'
import {
  getLinkToken, exchangeToken, getPlaidItems, triggerSync,
  updateAccount, getMortgageDetail, getCreditCardDetail, getManualAssets,
  createManualAccount,
} from '../api/client'
import { formatCurrency, formatCurrencyZero } from '../lib/format'
import { useAccounts } from '../hooks/useAccounts'

export default function ConnectAccounts() {
  const [linkToken, setLinkToken] = useState(null)
  const [items, setItems] = useState([])
  const { accounts, refresh: refreshAccounts } = useAccounts()
  const [manualAssets, setManualAssets] = useState([])
  const [status, setStatus] = useState(null) // null | 'connecting' | 'success' | 'error'
  const [error, setError] = useState('')
  const [addingAccount, setAddingAccount] = useState(false)
  const { toast } = useToast()

  useEffect(() => {
    getLinkToken().then(res => setLinkToken(res.link_token)).catch(() => {})
    loadData()
  }, [])

  const loadData = () => {
    getPlaidItems().then(setItems).catch(() => {})
    refreshAccounts()
    getManualAssets().then(setManualAssets).catch(() => setManualAssets([]))
  }

  // Manual entries unified into one shape so the new section's table can
  // render Account rows (Apple Card, 401(k)) and ManualAsset rows (home,
  // auto loan) side-by-side. `kind` is the human-readable category;
  // `side` is "asset" or "liability" for the badge column.
  const manualEntries = (() => {
    const fromAccounts = accounts
      .filter(a => a.is_manual)  // derived flag attached by /api/accounts
      .map(a => ({
        key: `acct-${a.id}`,
        name: a.custom_name || a.name,
        kind: a.subtype ? `${a.type} · ${a.subtype}` : a.type,
        // Credit / loan balances are owed amounts → liability side.
        side: (a.type === 'credit' || a.type === 'loan') ? 'liability' : 'asset',
        institution: a.institution_name || '—',
        value: a.current_balance,
        as_of: a.balance_as_of || null,
        notes: null,
      }))
    const fromAssets = manualAssets.map(m => ({
      key: `asset-${m.id}`,
      name: m.name,
      kind: m.type ? m.type.replace(/_/g, ' ') : 'manual entry',
      side: m.side,
      institution: m.address_city ? `${m.address_city}${m.address_region ? ', ' + m.address_region : ''}` : '—',
      value: m.current_value,
      as_of: m.value_as_of || null,
      notes: m.notes || null,
    }))
    // Liabilities below assets, then alphabetical inside each group.
    return [...fromAssets, ...fromAccounts].sort((a, b) => {
      if (a.side !== b.side) return a.side === 'asset' ? -1 : 1
      return (a.name || '').localeCompare(b.name || '')
    })
  })()

  const onSuccess = useCallback(async (publicToken, metadata) => {
    setStatus('connecting')
    try {
      await exchangeToken({
        public_token: publicToken,
        institution_id: metadata.institution?.institution_id,
        institution_name: metadata.institution?.name,
      })
      setStatus('success')
      loadData()
    } catch (e) {
      setStatus('error')
      setError(e.message)
    }
  }, [])

  const { open, ready } = usePlaidLink({
    token: linkToken,
    onSuccess,
    onExit: () => {},
  })

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">Connected Accounts</h1>
      </div>

      {/* Connect button */}
      <div className="card" style={{ marginBottom: 24, textAlign: 'center', padding: 40 }}>
        <Link2 size={40} style={{ color: 'var(--accent-blue)', marginBottom: 16 }} />
        <h3 style={{ marginBottom: 8 }}>Connect a Financial Institution</h3>
        <p style={{ color: 'var(--text-secondary)', marginBottom: 20, maxWidth: 400, margin: '0 auto 20px' }}>
          Securely link your bank accounts, credit cards, and investments through Plaid.
          Your credentials are never stored locally.
        </p>
        <button
          className="btn btn-primary"
          onClick={() => open()}
          disabled={!ready || !linkToken}
        >
          <Link2 size={16} />
          {!linkToken ? 'Configure Plaid API keys first' : 'Connect Account'}
        </button>

        {status === 'connecting' && <p style={{ marginTop: 12, color: 'var(--accent-blue)' }}>Connecting and syncing...</p>}
        {status === 'success' && (
          <p style={{ marginTop: 12, color: 'var(--accent-green)', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
            <CheckCircle size={16} /> Account connected successfully!
          </p>
        )}
        {status === 'error' && (
          <p style={{ marginTop: 12, color: 'var(--accent-red)', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
            <AlertCircle size={16} /> {error}
          </p>
        )}
      </div>

      {/* One-off historical backfill. Only meaningful once at least one
          institution is connected — Plaid endpoints obviously have nothing
          to query against until then. */}
      {items.length > 0 && <CSVImportPanel />}
      {items.length > 0 && <BackfillPanel items={items} />}

      {/* Connected institutions — accounts are grouped by Plaid item id, not by
          institution name (multiple items can exist for the same institution
          when each Plaid Link covers a different subset of accounts). */}
      {items.length > 0 && (
        <div className="card" style={{ marginBottom: 24 }}>
          <div className="card-header">
            <span className="card-title">Connected Institutions ({items.length})</span>
          </div>
          <div className="table-wrapper">
            <table>
              <thead>
                <tr><th>Institution & accounts</th><th style={{ whiteSpace: 'nowrap' }}>Count</th><th>Connected</th></tr>
              </thead>
              <tbody>
                {items.map(item => {
                  const itemAccounts = accounts.filter(a => a.plaid_item_id === item.id)
                  return (
                    <tr key={item.id} style={{ verticalAlign: 'top' }}>
                      <td style={{ fontWeight: 500 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <CheckCircle size={14} style={{ color: 'var(--accent-green)' }} />
                          {item.institution_name || 'Unknown Institution'}
                        </div>
                        {itemAccounts.length > 0 && (
                          <ul style={{
                            listStyle: 'none', padding: 0, margin: '6px 0 0 22px',
                            fontWeight: 400, fontSize: 12, color: 'var(--text-secondary)',
                          }}>
                            {itemAccounts.map(a => (
                              <li key={a.id} style={{ padding: '4px 0' }}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                  <SyncHealthDot asOf={a.balance_as_of} />
                                  <span style={{ color: 'var(--text-primary)', fontWeight: 500 }}>
                                    {a.custom_name || a.name}
                                  </span>
                                  {a.custom_name && a.custom_name !== a.name && (
                                    <span style={{ color: 'var(--text-muted)' }}>· {a.name}</span>
                                  )}
                                  <span style={{ color: 'var(--text-muted)' }}>
                                    · {a.type}{a.subtype ? ` / ${a.subtype}` : ''}
                                  </span>
                                  {a.mask && <span style={{ color: 'var(--text-muted)' }}>· ••{a.mask}</span>}
                                </div>
                                <AccountNoteEditor accountId={a.id} />
                              </li>
                            ))}
                          </ul>
                        )}
                      </td>
                      <td style={{ whiteSpace: 'nowrap' }}>
                        {itemAccounts.length} account{itemAccounts.length !== 1 ? 's' : ''}
                      </td>
                      <td style={{ color: 'var(--text-secondary)', fontSize: 13, whiteSpace: 'nowrap' }}>
                        {new Date(item.created_at).toLocaleDateString()}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Manual entries — accounts + assets/liabilities not flowing through Plaid */}
      <div className="card" style={{ marginBottom: 24 }}>
        <div className="card-header">
          <span className="card-title" style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
            <FileEdit size={16} style={{ color: 'var(--text-muted)' }} />
            Manual Accounts ({manualEntries.length})
          </span>
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 12 }}>
            <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
              entered by hand · not synced
            </span>
            <button
              onClick={() => setAddingAccount(true)}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 4,
                padding: '5px 12px', fontSize: 12, fontWeight: 500,
                background: 'var(--accent-blue)', color: '#0d0e14',
                border: 'none', borderRadius: 4, cursor: 'pointer',
              }}
            >
              <Plus size={12} /> Add account
            </button>
          </div>
        </div>
        {manualEntries.length === 0 ? (
          <div style={{
            padding: 24, textAlign: 'center', color: 'var(--text-muted)', fontSize: 13,
          }}>
            No manual accounts yet. Add HSAs, 401(k)s, pensions, or any account
            that doesn't sync via Plaid.
          </div>
        ) : (<></>)}
      </div>
      {manualEntries.length > 0 && (
        <div className="card" style={{ marginBottom: 24, marginTop: -24, borderTop: 'none', borderTopLeftRadius: 0, borderTopRightRadius: 0 }}>
          <div style={{ display: 'none' }}>
            {/* placeholder to satisfy nested layout — actual table below */}
          </div>
          <div className="table-wrapper">
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Kind</th>
                  <th>Side</th>
                  <th>Institution / Location</th>
                  <th>As of</th>
                  <th style={{ textAlign: 'right' }}>Value</th>
                </tr>
              </thead>
              <tbody>
                {manualEntries.map(m => (
                  <tr key={m.key}>
                    <td style={{ fontWeight: 500 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <Pill tone="warning">MANUAL</Pill>
                        <span>{m.name}</span>
                      </div>
                      {m.notes && (
                        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
                          {m.notes}
                        </div>
                      )}
                    </td>
                    <td style={{ color: 'var(--text-secondary)', fontSize: 13, textTransform: 'capitalize' }}>
                      {m.kind}
                    </td>
                    <td>
                      <Pill tone={m.side === 'asset' ? 'success' : 'danger'}>
                        {m.side === 'asset' ? 'Asset' : 'Liability'}
                      </Pill>
                    </td>
                    <td style={{ color: 'var(--text-secondary)', fontSize: 13 }}>
                      {m.institution}
                    </td>
                    <td style={{ color: 'var(--text-secondary)', fontSize: 13 }}>
                      {m.as_of || '—'}
                    </td>
                    <td style={{
                      textAlign: 'right',
                      fontVariantNumeric: 'tabular-nums',
                      color: m.side === 'liability' ? 'var(--accent-red)' : undefined,
                    }}>
                      {formatCurrency(m.value)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={{ marginTop: 12, fontSize: 12, color: 'var(--text-muted)' }}>
            Add or edit manual entries on the <RouterLink to="/net-worth" style={{ color: 'var(--accent-blue)' }}>Net Worth page</RouterLink>.
          </div>
        </div>
      )}

      {/* Individual accounts with alias editor */}
      {accounts.length > 0 && (
        <div className="card" style={{ marginBottom: 24 }}>
          <div className="card-header">
            <span className="card-title">All Accounts ({accounts.length})</span>
            <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
              click ▸ on credit / loan rows for liability detail
            </span>
          </div>
          <div className="table-wrapper">
            <table>
              <thead>
                <tr>
                  <th>Display Name</th>
                  <th>Type</th>
                  <th>Tax Bucket</th>
                  <th>Institution</th>
                  <th>Mask</th>
                  <th style={{ textAlign: 'right' }}>Balance</th>
                </tr>
              </thead>
              <tbody>
                {accounts.map(a => (
                  <AccountRow key={a.id} account={a} onUpdated={loadData} />
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Setup instructions */}
      {!linkToken && (
        <div className="card" style={{ background: 'var(--accent-blue-bg)', borderColor: 'var(--accent-blue)' }}>
          <h3 style={{ marginBottom: 12 }}>Setup Required</h3>
          <p style={{ color: 'var(--text-secondary)', marginBottom: 12 }}>
            To connect your bank accounts, you need a free Plaid developer account:
          </p>
          <ol style={{ color: 'var(--text-secondary)', paddingLeft: 20, lineHeight: 2 }}>
            <li>Sign up at <strong>dashboard.plaid.com</strong></li>
            <li>Copy your Client ID and Secret from the Keys page</li>
            <li>Create a <code>.env</code> file in the <code>backend/</code> folder (use <code>.env.example</code> as a template)</li>
            <li>Restart the backend server</li>
          </ol>
        </div>
      )}

      {addingAccount && (
        <AddManualAccountModal
          onClose={() => setAddingAccount(false)}
          onSaved={() => {
            setAddingAccount(false)
            loadData()
            toast({ kind: 'success', message: 'Manual account added' })
          }}
        />
      )}
    </div>
  )
}


/**
 * AddManualAccountModal — form to create a non-Plaid account (HSA,
 * 401(k), 457, pension, etc.). Posts to /api/accounts/.
 */
function AddManualAccountModal({ onClose, onSaved }) {
  const [form, setForm] = useState({
    name: '',
    custom_name: '',
    type: 'investment',
    subtype: '',
    institution_name: '',
    current_balance: '',
    mask: '',
  })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)

  useEffect(() => {
    const handler = (e) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  const submit = async (e) => {
    e.preventDefault()
    setSaving(true); setError(null)
    try {
      await createManualAccount({
        name: form.name.trim(),
        custom_name: form.custom_name.trim() || null,
        type: form.type,
        subtype: form.subtype.trim() || null,
        institution_name: form.institution_name.trim() || null,
        current_balance: Number(form.current_balance) || 0,
        mask: form.mask.trim() || null,
      })
      onSaved?.()
    } catch (err) {
      setError(err.message || 'Failed to save')
      setSaving(false)
    }
  }

  return (
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: 20, zIndex: 100,
    }}>
      <div onClick={e => e.stopPropagation()} style={{
        background: 'var(--bg-card)', border: '1px solid var(--border)',
        borderRadius: 12, padding: 20, width: '100%', maxWidth: 520,
        boxShadow: 'var(--shadow-lg)',
      }}>
        <div style={{
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          marginBottom: 14,
        }}>
          <div style={{ fontSize: 16, fontWeight: 600 }}>Add manual account</div>
          <button onClick={onClose} style={{
            background: 'transparent', border: 'none', cursor: 'pointer',
            color: 'var(--text-muted)',
          }}><X size={18} /></button>
        </div>
        <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <ManualAcctField label="Account name (required)">
            <input type="text" required autoFocus
              placeholder="e.g. HSA, 457 Plan, Pension"
              value={form.name}
              onChange={e => setForm(p => ({ ...p, name: e.target.value }))}
              style={maInputStyle} />
          </ManualAcctField>
          <ManualAcctField label="Custom display name (optional)">
            <input type="text" placeholder="overrides the default name in tables"
              value={form.custom_name}
              onChange={e => setForm(p => ({ ...p, custom_name: e.target.value }))}
              style={maInputStyle} />
          </ManualAcctField>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <ManualAcctField label="Type">
              <select value={form.type}
                onChange={e => setForm(p => ({ ...p, type: e.target.value }))}
                style={maInputStyle}>
                <option value="depository">Depository (checking/savings)</option>
                <option value="investment">Investment (401k, IRA, HSA)</option>
                <option value="credit">Credit card</option>
                <option value="loan">Loan</option>
                <option value="other">Other</option>
              </select>
            </ManualAcctField>
            <ManualAcctField label="Subtype (optional)">
              <input type="text" placeholder="e.g. 401k, hsa, 457, roth"
                value={form.subtype}
                onChange={e => setForm(p => ({ ...p, subtype: e.target.value }))}
                style={maInputStyle} />
            </ManualAcctField>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 10 }}>
            <ManualAcctField label="Institution">
              <input type="text" placeholder="e.g. Voya, PlanMember, HealthEquity"
                value={form.institution_name}
                onChange={e => setForm(p => ({ ...p, institution_name: e.target.value }))}
                style={maInputStyle} />
            </ManualAcctField>
            <ManualAcctField label="Last 4 (optional)">
              <input type="text" maxLength={4} placeholder="1234"
                value={form.mask}
                onChange={e => setForm(p => ({ ...p, mask: e.target.value.replace(/\D/g, '') }))}
                style={maInputStyle} />
            </ManualAcctField>
          </div>
          <ManualAcctField label="Current balance">
            <input type="number" step="0.01" placeholder="0.00"
              value={form.current_balance}
              onChange={e => setForm(p => ({ ...p, current_balance: e.target.value }))}
              style={maInputStyle} />
          </ManualAcctField>
          {error && (
            <div style={{ color: 'var(--accent-red)', fontSize: 12 }}>{error}</div>
          )}
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 4 }}>
            <button type="button" onClick={onClose}
              style={{
                padding: '7px 16px', fontSize: 13,
                background: 'transparent', color: 'var(--text-secondary)',
                border: '1px solid var(--border)', borderRadius: 6, cursor: 'pointer',
              }}>Cancel</button>
            <button type="submit" disabled={saving || !form.name.trim()}
              style={{
                padding: '7px 16px', fontSize: 13, fontWeight: 600,
                background: 'var(--accent-blue)', color: '#0d0e14',
                border: 'none', borderRadius: 6, cursor: 'pointer',
                opacity: !form.name.trim() ? 0.5 : 1,
              }}>
              {saving ? 'Saving…' : 'Add account'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

function ManualAcctField({ label, children }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 }}>
      <span style={{
        fontSize: 11, color: 'var(--text-muted)',
        textTransform: 'uppercase', letterSpacing: 0.4,
      }}>{label}</span>
      {children}
    </label>
  )
}

const maInputStyle = {
  width: '100%', padding: '7px 10px', fontSize: 13,
  border: '1px solid var(--border)', borderRadius: 6,
  background: 'var(--bg-input)', color: 'var(--text-primary)',
  height: 36, boxSizing: 'border-box',
}


/**
 * SyncHealthDot — small colored dot indicating freshness of an account's
 * last balance update. Green = synced within 7 days, yellow = 7-30 days,
 * red = > 30 days or never. Tooltip on hover shows exact age. Lets the
 * user spot stale connections at a glance in the Accounts list.
 */
function SyncHealthDot({ asOf }) {
  let color = 'var(--text-muted)'
  let label = 'never synced'
  if (asOf) {
    const ageDays = Math.floor((Date.now() - new Date(asOf).getTime()) / 86400000)
    label = `${ageDays}d since last update`
    if (ageDays <= 7) color = 'var(--accent-green)'
    else if (ageDays <= 30) color = 'var(--accent-yellow)'
    else color = 'var(--accent-red)'
  }
  return (
    <span
      title={label}
      style={{
        display: 'inline-block', width: 8, height: 8,
        background: color, borderRadius: '50%', flexShrink: 0,
      }}
    />
  )
}


/**
 * AccountNoteEditor — tiny inline note attached to a Plaid account, persisted
 * to localStorage (no backend round trip needed for a personal-use string).
 * Collapsed default shows "+ add note" or the existing note as muted text;
 * clicking expands a textarea with Save / Clear / Cancel. Useful for
 * remembering things like "this is the joint emergency fund" or
 * "auto-pay for utilities comes from here" without polluting the alias.
 */
function AccountNoteEditor({ accountId }) {
  const storageKey = `tuskledger.accountNote.${accountId}`
  const [note, setNote] = useState(() => {
    try { return localStorage.getItem(storageKey) || '' } catch { return '' }
  })
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(note)

  const beginEdit = () => {
    setDraft(note)
    setEditing(true)
  }

  const save = () => {
    const trimmed = draft.trim()
    try {
      if (trimmed) localStorage.setItem(storageKey, trimmed)
      else localStorage.removeItem(storageKey)
    } catch {}
    setNote(trimmed)
    setEditing(false)
  }

  const cancel = () => {
    setDraft(note)
    setEditing(false)
  }

  const clear = () => {
    try { localStorage.removeItem(storageKey) } catch {}
    setNote('')
    setDraft('')
    setEditing(false)
  }

  if (editing) {
    return (
      <div style={{ marginTop: 4, marginLeft: 14, display: 'flex', alignItems: 'flex-start', gap: 6 }}>
        <textarea
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Escape') cancel()
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) save()
          }}
          autoFocus
          placeholder="e.g. joint emergency fund, auto-pay source…"
          rows={2}
          style={{
            flex: 1, fontSize: 11, padding: '4px 6px',
            border: '1px solid var(--border)', borderRadius: 4,
            background: 'var(--bg-input)', color: 'var(--text-primary)',
            fontFamily: 'inherit', resize: 'vertical', minHeight: 32,
          }}
        />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <button
            onClick={save}
            title="Save (⌘+Enter)"
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--accent-green)', padding: 2 }}
          >
            <Check size={13} />
          </button>
          <button
            onClick={cancel}
            title="Cancel (Esc)"
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-secondary)', padding: 2 }}
          >
            <X size={13} />
          </button>
          {note && (
            <button
              onClick={clear}
              title="Delete note"
              style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--accent-red)', padding: 2, fontSize: 10 }}
            >
              ×
            </button>
          )}
        </div>
      </div>
    )
  }

  if (!note) {
    return (
      <button
        onClick={beginEdit}
        style={{
          marginTop: 2, marginLeft: 14,
          background: 'none', border: 'none', cursor: 'pointer',
          color: 'var(--text-muted)', fontSize: 11, padding: 0,
          opacity: 0.6,
        }}
        title="Add a personal note for this account"
      >
        + add note
      </button>
    )
  }

  return (
    <div
      onClick={beginEdit}
      title="Click to edit"
      style={{
        marginTop: 2, marginLeft: 14,
        fontSize: 11, color: 'var(--text-secondary)',
        fontStyle: 'italic', cursor: 'pointer',
        whiteSpace: 'pre-wrap', wordBreak: 'break-word',
      }}
    >
      {note}
    </div>
  )
}


function AccountRow({ account, onUpdated }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(account.custom_name || '')
  const [saving, setSaving] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [detail, setDetail] = useState(null)
  const [detailError, setDetailError] = useState(null)
  const [detailLoading, setDetailLoading] = useState(false)

  const display = account.custom_name || account.name
  const hasLiabilityDetail = account.type === 'loan' || account.type === 'credit'
  // Manual accounts are flagged via the derived `is_manual` field that the
  // backend attaches during serialization. Show a pill so they're scannable
  // in the unified Accounts table without scrolling up to the dedicated section.
  const isManual = !!account.is_manual

  // Lazy-load mortgage / CC detail the first time the row is expanded.
  const toggleExpanded = async () => {
    if (expanded) { setExpanded(false); return }
    setExpanded(true)
    if (detail || detailError || !hasLiabilityDetail) return
    setDetailLoading(true)
    try {
      if (account.type === 'loan') setDetail(await getMortgageDetail(account.id))
      else if (account.type === 'credit') setDetail(await getCreditCardDetail(account.id))
    } catch (e) {
      setDetailError(e.status === 404
        ? 'No detail data yet — sync once after the next link to populate.'
        : (e.message || 'Failed to load detail'))
    } finally {
      setDetailLoading(false)
    }
  }

  const save = async () => {
    setSaving(true)
    try {
      await updateAccount(account.id, { custom_name: draft })
      setEditing(false)
      onUpdated && onUpdated()
    } catch (e) {
      // leave editing state so user can retry / adjust
      console.error('Rename failed:', e)
    } finally {
      setSaving(false)
    }
  }

  const cancel = () => {
    setDraft(account.custom_name || '')
    setEditing(false)
  }

  const formattedBalance = formatCurrencyZero(account.current_balance, account.currency || 'USD')

  return (
    <>
      <tr>
        <td style={{ fontWeight: 500 }}>
          {editing ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <input
                type="text"
                value={draft}
                onChange={e => setDraft(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') save()
                  if (e.key === 'Escape') cancel()
                }}
                placeholder={account.name}
                autoFocus
                disabled={saving}
                style={{
                  flex: 1,
                  padding: '4px 8px',
                  fontSize: 13,
                  border: '1px solid var(--border-color, #ccc)',
                  borderRadius: 4,
                  background: 'var(--bg-input, white)',
                  color: 'inherit',
                }}
              />
              <button
                onClick={save}
                disabled={saving}
                title="Save"
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--accent-green)', padding: 4 }}
              >
                <Check size={16} />
              </button>
              <button
                onClick={cancel}
                disabled={saving}
                title="Cancel"
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-secondary)', padding: 4 }}
              >
                <X size={16} />
              </button>
            </div>
          ) : (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              {hasLiabilityDetail && (
                <button
                  onClick={toggleExpanded}
                  title={expanded ? 'Collapse detail' : 'Show mortgage / credit-card detail'}
                  style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-secondary)', padding: 0 }}
                >
                  {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                </button>
              )}
              <span>{display}</span>
              {isManual && <Pill tone="warning" title="Manually entered — not synced from a Plaid connection">MANUAL</Pill>}
              {account.custom_name && (
                <span style={{ color: 'var(--text-secondary)', fontWeight: 400, fontSize: 12 }}>
                  ({account.name})
                </span>
              )}
              <button
                onClick={() => setEditing(true)}
                title="Rename"
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-secondary)', padding: 4, marginLeft: 4 }}
              >
                <Pencil size={13} />
              </button>
            </div>
          )}
        </td>
        <td style={{ color: 'var(--text-secondary)', fontSize: 13 }}>
          {account.type}{account.subtype ? ` · ${account.subtype}` : ''}
        </td>
        <td>
          {account.type === 'investment' ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <TaxBucketSelect
                account={account}
                onUpdated={onUpdated}
              />
              {/* Roth split — visible when the account holds pre-tax
                  dollars (tax_deferred) since that's where mixed plans
                  live (Roth 401(k) inside an otherwise pre-tax 401(k)). */}
              {account.tax_bucket === 'tax_deferred' && (
                <RothSplitInput
                  account={account}
                  onUpdated={onUpdated}
                />
              )}
            </div>
          ) : (
            <span style={{ color: 'var(--text-muted)', fontSize: 13 }}>—</span>
          )}
        </td>
        <td style={{ color: 'var(--text-secondary)', fontSize: 13 }}>
          {account.institution_name || '—'}
        </td>
        <td style={{ color: 'var(--text-secondary)', fontSize: 13 }}>
          {account.mask ? `••${account.mask}` : '—'}
        </td>
        <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
          {formattedBalance}
        </td>
      </tr>
      {expanded && (
        <tr>
          <td colSpan={5} style={{ background: 'var(--bg-hover, rgba(255,255,255,0.02))', padding: 16 }}>
            {detailLoading && <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>Loading detail…</div>}
            {detailError && <div style={{ color: 'var(--text-secondary)', fontSize: 13 }}>{detailError}</div>}
            {!detailLoading && !detailError && detail && account.type === 'loan' && (
              <MortgageDetailPanel detail={detail} accountId={account.id} />
            )}
            {!detailLoading && !detailError && detail && account.type === 'credit' && (
              <CreditCardDetailPanel detail={detail} />
            )}
          </td>
        </tr>
      )}
    </>
  )
}


function formatPercent(n) {
  if (n === null || n === undefined) return '—'
  return n.toFixed(3).replace(/\.?0+$/, '') + '%'
}

function MortgageDetailPanel({ detail, accountId }) {
  const [pairedAsset, setPairedAsset] = useState(null)

  // Check whether any manual asset is paired with this mortgage. Used to
  // toggle the "Track this property" CTA between "create" and "view".
  useEffect(() => {
    if (!accountId) return
    getManualAssets()
      .then(list => {
        const paired = list.find(a => a.plaid_mortgage_account_id === accountId)
        setPairedAsset(paired || null)
      })
      .catch(() => {})
  }, [accountId])

  const cell = (label, value) => (
    <div style={{ minWidth: 160 }}>
      <div style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.4 }}>{label}</div>
      <div style={{ fontSize: 14, marginTop: 2 }}>{value || '—'}</div>
    </div>
  )

  const property = [detail.property_street, detail.property_city, detail.property_region, detail.property_postal_code]
    .filter(Boolean).join(', ')

  return (
    <div>
      {/* Cross-link to Net Worth so the user can attach a home value to this mortgage. */}
      <div style={{
        marginBottom: 14, padding: '10px 12px',
        background: pairedAsset ? 'rgba(52,211,153,0.08)' : 'rgba(96,165,250,0.08)',
        border: `1px solid ${pairedAsset ? 'rgba(52,211,153,0.3)' : 'rgba(96,165,250,0.3)'}`,
        borderRadius: 8, fontSize: 13,
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Home size={14} />
          {pairedAsset ? (
            <span>
              Paired with <strong>{pairedAsset.name}</strong> · valued{' '}
              <strong>${(pairedAsset.current_value || 0).toLocaleString()}</strong> on {pairedAsset.value_as_of}
            </span>
          ) : (
            <span>This mortgage isn't paired with a home value yet — Net Worth will only see the liability side.</span>
          )}
        </div>
        <RouterLink
          to={`/net-worth?pair=${accountId}`}
          style={{ fontSize: 12, color: 'var(--accent-blue)', whiteSpace: 'nowrap' }}
        >
          {pairedAsset ? 'Edit value →' : 'Track property →'}
        </RouterLink>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: 16, fontSize: 13 }}>
      {cell('Rate', detail.interest_rate_percentage !== null ? `${formatPercent(detail.interest_rate_percentage)} ${detail.interest_rate_type || ''}`.trim() : null)}
      {cell('Loan term', detail.loan_term)}
      {cell('Loan type', detail.loan_type_description)}
      {cell('Original principal', formatCurrency(detail.origination_principal_amount))}
      {cell('Originated', detail.origination_date)}
      {cell('Maturity', detail.maturity_date)}
      {cell('Next payment', formatCurrency(detail.next_monthly_payment))}
      {cell('Due date', detail.next_payment_due_date)}
      {cell('Last payment', detail.last_payment_amount !== null ? `${formatCurrency(detail.last_payment_amount)} on ${detail.last_payment_date || '?'}` : null)}
      {cell('Past due', formatCurrency(detail.past_due_amount))}
      {cell('YTD interest', formatCurrency(detail.ytd_interest_paid))}
      {cell('YTD principal', formatCurrency(detail.ytd_principal_paid))}
      {cell('Escrow balance', formatCurrency(detail.escrow_balance))}
      {cell('PMI', detail.has_pmi === null || detail.has_pmi === undefined ? '—' : detail.has_pmi ? 'Yes' : 'No')}
      {cell('Prepayment penalty', detail.has_prepayment_penalty === null || detail.has_prepayment_penalty === undefined ? '—' : detail.has_prepayment_penalty ? 'Yes' : 'No')}
      {property && (
        <div style={{ gridColumn: '1 / -1' }}>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.4 }}>Property</div>
          <div style={{ fontSize: 14, marginTop: 2 }}>{property}</div>
        </div>
      )}
      </div>
    </div>
  )
}

function CreditCardDetailPanel({ detail }) {
  const cell = (label, value) => (
    <div style={{ minWidth: 160 }}>
      <div style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.4 }}>{label}</div>
      <div style={{ fontSize: 14, marginTop: 2 }}>{value || '—'}</div>
    </div>
  )

  const purchaseAPR = (detail.aprs || []).find(a => (a.apr_type || '').toLowerCase().includes('purchase'))

  return (
    <div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: 16, fontSize: 13 }}>
        {cell('Purchase APR', purchaseAPR ? formatPercent(purchaseAPR.apr_percentage) : '—')}
        {cell('Statement balance', formatCurrency(detail.last_statement_balance))}
        {cell('Statement issued', detail.last_statement_issue_date)}
        {cell('Minimum payment', formatCurrency(detail.minimum_payment_amount))}
        {cell('Due date', detail.next_payment_due_date)}
        {cell('Last payment', detail.last_payment_amount !== null ? `${formatCurrency(detail.last_payment_amount)} on ${detail.last_payment_date || '?'}` : null)}
        {cell('Overdue?', detail.is_overdue === null || detail.is_overdue === undefined ? '—' : detail.is_overdue ? 'Yes' : 'No')}
      </div>
      {detail.aprs && detail.aprs.length > 1 && (
        <div style={{ marginTop: 14 }}>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 6 }}>All APRs</div>
          <table style={{ fontSize: 12 }}>
            <thead>
              <tr><th style={{ textAlign: 'left', padding: '2px 12px 2px 0', color: 'var(--text-muted)' }}>Type</th><th style={{ textAlign: 'right', padding: '2px 12px 2px 0', color: 'var(--text-muted)' }}>APR</th><th style={{ textAlign: 'right', padding: '2px 12px 2px 0', color: 'var(--text-muted)' }}>Balance</th><th style={{ textAlign: 'right', color: 'var(--text-muted)' }}>Interest</th></tr>
            </thead>
            <tbody>
              {detail.aprs.map((a, i) => (
                <tr key={i}>
                  <td style={{ padding: '2px 12px 2px 0' }}>{a.apr_type || '—'}</td>
                  <td style={{ padding: '2px 12px 2px 0', textAlign: 'right' }}>{formatPercent(a.apr_percentage)}</td>
                  <td style={{ padding: '2px 12px 2px 0', textAlign: 'right' }}>{formatCurrency(a.balance_subject_to_apr)}</td>
                  <td style={{ textAlign: 'right' }}>{formatCurrency(a.interest_charge_amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}


function TaxBucketSelect({ account, onUpdated }) {
  const [saving, setSaving] = useState(false)

  const handleChange = async (e) => {
    const newValue = e.target.value || null
    setSaving(true)
    try {
      await updateAccount(account.id, { tax_bucket: newValue })
      onUpdated && onUpdated()
    } catch (error) {
      console.error('Failed to update tax bucket:', error)
    } finally {
      setSaving(false)
    }
  }

  return (
    <select
      value={account.tax_bucket || ''}
      onChange={handleChange}
      disabled={saving}
      style={{
        padding: '5px 8px',
        fontSize: 12,
        border: '1px solid var(--border-color, rgba(255,255,255,0.15))',
        borderRadius: 4,
        background: 'var(--bg-input, rgba(255,255,255,0.06))',
        color: 'inherit',
        cursor: saving ? 'not-allowed' : 'pointer',
        opacity: saving ? 0.6 : 1,
      }}
    >
      <option value="">— Unset</option>
      <option value="tax_deferred">Tax-deferred</option>
      <option value="roth">Roth</option>
      <option value="taxable">Taxable</option>
      {/* HSA — triple-tax-advantaged when spent on qualified medical.
          Retirement projection draws healthcare bridge + LTC from this
          bucket TAX-FREE before touching anything else. Choose this for
          dedicated HSA accounts (HealthEquity, Fidelity HSA, etc.). */}
      <option value="hsa">HSA (qualified medical)</option>
      {/* 'Excluded' is for investment accounts the user doesn't consider
          retirement money — e.g. balance is funded by a HELOC and
          earmarked to be paid back. Account stays visible everywhere
          else (Net Worth, etc.) but the retirement projection skips it. */}
      <option value="excluded">Excluded</option>
    </select>
  )
}


/**
 * Per-account Roth-split editor. Many 401(k) plans let participants
 * split contributions between traditional and Roth designations within
 * the same account, and Plaid only sees the total balance. This input
 * lets the user enter the Roth fraction (sourced from their plan
 * portal) so the retirement projection routes that share to the Roth
 * bucket and the rest to whatever the account's primary bucket is.
 *
 * Saves on blur — keeping immediate-keystroke autosave out so the user
 * can type "60.4" without intermediate updates firing at "6", "60.",
 * etc. Empty input clears the split (NULL).
 */
function RothSplitInput({ account, onUpdated }) {
  const initial = account.roth_split_pct == null
    ? ''
    : String(Math.round(account.roth_split_pct * 1000) / 10)
  const [value, setValue] = useState(initial)
  const [saving, setSaving] = useState(false)

  // Resync local state when the parent reloads accounts (e.g., after a
  // sibling field saves and the row re-renders).
  useEffect(() => {
    setValue(account.roth_split_pct == null
      ? ''
      : String(Math.round(account.roth_split_pct * 1000) / 10))
  }, [account.roth_split_pct])

  const persist = async () => {
    let payload
    if (value === '' || value == null) {
      payload = null
    } else {
      const pct = Number(value) / 100
      if (!Number.isFinite(pct) || pct < 0 || pct > 1) return
      payload = pct
    }
    if (payload === account.roth_split_pct) return
    setSaving(true)
    try {
      await updateAccount(account.id, { roth_split_pct: payload })
      onUpdated && onUpdated()
    } catch (err) {
      console.error('Failed to update roth_split_pct:', err)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 4,
        fontSize: 11,
        color: 'var(--text-muted)',
      }}
      title="Fraction of this account that's actually in Roth 401(k). Leave blank if the whole balance is pre-tax. Source: your plan portal's 'money source' breakdown (Merrill, Fidelity, Empower, etc. all show this)."
    >
      <span>Roth split:</span>
      <input
        type="number"
        min={0}
        max={100}
        step={0.1}
        placeholder="—"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={persist}
        onKeyDown={(e) => { if (e.key === 'Enter') e.target.blur() }}
        disabled={saving}
        style={{
          width: 50,
          padding: '2px 4px',
          fontSize: 11,
          border: '1px solid var(--border-color, rgba(255,255,255,0.15))',
          borderRadius: 4,
          background: 'var(--bg-input, rgba(255,255,255,0.06))',
          color: 'inherit',
          textAlign: 'right',
        }}
      />
      <span>%</span>
    </div>
  )
}
