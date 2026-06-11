import { useEffect, useState } from 'react'
import { PieChart } from 'lucide-react'
import { getInvestmentsSummary } from '../../api/client'
import { SkeletonCard } from '../Skeleton'
import { fmtMoney, tileCardStyle } from './shared'

/**
 * PortfolioSnapshot — at-a-glance view of total portfolio value, the
 * unrealized gain vs. cost basis, asset allocation, and the top
 * holdings by market value.
 *
 * Sized 'standard' (3 row units) in the dashboard tile system. The
 * layout is three stacked sections with `flex: 1` on the middle one
 * so the allocation block absorbs spare vertical space when the tile
 * is rendered at the upper end of the standard size.
 *
 * Hidden entirely if the user has no investment accounts (or the
 * total comes back as zero) — same pattern as HsaTracker. Avoids a
 * fake-empty card on a household that doesn't invest through tracked
 * accounts.
 */
const ALLOC_PALETTE = [
  'var(--accent-purple)', 'var(--accent-blue)', 'var(--accent-green)',
  'var(--accent-amber)', 'var(--accent-pink)', 'var(--accent-coral)',
]

export function PortfolioSnapshot() {
  const [summary, setSummary] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    getInvestmentsSummary()
      .then(setSummary)
      .catch(() => setSummary(null))
      .finally(() => setLoading(false))
  }, [])

  if (loading) return <SkeletonCard titleWidth="40%" rows={4} />
  // No investments → render nothing so the grid doesn't reserve a
  // dead cell. Mirrors HsaTracker's behavior.
  if (!summary || !summary.total_value || summary.total_value <= 0) return null

  const {
    total_value,
    total_gain_loss,
    total_gain_loss_pct,
    allocation = [],
    top_holdings = [],
  } = summary

  const hasGain = total_gain_loss != null && Number.isFinite(total_gain_loss)
  const gainPositive = hasGain && total_gain_loss >= 0
  const gainColor = gainPositive ? 'var(--accent-green)' : 'var(--accent-red)'

  // Take the top 4 allocation slices; lump the rest into "Other" so
  // the bar always sums to 100 % and the legend doesn't sprawl past
  // a few entries on accounts with long-tail security types.
  const visibleAlloc = allocation.slice(0, 4)
  const remainingPct = allocation.slice(4).reduce((s, a) => s + (a.pct || 0), 0)
  const allocSlices = remainingPct > 0
    ? [...visibleAlloc, { type: 'other', label: 'Other', pct: remainingPct, value: 0 }]
    : visibleAlloc

  return (
    <div className="card" style={tileCardStyle}>
      <div className="card-header">
        <span className="card-title" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <PieChart size={14} style={{ color: 'var(--accent-purple)' }} /> Portfolio
        </span>
        <a href="/investments" style={{ fontSize: 11, color: 'var(--accent-blue)' }}>
          Detail →
        </a>
      </div>

      {/* Headline: total value + unrealized P&L */}
      <div style={{ marginTop: 4 }}>
        <div style={{
          fontSize: 10, color: 'var(--text-muted)',
          textTransform: 'uppercase', letterSpacing: 0.4,
        }}>
          Total value
        </div>
        <div style={{
          fontSize: 24, fontWeight: 700, color: 'var(--text-primary)',
          fontVariantNumeric: 'tabular-nums', marginTop: 2,
        }}>
          {fmtMoney(total_value)}
        </div>
        {hasGain && (
          <div style={{
            fontSize: 12, color: gainColor, marginTop: 4,
            fontWeight: 600, fontVariantNumeric: 'tabular-nums',
          }}>
            {gainPositive ? '+' : ''}{fmtMoney(total_gain_loss)}
            {total_gain_loss_pct != null && (
              <> · {gainPositive ? '+' : ''}{total_gain_loss_pct.toFixed(1)}%</>
            )}
            <span style={{ color: 'var(--text-dim)', fontWeight: 400 }}>
              {' '}unrealized
            </span>
          </div>
        )}
      </div>

      {/* Allocation: stacked bar + small legend. flex: 1 absorbs the
          row's stretched height so the allocation block sits in the
          middle of the tile, top holdings pinned to the bottom. */}
      {allocSlices.length > 0 && (
        <div style={{ flex: 1, marginTop: 14, display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
          <div style={{
            fontSize: 10, color: 'var(--text-muted)',
            textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 6,
          }}>
            Allocation
          </div>
          <div style={{
            display: 'flex', height: 8, borderRadius: 4, overflow: 'hidden',
            background: 'var(--border-color, rgba(255,255,255,0.06))',
          }}>
            {allocSlices.map((slice, i) => (
              <div
                key={(slice.type || slice.label || '') + i}
                title={`${slice.label || slice.type}: ${slice.pct.toFixed(1)}%`}
                style={{
                  width: `${slice.pct}%`,
                  background: ALLOC_PALETTE[i % ALLOC_PALETTE.length],
                }}
              />
            ))}
          </div>
          <div style={{
            display: 'flex', flexWrap: 'wrap', gap: '4px 12px',
            marginTop: 8, fontSize: 11, color: 'var(--text-secondary)',
          }}>
            {allocSlices.map((slice, i) => (
              <span key={(slice.type || slice.label || '') + i}
                    style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                <span style={{
                  width: 8, height: 8, borderRadius: 2, flexShrink: 0,
                  background: ALLOC_PALETTE[i % ALLOC_PALETTE.length],
                }} />
                {slice.label || slice.type} {Math.round(slice.pct)}%
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Top holdings — pinned to bottom of the tile. Show up to 4
          (instead of the previous 2) so the tile carries enough
          content to balance the height of Pulse / HSA in the same
          row. Account count footer below as a one-line summary. */}
      {top_holdings.length > 0 && (
        <div style={{
          marginTop: 'auto', paddingTop: 10,
          borderTop: '1px solid var(--border)', fontSize: 11,
        }}>
          <div style={{
            fontSize: 10, color: 'var(--text-muted)',
            textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 6,
          }}>
            Top holdings
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
            {top_holdings.slice(0, 4).map((h, i) => (
              <div key={i} style={{
                display: 'flex', justifyContent: 'space-between', gap: 8,
              }}>
                <span style={{
                  color: 'var(--text-secondary)', fontWeight: 500,
                  whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                  flex: 1, minWidth: 0,
                }}>
                  {h.ticker || h.security_name || 'Unknown'}
                </span>
                <span style={{
                  color: 'var(--text-secondary)',
                  fontVariantNumeric: 'tabular-nums', flexShrink: 0,
                }}>
                  {fmtMoney(h.value)} · {h.pct_of_portfolio.toFixed(1)}%
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Account-count footer — small, dim. Adds a final line of
          context (how many accounts the totals roll up) and gives
          the tile one more vertical row of content so it sits
          comfortably alongside Pulse and HSA in the same grid row. */}
      {summary.accounts && summary.accounts.length > 0 && (
        <div style={{
          marginTop: 8, fontSize: 10,
          color: 'var(--text-dim)', textAlign: 'center',
        }}>
          Across {summary.accounts.length} account{summary.accounts.length === 1 ? '' : 's'}
          {summary.total_cash > 0 && ` · ${fmtMoney(summary.total_cash)} cash`}
        </div>
      )}
    </div>
  )
}
