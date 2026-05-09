/**
 * Dashboard — the open-the-app-and-glance screen.
 *
 * Shows: month-to-date net cash, top spend categories, and net worth.
 * Reads exclusively from the local SQLite mirror — instant, even
 * offline. The sync indicator at the top tells the user how fresh
 * the data is.
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
  CategoryTotal,
  MonthSummary,
  NetWorthSnapshot,
  currentMonthSummary,
  netWorth,
  topCategoriesThisMonth,
} from '../db/queries';
import { syncNow, useSyncStore } from '../sync/manager';
import { colors, formatCurrency, formatRelative, radius, space, type } from '../theme';
import NetWorthSparkline from './NetWorthSparkline';
import StaleBanner from './StaleBanner';
import SyncBadge from './SyncBadge';

export default function DashboardScreen() {
  const dataVersion = useSyncStore((s) => s.dataVersion);
  const status = useSyncStore((s) => s.status);
  const lastSyncedAt = useSyncStore((s) => s.lastSyncedAt);
  const [summary, setSummary] = useState<MonthSummary | null>(null);
  const [topCats, setTopCats] = useState<CategoryTotal[]>([]);
  const [nw, setNw] = useState<NetWorthSnapshot | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [s, c, n] = await Promise.all([
        currentMonthSummary(),
        topCategoriesThisMonth(5),
        netWorth(),
      ]);
      if (cancelled) return;
      setSummary(s);
      setTopCats(c);
      setNw(n);
    })();
    return () => {
      cancelled = true;
    };
  }, [dataVersion]);

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg }}>
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
        <View style={styles.header}>
          <View>
            <Text style={type.caption}>TUSK LEDGER</Text>
            <Text style={type.h1}>This month</Text>
          </View>
          <SyncBadge />
        </View>
        <Text style={[type.small, { marginTop: space(1) }]}>
          Last synced {formatRelative(lastSyncedAt)}
        </Text>

        {/* This-month card. Earlier version had a giant red NET number
            on the left dominating the card with INCOME/SPENDING tucked
            underneath; the visual hierarchy implied NET was the most
            important number, but it's actually the derived one. New
            layout reads top-to-bottom like the math itself: Income +
            Spending → divider → Net. Same prominence on all three rows,
            colors carry the up/down signal, no number outsizes the others. */}
        <View style={[styles.card, { marginTop: space(5) }]}>
          <View style={styles.kvRow}>
            <Text style={type.body}>Income</Text>
            <Text
              style={[type.body, styles.amount, { color: colors.income }]}>
              {formatCurrency(summary?.income ?? 0)}
            </Text>
          </View>
          <View style={styles.kvRow}>
            <Text style={type.body}>Spending</Text>
            <Text
              style={[type.body, styles.amount, { color: colors.expense }]}>
              −{formatCurrency(summary?.spending ?? 0)}
            </Text>
          </View>
          <View style={styles.divider} />
          <View style={styles.kvRow}>
            <Text style={[type.body, { fontWeight: '600' }]}>Net</Text>
            <Text
              style={[
                type.h2,
                styles.amount,
                {
                  color:
                    summary && summary.net >= 0 ? colors.income : colors.expense,
                },
              ]}>
              {formatCurrency(summary?.net ?? 0)}
            </Text>
          </View>
          <Text style={[type.small, { marginTop: space(3) }]}>
            {summary?.transactionCount ?? 0} transactions, transfers excluded
          </Text>
        </View>

        <Text style={[type.caption, { marginTop: space(6) }]}>TOP CATEGORIES</Text>
        <View style={[styles.card, { marginTop: space(2) }]}>
          {topCats.length === 0 ? (
            <Text style={type.small}>No spending recorded yet this month.</Text>
          ) : (
            topCats.map((c, i) => (
              <View
                key={c.category}
                style={[
                  styles.row,
                  {
                    paddingVertical: space(3),
                    borderTopWidth: i === 0 ? 0 : StyleSheet.hairlineWidth,
                    borderTopColor: colors.border,
                  },
                ]}>
                <Text style={[type.body, { flex: 1 }]} numberOfLines={1}>
                  {c.category}
                </Text>
                <Text style={[type.body, { color: colors.expense }]}>
                  {formatCurrency(c.total)}
                </Text>
              </View>
            ))
          )}
        </View>

        <Text style={[type.caption, { marginTop: space(6) }]}>NET WORTH</Text>
        {/* Same kv-row treatment as the This-Month card — assets and
            liabilities each get their own row, divider, then net worth
            on the bottom in larger weight. Cleaner than the previous
            "huge total + assets/liabilities side-by-side mini-row" which
            crowded the two halves of the balance sheet into a sliver. */}
        <View style={[styles.card, { marginTop: space(2) }]}>
          <View style={styles.kvRow}>
            <Text style={type.body}>Assets</Text>
            <Text style={[type.body, styles.amount]}>
              {formatCurrency(nw?.assets ?? 0)}
            </Text>
          </View>
          <View style={styles.kvRow}>
            <Text style={type.body}>Liabilities</Text>
            <Text
              style={[type.body, styles.amount, { color: colors.expense }]}>
              −{formatCurrency(nw?.liabilities ?? 0)}
            </Text>
          </View>
          <View style={styles.divider} />
          <View style={styles.kvRow}>
            <Text style={[type.body, { fontWeight: '600' }]}>Net worth</Text>
            <Text
              style={[
                type.h2,
                styles.amount,
                {
                  color: nw && nw.net >= 0 ? colors.text : colors.expense,
                },
              ]}>
              {formatCurrency(nw?.net ?? 0)}
            </Text>
          </View>
          <NetWorthSparkline />
        </View>

        <View style={{ height: space(10) }} />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
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
  // Key/value row used by the This-Month and Net Worth cards. Aligning
  // numbers right with tabular-nums so dollar amounts line up vertically
  // even when the integer parts have different digit counts ($821,912 vs
  // $1,765 etc.).
  kvRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    paddingVertical: space(1),
  },
  amount: {
    fontVariant: ['tabular-nums'],
    textAlign: 'right',
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.border,
    marginVertical: space(2),
  },
});
