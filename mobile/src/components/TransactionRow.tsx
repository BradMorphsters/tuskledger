/**
 * TransactionRow — the canonical transaction list row.
 *
 *   [glyph circle]  Merchant name             amount
 *                   Jun 9 · Groceries · Chase
 *
 * Amount semantics follow Plaid: positive = money out, negative =
 * money in. Income renders green with an explicit +; transfers render
 * muted; pending rows dim and italicize the amount.
 *
 * Read-only by design — the row is not pressable (there is no detail
 * screen to push, and the phone never edits).
 */
import { StyleSheet, Text, View } from 'react-native';
import type { TransactionRow as Tx } from '../db/queries';
import {
  colors,
  formatCurrency,
  formatDate,
  layout,
  space,
  type,
} from '../theme';
import { categoryGlyph } from './categoryGlyph';

interface Props {
  tx: Tx;
  /** Hide the account label when the list is already account-scoped. */
  showAccount?: boolean;
}

export default function TransactionRow({ tx, showAccount = true }: Props) {
  const isIncome = tx.amount < 0;
  const glyph = categoryGlyph(tx.effective_category);

  const meta = [
    formatDate(tx.date),
    tx.effective_category,
    showAccount && tx.account_label ? tx.account_label : null,
  ]
    .filter(Boolean)
    .join(' · ');

  const amountColor = tx.is_transfer
    ? colors.textMuted
    : isIncome
      ? colors.income
      : colors.text;

  return (
    <View
      style={[styles.row, tx.pending && styles.pendingRow]}
      accessibilityLabel={`${tx.effective_name}, ${formatCurrency(Math.abs(tx.amount))}${isIncome ? ' received' : ''}, ${meta}${tx.pending ? ', pending' : ''}`}>
      <View style={[styles.glyph, { backgroundColor: glyph.bg }]}>
        {glyph.emoji ? (
          <Text style={styles.glyphEmoji}>{glyph.emoji}</Text>
        ) : (
          <Text style={[styles.glyphInitial, { color: glyph.fg }]}>
            {glyph.initial}
          </Text>
        )}
      </View>
      <View style={styles.middle}>
        <Text style={type.body} numberOfLines={1}>
          {tx.effective_name}
        </Text>
        <Text style={[type.small, styles.meta]} numberOfLines={1}>
          {meta}
          {tx.pending ? ' · pending' : ''}
        </Text>
      </View>
      <Text
        style={[
          styles.amount,
          { color: amountColor },
          tx.pending && styles.pendingAmount,
        ]}
        numberOfLines={1}>
        {isIncome ? '+' : ''}
        {formatCurrency(-tx.amount)}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: layout.minTouch + 8,
    paddingVertical: space(2.5),
  },
  pendingRow: {
    opacity: 0.65,
  },
  glyph: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: space(3),
  },
  glyphEmoji: { fontSize: 17 },
  glyphInitial: { fontSize: 16, fontWeight: '700' },
  middle: {
    flex: 1,
    flexShrink: 1,
    minWidth: 0,
    marginRight: space(3),
  },
  meta: { marginTop: 2 },
  amount: {
    fontSize: 16,
    fontVariant: ['tabular-nums'],
    textAlign: 'right',
  },
  pendingAmount: {
    fontStyle: 'italic',
  },
});
