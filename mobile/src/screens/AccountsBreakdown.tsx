/**
 * AccountsBreakdown — the Accounts summary card on the Dashboard.
 *
 * One card, grouped rows (Cash / Investment / Credit / Loans, plus
 * manual-asset and manual-liability groups when the user has any).
 * Each group row shows a colored dot, label, account count, and group
 * subtotal; tapping expands the group in place to reveal per-account
 * rows (name, ····mask, stale chip, balance). A net-worth footer pins
 * the card so the bottom number always matches the hero at the top of
 * the Dashboard — one number, one truth.
 *
 * Data shape comes from accountsBreakdown() — including the
 * manual_assets fold-in — and is used EXACTLY as before; only the
 * presentation changed from a stack of cards to one expandable card.
 */
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import AccountRow from '../components/AccountRow';
import Card from '../components/Card';
import SectionHeader from '../components/SectionHeader';
import {
  AccountBreakdownGroup,
  accountsBreakdown,
} from '../db/queries';
import { useSyncStore } from '../sync/manager';
import { colors, formatCurrency, layout, space, type } from '../theme';

const STALE_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000;

function staleDays(updatedAt: string | null): number | null {
  if (!updatedAt) return null;
  const ms = Date.now() - new Date(updatedAt).getTime();
  if (!Number.isFinite(ms) || ms < STALE_THRESHOLD_MS) return null;
  return Math.floor(ms / (24 * 60 * 60 * 1000));
}

// Color accent per group — same semantic palette as the rest of the
// app, so the color tells you something instead of being decor.
function accentForKey(key: string): string {
  switch (key) {
    case 'depository':         return colors.income;
    case 'investment':         return colors.accent;
    case 'credit':             return colors.warning;
    case 'loan':               return colors.expense;
    case 'manual-assets':      return colors.income;
    case 'manual-liabilities': return colors.expense;
    default:                   return colors.textMuted;
  }
}

// True for manual_assets / manual_liabilities groups. Used to swap the
// count noun ("entries" vs "accounts") and to suppress the per-row
// stale badge — manual entries follow the user's own update cadence,
// not a Plaid sync cadence, so flagging them as stale would be
// nagging, not useful.
function isManualGroup(key: string): boolean {
  return key.startsWith('manual-');
}

export default function AccountsBreakdown() {
  const dataVersion = useSyncStore((s) => s.dataVersion);
  const [groups, setGroups] = useState<AccountBreakdownGroup[]>([]);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const g = await accountsBreakdown();
      if (!cancelled) setGroups(g);
    })();
    return () => {
      cancelled = true;
    };
  }, [dataVersion]);

  if (groups.length === 0) return null;

  const totalAssets = groups
    .filter((g) => g.side === 'asset')
    .reduce((s, g) => s + g.subtotal, 0);
  const totalLiabilities = groups
    .filter((g) => g.side === 'liability')
    .reduce((s, g) => s + g.subtotal, 0);
  const net = totalAssets - totalLiabilities;

  const synced = groups
    .filter((g) => !isManualGroup(g.key))
    .reduce((s, g) => s + g.items.length, 0);
  const manual = groups
    .filter((g) => isManualGroup(g.key))
    .reduce((s, g) => s + g.items.length, 0);

  return (
    <>
      <SectionHeader
        label="Accounts"
        right={
          <Text style={type.small}>
            {manual > 0 ? `${synced} synced · ${manual} manual` : `${synced} synced`}
          </Text>
        }
      />
      <Card padded={false}>
        {groups.map((g, i) => (
          <Group
            key={g.key}
            group={g}
            first={i === 0}
            expanded={!!expanded[g.key]}
            onToggle={() =>
              setExpanded((e) => ({ ...e, [g.key]: !e[g.key] }))
            }
          />
        ))}

        {/* Net worth footer — anchors the card, matches the hero. */}
        <View style={styles.footer}>
          <Text style={[type.body, { fontWeight: '600' }]}>Net worth</Text>
          <Text
            style={[
              styles.footerValue,
              { color: net >= 0 ? colors.text : colors.expense },
            ]}>
            {net < 0 ? '−' : ''}
            {formatCurrency(Math.abs(net))}
          </Text>
        </View>
      </Card>
    </>
  );
}

function Group({
  group,
  first,
  expanded,
  onToggle,
}: {
  group: AccountBreakdownGroup;
  first: boolean;
  expanded: boolean;
  onToggle: () => void;
}) {
  const accent = accentForKey(group.key);
  const liability = group.side === 'liability';
  const noun = isManualGroup(group.key)
    ? group.items.length === 1 ? 'entry' : 'entries'
    : group.items.length === 1 ? 'account' : 'accounts';

  return (
    <View style={first ? null : styles.groupDivider}>
      <Pressable
        onPress={onToggle}
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        accessibilityLabel={`${group.label}, ${group.items.length} ${noun}, ${formatCurrency(group.subtotal)}. ${expanded ? 'Collapse' : 'Expand'}.`}
        style={({ pressed }) => [styles.groupRow, pressed && { opacity: 0.65 }]}>
        <View style={[styles.dot, { backgroundColor: accent }]} />
        <View style={styles.groupLeft}>
          <Text style={type.body} numberOfLines={1}>
            {group.label}
          </Text>
          <Text style={[type.small, { marginTop: 1 }]}>
            {group.items.length} {noun}
          </Text>
        </View>
        <Text
          style={[
            styles.subtotal,
            { color: liability ? colors.expense : colors.text },
          ]}
          numberOfLines={1}>
          {liability ? '−' : ''}
          {formatCurrency(group.subtotal)}
        </Text>
        <Text
          style={[
            styles.chevron,
            expanded && { transform: [{ rotate: '90deg' }] },
          ]}>
          ›
        </Text>
      </Pressable>

      {expanded && (
        <View style={styles.itemList}>
          {group.items.map((a) => (
            <AccountRow
              key={a.id}
              name={a.name}
              mask={a.mask}
              balance={a.current_balance}
              liability={liability}
              staleDays={isManualGroup(group.key) ? null : staleDays(a.updated_at)}
            />
          ))}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  groupDivider: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  groupRow: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: layout.minTouch + 12,
    paddingHorizontal: layout.cardPad,
    paddingVertical: space(2.5),
  },
  dot: {
    width: 9,
    height: 9,
    borderRadius: 5,
    marginRight: space(3),
  },
  groupLeft: {
    flex: 1,
    flexShrink: 1,
    minWidth: 0,
    paddingRight: space(2),
  },
  subtotal: {
    fontSize: 16,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
    textAlign: 'right',
  },
  chevron: {
    fontSize: 18,
    color: colors.textFaint,
    marginLeft: space(2),
    width: 14,
    textAlign: 'center',
  },
  itemList: {
    paddingHorizontal: layout.cardPad,
    paddingLeft: layout.cardPad + space(3) + 9, // align under the label
    paddingBottom: space(2),
  },
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: layout.cardPad,
    paddingVertical: space(3.5),
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    backgroundColor: colors.surfaceElevated,
  },
  footerValue: {
    fontSize: 17,
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
  },
});
