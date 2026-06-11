/**
 * Screen — shared chrome for the four tab screens: SafeArea, the
 * kicker/title header with the SyncBadge in the top-right, the
 * StaleBanner, and (by default) a padded ScrollView whose
 * pull-to-refresh is wired to syncNow.
 *
 * `scroll={false}` for screens that own their scrolling (the
 * Transactions SectionList) — the header and banner still render, the
 * children fill the rest.
 */
import { ReactNode } from 'react';
import {
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { syncNow, useSyncStore } from '../sync/manager';
import { colors, layout, space, type } from '../theme';
import StaleBanner from './StaleBanner';
import SyncBadge from './SyncBadge';

interface Props {
  title: string;
  /** Tiny uppercase brand line above the title (Dashboard only). */
  kicker?: string;
  /** Defaults to the SyncBadge; pass null to hide. */
  headerRight?: ReactNode;
  /** Show the stale-data banner (default true). */
  banner?: boolean;
  scroll?: boolean;
  children: ReactNode;
}

export default function Screen({
  title,
  kicker,
  headerRight,
  banner = true,
  scroll = true,
  children,
}: Props) {
  const status = useSyncStore((s) => s.status);

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'left', 'right']}>
      <View style={styles.header}>
        <View style={styles.headerLeft}>
          {kicker ? <Text style={[type.caption, styles.kicker]}>{kicker}</Text> : null}
          <Text style={type.h1}>{title}</Text>
        </View>
        {headerRight === undefined ? <SyncBadge /> : headerRight}
      </View>
      {banner ? <StaleBanner /> : null}
      {scroll ? (
        <ScrollView
          contentContainerStyle={styles.content}
          refreshControl={
            <RefreshControl
              refreshing={status === 'syncing'}
              onRefresh={() => syncNow()}
              tintColor={colors.textMuted}
            />
          }>
          {children}
          <View style={{ height: space(8) }} />
        </ScrollView>
      ) : (
        <View style={styles.fill}>{children}</View>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: layout.screenPad,
    paddingTop: space(2),
    paddingBottom: space(1),
  },
  headerLeft: {
    flexShrink: 1,
    minWidth: 0,
    paddingRight: space(3),
  },
  kicker: {
    color: colors.accent,
    marginBottom: 2,
  },
  content: {
    paddingHorizontal: layout.screenPad,
    paddingTop: space(2),
  },
  fill: { flex: 1 },
});
