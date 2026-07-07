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
import { listTransactions, spendCategories, TransactionRow as Tx } from '../db/queries';
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
  { key: 'month', label: 'This month' },
  { key: '30d', label: 'Last 30 days' },
];

function sinceFor(filter: DateFilter): string | undefined {
  const pad = (n: number) => String(n).padStart(2, '0');
  const now = new Date();
  if (filter === 'month') {
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-01`;
  }
  if (filter === '30d') {
    const d = new Date(now.getTime() - 30 * 86400000);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }
  return undefined;
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
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<DateFilter>('all');
  const [loadingMore, setLoadingMore] = useState(false);
  const [reachedEnd, setReachedEnd] = useState(false);

  // Debounce keystrokes so we're not re-querying SQLite per character.
  useEffect(() => {
    const t = setTimeout(() => setSearch(searchInput), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [searchInput]);

  // Chip row of this month's top spend categories. A drilled-in
  // category that's outside the top set still renders (prepended) so
  // the active filter is always visible and clearable.
  useEffect(() => {
    let cancelled = false;
    spendCategories(10).then((c) => {
      if (!cancelled) setCats(c);
    });
    return () => {
      cancelled = true;
    };
  }, [dataVersion]);

  // Reset pagination when search, filter, or the underlying data change.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const initial = await listTransactions({
        limit: PAGE_SIZE,
        offset: 0,
        search,
        sinceDate: sinceFor(filter),
        category: category ?? undefined,
      });
      if (cancelled) return;
      setRows(initial);
      setReachedEnd(initial.length < PAGE_SIZE);
    })();
    return () => {
      cancelled = true;
    };
  }, [dataVersion, search, filter, category]);

  async function loadMore() {
    if (loadingMore || reachedEnd) return;
    setLoadingMore(true);
    try {
      const next = await listTransactions({
        limit: PAGE_SIZE,
        offset: rows.length,
        search,
        sinceDate: sinceFor(filter),
        category: category ?? undefined,
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
    if (search.trim() || filter !== 'all' || category) {
      return { title: 'No matches', message: 'Nothing in your local copy matches these filters.' };
    }
    if (status === 'unpaired') {
      return { title: 'Not paired yet', message: 'Pair this phone with your laptop to start syncing.' };
    }
    return { title: 'No transactions yet', message: 'Pull down to sync from your laptop.' };
  }, [rows.length, search, filter, category, status]);

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
            onPress={() => setFilter(f.key)}
          />
        ))}
      </View>
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
          empty ? (
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
    marginBottom: space(3),
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
