/**
 * AccountsBreakdown — per-account balance section for the Dashboard.
 *
 * Visual design:
 *
 *   - Each account-type group renders as its OWN card. Cramming all
 *     four groups into one card (the v1 layout) made the screen feel
 *     dense and made it hard to scan to "just the credit cards."
 *     Separate cards give each group its own visual region with room
 *     to breathe.
 *
 *   - Per-group color accent lives in a thin stripe + the group
 *     header text. The whole card stays neutral so a stack of four
 *     cards reads as one composition rather than a circus.
 *
 *   - Account rows: account name large, mask + stale indicator
 *     small/muted underneath, balance right-aligned in tabular-nums.
 *     Mirrors how Apple Wallet / Apple Card / Monarch lay out
 *     transactions.
 *
 *   - Group subtotal sits at the bottom of each card with a divider
 *     above it — visually anchors the group total without needing
 *     to scan back up to the header to do the math.
 *
 *   - Final "Net (Plaid only)" card stands alone, bigger, bolder.
 *     Explicitly labeled to distinguish from the headline net-worth
 *     card above (which folds in manual_assets).
 */
import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import {
  AccountBreakdownGroup,
  accountsBreakdown,
} from '../db/queries';
import { useSyncStore } from '../sync/manager';
import { colors, formatCurrency, radius, space, type } from '../theme';

const STALE_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000;

function staleDays(updatedAt: string | null): number | null {
  if (!updatedAt) return null;
  const ms = Date.now() - new Date(updatedAt).getTime();
  if (!Number.isFinite(ms) || ms < STALE_THRESHOLD_MS) return null;
  return Math.floor(ms / (24 * 60 * 60 * 1000));
}

// Color accent per group. Kept subtle (single hue, used only on the
// stripe + header text + subtotal) so a stack of four cards reads as
// a unified composition. Cash gets the income green, credit gets a
// warning orange, etc. — the same semantic palette the rest of the
// app uses, so the color tells you something instead of being decor.
function accentForKey(key: string): string {
  switch (key) {
    case 'depository': return colors.income;
    case 'investment': return colors.accent;
    case 'credit':     return colors.warning;
    case 'loan':       return colors.expense;
    default:           return colors.textMuted;
  }
}

// Plain-English subtitle for each group. The count alone ("3
// accounts") feels mechanical; pairing it with a one-line description
// of what the bucket *means* keeps the visual hierarchy human.
function subtitleForKey(key: string): string {
  switch (key) {
    case 'depository': return 'Checking, savings, money market';
    case 'investment': return 'Brokerage, retirement, HSA';
    case 'credit':     return 'Credit cards';
    case 'loan':       return 'Mortgage, auto, student';
    default:           return '';
  }
}

export default function AccountsBreakdown() {
  const dataVersion = useSyncStore((s) => s.dataVersion);
  const [groups, setGroups] = useState<AccountBreakdownGroup[]>([]);

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

  return (
    <>
      {/* Section heading lives outside the cards so each card can have
          its own header without competing with a wrapper title. */}
      <View style={styles.sectionHeading}>
        <Text style={type.caption}>ACCOUNTS</Text>
        <Text style={[type.small, { marginTop: space(1) }]}>
          {groups.reduce((s, g) => s + g.items.length, 0)} synced
        </Text>
      </View>

      {groups.map((g) => (
        <GroupCard key={g.key} group={g} accent={accentForKey(g.key)} />
      ))}

      {/* Net (Plaid only) — the headline summary card. Visually heavier
          than the per-group cards via a thicker border-top accent and
          bigger headline number, so the eye lands here at the end of
          the section. */}
      <View style={[styles.netCard, { borderTopColor: net >= 0 ? colors.income : colors.expense }]}>
        <View style={{ flex: 1 }}>
          <Text style={type.caption}>NET (PLAID ONLY)</Text>
          <Text style={[type.small, { marginTop: 2 }]}>
            Excludes manual assets · see Net Worth above
          </Text>
        </View>
        <Text
          style={[
            type.display,
            {
              fontVariant: ['tabular-nums'],
              color: net >= 0 ? colors.text : colors.expense,
            },
          ]}>
          {formatCurrency(net)}
        </Text>
      </View>
    </>
  );
}

function GroupCard({
  group,
  accent,
}: {
  group: AccountBreakdownGroup;
  accent: string;
}) {
  const subtitle = subtitleForKey(group.key);
  return (
    <View style={styles.card}>
      {/* Color stripe along the left edge — subtle visual anchor for
          the group, matches the accent in the header text. Two pixels
          wide so it's noticeable without being loud. */}
      <View style={[styles.accentStripe, { backgroundColor: accent }]} />

      <View style={styles.cardBody}>
        {/* Group header — label in accent color (so the eye associates
            color with category), count + subtotal right-aligned. The
            subtotal here is a quick read; full per-account detail is
            below. */}
        <View style={styles.groupHeader}>
          <View style={{ flex: 1, paddingRight: space(2) }}>
            <Text style={[styles.groupTitle, { color: accent }]}>
              {group.label}
            </Text>
            {subtitle ? (
              <Text style={[type.small, { marginTop: 2 }]}>
                {subtitle}
              </Text>
            ) : null}
          </View>
          <View style={{ alignItems: 'flex-end' }}>
            <Text
              style={[
                type.h2,
                {
                  fontVariant: ['tabular-nums'],
                  color:
                    group.side === 'liability' ? colors.expense : colors.text,
                },
              ]}>
              {group.side === 'liability' ? '−' : ''}
              {formatCurrency(group.subtotal)}
            </Text>
            <Text style={[type.caption, { marginTop: 2 }]}>
              {group.items.length} {group.items.length === 1 ? 'ACCOUNT' : 'ACCOUNTS'}
            </Text>
          </View>
        </View>

        {/* Account rows. Generous vertical padding (12pt) so a finger
            could plausibly tap these to drill in later. Hairline
            divider between rows, no divider on the last row before
            the bottom of the card. */}
        <View style={styles.accountList}>
          {group.items.map((a, i) => {
            const days = staleDays(a.updated_at);
            return (
              <View
                key={a.id}
                style={[
                  styles.accountRow,
                  i === 0
                    ? null
                    : {
                        borderTopWidth: StyleSheet.hairlineWidth,
                        borderTopColor: colors.border,
                      },
                ]}>
                <View style={{ flex: 1, paddingRight: space(3), minWidth: 0 }}>
                  <Text style={type.body} numberOfLines={1}>
                    {a.name}
                  </Text>
                  <View style={styles.metaRow}>
                    {a.mask ? (
                      <Text style={[type.small, styles.metaText]}>
                        ····{a.mask}
                      </Text>
                    ) : null}
                    {days != null ? (
                      <View style={styles.staleBadge}>
                        <View style={styles.staleDot} />
                        <Text style={styles.staleText}>
                          {days}d stale
                        </Text>
                      </View>
                    ) : null}
                  </View>
                </View>
                <Text
                  style={[
                    type.h2,
                    {
                      fontVariant: ['tabular-nums'],
                      color:
                        group.side === 'liability'
                          ? colors.expense
                          : colors.text,
                    },
                  ]}>
                  {group.side === 'liability' ? '−' : ''}
                  {formatCurrency(a.current_balance)}
                </Text>
              </View>
            );
          })}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  sectionHeading: {
    marginTop: space(6),
    marginBottom: space(3),
  },
  card: {
    flexDirection: 'row',
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: 'hidden',
    marginBottom: space(3),
  },
  accentStripe: {
    width: 3,
  },
  cardBody: {
    flex: 1,
    padding: space(5),
  },
  groupHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingBottom: space(4),
  },
  groupTitle: {
    fontSize: 13,
    fontWeight: '700',
    letterSpacing: 1.2,
    textTransform: 'uppercase',
  },
  accountList: {
    marginTop: 0,
  },
  accountRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: space(3),
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 4,
    gap: space(2),
    flexWrap: 'wrap',
  },
  metaText: {
    color: colors.textMuted,
    fontVariant: ['tabular-nums'],
  },
  staleBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: space(2),
    paddingVertical: 2,
    borderRadius: radius.sm,
    backgroundColor: 'rgba(255, 180, 84, 0.10)',
    borderWidth: 1,
    borderColor: 'rgba(255, 180, 84, 0.35)',
  },
  staleDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.warning,
  },
  staleText: {
    fontSize: 11,
    fontWeight: '600',
    color: colors.warning,
    letterSpacing: 0.4,
  },
  netCard: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: colors.surfaceElevated,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    borderTopWidth: 3,
    padding: space(5),
    marginTop: space(2),
    marginBottom: space(3),
  },
});
