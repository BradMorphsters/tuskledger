import { useState, useEffect } from 'react'
import { Upload, Loader2, CheckCircle, AlertCircle } from 'lucide-react'
import { importCsv } from '../api/client'
import { useAccounts } from '../hooks/useAccounts'

/**
 * CSV Import Panel — drag-and-drop file upload for bulk transaction imports.
 * Supports LMCU, Chase, and generic 3-column formats.
 * Auto-deduplicates by (account_id, date, amount, merchant).
 */
export default function CSVImportPanel() {
  const { accounts, loading } = useAccounts()
  const [selectedAccountId, setSelectedAccountId] = useState('')
  const [dragActive, setDragActive] = useState(false)
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState(null)
  const [error, setError] = useState(null)

  // Auto-select the first account once accounts load.
  useEffect(() => {
    if (!selectedAccountId && accounts.length > 0) {
      setSelectedAccountId(accounts[0].id.toString())
    }
  }, [accounts, selectedAccountId])

  const handleDrag = (e) => {
    e.preventDefault()
    e.stopPropagation()
    if (e.type === 'dragenter' || e.type === 'dragover') {
      setDragActive(true)
    } else if (e.type === 'dragleave') {
      setDragActive(false)
    }
  }

  const handleDrop = (e) => {
    e.preventDefault()
    e.stopPropagation()
    setDragActive(false)

    const files = e.dataTransfer?.files
    if (files && files.length > 0) {
      processFile(files[0])
    }
  }

  const handleFileSelect = (e) => {
    const files = e.target.files
    if (files && files.length > 0) {
      processFile(files[0])
    }
  }

  const processFile = async (file) => {
    if (!selectedAccountId) {
      setError('Please select an account first')
      return
    }

    setError(null)
    setResult(null)
    setRunning(true)

    try {
      const res = await importCsv(parseInt(selectedAccountId), file)
      setResult(res)
    } catch (e) {
      setError(e.message || 'Import failed')
    } finally {
      setRunning(false)
    }
  }

  if (loading) {
    return <div style={{ color: 'var(--text-muted)' }}>Loading accounts…</div>
  }

  return (
    <div className="card" style={{ marginBottom: 24 }}>
      <div className="card-header">
        <span className="card-title" style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          <Upload size={16} style={{ color: 'var(--accent-blue)' }} />
          Import CSV transactions
        </span>
        <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
          LMCU, Chase, or generic format
        </span>
      </div>

      <div style={{
        background: 'rgba(96, 165, 250, 0.06)',
        border: '1px solid rgba(96, 165, 250, 0.2)',
        borderRadius: 8,
        padding: '10px 12px',
        marginBottom: 16,
        display: 'flex',
        alignItems: 'flex-start',
        gap: 10,
        fontSize: 13,
        color: 'var(--text-secondary)',
      }}>
        <AlertCircle size={14} style={{ color: 'var(--accent-blue)', flexShrink: 0, marginTop: 2 }} />
        <div>
          Upload a CSV file with your transactions. Supported formats: LMCU (Date, Description, Amount, Balance),
          Chase (Transaction Date, Description, Amount), or generic (Date, Description, Amount).
          Duplicates are skipped automatically.
        </div>
      </div>

      <div style={{ marginBottom: 12 }}>
        <label style={{ fontSize: 'var(--text-xs)', color: 'var(--text-secondary)', marginBottom: 6, display: 'block' }}>
          Select account
        </label>
        <select
          value={selectedAccountId}
          onChange={e => setSelectedAccountId(e.target.value)}
          disabled={running}
          style={{
            width: '100%',
            padding: '8px 12px',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-sm)',
            background: 'var(--bg-input)',
            color: 'var(--text-primary)',
            fontSize: 'var(--text-base)',
            boxSizing: 'border-box',
          }}
        >
          <option value="">— Select account —</option>
          {accounts.map(a => (
            <option key={a.id} value={a.id}>
              {a.custom_name || a.name} ({a.type})
            </option>
          ))}
        </select>
      </div>

      {/* Drag-drop zone */}
      <div
        onDragEnter={handleDrag}
        onDragLeave={handleDrag}
        onDragOver={handleDrag}
        onDrop={handleDrop}
        style={{
          border: '2px dashed',
          borderColor: dragActive ? 'var(--accent-blue)' : 'var(--border)',
          borderRadius: 8,
          padding: 32,
          textAlign: 'center',
          background: dragActive ? 'rgba(96, 165, 250, 0.08)' : 'transparent',
          transition: 'all 0.2s',
          cursor: running ? 'default' : 'pointer',
          opacity: running ? 0.6 : 1,
        }}
      >
        <input
          type="file"
          accept=".csv,.txt"
          onChange={handleFileSelect}
          disabled={running}
          id="csv-file-input"
          style={{ display: 'none' }}
        />
        <label htmlFor="csv-file-input" style={{ cursor: running ? 'default' : 'pointer', display: 'block' }}>
          <Upload size={32} style={{ color: 'var(--accent-blue)', margin: '0 auto 12px' }} />
          <div style={{ fontWeight: 500, marginBottom: 4 }}>
            {running ? 'Uploading…' : 'Drop CSV file here or click to select'}
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
            or click to browse
          </div>
        </label>
      </div>

      {/* Errors */}
      {error && (
        <div style={{
          marginTop: 12,
          padding: '10px 12px',
          background: 'rgba(248, 113, 113, 0.08)',
          border: '1px solid rgba(248, 113, 113, 0.3)',
          borderRadius: 8,
          fontSize: 13,
          display: 'flex',
          alignItems: 'flex-start',
          gap: 8,
          color: 'var(--accent-red)',
        }}>
          <AlertCircle size={14} style={{ flexShrink: 0, marginTop: 2 }} />
          {error}
        </div>
      )}

      {/* Results */}
      {result && (
        <div style={{ marginTop: 16 }}>
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            marginBottom: 12,
            fontSize: 14,
            color: result.inserted > 0 ? 'var(--accent-green)' : 'var(--text-secondary)',
          }}>
            <CheckCircle size={14} />
            {result.inserted > 0
              ? `Imported ${result.inserted} transaction${result.inserted !== 1 ? 's' : ''} · Format detected: ${result.format_detected.toUpperCase()}`
              : `Checked ${result.parsed} rows · ${result.skipped_existing} already imported`}
          </div>

          <div className="table-wrapper">
            <table style={{ fontSize: 12 }}>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Merchant</th>
                  <th style={{ textAlign: 'right' }}>Amount</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {(result.rows || []).map((row, i) => (
                  <tr key={i}>
                    <td style={{ fontVariantNumeric: 'tabular-nums' }}>{row.date}</td>
                    <td style={{ maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {row.merchant}
                    </td>
                    <td style={{
                      textAlign: 'right',
                      fontVariantNumeric: 'tabular-nums',
                    }}>
                      {typeof row.amount === 'number' ? row.amount.toFixed(2) : '—'}
                    </td>
                    <td>
                      <span style={{
                        display: 'inline-block',
                        padding: '2px 8px',
                        borderRadius: 12,
                        fontSize: 11,
                        fontWeight: 500,
                        background: row.status === 'inserted'
                          ? 'rgba(52,211,153,0.12)'
                          : 'rgba(156,163,175,0.12)',
                        color: row.status === 'inserted'
                          ? 'var(--accent-green)'
                          : 'var(--text-muted)',
                        whiteSpace: 'nowrap',
                      }}>
                        {row.status === 'inserted' ? 'Imported' : 'Skipped'}
                        {row.reason ? ` · ${row.reason}` : ''}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}
