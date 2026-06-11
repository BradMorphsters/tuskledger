/**
 * AccountRow — name + mask/meta on the left, balance right-aligned in
 * tabular-nums. Liability balances render red with an explicit minus.
 * Stale chip appears when the account hasn't synced in a week (the
 * caller decides; manual entries pass staleDays=null to suppress it).
 */
import { StyleSheet, Text, View } from 'react-native';
import { colors, formatCurrency, layout, space, type } from '../theme';

interface Props {
  name: string;
  mask?: string | null;
  balance: number;
  liability?: boolean;
  staleDays?: number | null;
}

export default function AccountRow({
  name,
  mask,
  balance,
  liability = false,
  staleDays,
}: Props) {
  return (
    <View
      style={styles.row}
      accessibilityLabel={`${name}${mask ? `, ending ${mask}` : ''}, ${liability ? 'owes ' : ''}${formatCurrency(balance)}${staleDays != null ? `, ${staleDays} days stale` : ''}`}>
      <View style={styles.left}>
        <Text style={type.body} numberOfLines={1}>
          {name}
        </Text>
        {(mask || staleDays != null) && (
          <View style={styles.metaRow}>
            {mask ? (
              <Text style={[type.small, styles.mask]}>····{mask}</Text>
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
      <Text
        style={[
          styles.balance,
          { color: liability ? colors.expense : colors.text },
        ]}
        numberOfLines={1}>
        {liability ? '−' : ''}
        {formatCurrency(balance)}
      </Text>
    </View>
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
