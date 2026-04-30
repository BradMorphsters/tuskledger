/**
 * RetirementScenarios — save, load, and compare named retirement
 * projection scenarios. Each scenario is a snapshot of the form state
 * at a moment in time, persisted to localStorage so the user can A/B
 * test "what if I retire 2 years later" without losing the baseline.
 *
 * Stored in localStorage as JSON array under STORAGE_KEY:
 *   [{ id, name, savedAt, form: {...} }, ...]
 */
import { useState, useEffect } from 'react'
import { Save, FolderOpen, Trash2, Bookmark, X } from 'lucide-react'
import { useToast } from './Toast'

const STORAGE_KEY = 'tuskledger-retirement-scenarios'
const MAX_SCENARIOS = 10

function loadScenarios() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? JSON.parse(raw) : []
  } catch { return [] }
}
function saveScenarios(list) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(list)) } catch {}
}

/**
 * Toolbar component — save current state, list scenarios, load one,
 * delete. Renders as a compact row that fits in the projection card.
 *
 * Props:
 *   currentForm — the live form state (will be saved when user clicks Save)
 *   onLoad      — callback invoked with the saved form to restore it
 *   currentMetrics — optional { fi_age, end_balance, success_pct } for tile display
 */
export function ScenariosToolbar({ currentForm, onLoad, currentMetrics }) {
  const { toast } = useToast()
  const [scenarios, setScenarios] = useState(loadScenarios)
  const [showSave, setShowSave] = useState(false)
  const [newName, setNewName] = useState('')
  const [showList, setShowList] = useState(false)

  const persist = (list) => {
    setScenarios(list)
    saveScenarios(list)
  }

  const handleSave = () => {
    const name = newName.trim() || `Scenario ${scenarios.length + 1}`
    const entry = {
      id: Date.now(),
      name,
      savedAt: new Date().toISOString(),
      form: { ...currentForm },
      metrics: currentMetrics || null,
    }
    const next = [...scenarios, entry].slice(-MAX_SCENARIOS)
    persist(next)
    setShowSave(false)
    setNewName('')
    setShowList(true)
    toast({ kind: 'success', message: `Saved "${name}"` })
  }

  const handleLoad = (s) => {
    onLoad?.(s.form)
    setShowList(false)
    toast({ kind: 'info', message: `Loaded "${s.name}"` })
  }

  // Delete with undo. The 5-second toast lets the user restore the
  // scenario before it's gone for good. Mirrors gmail's "trash" pattern.
  const handleDelete = (id) => {
    const removed = scenarios.find(s => s.id === id)
    persist(scenarios.filter(s => s.id !== id))
    toast({
      kind: 'undo',
      message: `Deleted "${removed?.name}"`,
      timeout: 5000,
      onUndo: () => persist([...scenarios]),
    })
  }

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
      padding: '8px 12px', marginBottom: 16,
      background: 'var(--bg-elevated)',
      border: '1px dashed var(--border)',
      borderRadius: 8,
      fontSize: 12,
    }}>
      <Bookmark size={13} style={{ color: 'var(--accent-blue)' }} />
      <span style={{ color: 'var(--text-secondary)' }}>
        Scenarios: {scenarios.length} saved
      </span>
      <div style={{ flex: 1 }} />
      <button
        onClick={() => { setShowSave(true); setShowList(false) }}
        style={btnStyle}
      >
        <Save size={11} /> Save current
      </button>
      <button
        onClick={() => { setShowList(s => !s); setShowSave(false) }}
        disabled={scenarios.length === 0}
        style={{ ...btnStyle, opacity: scenarios.length === 0 ? 0.4 : 1 }}
      >
        <FolderOpen size={11} /> Load / compare
      </button>
      {showSave && (
        <div style={{
          width: '100%', display: 'flex', alignItems: 'center', gap: 8,
          paddingTop: 8, borderTop: '1px dashed var(--border)',
        }}>
          <input
            type="text"
            placeholder='e.g. "Retire at 58", "Bad market"'
            value={newName}
            onChange={e => setNewName(e.target.value)}
            autoFocus
            onKeyDown={e => { if (e.key === 'Enter') handleSave() }}
            style={inputStyle}
          />
          <button onClick={handleSave} style={btnPrimary}>Save</button>
          <button onClick={() => setShowSave(false)} style={btnStyle}>Cancel</button>
        </div>
      )}
      {showList && scenarios.length > 0 && (
        <div style={{
          width: '100%', paddingTop: 8,
          borderTop: '1px dashed var(--border)',
          display: 'flex', flexDirection: 'column', gap: 6,
        }}>
          {/* Comparison table */}
          <div style={{
            display: 'grid',
            gridTemplateColumns: '1fr 90px 90px 90px 70px',
            gap: 8, padding: '4px 0',
            fontSize: 10, color: 'var(--text-muted)',
            textTransform: 'uppercase', letterSpacing: 0.4,
          }}>
            <div>Scenario</div>
            <div style={{ textAlign: 'right' }}>FI age</div>
            <div style={{ textAlign: 'right' }}>End $</div>
            <div style={{ textAlign: 'right' }}>Success</div>
            <div></div>
          </div>
          {scenarios.slice().reverse().map(s => (
            <div key={s.id} style={{
              display: 'grid',
              gridTemplateColumns: '1fr 90px 90px 90px 70px',
              gap: 8, padding: '6px 0',
              alignItems: 'center', fontSize: 12,
              borderTop: '1px solid rgba(255,255,255,0.04)',
            }}>
              <div>
                <div style={{ color: 'var(--text-primary)', fontWeight: 500 }}>{s.name}</div>
                <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>
                  {new Date(s.savedAt).toLocaleString(undefined, {
                    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
                  })}
                </div>
              </div>
              <div style={{ textAlign: 'right', color: 'var(--text-secondary)', fontVariantNumeric: 'tabular-nums' }}>
                {s.metrics?.fi_age ?? '—'}
              </div>
              <div style={{ textAlign: 'right', color: 'var(--text-secondary)', fontVariantNumeric: 'tabular-nums' }}>
                {s.metrics?.end_balance != null
                  ? `$${(s.metrics.end_balance / 1000).toFixed(0)}k`
                  : '—'}
              </div>
              <div style={{ textAlign: 'right', color: 'var(--text-secondary)', fontVariantNumeric: 'tabular-nums' }}>
                {s.metrics?.success_pct != null ? `${s.metrics.success_pct}%` : '—'}
              </div>
              <div style={{ display: 'flex', gap: 4, justifyContent: 'flex-end' }}>
                <button onClick={() => handleLoad(s)} style={miniBtn} title="Load this scenario">
                  Load
                </button>
                <button onClick={() => handleDelete(s.id)}
                  style={{ ...miniBtn, color: 'var(--accent-red)' }}
                  title="Delete">
                  <X size={11} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

const btnStyle = {
  display: 'inline-flex', alignItems: 'center', gap: 4,
  padding: '4px 10px', fontSize: 11,
  background: 'transparent', color: 'var(--text-secondary)',
  border: '1px solid var(--border)', borderRadius: 4, cursor: 'pointer',
}
const btnPrimary = {
  ...btnStyle,
  background: 'var(--accent-blue)', color: '#0d0e14',
  borderColor: 'transparent', fontWeight: 600,
}
const miniBtn = {
  display: 'inline-flex', alignItems: 'center', gap: 2,
  padding: '2px 8px', fontSize: 10,
  background: 'transparent', color: 'var(--text-secondary)',
  border: '1px solid var(--border)', borderRadius: 3, cursor: 'pointer',
}
const inputStyle = {
  flex: 1, padding: '5px 10px', fontSize: 12,
  background: 'var(--bg-input)', color: 'var(--text-primary)',
  border: '1px solid var(--border)', borderRadius: 4,
}
