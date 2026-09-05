/**
 * SafeToSpendCard — the one number a "can I buy this?" moment needs,
 * plus the input that answers it.
 *
 * The estimate itself comes from the laptop (services/safe_to_spend.py,
 * cached via insights/store) — the phone never re-derives paycheck
 * cadence or bill de-dup. What the phone adds is the moment-of-decision
 * layer: type an amount, see the verdict instantly, offline, from the
 * cached breakdown (insights/afford.ts).
 *
 * Layout: headline number + "until <payday>" · an amount field ·
 * a verdict line · a collapsible breakdown (checking − bills − usual),
 * with the laptop's own caveat notes at the bottom so a confident
 * number never hides its assumptions.
 */
import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { affordability, parseAmount, type AffordResult } from '../insights/afford';
import type { SafeToSpendWire } from '../sync/types';
import { colors, formatCurrency, formatDate, radius, space, type } from '../theme';
import Card from './Card';
import MoneyText from './MoneyText';
import SectionHeader from './SectionHeader';

interface Props {
  data: SafeToSpendWire;
  /** ISO timestamp the payload was generated (for the footer). */
  generatedAt?: string;
}

function verdictCopy(r: AffordResult, data: SafeToSpendWire): { title: string; detail: string; color: string } {
  const payday = formatDate(data.next_paycheck_date);
  switch (r.verdict) {
    case 'yes':
      return {
        title: 'Yes',
        detail: `Leaves ${formatCurrency(r.remaining)} safe to spend until ${payday}.`,
        color: colors.income,
      };
    case 'tight':
      return {
        title: 'Tight',
        detail: `Covered, but it uses ${formatCurrency(r.allowanceUsed)} of your usual spending before ${payday} — you'd need to spend less than normal on everything else.`,
        color: colors.warning,
      };
    default:
      return {
        title: r.usesSavings ? 'No — not even with savings' : r.dipsIntoBills ? 'No — it cuts into bills' : 'No',
        detail: r.dipsIntoBills
          ? `After this, checking wouldn't cover the ${formatCurrency(data.bills_due)} in bills due before ${payday}.`
          : `That's ${formatCurrency(-r.remaining)} more than what's safe to spend before ${payday}.`,
        color: colors.expense,
      };
  }
}

export default function SafeToSpendCard({ data, generatedAt }: Props) {
  const [text, setText] = useState('');
  const [showBreakdown, setShowBreakdown] = useState(false);

  const amount = useMemo(() => parseAmount(text), [text]);
  const result = useMemo(
    () =>
      amount == null
        ? null
        : affordability(
            {
              safeToSpend: data.safe_to_spend,
              usualSpending: data.budget_remaining_pro_rata,
              spendableCash: data.spendable_cash,
              billsDue: data.bills_due,
              savingsCash: data.savings_cash,
            },
            amount,
          ),
    [amount, data],
  );

  const positive = data.safe_to_spend >= 0;
  const payday = formatDate(data.next_paycheck_date);
  const paydayLabel =
    data.next_paycheck_source === 'recurring_income'
      ? `until payday · ${payday}`
      : `until ${payday} (no paycheck detected — assuming the 1st)`;
  const usualLabel =
    data.budget_source === 'trailing_average'
      ? '90-day avg'
      : data.budget_source === 'mixed'
        ? 'mixed'
        : data.budget_source === 'none'
          ? 'no history'
          : 'budget';

  return (
    <>
      <SectionHeader
        label="Safe to spend"
        right={<Text style={type.small}>estimate</Text>}
      />
      <Card elevated>
        <View accessibilityLabel={`Safe to spend ${formatCurrency(data.safe_to_spend)} ${paydayLabel}`}>
          <MoneyText
            value={data.safe_to_spend}
            size="display"
            tone={positive ? 'income' : 'expense'}
            whole
          />
          <Text style={[type.small, { marginTop: space(1) }]}>{paydayLabel}</Text>
        </View>

        {/* ── Can I afford this? ─────────────────────────────────── */}
        <View style={styles.askRow}>
          <Text style={styles.dollar}>$</Text>
          <TextInput
            value={text}
            onChangeText={setText}
            placeholder="Can I afford…"
            placeholderTextColor={colors.textFaint}
            keyboardType="decimal-pad"
            returnKeyType="done"
            style={styles.input}
            accessibilityLabel="Amount to check"
            accessibilityHint="Type a purchase amount to see whether it fits before payday"
          />
          {text.length > 0 && (
            <Pressable
              onPress={() => setText('')}
              accessibilityRole="button"
              accessibilityLabel="Clear amount"
              hitSlop={8}>
              <Text style={styles.clear}>×</Text>
            </Pressable>
          )}
        </View>
        {result && (() => {
          const v = verdictCopy(result, data);
          return (
            <View
              style={[styles.verdict, { borderColor: v.color }]}
              accessibilityLiveRegion="polite"
              accessibilityLabel={`${v.title}. ${v.detail}`}>
              <Text style={[type.h2, { color: v.color }]}>{v.title}</Text>
              <Text style={[type.small, { marginTop: space(1), color: colors.text }]}>{v.detail}</Text>
            </View>
          );
        })()}

        {/* ── Breakdown ──────────────────────────────────────────── */}
        <Pressable
          onPress={() => setShowBreakdown((s) => !s)}
          style={styles.toggle}
          accessibilityRole="button"
          accessibilityState={{ expanded: showBreakdown }}>
          <Text style={[type.small, { color: colors.link }]}>
            {showBreakdown ? 'Hide breakdown' : 'How this was calculated'}
          </Text>
        </Pressable>
        {showBreakdown && (
          <View style={{ marginTop: space(2) }}>
            <Line label="Checking cash" value={data.spendable_cash} />
            <Line label={`− Bills due before ${payday}`} value={-data.bills_due} />
            <Line label={`− Usual spending (${usualLabel})`} value={-data.budget_remaining_pro_rata} />
            <View style={styles.divider} />
            <Line label="Safe to spend" value={data.safe_to_spend} bold />
            {data.savings_cash > 0 && (
              <Text style={[type.small, { marginTop: space(2) }]}>
                + {formatCurrency(data.savings_cash)} in savings, not counted.
              </Text>
            )}
            {data.bills.length > 0 && (
              <View style={{ marginTop: space(3) }}>
                <Text style={type.caption}>Bills before payday</Text>
                {data.bills.slice(0, 6).map((b, i) => (
                  <View key={`${b.name}-${b.date}-${i}`} style={styles.billRow}>
                    <Text style={[type.small, { flex: 1, color: colors.text }]} numberOfLines={1}>
                      {b.name}
                    </Text>
                    <Text style={type.small}>{formatDate(b.date)}</Text>
                    <MoneyText value={b.amount} size="small" style={{ marginLeft: space(3) }} />
                  </View>
                ))}
              </View>
            )}
            {data.notes.map((n) => (
              <Text key={n} style={[type.small, { marginTop: space(2), color: colors.textFaint }]}>
                {n}
              </Text>
            ))}
            {generatedAt && (
              <Text style={[type.small, { marginTop: space(2), color: colors.textFaint }]}>
                Computed on your laptop at last sync.
              </Text>
            )}
          </View>
        )}
      </Card>
    </>
  );
}

function Line({ label, value, bold = false }: { label: string; value: number; bold?: boolean }) {
  return (
    <View style={styles.line}>
      <Text style={[type.small, bold && { color: colors.text, fontWeight: '600' }]} numberOfLines={1}>
        {label}
      </Text>
      <MoneyText value={value} size="small" tone={bold ? 'auto' : 'neutral'} style={bold ? { fontWeight: '700' } : undefined} />
    </View>
  );
}

const styles = StyleSheet.create({
  askRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: space(4),
    backgroundColor: colors.bg,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: space(3),
    minHeight: 44,
  },
  dollar: {
    ...type.body,
    color: colors.textMuted,
    marginRight: space(1),
  },
  input: {
    flex: 1,
    ...type.body,
    fontVariant: ['tabular-nums'],
    paddingVertical: space(2.5),
  },
  clear: {
    fontSize: 20,
    color: colors.textMuted,
    paddingHorizontal: space(1),
  },
  verdict: {
    marginTop: space(3),
    padding: space(3),
    borderRadius: radius.md,
    borderLeftWidth: 3,
    backgroundColor: colors.bg,
  },
  toggle: {
    marginTop: space(3),
    minHeight: 32,
    justifyContent: 'center',
  },
  line: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    gap: space(3),
    marginTop: space(1.5),
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.border,
    marginVertical: space(2),
  },
  billRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: space(2),
    marginTop: space(1.5),
  },
});
