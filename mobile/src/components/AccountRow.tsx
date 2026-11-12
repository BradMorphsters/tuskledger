/**
 * AccountRow — name + mask/meta on the left, balance right-aligned in
 * tabular-nums. Liability balances render red with an explicit minus.
 * Stale chip appears when the account hasn't synced in a week (the
 * caller decides; manual entries pass staleDays=null to suppress it).
 * With onPress the row is tappable (Dashboard → that account's
 * transactions) and shows a chevron.
 */
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { monthYear } from '../format/dates';
import { colors, formatCurrency, layout, space, type } from '../theme';

interface Props {
  name: string;
  mask?: string | null;
  balance: number;
  liability?: boolean;
  staleDays?: number | null;
  /** Closed accounts: shows "Closed <Mon YYYY>" instead of the balance. */
  closedAt?: string | null;
  onPress?: () => void;
}

export default function AccountRow({
  name,
  mask,
  balance,
  liability = false,
  staleDays,
  closedAt,
  onPress,
}: Props) {
  const closed = closedAt !== undefined && closedAt !== null;
  return (
    <Pressable
      onPress={onPress}
      disabled={!onPress}
      accessibilityRole={onPress ? 'button' : undefined}
      accessibilityHint={onPress ? 'Shows this account’s transactions' : undefined}
      style={({ pressed }) => [styles.row, pressed && onPress ? { opacity: 0.6 } : null]}
      accessibilityLabel={`${name}${mask ? `, ending ${mask}` : ''}, ${closed ? `closed ${monthYear(closedAt)}` : `${liability ? 'owes ' : ''}${formatCurrency(balance)}`}${staleDays != null ? `, ${staleDays} days stale` : ''}`}>
      <View style={styles.left}>
        <Text style={type.body} numberOfLines={1}>
          {name}
        </Text>
        {(mask || staleDays != null || closed) && (
          <View style={styles.metaRow}>
            {mask ? (
              <Text style={[type.small, styles.mask]}>····{mask}</Text>
            ) : null}
            {closed ? (
              <Text style={type.small}>{['Closed', monthYear(closedAt)].filter(Boolean).join(' ')}</Text>
            ) : null}
            {staleDays != null ? (
              <View style={styles.staleBadge}>
                <View style={styles.staleDot} />
                <Text style={styles.staleText}>{staleDays}d stale</Text>
              </View>
            ) : null}
          </View>
        )}
      </View>
      {closed ? (
        <Text style={[styles.balance, { color: colors.textFaint }]}>History</Text>
      ) : (
        <Text
          style={[
            styles.balance,
            { color: liability ? colors.expense : colors.text },
          ]}
          numberOfLines={1}>
          {liability ? '−' : ''}
          {formatCurrency(balance)}
        </Text>
      )}
      {onPress ? <Text style={styles.chevron}>›</Text> : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: layout.minTouch,
    paddingVertical: space(2),
  },
  left: {
    flex: 1,
    flexShrink: 1,
    minWidth: 0,
    paddingRight: space(3),
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 3,
    gap: space(2),
    flexWrap: 'wrap',
  },
  mask: {
    fontVariant: ['tabular-nums'],
  },
  chevron: {
    fontSize: 18,
    color: colors.textFaint,
    marginLeft: space(2),
  },
  balance: {
    fontSize: 16,
    fontWeight: '500',
    fontVariant: ['tabular-nums'],
    textAlign: 'right',
  },
  staleBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: space(1.5),
    paddingVertical: 1,
    borderRadius: 6,
    backgroundColor: colors.warningBg,
  },
  staleDot: {
    width: 5,
    height: 5,
    borderRadius: 3,
    backgroundColor: colors.warning,
  },
  staleText: {
    fontSize: 11,
    fontWeight: '600',
    color: colors.warning,
    letterSpacing: 0.3,
  },
});
