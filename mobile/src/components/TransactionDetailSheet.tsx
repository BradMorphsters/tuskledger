/**
 * TransactionDetailSheet — tap a transaction row to see everything the
 * phone knows about it: amount, date, account, category, flags
 * (pending / transfer / refund), the bank's original description, notes,
 * and how often you spend at this merchant.
 *
 * Read-only (the phone never edits). Two shortcuts re-scope the list:
 * "All from this account" and "All from <merchant>".
 *
 * A plain RN Modal rather than a navigation screen: the app runs with
 * enableScreens(false) and a tab-only navigator, and a page sheet is the
 * iOS-native shape for "details of one row".
 */
import { useEffect, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { merchantStats, MerchantStats, TransactionRow as Tx } from '../db/queries';
import { longDate } from '../format/dates';
import { colors, formatCurrency, layout, radius, space, type } from '../theme';
import { categoryGlyph } from './categoryGlyph';
import Chip from './Chip';

interface Props {
  tx: Tx | null;
  onClose(): void;
  onFilterAccount(accountId: number): void;
  onFilterMerchant(merchant: string): void;
}

export default function TransactionDetailSheet({ tx, onClose, onFilterAccount, onFilterMerchant }: Props) {
  const [stats, setStats] = useState<MerchantStats | null>(null);

  useEffect(() => {
    setStats(null);
    if (!tx || tx.is_transfer) return;
    let cancelled = false;
    merchantStats(tx.effective_name).then((s) => {
      if (!cancelled) setStats(s);
    });
    return () => {
      cancelled = true;
    };
  }, [tx?.id]);

  return (
    <Modal
      visible={!!tx}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}>
      {tx ? <Body tx={tx} stats={stats} onClose={onClose}
        onFilterAccount={onFilterAccount} onFilterMerchant={onFilterMerchant} /> : null}
    </Modal>
  );
}

function Body({ tx, stats, onClose, onFilterAccount, onFilterMerchant }: {
  tx: Tx;
  stats: MerchantStats | null;
  onClose(): void;
  onFilterAccount(accountId: number): void;
  onFilterMerchant(merchant: string): void;
}) {
  const glyph = categoryGlyph(tx.effective_category);
  const isIncome = tx.amount < 0;
  const kind = tx.is_transfer ? 'Transfer' : tx.is_refund ? 'Refund' : isIncome ? 'Money in' : 'Money out';
  const amountColor = tx.is_transfer || tx.is_refund
    ? colors.textMuted
    : isIncome ? colors.income : colors.text;
  const showOriginal = tx.name && tx.name.trim() !== tx.effective_name.trim();

  return (
    <View style={styles.sheet}>
      <View style={styles.topBar}>
        <View style={styles.grabber} />
        <Pressable onPress={onClose} hitSlop={12} accessibilityRole="button" accessibilityLabel="Close">
          <Text style={styles.done}>Done</Text>
        </Pressable>
      </View>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={[styles.glyph, { backgroundColor: glyph.bg }]}>
          {glyph.emoji ? (
            <Text style={styles.glyphEmoji}>{glyph.emoji}</Text>
          ) : (
            <Text style={[styles.glyphInitial, { color: glyph.fg }]}>{glyph.initial}</Text>
          )}
        </View>
        <Text style={styles.merchant} numberOfLines={2}>{tx.effective_name}</Text>
        <Text style={[styles.amount, { color: amountColor }]}>
          {isIncome ? '+' : ''}{formatCurrency(-tx.amount)}
        </Text>
        <View style={styles.flags}>
          <Chip small label={kind} />
          {tx.pending ? <Chip small tone="warning" label="Pending" /> : null}
        </View>

        <View style={styles.card}>
          <Field label="Date" value={longDate(tx.date)} />
          <Field label="Account" value={tx.account_label || '—'}
            action="All from this account" onAction={() => onFilterAccount(tx.account_id)} />
          <Field label="Category" value={tx.effective_category}
            sub={tx.custom_category && tx.category && tx.custom_category !== tx.category
              ? `Bank labeled it ${tx.category}` : undefined} />
          {showOriginal ? <Field label="Bank description" value={tx.name} mono /> : null}
          {tx.notes ? <Field label="Notes" value={tx.notes} last /> : null}
        </View>

        {stats && stats.count > 0 ? (
          <View style={styles.card}>
            <Text style={type.caption}>AT {tx.effective_name.toUpperCase()} · LAST 12 MONTHS</Text>
            <View style={styles.statsRow}>
              <Stat label="Visits" value={String(stats.count)} />
              <Stat label="Spent" value={formatCurrency(stats.total)} />
              <Stat label="Average" value={formatCurrency(stats.average)} />
            </View>
            <Pressable
              onPress={() => onFilterMerchant(tx.effective_name)}
              accessibilityRole="button"
              style={({ pressed }) => [styles.linkRow, pressed && { opacity: 0.6 }]}>
              <Text style={styles.link}>See all from {tx.effective_name} ›</Text>
            </Pressable>
          </View>
        ) : null}
      </ScrollView>
    </View>
  );
}

function Field({ label, value, sub, action, onAction, mono, last }: {
  label: string; value: string; sub?: string; action?: string; onAction?(): void; mono?: boolean; last?: boolean;
}) {
  return (
    <View style={[styles.field, !last && styles.fieldDivider]}>
      <Text style={type.small}>{label}</Text>
      <Text style={[type.body, mono && styles.mono]} selectable>{value}</Text>
      {sub ? <Text style={[type.small, { marginTop: 2 }]}>{sub}</Text> : null}
      {action && onAction ? (
        <Pressable onPress={onAction} hitSlop={8} accessibilityRole="button">
          <Text style={[styles.link, { marginTop: space(1) }]}>{action} ›</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <View style={{ flex: 1 }}>
      <Text style={type.small}>{label}</Text>
      <Text style={styles.statValue}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  sheet: { flex: 1, backgroundColor: colors.bg },
  topBar: {
    alignItems: 'flex-end',
    paddingHorizontal: layout.screenPad,
    paddingTop: space(2),
    paddingBottom: space(1),
  },
  grabber: {
    alignSelf: 'center',
    width: 36,
    height: 5,
    borderRadius: 3,
    backgroundColor: colors.border,
    marginBottom: space(1),
  },
  done: { color: colors.accent, fontSize: 16, fontWeight: '600' },
  content: {
    alignItems: 'center',
    paddingHorizontal: layout.screenPad,
    paddingBottom: space(10),
  },
  glyph: {
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: space(2),
  },
  glyphEmoji: { fontSize: 26 },
  glyphInitial: { fontSize: 22, fontWeight: '700' },
  merchant: { ...type.h2, marginTop: space(3), textAlign: 'center' },
  amount: {
    fontSize: 34,
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
    marginTop: space(1),
  },
  flags: { flexDirection: 'row', gap: space(2), marginTop: space(2), marginBottom: space(4) },
  card: {
    alignSelf: 'stretch',
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    padding: layout.cardPad,
    marginBottom: space(3),
  },
  field: { paddingVertical: space(2.5) },
  fieldDivider: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.borderSubtle },
  mono: { fontFamily: 'Menlo', fontSize: 13, color: colors.textMuted },
  statsRow: { flexDirection: 'row', marginTop: space(3) },
  statValue: { fontSize: 17, fontWeight: '600', color: colors.text, fontVariant: ['tabular-nums'], marginTop: 2 },
  linkRow: { marginTop: space(3) },
  link: { color: colors.link, fontSize: 14, fontWeight: '600' },
});
