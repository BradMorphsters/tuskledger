/**
 * WeeklyDigestCard — "what happened, what's coming, what changed" for
 * the last 7 days, computed on the laptop (services/weekly_digest.py) and
 * cached on the phone. A compact version of the laptop's /digest page:
 * the spend/income deltas, the notable items worth a raised eyebrow
 * (unusual charges, possible price hikes, first-time merchants), and
 * what's due in the next two weeks.
 *
 * Read-only by design — the action items ("N transfers to pair", "N
 * uncategorized") are shown as a nudge to open the laptop, not as buttons.
 */
import { StyleSheet, Text, View } from 'react-native';
import type { WeeklyDigestWire } from '../sync/types';
import { colors, formatCurrency, formatDate, formatDelta, space, type } from '../theme';
import Card from './Card';
import Chip from './Chip';
import MoneyText from './MoneyText';
import SectionHeader from './SectionHeader';

interface Props {
  digest: WeeklyDigestWire;
}

function pctLabel(pct: number | null): string {
  if (pct == null) return '';
  const sign = pct > 0 ? '+' : '';
  return ` (${sign}${Math.round(pct)}%)`;
}

export default function WeeklyDigestCard({ digest }: Props) {
  const h = digest.happened;
  const n = digest.notable;
  const c = digest.coming;
  const spendUp = h.spend_delta.amount > 0;
  const hasNotable =
    n.large_transactions.length + n.price_hikes.length + n.new_merchants.length > 0;
  const actions = digest.action_items;
  const actionCount = (actions?.unpaired_transfers?.count ?? 0) + (actions?.uncategorized?.count ?? 0);

  return (
    <>
      <SectionHeader
        label="This week"
        right={
          <Text style={type.small}>
            {formatDate(digest.week_start)} – {formatDate(digest.week_end)}
          </Text>
        }
      />
      <Card>
        {/* ── Happened ─────────────────────────────────────────── */}
        <View style={styles.twoCol}>
          <View style={styles.col}>
            <Text style={type.caption}>Spent</Text>
            <MoneyText value={h.spend} size="title" style={{ marginTop: space(1) }} />
            <Text style={[type.small, { marginTop: space(0.5), color: spendUp ? colors.expense : colors.income }]}>
              {formatDelta(h.spend_delta.amount)}{pctLabel(h.spend_delta.pct)} vs last week
            </Text>
          </View>
          <View style={[styles.col, { alignItems: 'flex-end' }]}>
            <Text style={type.caption}>Income</Text>
            <MoneyText value={h.income} size="title" tone="income" style={{ marginTop: space(1) }} />
            <Text style={[type.small, { marginTop: space(0.5) }]}>
              {h.transaction_count} transactions
            </Text>
          </View>
        </View>

        {h.top_categories.length > 0 && (
          <View style={styles.chips}>
            {h.top_categories.slice(0, 3).map((cat) => (
              <Chip
                key={cat.category}
                label={`${cat.category} ${formatCurrency(cat.amount)}`}
                small
                tone={cat.delta > 0 ? 'expense' : 'neutral'}
              />
            ))}
          </View>
        )}

        {/* ── Notable ──────────────────────────────────────────── */}
        {hasNotable && (
          <>
            <View style={styles.divider} />
            <Text style={type.caption}>Worth a look</Text>
            {n.large_transactions.slice(0, 3).map((t, i) => (
              <Row
                key={`l-${t.merchant}-${i}`}
                left={t.merchant}
                sub={`unusually large · usually ${formatCurrency(t.typical_amount)}`}
                right={formatCurrency(t.amount)}
                tone={colors.expense}
              />
            ))}
            {n.price_hikes.slice(0, 3).map((p, i) => (
              <Row
                key={`p-${p.merchant}-${i}`}
                left={p.merchant}
                sub={`possible price hike · up ${Math.round(p.delta_pct)}% from ${formatCurrency(p.typical_amount)}`}
                right={formatCurrency(p.latest_amount)}
                tone={colors.warning}
              />
            ))}
            {n.new_merchants.slice(0, 3).map((m, i) => (
              <Row
                key={`n-${m.merchant}-${i}`}
                left={m.merchant}
                sub="first time here"
                right={formatCurrency(m.amount)}
              />
            ))}
          </>
        )}

        {/* ── Coming ───────────────────────────────────────────── */}
        {c.bills.length > 0 && (
          <>
            <View style={styles.divider} />
            <Text style={type.caption}>Next two weeks</Text>
            {c.bills.slice(0, 4).map((b, i) => (
              <Row
                key={`b-${b.name}-${b.date}-${i}`}
                left={b.name}
                sub={b.days_until <= 0 ? 'due now' : `due ${formatDate(b.date)} · in ${b.days_until}d`}
                right={b.amount != null ? formatCurrency(b.amount) : '—'}
                tone={b.days_until <= 3 ? colors.warning : undefined}
              />
            ))}
          </>
        )}

        {/* ── Budget + net worth one-liners ────────────────────── */}
        {(digest.budget_status || digest.net_worth?.delta != null) && (
          <View style={styles.divider} />
        )}
        {digest.budget_status && (
          <Text style={type.small}>
            Budget: {digest.budget_status.on_pace} of {digest.budget_status.lines} categories on pace
            {digest.budget_status.over_pace.length > 0
              ? ` · over on ${digest.budget_status.over_pace.slice(0, 2).map((o) => o.category).join(', ')}`
              : ''}
          </Text>
        )}
        {digest.net_worth?.delta != null && (
          <Text style={[type.small, { marginTop: digest.budget_status ? space(1) : 0 }]}>
            Net worth {formatDelta(digest.net_worth.delta)} since {formatDate(digest.net_worth.prior_date ?? digest.net_worth.date)}
          </Text>
        )}

        {actionCount > 0 && (
          <Text style={[type.small, { marginTop: space(3), color: colors.textFaint }]}>
            On your laptop: {actions.unpaired_transfers.count > 0 ? `${actions.unpaired_transfers.count} transfer${actions.unpaired_transfers.count === 1 ? '' : 's'} to pair` : ''}
            {actions.unpaired_transfers.count > 0 && actions.uncategorized.count > 0 ? ' · ' : ''}
            {actions.uncategorized.count > 0 ? `${actions.uncategorized.count} uncategorized` : ''}
          </Text>
        )}
      </Card>
    </>
  );
}

function Row({ left, sub, right, tone }: { left: string; sub: string; right: string; tone?: string }) {
  return (
    <View style={styles.row} accessibilityLabel={`${left}, ${right}, ${sub}`}>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={type.body} numberOfLines={1}>{left}</Text>
        <Text style={[type.small, tone ? { color: tone } : null]} numberOfLines={1}>{sub}</Text>
      </View>
      <Text style={[type.body, styles.tabular, tone ? { color: tone } : null]}>{right}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  twoCol: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: space(3),
  },
  col: { flex: 1, minWidth: 0 },
  chips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: space(2),
    marginTop: space(3),
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.border,
    marginVertical: space(3),
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space(3),
    marginTop: space(2.5),
  },
  tabular: { fontVariant: ['tabular-nums'] },
});
