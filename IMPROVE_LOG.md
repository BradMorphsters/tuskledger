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
| D1 | Data trust | **5** | Refunds net against their category on laptop AND phone; per-payee transfer rules; canonical taxonomy; transfers never Income; Pulse has no constants. | Mark the external-savings payee as a transfer (one click, Eduardo's call). |
| D2 | Insight density | **4** ↑ from 3 | Budgets page now shows every dollar (Unbudgeted section, rows sum to Total spent); Income Sources roll up by payer; fitted Net Worth axis. Remaining: other level charts still zero-anchored; Dashboard tiles lack period deltas. | Deltas vs prior period on Dashboard tiles. |
| D3 | Speed | 4 *(provisional)* | ~1k rows; in-window full fetches are fine at this scale. Not measured against a live server. | Measure once a sandbox backend boot exists. |
| D4 | Polish & consistency | **4** ↑ from 3 | Loading / empty / failed are three visibly different states on every daily page; skeletons on 13/25 pages (was 3), no more "Loading…" text; three false-empty-state flashes fixed; two more level charts fitted. Remaining: 8 clickable `<div>`s, inline styles vs tokens drift on older pages. | Convert clickable divs to buttons (also D9). |
| D5 | Workflow completeness | **4** | Budgets carry forward; alerts fire; Set budget one click; recategorize once; per-row transfer toggle with "Always a transfer"; keyboard review queue (j/k/c/t/x/?) discoverable. Remaining: splits still a separate dialog; no keyboard on the drawer. | Keyboard in the drill-down drawer. |
| D6 | Reliability & recovery | **4** ↑ from 3 | `register_background_jobs()` + a test that every promised job is registered and the startup hook can't crash boot; daily snapshots and backups. Remaining: no test that an alert notification actually reaches the browser; restore-from-backup not exercised. | One-command restore drill. |
| D7 | First-run & OSS on-ramp | 3 *(provisional)* | `doctor`, demo mode, one-shot `start.sh`; not timed on a clean machine. | Time clone → dashboard. |
| D8 | Financial correctness | 4 *(provisional)* | Six audit passes + tests; not re-examined. | — |
| D9 | Accessibility | **3** ↑ from 2 | Clickable cards/rows/segments on Business, Insights, Investments and the Transactions merchant link are real buttons or role=button with keyboard handlers; icon-only close labelled; transfer toggles carry aria-pressed. Remaining: charts have no text alternative; contrast unaudited. | Text summaries under each chart. |
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
- 2026-09-05 (Pass 2) — Approved all four: taxonomy canonicalization + backfill, transfers never
  shown as Income, Income Sources by payer, and the (off-theme) Unbudgeted section.
- 2026-09-05 (Pass 3) — Chose theme A "Fixes that stick" over B (central income/spend
  classifier) and C (loading polish). B remains the most important D1 item; do it when commits
  can land incrementally.
- 2026-09-05 (Pass 4) — Offered B-lite (is_refund + transfer rules + unpaired-transfer filter)
  vs C; chose **C**. B-lite stays first in the queue for when the repo can take commits.
- 2026-09-05 (Pass 5) — "Do a larger wave of improvements that is listed" → the whole queue in
  one pass: B-lite, D9, D5 keyboard, D6 jobs test.

---

## Passes

### 2026-09-06 — Pass 10 · Mobile wave 2 — Ask Tusk on the phone (D10 · D8)

**Why:** D10 (assistant) was the least-exercised dimension and lived only
on the laptop. The phone is where the questions occur. Reusing the
laptop's brain over device-token auth costs one thin endpoint; the
offline parser covers the handful of questions people ask away from Wi-Fi
without pretending to be a model.

**Shipped (uncommitted on the Mac at handoff):**
- Backend `routers/mobile.py`: `POST /api/mobile/ask` → `services.assistant.answer`
  (payload trimmed: no snapshot, rows capped at 25, provenance `source`
  documented as ollama | retrieval | guarded | refusal | template);
  `GET /api/mobile/briefing`; manifest `schema_version` 5→6. Four new
  tests (401s, shape, 422 on unknown fields/empty question, briefing).
- Phone: `screens/AskScreen.tsx` (chat, suggestions, typing state,
  provenance line, session-only history, insight-only footnote),
  `ask/intent.ts` (9 intents, period resolver, 34 node assertions),
  `ask/local.ts` (SQLite answers mirroring db/queries.ts netting rules),
  `askTusk`/`fetchBriefing` in `sync/api.ts` (60 s / 20 s timeouts), Ask
  tab + speech-bubble `TabIcon`. `npm test` now runs four suites.

**Verification:** 17 mobile router tests green in the container; Babel
parse + stubbed strict tsc clean on the new modules; node suites ALL PASS;
PII scan clean (fictional merchants only).

**Deferred:** voice on the phone (mic → laptop Parakeet STT → answer →
Kokoro TTS, all endpoints exist on the laptop already); iOS 26 on-device
Foundation Models as a richer offline brain; Siri App Intents.

### 2026-09-05 — Pass 9 · Mobile wave 1 — intelligence on the phone (D8 mobile · D2)

**Why this pass:** after eight passes the phone had received exactly one
change (the `is_refund` mirror + schema fix). Yet the phone is where the
decision moments happen — at a register, on a charge notification,
wondering if a trip fits. The laptop is where you manage; the phone is
where you decide. This wave puts the two new "intelligence" outputs
(safe-to-spend, weekly digest) in a pocket and lets the phone speak up
when something matters — all while keeping the read-only contract.

**Shipped (uncommitted on Eduardo's Mac at handoff; container tests green):**
- Backend: `GET /api/mobile/insights` — pass-through of
  `compute_safe_to_spend` + `compute_weekly_digest`; manifest
  `schema_version` 4→5. Three new tests in `test_mobile_sync.py` (401
  without token; empty-DB shape; numbers equal the laptop services').
- Phone: `fetchInsights` after the delta pages drain (one call per cycle,
  404 → hidden), cached in the `meta` table (`insights/store.ts`, no
  SCHEMA_VERSION bump so no mirror drop on upgrade). `SafeToSpendCard`
  with the "Can I afford this?" field (`insights/afford.ts`: yes / tight /
  no ladder, 25 node assertions), `WeeklyDigestCard`. Both hydrate at boot
  and render offline.
- Alerts: `alerts/rules.ts` pure rule engine (bill due, budget 80/100 %,
  unusually large charge, possible price hike, Sunday digest-ready) with
  stable dedupe keys + a pruned fired-key ledger (27 node assertions);
  `alerts/scheduler.ts` runs after each sync, opt-in via Settings → Alerts,
  cap 4 per run; `alerts/notify.ts` wraps `expo-notifications` and no-ops
  when the module is absent (Expo Go). Local only — no APNs, no token
  leaves the phone.
- Widget: optional `safeToSpend` in the snapshot (TS + Swift), leads the
  small/medium/large views when present.
- `mobile/package.json`: `expo-notifications`, `npm test` runs the three
  node suites. `app.json`: iOS `buildNumber` 4. Gotcha: prebuild-config
  AUTO-applies expo-notifications' config plugin whenever the package is
  installed (it's on the "versioned SDK packages" list), and that plugin
  always injects the `aps-environment` push entitlement — which the ad-hoc
  provisioning profile lacks, so two build-4 attempts failed at signing.
  Fix: `mobile/plugins/withoutPushEntitlement.js` (listed in app.json)
  deletes the key after the auto-plugin runs. Local notifications need
  neither APNs nor the entitlement.

**Verification:** 71 backend tests across mobile_sync / safe_to_spend /
weekly_digest / budget_health / http_security pass in the container;
Babel parse of all 14 touched TS/TSX files; a stubbed `tsc --strict` pass
over the new modules (no errors in new code); both node suites ALL PASS;
Swift brace/paren balance checked (no Xcode here — the EAS build is the
real compile). PII scan of every new file: fictional names and round
numbers only.

**Needs Eduardo:** `cd mobile && npx expo install expo-notifications`
(updates package-lock), commit, then `eas build --profile preview
--platform ios` for buildNumber 4. Then flip Settings → Alerts on the phone.

**Placement decision (Eduardo, same day):** safe-to-spend is a
paycheck-to-paycheck number and he doesn't budget cycle-to-cycle, so it
must not lead anywhere. Web tile order v13 puts it last; the phone card
sits below Budgets; the widget shows it as a footnote under total cash /
net MTD. Feature stays (it's useful for other users of the public app)
but the default hierarchy favours net worth, accounts and the month view.

**Deferred (Wave 2/3, logged in seed backlog):** Ask Tusk on the phone
(LAN to the Mac's Ollama + on-device intent parser offline); on-device
Foundation Models (iOS 26) + Siri App Intents; the read-only exception
(triage queue) stays Eduardo's call.

### 2026-09-05 — Pass 8 · Finish correctness and test repairs

Completed the in-progress batch with Luna implementation and coordinator review.
Safe-to-spend covers each calendar month before payday, ignores stale income
streams after two cadence intervals plus three days, and nets refunds through
budget_health consistently with spending_summary. Confirmed bill/category
matches reduce overlapping allowances within the same month; credit-card
statements and ambiguous matches remain separately reserved. Trailing overlap
uses the same 90-day window and is capped so usual spending cannot go negative.
Mortgage aliases use account IDs rather than guessing among display names.

Digest date changes use latest-request protection, notification links select the
matching week, and comparison text shows actual snapshot dates. Mixed spending
sources and historical bill-record limitations are explicit.

Repaired active tests without changing tax/retirement production calculations:
primitive defaults for direct route calls, current unmatched-sale/refund API
contracts, sparse YoY alignment, and stable time-window fixtures. Three further
assertion problems surfaced after repairing invocation: same-fraction spending
history, the current retirement chart horizon, and inheritance event-year timing.

Final verification: **845 active backend tests passed**, **263 frontend tests
passed**, production build passed, git diff --check clean. Existing parked tests
remain parked and are excluded with --ignore=tests/_disabled. Both live endpoints
returned 200; safe-to-spend arithmetic and nonnegative allowance checked locally
without exposing financial values. No new dependencies or real-data edits.

Remaining separate work: phone build/install and device verification, external
savings classification, identified-folder cleanup, and later roadmap candidates.
Unmatched bills can still overlap with usual spending conservatively; projections
remain estimates. No push/deployment performed.

### 2026-09-05 — Pass 7 · Safe-to-spend estimate and weekly digest

Committed locally as `9596f9d` after reviewing the implementation. Added the
Dashboard estimate and breakdown, Weekly Digest page/date picker, both analytics
endpoints, and a once-weekly browser notification. The Dashboard order key moves
to v12, resetting stored tile order once.

Review fixed invalid digest-date handling, same-day payday bill boundaries,
substring-based bill suppression, and the inclusive 90-day window. Notifications
also deliver the most recent Sunday digest when the app opens later in the week.
Price-hike language is explicitly tentative. Budget/bill overlap and stale income
remain known estimate limitations for the next correctness pass.

Verification at this checkpoint: 42 focused backend tests; full backend 827 passed
and 39 failures unchanged from the pre-review baseline; frontend 258 passed and
production build succeeded. The full run included four parked `_disabled` tests,
so 35 failures were active. Node 25 needs experimental web storage disabled for
these frontend tests; the repository specifies Node 22. Live endpoints and basic
Dashboard/digest interactions passed without exporting financial values.

Record correction: Passes 1–6 below were subsequently committed (latest Pass 6
commit `6ebbcae`); the mobile schema repair is committed as `8d6732a`. Their original
"Not committed" statements describe the earlier handoff, not current Git state.
The phone still requires build/install verification.

### 2026-09-05 — Pass 6 · Mobile mirror learns `is_refund`

Small, consistency-driven pass: Pass 5 made the laptop net refunds against spend, so the phone
(which computes its own sums from a mirrored SQLite) had started disagreeing with it by exactly
the refund amounts. Shell still down; built in the container, written back via the file bridge.
**Not committed.**

**Shipped:** backend `/api/mobile/sync` sends `is_refund` (default `False`, so an older phone
keeps parsing); mobile `SCHEMA_VERSION` 5 → 6 (one-time wipe + full re-pull on next launch)
adds the column; every phone-side sum uses the laptop's rule — income excludes refunds,
spending/category/budget sums include them and clamp at 0 (`HAVING SUM(amount) > 0`,
`Math.max(0, spent)`); `TransactionRow` shows "· refund", neutral colour, accessibility label
"refunded". *Measure:* phone month totals equal the laptop's again (were off by the month's
refunds). New backend test asserts the sync payload carries the flag. Backend `mobile.py`
manifest `schema_version` left at 4 (additive field; nothing on the phone gates on it).

**Verification:** `test_mobile_sync.py` 10/10; `@babel/parser` (typescript plugin) pass on the
four touched `.ts/.tsx` files. Needs an EAS build to reach the phone.

**Field bug, same day:** the first v6 build failed on the phone with *"table transactions has no
column named is_refund"*. Root cause: the schema-bump path only ever `DELETE`d rows, and
`CREATE TABLE IF NOT EXISTS` is a no-op on an existing table — every earlier bump had added
*tables*, so an added *column* was the first time this mattered. Fix: on a bump the mirror
tables are `DROP`ped and re-created from one `SCHEMA_SQL`, and `ensureColumn()` checks the
real table shape on every launch and `ALTER TABLE … ADD COLUMN`s what's missing — which also
repairs a phone that already recorded v6 during the failed launch. No reinstall needed.

**Next-pass candidates:** D9 text summaries under charts + contrast audit; D6 restore-from-
backup drill as a test; D7 clean-machine `start-demo.sh` timing; D10 exercise Ask Tusk against
the new refund/transfer semantics (its income retrievers already exclude refunds).

### 2026-09-05 — Pass 5 · The queued wave (B-lite + D9 + D5 keyboard + D6)

Eduardo asked for the whole remaining queue in one pass. Shell still down; built in the
container (backend checkpointed in a local git there), written back via the file bridge.
**Not committed.**

**A regression found and repaired first.** Re-reading the device copies before editing showed
Pass 4 had overwritten Pass 2's Unbudgeted section in `Budgets.jsx` and Pass 3's suggestion/undo
wiring in `Transactions.jsx`. Cause: `device_stage_files` returned a stale cached copy (the
mtime it reported predated the earlier write) and Pass 4 was patched onto that base. Both files
were rebuilt from the correct bases with every pass's changes and re-verified; the loop prompt
now requires checking a staged file's mtime/size against `device_list_dir` before patching it.

**Shipped:**

1. **Refunds net against spending (D1).** `transactions.is_refund` (derived, never a toggle) +
   `services/refund_detector.py` with one shared definition (`is_refund_row`): an inflow that is
   not a transfer and sits in a spending category. Recomputed after every sync (via the transfer
   detector) and on any PATCH that changes category or transfer status. Migration 0021 backfills.
   Income sites stop counting them (income-vs-spending, category-breakdown, spending-summary,
   /totals — which now also reports `refunds` —, spending-patterns, monthly report, cash-flow
   forecast/health, Pulse inflow, YoY, Ask Tusk's income retrievers and prompt bundles); the
   headline spend endpoints net them into their category (clamped at 0 so a return larger than
   the month's purchases never draws a negative slice). *Measure:* 6 rows flagged; every month's
   income drops by exactly its refunds (largest single month −3.6%); Home/Shopping/etc. spend
   drops by the same. Old → new for all eight months logged in the pass transcript.
2. **Per-payee transfer rules (D1).** `transfer_rules` table (0021), consulted by the detector's
   pattern pass alongside the built-in issuer rules; `GET/POST/DELETE /analytics/transfer-rules`
   (POST applies to history immediately) and `/transfer-rules/preview`. In the UI the ↔ pill on
   every row (table and drawer) is now a toggle with `aria-pressed`; flagging an outflow offers
   **"Always a transfer"** for that payee (`TransferSuggestion.jsx`), with undo on the toggle.
   New Transactions filter **"Unpaired transfer-outs"** (`?unpaired_transfers=true`) lists the
   Transfer-labelled outflows the detector couldn't pair. *Measure:* 22 such rows today; one rule
   on the external-savings payee would move 2 of them (and ~16% of one month's "spend") out of
   spending — a decision left to Eduardo by design.
3. **Refund pill** (↩) on table and drawer rows so the netting is visible, not silent.
4. **D9.** Business overview cards, Insights expandable rows and Investments allocation segments
   are keyboard-reachable (`role=button`, `tabIndex`, Enter/Space, `aria-expanded` where they
   expand); the Transactions merchant link is a real `<button>`; the split-modal close is
   labelled.
5. **D5.** The Transactions page already had j/k/x/e navigation (my Pass-4 log entry was wrong
   to call it missing — verified before building). Added: `c` as the natural alias for
   category, `t` to mark/unmark the highlighted row as a transfer, `?` for a legend, `Esc`
   clears the highlight, the highlighted row scrolls into view, and a one-line on-screen hint
   so the feature is discoverable. `<kbd>` styling added to `index.css`.
6. **D6.** Scheduler registration extracted to `register_background_jobs(scheduler, settings)`
   with `EXPECTED_JOB_IDS`; `tests/test_background_jobs.py` asserts every promised job is
   registered exactly once with a sane trigger, that budget carry-forward is a daily cron just
   after midnight, and that the startup hook cannot raise on an empty DB.

**Verification:** 22 new backend tests green (refund detector, transfer rules, jobs); migration
0021 applied to a DB copy (0020 → 0021, 6 refunds flagged, empty `transfer_rules`) and the
before/after income-vs-spending table compared month by month. Full suite in the container:
717 passed / 46 failed / 43 errors, **identical failure set to the pre-wave baseline** (diffed
against a worktree of the previous checkpoint; the counts moved only because installing
`plaid`/`qrcode`/`zeroconf` let more tests collect). Frontend: `@babel/parser` pass on all
touched files. Run `npx vitest` and `pytest` on the Mac.

**Next-pass candidates:**
- Mobile mirror: teach `mobile/src/db/queries.ts` the `is_refund` column so phone totals match
  the laptop.
- D9: text summaries under charts; contrast audit.
- D6: restore-from-backup drill as a test.
- D7: time a clean-machine `start-demo.sh` to first dashboard paint.

### 2026-09-05 — Pass 4 · D4 "Every page paints instantly"

**Recon:** inventory of all 25 pages for loading / empty / error handling. 3 pages used
skeletons, 9 rendered bare "Loading…" text, and three pages painted a **false empty state**
during the first fetch: Transactions ("No transactions found"), Budgets ("No budget set …
Copy from last month"), Business ("No businesses yet"). Transactions also swallowed fetch
errors (`.catch(() => {})`), so a backend hiccup was indistinguishable from an empty account.
Re-measured theme B before proposing: refunds distort income ≤ 3.6% in the worst month (6
rows all-time) — real but small; unpaired `TRANSFER_OUT` outflows are the larger leak (22 rows,
~16% of one month's spend). Eduardo chose C. Shell still down; built in the container.

**Shipped:**

1. **Three states, visibly different.** New `SkeletonTableRows` / `SkeletonPage` in
   `components/Skeleton.jsx` and a shared `components/LoadError.jsx` (message + Retry).
   Transactions: skeleton rows until the first response, `LoadError` on failure, the empty
   message only once loaded. Budgets: skeleton rows until `GET /budgets` answers; the Copy CTA
   no longer flashes on months that have a budget. Business: `businesses` starts as `null`
   (not loaded) so the overview shows a skeleton instead of "No businesses yet".
2. **"Loading…" text replaced with skeletons** on NetWorth (debt payoff section), CashFlow
   (both tabs), Goals, Categories, Insights (subscriptions), Loans, TaxPrepPack and the
   Spending & Income recurring card. *Measure:* pages using skeletons 3 → 13 of 25; bare
   "Loading…" strings 9 → 0.
3. **Two more fitted axes** via `niceDomain`: the Dashboard Cash Flow Forecast tile (projected
   balance is a level; the $0 danger line still renders whenever the projection gets near it)
   and the Cash Flow page's cumulative-change chart (today = $0 is always in the domain).
   Spending bars everywhere stay zero-based by design.

**Verification:** `@babel/parser` pass on all 14 touched files; `Business.jsx` null-safety
audited at every `businesses.` use (other tabs receive `businesses ?? []`); smoke tests assert
none of the replaced strings. Run `npx vitest` on the Mac.

**Next-pass candidates:**
- **B-lite (D1)** — `is_refund` flag + detector; `transfer_rules` with an "Always treat
  <payee> as a transfer" card; "Unpaired transfer-outs" filter. First in the queue once
  commits can land.
- D9 — convert the 8 clickable `<div>`s to buttons; labels + focus order on the transaction
  table and drawers.
- D5 — keyboard review queue for new transactions.

### 2026-09-05 — Pass 3 · D5 "Fixes that stick"

**Recon correction:** the log's Pass 2 candidate "rule suggestion on recategorize" was
half-built already — the Transactions page offered "apply to N other" and the Rules page had a
live match preview. Verified before proposing; the real gaps were narrower: page-local count,
no "always", nothing in the drawer, no undo. Sandbox shell still down; built in the container,
written back via the file bridge. **Not committed** (same reason as Pass 2).

**Shipped (theme approved as a whole):**

1. **Full-history suggestion.** New `GET /analytics/rules/preview?pattern&category&exclude_id`
   scans every transaction with the rule engine's own matching and returns the rows whose
   effective category differs (`candidates`, each with its prior override so the action can be
   undone) plus `rule_would_update` under the engine's never-override-a-hand-set-category
   semantics. *Measure:* fixing a row of the most frequent merchant on the newest page used to offer
   "apply to 1 other" (2 visible); it now offers 79. The next two merchants: 1 → 28, 0 → 19.
2. **"Apply to N past" and "Always".** Shared `components/CategorySuggestion.jsx`. Apply
   PATCHes exactly the listed rows and posts an 8-second **Undo** toast that restores each row's
   prior override (or clears it). Always creates a category rule via the existing endpoint,
   which applies retroactively and on every future sync. Pattern comes from
   `lib/categoryFix.buildRulePattern()` — normalized display name with store numbers and
   processor prefixes stripped ("SQ *TACO PLANET" → `taco planet`, "AMAZON MKTPL*AB12…" →
   `amazon mktpl`) so a rule matches the merchant, not one receipt. 14 unit tests.
3. **Drawer support.** The same card appears after a recategorize inside the drill-down
   drawer — where fixes reached from Spending & Income and Budgets actually happen.
4. **Undo on bulk edits.** Bulk recategorize and bulk transfer-toggle on the Transactions
   page capture the pre-change rows and post an undo toast (`bulkUndoPlan`). To make "restore
   to no override" expressible, `PATCH /transactions/{id}` now treats `custom_category: ""` as
   *clear* (null still means unchanged) — same convention `notes` already used.

**Verification:** backend 4 new tests (`test_rule_preview.py`) green; full suite in the
container 669 passed / 36 failed / 48 errors — failure set unchanged (pre-existing env drift).
Frontend: `@babel/parser` pass on all six touched files; `categoryFix` logic verified under
node (17 assertions). `lucide-react` icon availability checked against the installed package
(the listing truncates at 2,000 entries, so `Wand2` was swapped for `ListChecks`, which is
confirmed present). Run `npx vitest` on the Mac for the committed test files.

**Next-pass candidates:**
- D1 — central income/spend classifier (theme B): refunds net against their category;
  unpaired `TRANSFER_OUT` rule. 66 sign-check sites; needs incremental commits.
- D4 — skeletons/empty states on the 22 pages without them; fitted axes on remaining level
  charts (theme C).
- D5 — keyboard review queue for new transactions (j/k, c, t, u).
- D9 — labels + focus order on the transaction table and drawers.

### 2026-09-05 — Pass 2 · D1 "Numbers that reconcile"

**Ground truth used:** DB copy taken after Pass 1 (identical to live at that moment); the
Mac's sandbox shell was down for the whole pass (bridge-socket failure after its disk hit
100%), so everything was built and verified in the cloud container and written back with
the file tools. **Not committed** — see "Follow-ups".

**Shipped (4/4 approved):**

1. **One category taxonomy at every import path.** `categories.canonical_category()` +
   `CATEGORY_ALIASES`; the CSV classifier now emits standard names; unmapped Plaid
   primaries (`LOAN_DISBURSEMENTS`) fold through the alias table instead of creating a
   bucket nothing knows about. Migration 0020 backfills `category` AND `custom_category`
   (the Apple Card load script had written its labels into `custom_category`, so
   `category`-only would have missed 47 of the 53 rows — caught by measuring, not assumed).
   *Measure:* rows outside the taxonomy 53 → 0; the folded food rows raise all-time
   Food & Dining spend by ~40% — the honest number, previously split across a bucket no
   budget line could see. User overrides (Childcare etc.) untouched.
2. **A flagged transfer never shows under Income.** `transfer_detector._flag()` sets
   `custom_category = Transfer` when the row's effective category is Income (a hand-chosen
   category is left alone); 0020 backfills. *Measure:* `is_transfer=1 AND effective
   category = Income` 3 → 0 (one of them was the largest single row in the Income list).
3. **Income Sources roll up by payer.** `spending-patterns` keys the card on
   `merchant_normalizer.normalize()`; the normalizer now collapses the doubled payer that ACH
   descriptors produce ("X … CO: X"), consumes multi-word `TYPE:` values ("TAX REF"), strips
   X-masked IDs, and treats `ACH/<payer> - PAYROLL` as the deposit form. *Measure:* August
   income sources 9 → 4 (3 payers + 1 refund).
4. **Unbudgeted section on Budgets** (deferred from Pass 1): categories with spend but no
   line, largest first, with the share of the month's spend and a one-click **Set budget**
   that adds the line at spend rounded up to the next $25 and auto-saves. Pure helpers
   `unbudgetedCategories()` / `suggestedLimit()` exported and tested. *Measure:* rows on the
   page now sum to Total spent; 8.7% (Aug) / 16.5% (Jul) of spend was invisible before.

**Verification:** backend 48/48 across the touched modules (16 new tests: taxonomy,
normalizer, detector relabel); full suite in the container 665 passed / 36 failed / 48
errors — the failure set is identical to Pass 1's pre-existing env drift. Migration 0020
applied to a copy of the real DB (0019 → 0020), measured before/after, and re-run
idempotently. Frontend: `@babel/parser` syntax pass; helper logic verified under node;
`Budgets.test.jsx` extended (run `npx vitest` on the Mac).

**Follow-ups / caution:**
- **Uncommitted.** Files were written straight into the working tree via the file bridge;
  `git commit` needs the sandbox shell, which was unavailable. Commit message drafted in
  the pass summary. Because the backend runs `uvicorn --reload`, 0020 will have applied to
  the live DB the moment the files landed.
- `test_recurring_detector::test_classify_kind_salary` was already failing before this pass
  (unchanged by the normalizer edits) — audit-loop item.

**Next-pass candidates:**
- D1 — central income/spend classifier (refunds net against their category; unpaired
  `TRANSFER_OUT` outflows: Venmo/ATM = spend, external-account deposits = transfer).
- D2 — period deltas on Dashboard tiles; fitted axes on the remaining level charts.
- D5 — "Always categorize <merchant> as <category>?" prompt on recategorize → category rule.
- D9 — keyboard + labels on the transaction table and drawers (lowest score, untouched).

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
- Accounts that share a display name are indistinguishable in every list. Show the mask
  (accounts table has `mask`) beside the name wherever accounts are listed, and an "inactive"
  pill when an account has had no transactions for 60+ days (accounts 2 vs 5 are the live
  example).

**D2 — Insight density**
- Audit the other level-over-time charts for zero-anchored axes (Dashboard, Insights,
  CashFlow, Business, MerchantDrawer, SpendingPace, CashFlowForecast each have one `<YAxis>`
  with no `domain`; Loans already uses `['dataMin','dataMax']`). Reuse `niceDomain` where the
  series is a level; leave bars zero-based.

**D5 — Workflow completeness**
- Re-categorizing a transfer in the drawer doesn't offer "also clear the transfer flag" (and
  vice-versa); the two facts drift. One control that sets both.

**D7 — First-run**
- `README.md` vs `AGENTS.md` "How to run": confirm they agree after the fintrack → tuskledger
  rename; time a clean-machine `start-demo.sh` to first dashboard paint.
