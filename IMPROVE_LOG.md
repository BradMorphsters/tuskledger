# Tusk Ledger — Improvement Log

Memory for `IMPROVE_LOOP.md`. Newest pass on top. The scorecard is the source of truth for
"where are we"; the seed backlog is a warm start, not a queue — every pass re-scores first.

**This file is committed to a public repo.** No real balances, amounts, employer names,
account names or raw bank descriptors — ids, percentages and generic descriptions only.

---

## Scorecard

Scores are 1–5 against best-in-class (see rubric in `IMPROVE_LOOP.md`). Baseline set in Pass 1
(2026-09-05). A pass that doesn't examine a dimension carries its score forward and marks it
*(carried)* / *(provisional)*.

| # | Dimension | Score | One-line reason | Highest-leverage gap |
|---|---|---|---|---|
| D1 | Data trust | 3 | Transfer pairing + issuer patterns work; Pulse's hardcoded budget component removed this pass. Still: refunds bucketed as income; CSV importer emits categories outside the taxonomy; unpaired `TRANSFER_OUT` outflows count as spend. | Canonical category taxonomy at import + refund-as-negative-spend. |
| D2 | Insight density | 3 | Spending & Income (presets, deltas, pace) and the fitted Net Worth axis are strong; Budgets page hides unbudgeted categories (8–17% of a month's spend). | "Unbudgeted" section on Budgets. |
| D3 | Speed | 4 *(provisional)* | ~1k rows; in-window full fetches are fine at this scale. Not measured against a live server. | Measure once a sandbox backend boot exists. |
| D4 | Polish & consistency | 3 | Skeleton loading in 3/25 pages, EmptyState in 8/25, 8 clickable `<div>`s. | Loading/empty states on the remaining pages. |
| D5 | Workflow completeness | **3** ↑ from 2 | Budgets now carry forward automatically; alerts fire; Pulse adherence is real. Still no "set budget" from an unbudgeted category, no rule suggestion on recategorize. | Unbudgeted rollup with one-click Set budget. |
| D6 | Reliability & recovery | 3 | Daily snapshots (gaps: 124×1d, 3×2d, 1×3d), daily backups, freshness UI. A silently-dead feature (alerts) was found and fixed — others may exist. | Smoke test that each promised background feature actually fires. |
| D7 | First-run & OSS on-ramp | 3 *(provisional)* | `doctor`, demo mode, one-shot `start.sh`; not timed on a clean machine. | Time clone → dashboard. |
| D8 | Financial correctness | 4 *(provisional)* | Six audit passes + tests; not re-examined. | — |
| D9 | Accessibility | 2 | 26 aria-labels across 254 buttons, 5 keyboard handlers, no chart text alternatives. | Keyboard + labels on the transaction table and drawers. |
| D10 | Assistant quality | 3 *(provisional)* | Not exercised this pass. | — |

---|---|---|---|---|
| D1 | Data trust | — | | |
| D2 | Insight density | — | | |
| D3 | Speed | — | | |
| D4 | Polish & consistency | — | | |
| D5 | Workflow completeness | — | | |
| D6 | Reliability & recovery | — | | |
| D7 | First-run & OSS on-ramp | — | | |
| D8 | Financial correctness | — | | |
| D9 | Accessibility | — | | |
| D10 | Assistant quality | — | | |

---

## Decisions (Eduardo's standing calls)

- 2026-09-05 — Net Worth chart: "as it goes from 0 and up it should do more of a tighter zoom
  in … so you can actually see the increase or decrease." → fitted axis shipped; keep it.
- 2026-09-05 — Two linked accounts share a display name because one bank is being wound down
  and its balance will move to the active one. Both are real; don't merge or unlink.
- 2026-09-05 (Pass 1) — Approved items 1–3 of the D5 theme; did NOT select "4 · Unbudgeted
  section + 5 · CSV category canonicalization". Treat 4 and 5 as deferred (not rejected) —
  they were bundled in one option.

---

## Passes

### 2026-09-05 — Pass 1 · D5 "Budgets that keep working without you"

**Ground truth used:** real DB read-only (988 txns, 23 accounts, 129 net-worth snapshots,
7 monthly budgets Feb–Aug, 0 for September on the 5th); every page and tile read; no live
server (sandbox has no disk for a venv), so latency was not measured.

**Shipped (3/3 approved):**

1. **Budgets carry forward automatically.** `services/budget_carry.py` clones the latest
   prior month into the current month when it has none — at startup, daily at 00:10, and
   lazily on `GET /budgets/{m}/{y}` for the current month only. Migration 0019 adds
   `budgets.inherited_from_budget_id` (cleared on the user's first save) and a unique
   `(month, year)` index so the three call sites can't race into duplicates. Budgets page
   shows "Carried forward from <month> — edit any line or Save to make it this month's own."
   *Measure:* September budget rows 0 → 1 (18 lines, cloned from August); monthly clicks to
   have a budget 3 → 0. Verified live: uvicorn `--reload` picked the change up, ran 0019 on the
   real DB and created September before the pass finished.
2. **Budget alerts resurrected.** The monitor read `amount_limit` / `amount_spent` from
   `GET /budgets/` (which returns `limit_amount` and no spend) across every month ever saved
   — it had never fired. Now driven by `lib/budgetAlerts.js` (`evaluateBudgetAlerts`, pure,
   9 tests) over the current month's `spending-summary` rows, so an alert can't disagree
   with the Budgets page. *Measure:* replaying August end-of-month: 0 alerts → 5 "over
   budget" + 3 "90%" alerts.
3. **Financial Pulse budget adherence is real.** `services/budget_health.py`: pace-aware
   (limit × fraction of month elapsed, floored at one week), limit-weighted line scores,
   Business line excluded; component goes `null` and the other three re-weight when no
   budget exists. Tile shows "N of M lines on pace (x% of month elapsed)" or "no budget this
   month". *Measure:* the 15%-weight constant (75) is gone; on Sept 5 the computed component
   differed from the constant by a few points — small today, but it now moves.

**Also fixed in passing:** `tests/test_financial_pulse.py` asserted a list-of-`{key}` shape
the endpoint never returned (2 tests could never pass) — corrected to the real dict shape.

**Verification:** backend — 22/22 in `test_budget_carry`, `test_budget_health`,
`test_financial_pulse` (run in the cloud container against a copy of the source; the device
sandbox has no free disk for a venv). Full suite there: 649 passed / 36 failed / 48 errors,
all pre-existing env drift (missing `plaid` etc. at collection; direct endpoint calls with
`Query` defaults — e.g. all 6 `test_spending_summary` cases; date-sensitive retirement/YoY
tests). Migration 0019 applied cleanly to a copy of the real DB and, via `--reload`, to the
real one. Frontend — `@babel/parser` syntax pass on all touched JSX; `budgetAlerts` logic
verified under node (10/10) — run `npx vitest` on the Mac for the committed test files.

**Next-pass candidates:**
- D2/D5 — "Unbudgeted" section on Budgets (deferred item 4): 8.7% of August and 16.5% of
  July spend sits in categories with no line; one-click "Set budget" per row.
- D1 — Canonicalize CSV-importer categories (deferred item 5) and treat refunds as negative
  spend in their category rather than income.
- D1 — Unpaired `TRANSFER_OUT` outflows (Venmo, ATM, external-account deposits) count as
  spend; needs a rule for unlinked-account moves.
- Audit-loop handoff: `test_spending_summary.py` calls the endpoint with `Query` defaults
  and can't pass; `financial_pulse` budget adherence should eventually use split-aware
  business filtering identical to `spending_summary`.

---

## Prior context (shipped 2026-09-05, before the loop existed)

- **TransactionDrawer summary excludes transfers.** A CC autopay credit that Plaid categorized
  "Income" (`is_transfer=1`) inflated Count and hijacked Largest in the Income drill-down while
  the pie slice behind it was already clean. Now skipped, second tile relabelled "Income" for
  income-only scopes, footnote "N transfers listed below but excluded from these totals". The
  drill-down total now equals the pie slice exactly.
- **Net Worth Y axis fitted to data** via new `frontend/src/lib/chartScale.js`
  (`niceDomain`, `niceStep`, `currencyTickFormatter`, unit-tested). Plot-area usage on real
  snapshots: 30D 2.0% → 79.3%, 90D 6.7% → 84.2%, 1Y 37.0% → 71.9%. Disclosure caption when
  the axis excludes zero.

---

## Seed backlog (verified against code/DB on 2026-09-05; prune as items ship)

**D1 — Data trust**
- Refunds and returns are counted as *income*. `income_vs_spending` and `category_breakdown`
  bucket every `amount < 0` as income regardless of category — a store return categorized
  Home (txn 756) and a warehouse-club credit categorized Shopping (txn 1006) both land in the
  Income stat card. Monarch, Copilot and YNAB net a refund against its category's spend.
  Proposal shape: an inflow whose category is a *spending* category counts as negative spend
  in that category; an explicit Income-category whitelist stays income. Measure: Income card
  for Aug 2026 drops by exactly the two credits; those categories' spend drops by the same.
- CC-payment credits arrive from Plaid categorized **"Income"** (txn 1037). `is_transfer`
  keeps them out of totals, but they still list under the Income category.
  `merchant_normalizer.classify()` already knows they're `cc_payment` — have the transfer
  detector (or sync) also set `custom_category = "Transfer"` when it flags a row so the
  category view and the flag agree. Measure: `is_transfer=1 AND category='Income'` rows → 0.
- Accounts that share a display name are indistinguishable in every list. Show the mask
  (accounts table has `mask`) beside the name wherever accounts are listed, and an "inactive"
  pill when an account has had no transactions for 60+ days (accounts 2 vs 5 are the live
  example).

**D2 — Insight density**
- Milestone markers on the net-worth chart jump 500k → 1M (`thresholds` list in
  `NetWorth.jsx`); add 750k and 1.5M so the journey between them gets a dot.
- Audit the other level-over-time charts for zero-anchored axes (Dashboard, Insights,
  CashFlow, Business, MerchantDrawer, SpendingPace, CashFlowForecast each have one `<YAxis>`
  with no `domain`; Loans already uses `['dataMin','dataMax']`). Reuse `niceDomain` where the
  series is a level; leave bars zero-based.
- Income Sources card keys on raw `merchant_name || name`, and bank payroll descriptors embed
  a per-deposit ACH trace number — so every paycheck is its own "source" and the card never
  rolls up to the employer. Normalize the key (strip `ACH Trace`, `DATA:`, `ID:` suffixes; or
  reuse the recurring-detector's name normalization).

**D5 — Workflow completeness**
- Re-categorizing a transfer in the drawer doesn't offer "also clear the transfer flag" (and
  vice-versa); the two facts drift. One control that sets both.

**D7 — First-run**
- `README.md` vs `AGENTS.md` "How to run": confirm they agree after the fintrack → tuskledger
  rename; time a clean-machine `start-demo.sh` to first dashboard paint.
