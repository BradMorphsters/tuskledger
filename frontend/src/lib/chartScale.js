/**
 * Y-axis scaling math for value-over-time charts.
 *
 * Recharts' default numeric Y domain is `[0, 'auto']`, which anchors
 * every chart to zero. That is the right call for spending bars, where
 * the bar's LENGTH is the quantity being compared. It is the wrong call
 * for a running balance like net worth: once the balance is large, the
 * month-to-month movement the user actually wants to read is a sliver
 * at the top of the plot area. A $10k move across 30 days on a $500k
 * balance occupies 2% of a zero-based axis and renders as a flat line.
 *
 * `niceDomain` fits the axis to the data instead: pad the observed
 * range by a fraction of its own span, then snap the bounds outward to
 * a round step so the gridlines stay readable. The result is that a
 * small move on a big balance fills the plot, and the axis still shows
 * human numbers rather than 872,036.77.
 *
 * Deliberately dependency-free (no React, no recharts) so it can be
 * unit-tested and run directly under node.
 */

// The multipliers that produce gridlines people read without effort
// ($25k, $50k, $100k — never $37k).
const NICE_MULTIPLIERS = [1, 2, 2.5, 5, 10]

/**
 * Snap `raw` to a "nice" number: one of 1, 2, 2.5, 5 or 10 times a power
 * of ten.
 *
 * @param {number} raw
 * @param {'up'|'nearest'} [mode='up']
 *   'up' never returns less than `raw` — use it when the step must cover
 *   something. 'nearest' may round down, which is what domain fitting
 *   wants: rounding 6.25 up to 10 would snap the axis bounds outward by
 *   as much as two extra steps and undo the zoom we just computed.
 */
export function niceStep(raw, mode = 'up') {
  if (!Number.isFinite(raw) || raw <= 0) return 1
  const exp = Math.floor(Math.log10(raw))
  const pow = Math.pow(10, exp)
  const frac = raw / pow // always in [1, 10)
  let nice
  if (mode === 'nearest') {
    nice = NICE_MULTIPLIERS.reduce(
      (best, m) => (Math.abs(m - frac) < Math.abs(best - frac) ? m : best),
      NICE_MULTIPLIERS[0],
    )
  } else {
    nice = NICE_MULTIPLIERS.find(m => frac <= m) ?? 10
  }
  return nice * pow
}

/**
 * Fit a Y-axis domain to a set of values.
 *
 * @param {number[]} values  every y-value that will be plotted, across
 *                           all series (nulls / undefined are ignored —
 *                           gap-y overlay series pass those freely).
 * @param {object}  [opts]
 * @param {number}  [opts.padRatio=0.08]   headroom above and below, as a
 *                           fraction of the observed span. 8% keeps the
 *                           line off the frame without wasting the plot.
 * @param {number}  [opts.targetTicks=6]   roughly how many gridlines to
 *                           aim for; drives the rounding step. Higher
 *                           means a finer step, which means the snapped
 *                           bounds hug the data more closely.
 * @param {boolean} [opts.clampZero=true]  when every value is >= 0, never
 *                           let the lower bound go negative. A net worth
 *                           that has never been negative should not show
 *                           axis room below zero.
 * @param {number}  [opts.flatRatio=0.02]  when every value is identical,
 *                           open the window to +/- this fraction of the
 *                           value so the flat line sits mid-plot instead
 *                           of on the floor.
 *
 * @returns {{domain: [number, number], min: number, max: number,
 *            span: number, step: number, zoomed: boolean}}
 *   `domain` feeds straight into <YAxis domain={...} />. `span` is the
 *   OBSERVED span (before padding) and drives tick formatting. `zoomed`
 *   is true when the axis excludes zero entirely — the UI uses it to
 *   disclose that the chart is not zero-based, which matters: a
 *   truncated axis exaggerates movement, and the reader deserves to
 *   know that before eyeballing the slope. A series that straddles zero
 *   is NOT flagged: its baseline is already on the chart.
 */
export function niceDomain(values, opts = {}) {
  const {
    padRatio = 0.08,
    targetTicks = 6,
    clampZero = true,
    flatRatio = 0.02,
  } = opts

  const nums = (values || []).filter(v => typeof v === 'number' && Number.isFinite(v))
  if (nums.length === 0) {
    return { domain: [0, 1], min: 0, max: 0, span: 0, step: 1, zoomed: false }
  }

  const min = Math.min(...nums)
  const max = Math.max(...nums)
  const span = max - min

  // Flat (or single-point) series: manufacture a window around the value
  // so the line lands in the middle of the plot rather than on an edge.
  let low, high
  if (span === 0) {
    const magnitude = Math.abs(max)
    const pad = magnitude > 0 ? magnitude * flatRatio : 1
    low = min - pad
    high = max + pad
  } else {
    const pad = span * padRatio
    low = min - pad
    high = max + pad
  }

  // Everything non-negative? Then the axis has no business below zero.
  if (clampZero && min >= 0 && low < 0) low = 0

  // 'nearest' matters here: ceiling the step would routinely double it
  // (a 6.25-unit ideal step becomes 10), and each snap then pushes the
  // bounds out by up to a full extra step on both sides — which is
  // exactly the wasted plot area this function exists to reclaim.
  const step = niceStep((high - low) / Math.max(targetTicks, 1), 'nearest')
  let lower = Math.floor(low / step) * step
  let upper = Math.ceil(high / step) * step

  // Snapping outward can push a clamped floor back below zero.
  if (clampZero && min >= 0 && lower < 0) lower = 0

  // Kill floating-point dust from the divide/multiply above. Do this
  // BEFORE the inversion guard — rounding sub-cent values can collapse
  // the two bounds onto each other, and recharts renders nothing at all
  // for an empty domain.
  lower = Math.round(lower * 100) / 100
  upper = Math.round(upper * 100) / 100

  // Degenerate guard: never hand recharts an inverted or empty domain.
  if (upper <= lower) upper = lower + Math.max(step, 0.01)

  // "Zoomed" = zero is off the chart in one direction or the other.
  const zoomed = lower > 0 || upper < 0

  return { domain: [lower, upper], min, max, span, step, zoomed }
}

/**
 * Currency tick formatter whose precision follows the axis span.
 *
 * A fixed `$${(v/1000).toFixed(0)}k` is fine across a $300k range and
 * useless across a $4k one, where every tick collapses to the same
 * "$500k". Pick the unit and the decimal places from how much ground
 * the axis actually covers.
 *
 * @param {number} span  the OBSERVED span from niceDomain (not padded).
 * @returns {(v: number) => string}
 */
export function currencyTickFormatter(span) {
  const s = Number.isFinite(span) ? Math.abs(span) : 0
  return (v) => {
    if (!Number.isFinite(v)) return ''
    const neg = v < 0
    const abs = Math.abs(v)
    let out
    if (s >= 2_000_000) out = `$${(abs / 1_000_000).toFixed(1)}M`
    else if (s >= 20_000) out = `$${Math.round(abs / 1000)}k`
    else if (s >= 2_000) out = `$${(abs / 1000).toFixed(1)}k`
    else out = `$${Math.round(abs).toLocaleString('en-US')}`
    return neg ? `-${out}` : out
  }
}
