/**
 * Spending-pace math — the pure core of `spendingPace()` in queries.ts.
 *
 * Kept free of any RN / expo-sqlite import so it can be unit-tested with
 * plain Node (see scripts/test-pace.mjs). queries.ts runs the SQL that
 * produces daily gross-spend sums, then hands them here; ALL of the
 * calendar/cumulative/average math lives in this file.
 *
 * The math mirrors the laptop's `spending_trend()`
 * (backend/app/routers/analytics.py) exactly — same baseline window,
 * same per-month cumulative-by-day curve with the month-length clamp,
 * same "drop months with no data from the average" rule, same
 * delta/pct/projection formulas. The only intentional divergence is that
 * the phone tile omits the recurring-income baseline line.
 */

export interface PacePoint {
  day: number;
  baseline: number;
  /** null for days after today (local time). */
  mtd: number | null;
}

export interface SpendingPace {
  points: PacePoint[];
  mtdTotal: number;
  baselineToDate: number;
  baselineFull: number;
  /** mtdTotal − baselineToDate. Positive = spending more than usual. */
  delta: number;
  /** delta / baselineToDate * 100, one decimal; null when baseline is 0. */
  pct: number | null;
  /** mtdTotal / baselineToDate * baselineFull; null when baseline is 0. */
  projected: number | null;
  /** Count of prior months actually averaged (2..4). */
  baselineWindow: number;
  /** Day of month (local). */
  today: number;
  daysInMonth: number;
  /** 1-12 (local). */
  month: number;
}

/** One day's gross spend, as produced by the GROUP BY date query. */
export interface DailySpendRow {
  date: string; // YYYY-MM-DD
  total: number;
}

/** Round to cents, matching the backend's `round(x, 2)`. */
const round2 = (x: number): number => Math.round(x * 100) / 100;

const pad2 = (n: number): string => String(n).padStart(2, '0');

/** Days in calendar month (mm is 1-based). */
const daysIn = (yy: number, mm: number): number => new Date(yy, mm, 0).getDate();

/**
 * Compute the spending-pace tile model from daily gross-spend sums.
 *
 * @param rows daily sums (`amount > 0 AND is_transfer = 0`, GROUP BY date)
 *   spanning the earliest baseline month start through today.
 * @param now  LOCAL device time — defines today / the month boundaries.
 * @returns the tile model, or null when fewer than 2 of the prior 4
 *   calendar months have any spend rows (a 1-month "average" misleads).
 */
export function computePace(rows: DailySpendRow[], now: Date): SpendingPace | null {
  const cy = now.getFullYear();
  const cm = now.getMonth() + 1;
  const cd = now.getDate();
  const daysInMonth = daysIn(cy, cm);

  // The 4 calendar months before the current (partial) one, oldest → newest.
  const baselineMonths: [number, number][] = [];
  let y = cy;
  let m = cm;
  for (let i = 0; i < 4; i++) {
    m -= 1;
    if (m === 0) {
      m = 12;
      y -= 1;
    }
    baselineMonths.push([y, m]);
  }
  baselineMonths.reverse();

  // Daily lookup. rows are already one-per-date, but accumulate defensively.
  const byDay = new Map<string, number>();
  for (const r of rows) {
    byDay.set(r.date, (byDay.get(r.date) ?? 0) + r.total);
  }

  /**
   * Cumulative spend in (yy, mm) through `uptoDay` (inclusive). `uptoDay`
   * is clamped to the month's own length, so a 30-day month's curve is
   * flat after day 30 — matching the backend's `_cum`.
   */
  const cum = (yy: number, mm: number, uptoDay: number): number => {
    const end = Math.min(uptoDay, daysIn(yy, mm));
    let s = 0;
    for (let day = 1; day <= end; day++) {
      s += byDay.get(`${yy}-${pad2(mm)}-${pad2(day)}`) ?? 0;
    }
    return round2(s);
  };

  // Only average over baseline months that actually have spend rows — a
  // missing month would otherwise contribute 0 and drag the baseline down.
  const present = new Set<string>();
  for (const r of rows) present.add(r.date.slice(0, 7));
  const avgMonths = baselineMonths.filter(([yy, mm]) =>
    present.has(`${yy}-${pad2(mm)}`),
  );

  // A 1-month baseline is a misleading "average" — hide the tile.
  if (avgMonths.length < 2) return null;

  const points: PacePoint[] = [];
  for (let day = 1; day <= daysInMonth; day++) {
    const baseVals = avgMonths.map(([yy, mm]) => cum(yy, mm, day));
    const baseline = round2(
      baseVals.reduce((a, b) => a + b, 0) / baseVals.length,
    );
    const mtd = day <= cd ? cum(cy, cm, day) : null;
    points.push({ day, baseline, mtd });
  }

  const mtdTotal = cum(cy, cm, cd);
  const baselineToDate =
    cd > 0 && cd <= points.length ? points[cd - 1].baseline : 0;
  const baselineFull = points.length ? points[points.length - 1].baseline : 0;
  const delta = round2(mtdTotal - baselineToDate);
  const pct =
    baselineToDate !== 0
      ? Math.round((delta / baselineToDate) * 100 * 10) / 10
      : null;
  const projected =
    baselineToDate !== 0
      ? round2((mtdTotal / baselineToDate) * baselineFull)
      : null;

  return {
    points,
    mtdTotal,
    baselineToDate,
    baselineFull,
    delta,
    pct,
    projected,
    baselineWindow: avgMonths.length,
    today: cd,
    daysInMonth,
    month: cm,
  };
}
