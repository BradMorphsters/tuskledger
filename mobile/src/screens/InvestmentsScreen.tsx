/**
 * Investments — portfolio hero, allocation bar, holdings list.
 *
 * Pure read of the local SQLite mirror. The rollup math — including
 * the LOAD-BEARING fold-in of investment-type accounts that report a
 * balance but no positions (HSAs, 457s, pensions) — lives untouched in
 * db/queries.ts (investmentsRollup). This screen only re-presents it.
 *
 * No day-change number: the mirror keeps current holdings only, not a
 * positions history, so there is nothing honest to compute it from.
 * The unrealized-gain chip carries the "how am I doing" signal instead.
 */
import { useEffect, useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Animated, { FadeInDown } from 'react-native-reanimated';
import Card from '../components/Card';
import Chip from '../components/Chip';
import MoneyText from '../components/MoneyText';
import SectionHeader from '../components/SectionHeader';
import Screen from '../components/Screen';
import SkeletonBlock from '../components/SkeletonBlock';
import {
  HoldingRow,
  InvestmentsRollup,
  investmentsRollup,
  listHoldings,
} from '../db/queries';
import { useSyncStore } from '../sync/manager';
import { colors, formatCurrency, formatDelta, layout, space, type } from '../theme';

// Segment palette for the allocation bar — brand gold first, then the
// semantic greens/blues. Distinct enough at 8px tall.
const SEGMENT_COLORS = [
  colors.accent,
  colors.income,
  colors.link,
  colors.warning,
  '#b48ce0', // soft violet — only used here, for a 5th asset class
  colors.expense,
  colors.textMuted,
];

interface Segment {
  label: string;
  value: number;
  color: string;
}

function typeLabel(t: string | null): string {
  switch ((t || '').toLowerCase()) {
    case 'equity': return 'Stocks';
    case 'etf': return 'ETFs';
    case 'mutual fund': return 'Funds';
    case 'fixed income': return 'Bonds';
    case 'cash': return 'Cash';
    case 'cryptocurrency': return 'Crypto';
    case 'derivative': return 'Options';
    case '': return 'Other';
    default:
      return (t as string).charAt(0).toUpperCase() + (t as string).slice(1);
  }
}

/**
 * Allocation by security type, plus one "Accounts" segment for the
 * balance-only investment accounts (rollup total minus holdings total)
 * so the bar always sums to the headline portfolio value.
 */
function buildSegments(holdings: HoldingRow[], rollup: InvestmentsRollup | null): Segment[] {
  const byType = new Map<string, number>();
  let holdingsTotal = 0;
  for (const h of holdings) {
    const label = typeLabel(h.type);
    byType.set(label, (byType.get(label) ?? 0) + h.value);
    holdingsTotal += h.value;
  }
  const entries = [...byType.entries()]
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1]);
  const accountsOnly = (rollup?.total_value ?? 0) - holdingsTotal;
  if (accountsOnly > 0.005) entries.push(['Accounts', accountsOnly]);
  return entries.map(([label, value], i) => ({
    label,
    value,
    color: SEGMENT_COLORS[i % SEGMENT_COLORS.length],
  }));
}

export default function InvestmentsScreen() {
  const dataVersion = useSyncStore((s) => s.dataVersion);
  const [holdings, setHoldings] = useState<HoldingRow[]>([]);
  const [rollup, setRollup] = useState<InvestmentsRollup | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [h, r] = await Promise.all([listHoldings(), investmentsRollup()]);
      if (cancelled) return;
      setHoldings(h);
      setRollup(r);
      setLoaded(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [dataVersion]);

  const segments = useMemo(
    () => buildSegments(holdings, rollup),
    [holdings, rollup],
  );
  const segTotal = segments.reduce((s, x) => s + x.value, 0);

  const gain = rollup && rollup.total_cost_basis > 0 ? rollup.total_gain : null;
  const gainPct =
    gain != null && rollup && rollup.total_cost_basis > 0
      ? (gain / rollup.total_cost_basis) * 100
      : null;

  return (
    <Screen title="Investments">
      {/* ── Portfolio hero ──────────────────────────────────────── */}
      {!loaded ? (
        <View style={styles.hero}>
          <SkeletonBlock width={130} height={12} />
          <SkeletonBlock width={220} height={40} style={{ marginTop: space(2) }} />
        </View>
      ) : (
        <Animated.View entering={FadeInDown.duration(400)} style={styles.hero}>
          <Text style={type.caption}>Portfolio value</Text>
          <MoneyText
            value={rollup?.total_value}
            size="hero"
            style={{ marginTop: space(1) }}
          />
          <View style={styles.chipRow}>
            {gain != null && (
              <Chip
                label={`${formatDelta(gain)}${gainPct != null ? ` (${gainPct >= 0 ? '+' : ''}${gainPct.toFixed(1)}%)` : ''}`}
                tone={gain >= 0 ? 'income' : 'expense'}
                small
              />
            )}
            {(rollup?.cash_value ?? 0) > 0 && (
              <Chip
                label={`${formatCurrency(rollup?.cash_value ?? 0)} cash`}
                tone="neutral"
                small
              />
            )}
          </View>
          <Text style={[type.small, { marginTop: space(2) }]}>
            {rollup?.positions ?? 0} positions
            {rollup && rollup.total_cost_basis === 0 && rollup.positions > 0
              ? ' · cost basis unavailable for some positions'
              : ''}
          </Text>
        </Animated.View>
      )}

      {/* ── Allocation ──────────────────────────────────────────── */}
      {segments.length > 0 && segTotal > 0 && (
        <>
          <SectionHeader label="Allocation" />
          <Card>
            <View
              style={styles.allocBar}
              accessibilityLabel={`Allocation: ${segments
                .map((s) => `${s.label} ${((s.value / segTotal) * 100).toFixed(0)} percent`)
                .join(', ')}`}>
              {segments.map((s) => (
                <View
                  key={s.label}
                  style={{
                    flex: s.value,
                    backgroundColor: s.color,
                  }}
                />
              ))}
            </View>
            <View style={styles.legend}>
              {segments.map((s) => (
                <View key={s.label} style={styles.legendItem}>
                  <View style={[styles.legendDot, { backgroundColor: s.color }]} />
                  <Text style={type.small} numberOfLines={1}>
                    {s.label}
                  </Text>
                  <Text style={styles.legendPct}>
                    {((s.value / segTotal) * 100).toFixed(0)}%
                  </Text>
                </View>
              ))}
            </View>
          </Card>
        </>
      )}

      {/* ── Holdings ────────────────────────────────────────────── */}
      <SectionHeader
        label="Holdings"
        right={
          holdings.length > 0 ? (
            <Text style={type.small}>{holdings.length}</Text>
          ) : undefined
        }
      />
      {holdings.length === 0 ? (
        <Card>
          <Text style={type.small}>
            No holdings synced yet. If you have investment accounts
            connected on the laptop, run "Sync now" — Plaid pulls
            positions on a slower cadence than transactions.
          </Text>
        </Card>
      ) : (
        <Card padded={false}>
          {holdings.map((h, i) => (
            <Holding key={h.id} h={h} first={i === 0} />
          ))}
        </Card>
      )}
    </Screen>
  );
}

function Holding({ h, first }: { h: HoldingRow; first: boolean }) {
  // Layout notes (load-bearing, learned the hard way on Fabric):
  //   • Left column: flex:1 + flexShrink:1 + minWidth:0 so long
  //     security names truncate with an ellipsis instead of pushing
  //     the dollar column off-screen (Yoga's default minWidth:'auto'
  //     equals content width).
  //   • marginRight instead of `gap` on the row — gap was triggering
  //     overflow on Fabric.
  return (
    <View
      style={[styles.holdingRow, !first && styles.holdingDivider]}
      accessibilityLabel={`${h.ticker}, ${h.security_name}, ${formatCurrency(h.value)}${
        h.gain_pct != null
          ? `, ${h.gain_pct >= 0 ? 'up' : 'down'} ${Math.abs(h.gain_pct * 100).toFixed(1)} percent`
          : ''
      }`}>
      <View style={styles.holdingLeft}>
        <Text style={[type.body, { fontWeight: '600' }]} numberOfLines={1}>
          {h.ticker}
        </Text>
        <Text style={[type.small, { marginTop: 1 }]} numberOfLines={1}>
          {h.security_name}
        </Text>
        <Text style={[type.small, styles.holdingMeta]} numberOfLines={1}>
          {h.quantity.toLocaleString(undefined, { maximumFractionDigits: 4 })} sh
          {' · '}
          {h.price != null ? formatCurrency(h.price) + '/sh' : '— /sh'}
          {' · '}
          {h.account_label}
        </Text>
      </View>
      <View style={styles.holdingRight}>
        <MoneyText value={h.value} size="body" />
        {h.gain_pct != null && (
          <Chip
            label={`${h.gain_pct >= 0 ? '+' : ''}${(h.gain_pct * 100).toFixed(1)}%`}
            tone={h.gain_pct >= 0 ? 'income' : 'expense'}
            small
            style={{ marginTop: space(1) }}
          />
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  hero: {
    paddingTop: space(3),
  },
  chipRow: {
    flexDirection: 'row',
    gap: space(2),
    marginTop: space(2),
  },
  allocBar: {
    flexDirection: 'row',
    height: 8,
    borderRadius: 4,
    overflow: 'hidden',
    backgroundColor: colors.surfaceElevated,
  },
  legend: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    columnGap: space(4),
    rowGap: space(2),
    marginTop: space(3),
  },
  legendItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space(1.5),
  },
  legendDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  legendPct: {
    fontSize: 13,
    color: colors.textFaint,
    fontVariant: ['tabular-nums'],
  },
  holdingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: layout.cardPad,
    paddingVertical: space(3),
    minHeight: layout.minTouch,
  },
  holdingDivider: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  holdingLeft: {
    flex: 1,
    flexShrink: 1,
    minWidth: 0,
    marginRight: space(3),
  },
  holdingMeta: {
    marginTop: 2,
    fontVariant: ['tabular-nums'],
  },
  holdingRight: {
    alignItems: 'flex-end',
  },
});
