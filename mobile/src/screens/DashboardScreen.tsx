/**
 * Dashboard — the open-the-app-and-glance screen.
 *
 * Hierarchy (top → bottom): net-worth hero with a 30-day delta chip
 * and a full-bleed sparkline; the grouped Accounts card; this month's
 * income vs spending; top spend categories; recent activity. All reads
 * come from the local SQLite mirror — instant, even offline — and the
 * SyncBadge in the header says how fresh that mirror is.
 */
import { useNavigation } from '@react-navigation/native';
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Animated, { FadeInDown } from 'react-native-reanimated';
import Card from '../components/Card';
import Chip from '../components/Chip';
import MoneyText from '../components/MoneyText';
import ProgressBar from '../components/ProgressBar';
import SectionHeader from '../components/SectionHeader';
import Screen from '../components/Screen';
import SkeletonBlock from '../components/SkeletonBlock';
import Sparkline from '../components/Sparkline';
import TransactionRow from '../components/TransactionRow';
import { categoryGlyph } from '../components/categoryGlyph';
import {
  BudgetProgress,
  CategoryTotal,
  MonthSummary,
  NetWorthPoint,
  NetWorthSnapshot,
  TransactionRow as Tx,
  budgetProgress,
  currentMonthSummary,
  listTransactions,
  netWorth,
  netWorthHistory,
  topCategoriesThisMonth,
} from '../db/queries';
import { useAppStore } from '../state/appStore';
import { useSyncStore } from '../sync/manager';
import { colors, formatCurrency, formatDelta, layout, space, type } from '../theme';
import AccountsBreakdown from './AccountsBreakdown';

/** Sparkline window options — label ↔ days of snapshot history. */
const RANGES: { key: number; label: string }[] = [
  { key: 30, label: '1M' },
  { key: 90, label: '3M' },
  { key: 365, label: '1Y' },
];

/**
 * Delta vs ~30 days ago, from the snapshot history. Picks the snapshot
 * closest to the 30-day mark; returns null when history doesn't reach
 * back far enough (≥ 20 days) to make the comparison honest.
 */
function delta30d(history: NetWorthPoint[], current: number): number | null {
  if (history.length < 2) return null;
  const target = Date.now() - 30 * 86400000;
  let best: NetWorthPoint | null = null;
  let bestDist = Infinity;
  for (const p of history) {
    const dist = Math.abs(new Date(p.date + 'T12:00:00').getTime() - target);
    if (dist < bestDist) {
      best = p;
      bestDist = dist;
    }
  }
  if (!best) return null;
  const ageDays = (Date.now() - new Date(best.date + 'T12:00:00').getTime()) / 86400000;
  if (ageDays < 20) return null; // history too short for a "30d" claim
  return current - best.net_worth;
}

export default function DashboardScreen() {
  const navigation = useNavigation<any>();
  const setTxCategory = useAppStore((s) => s.setTxCategory);
  const dataVersion = useSyncStore((s) => s.dataVersion);
  const [summary, setSummary] = useState<MonthSummary | null>(null);
  const [topCats, setTopCats] = useState<CategoryTotal[]>([]);
  const [budget, setBudget] = useState<BudgetProgress | null>(null);
  const [nw, setNw] = useState<NetWorthSnapshot | null>(null);
  const [range, setRange] = useState(90);
  const [history, setHistory] = useState<NetWorthPoint[]>([]);
  // Fixed 90d window for the 30-day delta chip, independent of the
  // sparkline range the user picked (1M history can't answer "30d ago"
  // reliably; 1Y just wastes rows on it).
  const [deltaHistory, setDeltaHistory] = useState<NetWorthPoint[]>([]);
  const [recent, setRecent] = useState<Tx[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [s, c, b, n, h, r] = await Promise.all([
        currentMonthSummary(),
        topCategoriesThisMonth(5),
        budgetProgress(),
        netWorth(),
        netWorthHistory(90),
        listTransactions({ limit: 6 }),
      ]);
      if (cancelled) return;
      setSummary(s);
      setTopCats(c);
      setBudget(b);
      setNw(n);
      setDeltaHistory(h);
      setRecent(r);
      setLoaded(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [dataVersion]);

  // Sparkline window re-queries on range change without reloading the
  // whole dashboard.
  useEffect(() => {
    let cancelled = false;
    netWorthHistory(range).then((h) => {
      if (!cancelled) setHistory(h);
    });
    return () => {
      cancelled = true;
    };
  }, [dataVersion, range]);

  /** Tap a top-category row → Transactions tab, pre-filtered. */
  const drillIntoCategory = (category: string) => {
    setTxCategory(category);
    navigation.navigate('Transactions');
  };

  const delta = nw ? delta30d(deltaHistory, nw.net) : null;
  const maxFlow = Math.max(summary?.income ?? 0, summary?.spending ?? 0, 1);
  const maxCat = Math.max(...topCats.map((c) => c.total), 1);

  return (
    <Screen kicker="Tusk Ledger" title="Overview">
      {/* ── Net worth hero ──────────────────────────────────────── */}
      {!loaded ? (
        <View style={styles.hero}>
          <SkeletonBlock width={110} height={12} />
          <SkeletonBlock width={240} height={40} style={{ marginTop: space(2) }} />
          <SkeletonBlock height={64} style={{ marginTop: space(4) }} />
        </View>
      ) : (
        <Animated.View entering={FadeInDown.duration(400)} style={styles.hero}>
          <Text style={type.caption}>Net worth</Text>
          <MoneyText
            value={nw?.net}
            size="hero"
            whole
            style={{ marginTop: space(1) }}
          />
          {delta != null && (
            <Chip
              label={`${delta >= 0 ? '▲' : '▼'} ${formatDelta(delta)} · 30d`}
              tone={delta >= 0 ? 'income' : 'expense'}
              small
              style={{ marginTop: space(2) }}
            />
          )}
          {/* Full-bleed sparkline — escapes the screen padding. */}
          {history.length >= 2 && (
            <Sparkline
              data={history.map((p) => p.net_worth)}
              height={64}
              columns={72}
              style={styles.sparkline}
            />
          )}
          {/* Range picker — snapshots sync 365 days back, so every
              option is answerable from the local mirror. */}
          {history.length >= 2 && (
            <View style={styles.rangeRow}>
              {RANGES.map((r) => (
                <Chip
                  key={r.key}
                  label={r.label}
                  small
                  selected={range === r.key}
                  onPress={() => setRange(r.key)}
                />
              ))}
            </View>
          )}
        </Animated.View>
      )}

      {/* ── Accounts ────────────────────────────────────────────── */}
      <AccountsBreakdown />

      {/* ── This month ──────────────────────────────────────────── */}
      <SectionHeader
        label="This month"
        right={
          <Text style={type.small}>
            {summary?.transactionCount ?? 0} transactions
          </Text>
        }
      />
      <Card>
        <FlowRow
          label="Income"
          amount={summary?.income ?? 0}
          max={maxFlow}
          color={colors.income}
        />
        <FlowRow
          label="Spending"
          amount={summary?.spending ?? 0}
          max={maxFlow}
          color={colors.expense}
          negative
        />
        <View style={styles.divider} />
        <View style={styles.netRow}>
          <Text style={[type.body, { fontWeight: '600' }]}>Net</Text>
          <MoneyText value={summary?.net ?? 0} size="title" tone="auto" signed />
        </View>
        <Text style={[type.small, { marginTop: space(2) }]}>
          Transfers excluded
        </Text>
      </Card>

      {/* ── Budgets (only when a budget exists for this month) ──── */}
      {budget && budget.rows.length > 0 && (
        <>
          <SectionHeader
            label="Budgets"
            right={
              budget.total_limit != null ? (
                <Text style={type.small}>
                  {formatCurrency(budget.total_spent)} of {formatCurrency(budget.total_limit)}
                </Text>
              ) : undefined
            }
          />
          <Card>
            {budget.rows.map((b, i) => (
              <BudgetLine key={b.category} row={b} first={i === 0} />
            ))}
          </Card>
        </>
      )}

      {/* ── Top categories ──────────────────────────────────────── */}
      <SectionHeader label="Top categories" />
      <Card>
        {topCats.length === 0 ? (
          <Text style={type.small}>No spending recorded yet this month.</Text>
        ) : (
          topCats.map((c, i) => (
            <CategoryLine
              key={c.category}
              cat={c}
              max={maxCat}
              first={i === 0}
              onPress={() => drillIntoCategory(c.category)}
            />
          ))
        )}
      </Card>

      {/* ── Recent activity ─────────────────────────────────────── */}
      <SectionHeader label="Recent activity" />
      <Card padded={false}>
        {recent.length === 0 ? (
          <Text style={[type.small, { padding: layout.cardPad }]}>
            Nothing here yet — pull down to sync.
          </Text>
        ) : (
          recent.map((tx, i) => (
            <View
              key={tx.id}
              style={[styles.txWrap, i > 0 && styles.txDivider]}>
              <TransactionRow tx={tx} showAccount={false} />
            </View>
          ))
        )}
      </Card>
    </Screen>
  );
}

function FlowRow({
  label,
  amount,
  max,
  color,
  negative = false,
}: {
  label: string;
  amount: number;
  max: number;
  color: string;
  negative?: boolean;
}) {
  return (
    <View style={styles.flowRow}>
      <View style={styles.flowHeader}>
        <Text style={type.body}>{label}</Text>
        <MoneyText
          value={negative ? -amount : amount}
          size="body"
          tone={negative ? 'expense' : 'income'}
          signed={amount > 0}
        />
      </View>
      <ProgressBar
        progress={amount / max}
        color={color}
        height={5}
        style={{ marginTop: space(1.5) }}
      />
    </View>
  );
}

/** One budget category: name, spent vs limit, tone-shifted bar
 *  (green under 80%, amber under 100%, red over). */
function BudgetLine({ row, first }: { row: { category: string; limit_amount: number; spent: number; pct: number }; first: boolean }) {
  const over = row.pct > 1;
  const near = row.pct > 0.8 && !over;
  const barColor = over ? colors.expense : near ? colors.warning : colors.income;
  return (
    <View
      style={[styles.flowRow, !first && { marginTop: space(1) }]}
      accessibilityLabel={`${row.category} budget, ${formatCurrency(row.spent)} of ${formatCurrency(row.limit_amount)} spent`}>
      <View style={styles.flowHeader}>
        <Text style={type.body} numberOfLines={1}>
          {row.category}
        </Text>
        <Text style={[type.small, over && { color: colors.expense, fontWeight: '700' }]}>
          {formatCurrency(row.spent)} / {formatCurrency(row.limit_amount)}
          {over ? '  over' : ''}
        </Text>
      </View>
      <ProgressBar
        progress={Math.min(row.pct, 1)}
        color={barColor}
        height={5}
        style={{ marginTop: space(1.5) }}
      />
    </View>
  );
}

function CategoryLine({
  cat,
  max,
  first,
  onPress,
}: {
  cat: CategoryTotal;
  max: number;
  first: boolean;
  onPress?: () => void;
}) {
  const glyph = categoryGlyph(cat.category);
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.catRow,
        !first && { marginTop: space(3.5) },
        pressed && { opacity: 0.6 },
      ]}
      accessibilityRole="button"
      accessibilityHint="Shows this category's transactions"
      accessibilityLabel={`${cat.category}, ${formatCurrency(cat.total)} this month`}>
      <View style={[styles.catGlyph, { backgroundColor: glyph.bg }]}>
        {glyph.emoji ? (
          <Text style={{ fontSize: 14 }}>{glyph.emoji}</Text>
        ) : (
          <Text style={{ fontSize: 13, fontWeight: '700', color: glyph.fg }}>
            {glyph.initial}
          </Text>
        )}
      </View>
      <View style={styles.catMiddle}>
        <View style={styles.catHeader}>
          <Text style={type.body} numberOfLines={1}>
            {cat.category}
          </Text>
          <MoneyText value={cat.total} size="small" tone="muted" />
        </View>
        <ProgressBar
          progress={cat.total / max}
          color={colors.accent}
          height={4}
          style={{ marginTop: space(1.5) }}
        />
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  hero: {
    paddingTop: space(3),
  },
  sparkline: {
    marginTop: space(4),
    marginHorizontal: -layout.screenPad,
  },
  rangeRow: {
    flexDirection: 'row',
    gap: space(2),
    marginTop: space(2),
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.border,
    marginVertical: space(3),
  },
  netRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
  },
  flowRow: {
    marginBottom: space(3),
  },
  flowHeader: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
  },
  catRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  catGlyph: {
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: space(3),
  },
  catMiddle: {
    flex: 1,
    flexShrink: 1,
    minWidth: 0,
  },
  catHeader: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: space(3),
  },
  txWrap: {
    paddingHorizontal: layout.cardPad,
  },
  txDivider: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
});
