import { useEffect, useState } from 'react'
import { X, TrendingUp } from 'lucide-react'
import { getMerchantDetails } from '../api/client'
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts'

/**
 * Slide-out drawer showing per-merchant drill-down:
 * - Total YTD, All-time total, Transaction count
 * - Monthly trend (last 12 months) as a bar chart
 * - Scrollable list of recent transactions
 *
 * Props:
 *   merchantName  string | null — merchant name to display, null closes drawer
 *   onClose()     called when user closes the drawer
 */
export default function MerchantDrawer({ merchantName, onClose }) {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!merchantName) {
      setData(null)
      return
    }

    setLoading(true)
    getMerchantDetails(merchantName)
      .then(result => {
        setData(result)
        setLoading(false)
      })
      .catch(e => {
        console.error('Failed to load merchant details:', e)
        setLoading(false)
      })
  }, [merchantName])

  const formatCurrency = (n) =>
    new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n || 0)

  if (!merchantName) return null

  return (
    <>
      {/* Overlay */}
      <div
        onClick={onClose}
        style={{
          position: 'fixed',
          inset: 0,
          background: 'rgba(0,0,0,0.45)',
          zIndex: 900,
        }}
      />
      {/* Drawer panel */}
      <aside
        role="dialog"
        aria-label={merchantName}
        style={{
          position: 'fixed',
          top: 0,
          right: 0,
          bottom: 0,
          width: 'min(680px, 100vw)',
          background: 'var(--bg-primary, #15171f)',
          borderLeft: '1px solid var(--border, #2a2d3a)',
          zIndex: 901,
          display: 'flex',
          flexDirection: 'column',
          boxShadow: '-12px 0 32px rgba(0,0,0,0.35)',
        }}
      >
        {/* Header */}
        <div
          style={{
            padding: '18px 22px',
            borderBottom: '1px solid var(--border, #2a2d3a)',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'flex-start',
            flexShrink: 0,
          }}
        >
          <div>
            <div style={{ fontSize: 18, fontWeight: 600 }}>{merchantName}</div>
            <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 2 }}>
              Merchant Activity
            </div>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            style={{
              background: 'none',
              border: 'none',
              color: 'var(--text-secondary)',
              cursor: 'pointer',
              padding: 4,
            }}
          >
            <X size={20} />
          </button>
        </div>

        {/* Loading state */}
        {loading ? (
          <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-muted)' }}>
            Loading merchant details…
          </div>
        ) : !data ? (
          <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-muted)' }}>
            No data available for this merchant.
          </div>
        ) : (
          <>
            {/* Stat tiles */}
            <div
              style={{
                padding: '14px 22px',
                borderBottom: '1px solid var(--border, #2a2d3a)',
                display: 'grid',
                gridTemplateColumns: 'repeat(3, 1fr)',
                gap: 12,
                fontSize: 12,
                color: 'var(--text-secondary)',
                flexShrink: 0,
              }}
            >
              <div>
                <div>YTD Total</div>
                <div style={{ fontSize: 16, fontWeight: 600, color: 'var(--text-primary)' }}>
                  {formatCurrency(data.total_ytd)}
                </div>
              </div>
              <div>
                <div>All-time Total</div>
                <div style={{ fontSize: 16, fontWeight: 600, color: 'var(--text-primary)' }}>
                  {formatCurrency(data.total_all_time)}
                </div>
              </div>
              <div>
                <div>Transactions</div>
                <div style={{ fontSize: 16, fontWeight: 600, color: 'var(--text-primary)' }}>
                  {data.transaction_count}
                </div>
              </div>
            </div>

            {/* Monthly trend chart */}
            {data.monthly_trend && data.monthly_trend.length > 0 && (
              <div
                style={{
                  padding: '16px 22px',
                  borderBottom: '1px solid var(--border, #2a2d3a)',
                  flexShrink: 0,
                }}
              >
                <div
                  style={{
                    fontSize: 12,
                    fontWeight: 500,
                    color: 'var(--text-secondary)',
                    marginBottom: 12,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                  }}
                >
                  <TrendingUp size={14} />
                  Monthly Trend (Last 12 Months)
                </div>
                <ResponsiveContainer width="100%" height={200}>
                  <BarChart data={data.monthly_trend}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border, #2a2d3a)" />
                    <XAxis
                      dataKey="month"
                      tick={{ fontSize: 10, fill: 'var(--text-secondary)' }}
                    />
                    <YAxis
                      tick={{ fontSize: 10, fill: 'var(--text-secondary)' }}
                    />
                    <Tooltip
                      contentStyle={{
                        background: 'var(--bg-secondary)',
                        border: '1px solid var(--border)',
                        borderRadius: 6,
                        color: 'var(--text-primary)',
                      }}
                      formatter={(value) => formatCurrency(value)}
                    />
                    <Bar dataKey="total" fill="var(--accent-blue)" />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}

            {/* Transaction list */}
            <div style={{ flex: 1, overflowY: 'auto', padding: '6px 0' }}>
              {data.transactions.length === 0 ? (
                <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-muted)' }}>
                  No transactions for this merchant.
                </div>
              ) : (
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <tbody>
                    {data.transactions.map((t) => (
                      <tr key={t.id} style={{ borderBottom: '1px solid var(--border, #2a2d3a)' }}>
                        <td
                          style={{
                            padding: '10px 18px',
                            whiteSpace: 'nowrap',
                            color: 'var(--text-secondary)',
                            fontSize: 12,
                          }}
                        >
                          {t.date}
                        </td>
                        <td
                          style={{
                            padding: '10px 12px',
                            fontSize: 13,
                            color: 'var(--text-primary)',
                          }}
                        >
                          {t.name}
                          {t.is_transfer && (
                            <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}>
                              Transfer
                            </div>
                          )}
                        </td>
                        <td
                          style={{
                            padding: '10px 18px',
                            textAlign: 'right',
                            whiteSpace: 'nowrap',
                            fontWeight: 500,
                          }}
                          className={t.amount > 0 ? 'amount-negative' : 'amount-positive'}
                        >
                          {t.amount > 0 ? '-' : '+'}
                          {formatCurrency(Math.abs(t.amount))}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </>
        )}
      </aside>
    </>
  )
}
