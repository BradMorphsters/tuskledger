/**
 * Investments — holdings list + portfolio rollup.
 *
 * Pure read of the local SQLite mirror. The interesting query work
 * (joining holdings to securities for tickers and prices, computing
 * unrealized gain) lives in db/queries.ts so the screen stays
 * declarative.
 */
import { useEffect, useState } from 'react';
import {
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  HoldingRow,
  InvestmentsRollup,
  investmentsRollup,
  listHoldings,
} from '../db/queries';
import { syncNow, useSyncStore } from '../sync/manager';
import { colors, formatCurrency, radius, space, type } from '../theme';
import StaleBanner from './StaleBanner';
import SyncBadge from './SyncBadge';

export default function InvestmentsScreen() {
  const dataVersion = useSyncStore((s) => s.dataVersion);
  const status = useSyncStore((s) => s.status);
  const [holdings, setHoldings] = useState<HoldingRow[]>([]);
  const [rollup, setRollup] = useState<InvestmentsRollup | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [h, r] = await Promise.all([listHoldings(), investmentsRollup()]);
      if (cancelled) return;
      setHoldings(h);
      setRollup(r);
    })();
    return () => {
      cancelled = true;
    };
  }, [dataVersion]);

  const hasData = holdings.length > 0;

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg }}>
      <View style={styles.header}>
        <Text style={type.h1}>Investments</Text>
        <SyncBadge />
      </View>
      <StaleBanner />
      <ScrollView
        contentContainerStyle={{ padding: space(5) }}
        refreshControl={
          <RefreshControl
            refreshing={status === 'syncing'}
            onRefresh={() => syncNow()}
            tintColor={colors.textMuted}
          />
        }>
        <View style={styles.card}>
          <Text style={type.caption}>PORTFOLIO VALUE</Text>
          {/* adjustsFontSizeToFit + numberOfLines=1 lets this big
              number shrink down on narrower iPhones rather than
              clipping off the right edge. minimumFontScale floors how
              small it can shrink so a $9,999,999.99 number doesn't
              become unreadable. */}
          <Text
            style={[type.display, { marginTop: space(1) }]}
            numberOfLines={1}
            adjustsFontSizeToFit
            minimumFontScale={0.7}>
            {formatCurrency(rollup?.total_value ?? 0)}
          </Text>
          <View style={[styles.row, { marginTop: space(4), gap: space(3) }]}>
            <View style={styles.col}>
              <Text style={type.caption}>UNREALIZED GAIN</Text>
              <Text
                style={[
                  type.h2,
                  {
                    color:
                      (rollup?.total_gain ?? 0) >= 0 ? colors.income : colors.expense,
                    marginTop: space(1),
                  },
                ]}
                numberOfLines={1}
                adjustsFontSizeToFit
                minimumFontScale={0.7}>
                {rollup && rollup.total_cost_basis > 0
                  ? formatCurrency(rollup.total_gain)
                  : '—'}
              </Text>
            </View>
            <View style={styles.col}>
              <Text style={type.caption}>CASH</Text>
              <Text
                style={[type.h2, { marginTop: space(1) }]}
                numberOfLines={1}
                adjustsFontSizeToFit
                minimumFontScale={0.7}>
                {formatCurrency(rollup?.cash_value ?? 0)}
              </Text>
            </View>
          </View>
          <Text style={[type.small, { marginTop: space(3) }]}>
            {rollup?.positions ?? 0} positions
            {rollup && rollup.total_cost_basis === 0 && rollup.positions > 0
              ? ' · cost basis unavailable for some positions'
              : ''}
          </Text>
        </View>

        <Text style={[type.caption, { marginTop: space(6) }]}>HOLDINGS</Text>
        {!hasData ? (
          <View style={[styles.card, { marginTop: space(2) }]}>
            <Text style={type.small}>
              No holdings synced yet. If you have investment accounts
              connected on the laptop, run "Sync now" — Plaid pulls
              positions on a slower cadence than transactions.
            </Text>
          </View>
        ) : (
          <View style={[styles.card, { marginTop: space(2), padding: 0 }]}>
            {holdings.map((h, i) => (
              <Holding key={h.id} h={h} first={i === 0} />
            ))}
          </View>
        )}

        <View style={{ height: space(10) }} />
      </ScrollView>
    </SafeAreaView>
  );
}

function Holding({ h, first }: { h: HoldingRow; first: boolean }) {
  const gainColor =
    h.gain == null
      ? colors.textMuted
      : h.gain >= 0
        ? colors.income
        : colors.expense;
  // Layout structure:
  //   • Two-column row, left column flex:1 + minWidth:0 so children
  //     can shrink below their natural width and truncate with an
  //     ellipsis (RN/Yoga's default minWidth is 'auto', which equals
  //     content width — that's why long security names were bleeding
  //     into the dollar column).
  //   • Right column lays out by content (value + gain%) and never
  //     gets pushed by the left column.
  //   • Ticker is on its own line above the security name, instead of
  //     side-by-side, so long names like "Vanguard Index Funds -
  //     Vanguard Growth Index Admiral" don't crowd the ticker.
  return (
    <View
      style={[
        styles.holdingRow,
        first ? null : { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
      ]}>
      <View style={styles.holdingLeft}>
        <Text style={[type.body, { fontWeight: '600' }]} numberOfLines={1}>
          {h.ticker}
        </Text>
        <Text style={[type.small, { marginTop: 1 }]} numberOfLines={1}>
          {h.security_name}
        </Text>
        <Text style={[type.small, { marginTop: 2 }]} numberOfLines={1}>
          {h.quantity.toLocaleString(undefined, { maximumFractionDigits: 4 })} sh
          {' · '}
          {h.price != null ? formatCurrency(h.price) + '/sh' : '— /sh'}
          {' · '}
          {h.account_label}
        </Text>
      </View>
      <View style={styles.holdingRight}>
        <Text
          style={[type.body, { fontVariant: ['tabular-nums'], textAlign: 'right' }]}
          numberOfLines={1}>
          {formatCurrency(h.value)}
        </Text>
        {h.gain_pct != null && (
          <Text
            style={[
              type.small,
              { color: gainColor, marginTop: 2, textAlign: 'right' },
            ]}>
            {h.gain_pct >= 0 ? '+' : ''}
            {(h.gain_pct * 100).toFixed(1)}%
          </Text>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: space(5),
    paddingTop: space(3),
    paddingBottom: space(2),
  },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: space(5),
  },
  row: { flexDirection: 'row', alignItems: 'center' },
  col: { flex: 1 },
  holdingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: space(4),
    paddingVertical: space(3),
  },
  // flex:1 lets the left column take the remaining width.
  // flexShrink:1 + minWidth:0 are the bits that make Text children
  // truncate via numberOfLines instead of pushing the row wider than
  // its parent — without these, RN renders the text at natural width
  // and the right column gets pushed off the screen edge (which is
  // exactly the bug we just hit).
  // marginRight gives breathing room between the two columns instead
  // of `gap` on the row, which was triggering the overflow on Fabric.
  holdingLeft: {
    flex: 1,
    flexShrink: 1,
    minWidth: 0,
    marginRight: space(3),
  },
  holdingRight: { alignItems: 'flex-end' },
});
