/**
 * Transactions — debounced local search, date-filter chips, a
 * category-filter chip row (also the landing zone for the Dashboard's
 * top-category drill-down via appStore.txCategory), and an
 * infinite-scrolling list grouped by day with sticky headers (date +
 * day net). No network reads in here — sync drops new rows into the
 * SQLite mirror in the background and the list reacts via dataVersion.
 */
import { useEffect, useMemo, useState } from 'react';
import {
  Pressable,
  RefreshControl,
  ScrollView,
  SectionList,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import Chip from '../components/Chip';
import EmptyState from '../components/EmptyState';
import Screen from '../components/Screen';
import TransactionRow from '../components/TransactionRow';
import SkeletonBlock from '../components/SkeletonBlock';
import {
  AccountChip,
  accountsWithActivity,
  listTransactions,
  spendCategories,
  TransactionRow as Tx,
} from '../db/queries';
import { useAppStore } from '../state/appStore';
import { syncNow, useSyncStore } from '../sync/manager';
import {
  colors,
  formatDayLabel,
  formatDelta,
  layout,
  radius,
  space,
  type,
} from '../theme';

const PAGE_SIZE = 60;
const SEARCH_DEBOUNCE_MS = 250;

type DateFilter = 'all' | 'month' | '30d';

const FILTERS: { key: DateFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'month', label: 'By month' },
  { key: '30d', label: 'Last 30 days' },
];

/** Local-calendar (year, month 1-12) shifted back by `offset` months. */
function shiftedMonth(offset: number): { y: number; m: number } {
  const now = new Date();
  const idx = now.getFullYear() * 12 + now.getMonth() - offset;
  return { y: Math.floor(idx / 12), m: (idx % 12) + 1 };
}

function monthLabel(offset: number): string {
  const { y, m } = shiftedMonth(offset);
  return new Date(y, m - 1, 1).toLocaleDateString(undefined, {
    month: 'long',
    year: 'numeric',
  });
}

/** [inclusive since, exclusive until) for the month filter; since only
 *  for the 30d filter; both undefined for 'all'. */
function rangeFor(
  filter: DateFilter,
  monthOffset: number,
): { since?: string; until?: string } {
  const pad = (n: number) => String(n).padStart(2, '0');
  if (filter === 'month') {
    const { y, m } = shiftedMonth(monthOffset);
    const next = m === 12 ? { y: y + 1, m: 1 } : { y, m: m + 1 };
    return {
      since: `${y}-${pad(m)}-01`,
      until: `${next.y}-${pad(next.m)}-01`,
    };
  }
  if (filter === '30d') {
    const d = new Date(Date.now() - 30 * 86400000);
    return { since: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` };
  }
  return {};
}

interface DaySection {
  title: string;
  /** Net for the day (income minus spending, transfers excluded). */
  net: number;
  data: Tx[];
}

/** Rows arrive date-DESC, so one pass groups consecutive dates. */
function groupByDay(rows: Tx[]): DaySection[] {
  const sections: DaySection[] = [];
  let current: DaySection | null = null;
  let currentDate = '';
  for (const r of rows) {
    if (r.date !== currentDate) {
      currentDate = r.date;
      current = { title: formatDayLabel(r.date), net: 0, data: [] };
      sections.push(current);
    }
    current!.data.push(r);
    if (!r.is_transfer) current!.net += -r.amount;
  }
  return sections;
}

export default function TransactionsScreen() {
  const dataVersion = useSyncStore((s) => s.dataVersion);
  const status = useSyncStore((s) => s.status);
  // Category filter lives in the app store so the Dashboard's
  // top-category drill-down can set it before switching tabs.
  const category = useAppStore((s) => s.txCategory);
  const setCategory = useAppStore((s) => s.setTxCategory);
  const [rows, setRows] = useState<Tx[]>([]);
  const [cats, setCats] = useState<string[]>([]);
  const [accounts, setAccounts] = useState<AccountChip[]>([]);
  const [accountId, setAccountId] = useState<number | null>(null);
  const [initialLoaded, setInitialLoaded] = useState(false);
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<DateFilter>('all');
  // 0 = current month; grows as the user steps back. Reset when the
  // month filter is deselected so re-entering starts at "now".
  const [monthOffset, setMonthOffset] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const [reachedEnd, setReachedEnd] = useState(false);

  // Debounce keystrokes so we're not re-querying SQLite per character.
  useEffect(() => {
    const t = setTimeout(() => setSearch(searchInput), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [searchInput]);

  // Chip rows: this month's top spend categories, and the accounts with
  // the most activity. A drilled-in category that's outside the top set
  // still renders (prepended) so the active filter is always visible and
  // clearable.
  useEffect(() => {
    let cancelled = false;
    Promise.all([spendCategories(10), accountsWithActivity(8)]).then(([c, a]) => {
      if (cancelled) return;
      setCats(c);
      setAccounts(a);
    });
    return () => {
      cancelled = true;
    };
  }, [dataVersion]);

  // Reset pagination when search, filter, or the underlying data change.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const range = rangeFor(filter, monthOffset);
      const initial = await listTransactions({
        limit: PAGE_SIZE,
        offset: 0,
        search,
        sinceDate: range.since,
        untilDate: range.until,
        category: category ?? undefined,
        accountId: accountId ?? undefined,
      });
      if (cancelled) return;
      setRows(initial);
      setReachedEnd(initial.length < PAGE_SIZE);
      setInitialLoaded(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [dataVersion, search, filter, monthOffset, category, accountId]);

  async function loadMore() {
    if (loadingMore || reachedEnd) return;
    setLoadingMore(true);
    try {
      const range = rangeFor(filter, monthOffset);
      const next = await listTransactions({
        limit: PAGE_SIZE,
        offset: rows.length,
        search,
        sinceDate: range.since,
        untilDate: range.until,
        category: category ?? undefined,
        accountId: accountId ?? undefined,
      });
      setRows((prev) => [...prev, ...next]);
      if (next.length < PAGE_SIZE) setReachedEnd(true);
    } finally {
      setLoadingMore(false);
    }
  }

  const sections = useMemo(() => groupByDay(rows), [rows]);

  const chipCats = useMemo(
    () => (category && !cats.includes(category) ? [category, ...cats] : cats),
    [category, cats],
  );

  // Empty-state messaging depends on whether there's a search term.
  const empty = useMemo(() => {
    if (rows.length > 0) return null;
    if (search.trim() || filter !== 'all' || category || accountId != null) {
      return { title: 'No matches', message: 'Nothing in your local copy matches these filters.' };
    }
    if (status === 'unpaired') {
      return { title: 'Not paired yet', message: 'Pair this phone with your laptop to start syncing.' };
    }
    return { title: 'No transactions yet', message: 'Pull down to sync from your laptop.' };
  }, [rows.length, search, filter, category, accountId, status]);

  return (
    <Screen title="Transactions" scroll={false}>
      <View style={styles.searchWrap}>
        <Text style={styles.searchIcon}>⌕</Text>
        <TextInput
          style={styles.search}
          placeholder="Search merchant or memo"
          placeholderTextColor={colors.textFaint}
          value={searchInput}
          onChangeText={setSearchInput}
          autoCapitalize="none"
          autoCorrect={false}
          clearButtonMode="while-editing"
          accessibilityLabel="Search transactions"
        />
      </View>
      <View style={styles.chipRow}>
        {FILTERS.map((f) => (
          <Chip
            key={f.key}
            label={f.label}
            selected={filter === f.key}
            onPress={() => {
              setFilter(f.key);
              if (f.key !== 'month') setMonthOffset(0);
            }}
          />
        ))}
      </View>
      {filter === 'month' && (
        <View style={styles.monthRow}>
          <Pressable
            onPress={() => setMonthOffset((o) => o + 1)}
            hitSlop={10}
            accessibilityRole="button"
            accessibilityLabel="Previous month">
            <Text style={styles.monthArrow}>‹</Text>
          </Pressable>
          <Text style={styles.monthLabel}>{monthLabel(monthOffset)}</Text>
          <Pressable
            onPress={() => setMonthOffset((o) => Math.max(0, o - 1))}
            hitSlop={10}
            disabled={monthOffset === 0}
            accessibilityRole="button"
            accessibilityLabel="Next month">
            <Text style={[styles.monthArrow, monthOffset === 0 && { opacity: 0.25 }]}>›</Text>
          </Pressable>
        </View>
      )}
      {chipCats.length > 0 && (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.catRow}
          contentContainerStyle={styles.catRowContent}>
          {chipCats.map((c) => (
            <Chip
              key={c}
              label={category === c ? `${c} ✕` : c}
              selected={category === c}
              onPress={() => setCategory(category === c ? null : c)}
            />
          ))}
        </ScrollView>
      )}
      {accounts.length > 1 && (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.catRow}
          contentContainerStyle={styles.catRowContent}>
          {accounts.map((a) => (
            <Chip
              key={a.id}
              label={accountId === a.id ? `${a.label} ✕` : a.label}
              selected={accountId === a.id}
              onPress={() => setAccountId(accountId === a.id ? null : a.id)}
            />
          ))}
        </ScrollView>
      )}
      <SectionList
        sections={sections}
        keyExtractor={(r) => String(r.id)}
        renderItem={({ item }) => (
          <View style={styles.rowWrap}>
            <TransactionRow tx={item} />
          </View>
        )}
        renderSectionHeader={({ section }) => (
          <View style={styles.sectionHeader}>
            <Text style={type.caption}>{section.title}</Text>
            <Text style={styles.sectionNet}>{formatDelta(section.net)}</Text>
          </View>
        )}
        ItemSeparatorComponent={() => <View style={styles.separator} />}
        stickySectionHeadersEnabled
        onEndReached={loadMore}
        onEndReachedThreshold={0.4}
        keyboardDismissMode="on-drag"
        refreshControl={
          <RefreshControl
            refreshing={status === 'syncing'}
            onRefresh={() => syncNow()}
            tintColor={colors.textMuted}
          />
        }
        ListEmptyComponent={
          !initialLoaded ? (
            // First query hasn't returned yet — skeleton rows instead of a
            // flash of "No transactions yet".
            <View style={{ paddingHorizontal: layout.screenPad, paddingTop: space(3), gap: space(4) }}>
              <SkeletonBlock height={44} />
              <SkeletonBlock height={44} />
              <SkeletonBlock height={44} />
            </View>
          ) : empty ? (
            <EmptyState icon="🔎" title={empty.title} message={empty.message} />
          ) : null
        }
        ListFooterComponent={<View style={{ height: space(8) }} />}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  searchWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    marginHorizontal: layout.screenPad,
    marginTop: space(2),
    backgroundColor: colors.surface,
    borderColor: colors.borderSubtle,
    borderWidth: 1,
    borderRadius: radius.md,
    paddingHorizontal: space(3),
  },
  searchIcon: {
    fontSize: 17,
    color: colors.textFaint,
    marginRight: space(2),
  },
  search: {
    flex: 1,
    color: colors.text,
    paddingVertical: space(2.5),
    fontSize: 15,
  },
  chipRow: {
    flexDirection: 'row',
    gap: space(2),
    paddingHorizontal: layout.screenPad,
    paddingVertical: space(3),
  },
  catRow: {
    flexGrow: 0,
    // ScrollView's base style is flexGrow:1 + flexShrink:1 — without
    // pinning shrink to 0, adding the second chip row made both rows
    // compress and clip their chips (the SectionList should absorb the
    // squeeze instead; it scrolls).
    flexShrink: 0,
    marginBottom: space(3),
  },
  monthRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space(5),
    paddingBottom: space(3),
  },
  monthArrow: {
    fontSize: 26,
    lineHeight: 28,
    color: colors.accent,
    paddingHorizontal: space(2),
  },
  monthLabel: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.text,
    minWidth: 150,
    textAlign: 'center',
    fontVariant: ['tabular-nums'],
  },
  catRowContent: {
    gap: space(2),
    paddingHorizontal: layout.screenPad,
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: colors.bg,
    paddingHorizontal: layout.screenPad,
    paddingTop: space(3),
    paddingBottom: space(1.5),
  },
  sectionNet: {
    fontSize: 11,
    fontWeight: '600',
    color: colors.textFaint,
    fontVariant: ['tabular-nums'],
    letterSpacing: 0.5,
  },
  rowWrap: {
    paddingHorizontal: layout.screenPad,
  },
  separator: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.borderSubtle,
    marginLeft: layout.screenPad + 38 + space(3), // align with text, past the glyph
  },
});
