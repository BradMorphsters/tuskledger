/**
 * Transactions list. Local search, infinite scroll backed by SQLite
 * pagination. No network reads in here — sync drops new rows into the
 * mirror in the background and the list reacts via dataVersion.
 */
import { useEffect, useMemo, useState } from 'react';
import {
  FlatList,
  RefreshControl,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { listTransactions, TransactionRow } from '../db/queries';
import { syncNow, useSyncStore } from '../sync/manager';
import { colors, formatCurrency, formatDate, radius, space, type } from '../theme';
import StaleBanner from './StaleBanner';
import SyncBadge from './SyncBadge';

const PAGE_SIZE = 60;

export default function TransactionsScreen() {
  const dataVersion = useSyncStore((s) => s.dataVersion);
  const status = useSyncStore((s) => s.status);
  const [rows, setRows] = useState<TransactionRow[]>([]);
  const [search, setSearch] = useState('');
  const [loadingMore, setLoadingMore] = useState(false);
  const [reachedEnd, setReachedEnd] = useState(false);

  // Reset pagination when the search term or the underlying data changes.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const initial = await listTransactions({
        limit: PAGE_SIZE,
        offset: 0,
        search,
      });
      if (cancelled) return;
      setRows(initial);
      setReachedEnd(initial.length < PAGE_SIZE);
    })();
    return () => {
      cancelled = true;
    };
  }, [dataVersion, search]);

  async function loadMore() {
    if (loadingMore || reachedEnd) return;
    setLoadingMore(true);
    try {
      const next = await listTransactions({
        limit: PAGE_SIZE,
        offset: rows.length,
        search,
      });
      setRows((prev) => [...prev, ...next]);
      if (next.length < PAGE_SIZE) setReachedEnd(true);
    } finally {
      setLoadingMore(false);
    }
  }

  // Empty-state messaging depends on whether there's a search term.
  const emptyText = useMemo(() => {
    if (rows.length > 0) return null;
    if (search.trim()) return 'No matches in your local copy.';
    if (status === 'unpaired') return 'Pair this phone to start syncing.';
    return 'No transactions yet — pull down to sync.';
  }, [rows.length, search, status]);

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg }}>
      <View style={styles.header}>
        <Text style={type.h1}>Transactions</Text>
        <SyncBadge />
      </View>
      <StaleBanner />
      <View style={styles.searchWrap}>
        <TextInput
          style={styles.search}
          placeholder="Search merchant or memo"
          placeholderTextColor={colors.textFaint}
          value={search}
          onChangeText={setSearch}
          autoCapitalize="none"
          autoCorrect={false}
          clearButtonMode="while-editing"
        />
      </View>
      <FlatList
        data={rows}
        keyExtractor={(r) => String(r.id)}
        renderItem={({ item }) => <Row row={item} />}
        ItemSeparatorComponent={() => (
          <View style={styles.separator} />
        )}
        onEndReached={loadMore}
        onEndReachedThreshold={0.4}
        refreshControl={
          <RefreshControl
            refreshing={status === 'syncing'}
            onRefresh={() => syncNow()}
            tintColor={colors.textMuted}
          />
        }
        ListEmptyComponent={
          emptyText ? (
            <View style={{ padding: space(6) }}>
              <Text style={type.small}>{emptyText}</Text>
            </View>
          ) : null
        }
      />
    </SafeAreaView>
  );
}

function Row({ row }: { row: TransactionRow }) {
  const isIncome = row.amount < 0;
  const isTransfer = row.is_transfer;
  return (
    <View style={styles.row}>
      <View style={{ flex: 1 }}>
        <Text style={type.body} numberOfLines={1}>
          {row.effective_name}
        </Text>
        <Text style={[type.small, { marginTop: 2 }]} numberOfLines={1}>
          {formatDate(row.date)} · {row.effective_category}
          {row.account_label ? ` · ${row.account_label}` : ''}
          {row.pending ? ' · pending' : ''}
        </Text>
      </View>
      <Text
        style={[
          type.body,
          {
            fontVariant: ['tabular-nums'],
            color: isTransfer
              ? colors.textMuted
              : isIncome
                ? colors.income
                : colors.text,
          },
        ]}>
        {isIncome ? '+' : ''}
        {formatCurrency(-row.amount)}
      </Text>
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
  searchWrap: { paddingHorizontal: space(5), paddingBottom: space(2) },
  search: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radius.md,
    color: colors.text,
    paddingHorizontal: space(3),
    paddingVertical: space(2.5),
    fontSize: 15,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: space(5),
    paddingVertical: space(3),
  },
  separator: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.border,
    marginLeft: space(5),
  },
});
