/**
 * Retirement Projection page.
 *
 * Originally lived inside Net Worth as one widget, but the projection
 * feature has grown to encompass: per-bucket withdrawal simulation,
 * staged income onset (pension + 2 SS streams), tax modeling, RMDs,
 * spending phases, healthcare bridge, sensitivity analysis, and
 * extensive disclosures. It's a top-level concern in its own right
 * — separating it gives users a dedicated mental space for retirement
 * planning without competing with the more day-to-day Net Worth
 * dashboard.
 *
 * The actual logic + form + chart all live in the RetirementProjection
 * component; this page is purely the route wrapper.
 */
import RetirementProjection from '../components/RetirementProjection'

export default function Retirement() {
  return (
    <div style={{ padding: '0 4px' }}>
      <RetirementProjection />
    </div>
  )
}
