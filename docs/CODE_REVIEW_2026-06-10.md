# Tusk Ledger — Full UI & Code Evaluation (2026-06-10)

> **Status update (2026-06-11, second pass):** nearly everything is now FIXED:
> **#1–#15, #16 (DashboardTiles half), #17–#30** plus schema-validation and the
> webhook key-cache TTL. TOTP encryption (#6) uses the existing `enc:v1:` Fernet
> envelope with plaintext passthrough — no migration; the secret lazily
> re-encrypts on first app load after a user exists (none exists yet under
> DEV_BYPASS_AUTH, so nothing has been rewritten). DBs backed up to
> `backend/backups/*.pre-review-fixes-20260611-021725` and verified logically
> identical afterward (only diff: iPhone device-token heartbeat).
>
> **Third pass (same day):** RetirementProjection extracted to
> `components/retirement/` (main file 4,117 → 290 lines); `datetime.utcnow`
> swept to a shared naive-UTC `app/utils.utcnow()` (58 sites — deliberately
> naive to keep stored format + mobile cursors unchanged); useAccounts adopted
> in 8 more files (Promise.all batches skipped intentionally); focus traps via
> `hooks/useFocusTrap.js` on all four dialogs; 13 hermetic HTTP security tests
> added in `tests/test_http_security.py` (read-only gate, lockout, replay,
> TOTP-at-rest, CSV cap, refresh throttle, schema limits).
>
> Still open by choice: float→Decimal (low value vs churn for a personal
> tracker — sums are rounded at the boundary and split validation already
> uses a cent epsilon); the older `test_transactions_search.py` TestClient
> tests don't install dependency_overrides, so they run against the real DB
> and fail in clean environments — worth porting to the pattern in
> test_http_security.py someday.

Scope: backend (~21.5k LOC), frontend (~31.5k LOC), mobile (~3.6k LOC). All file:line claims below were verified against the current code. Deliberate choices (DEV_BYPASS_AUTH, read-only phone, FAB fade behavior, mobile quirks) were excluded by design.

---

## Fix-now bugs (broken today)

### 1. CSV import is broken — `ReferenceError`
`frontend/src/api/client.js:523` uses `${API_BASE}` but the module only defines `const BASE = '/api'` (line 2). Every CSV import throws at runtime. **Fix:** `API_BASE` → `BASE`. While there, surface the backend `detail` field on error like the shared `request()` helper does.

### 2. Mobile widget is never updated after sync
`publishSnapshot()` (mobile/src/widget/snapshot.ts:99) is defined but never called — verified zero call sites. The widget shows placeholder/stale data forever. **Fix:** call `publishSnapshot()` after the sync loop succeeds in `mobile/src/sync/manager.ts` (best-effort, after `setLastSynced`).

### 3. Mobile "Top Categories" totals are wrong
`mobile/src/db/queries.ts:140` — `GROUP BY category` groups on the raw column, not the `COALESCE(custom_category, category, …)` alias (SQLite doesn't allow aliases in GROUP BY). Any transaction with a custom category gets split into two groups. **Fix:** `GROUP BY COALESCE(custom_category, category, 'Uncategorized')`.

### 4. Mobile sync can permanently lose transactions
`mobile/src/sync/manager.ts:116` — `saveCursor(resp.server_time)` runs inside the `has_more` paging loop. If page 1 saves the cursor and page 3 fails on network, pages 2–N are skipped forever on subsequent syncs. **Fix:** track a highwater mark in the loop, persist the cursor once after the loop exits cleanly. Also guard `last?.updated_at ?? server_time` — a null `updated_at` can stall page advancement.

### 5. Bulk category rules don't reach the phone
Bulk `UPDATE`s with `synchronize_session=False` (e.g. `apply_rule_to_existing`, analytics rule application) don't trigger SQLAlchemy's `onupdate`, so `updated_at` never bumps. Mobile incremental sync filters on `updated_at >= since`, so a rule that recategorizes 500 transactions sends 0 of them to the phone. **Fix:** include `"updated_at": utcnow` in every bulk-update dict.

---

## Security (high)

### 6. TOTP secret stored plaintext
`backend/app/models/user.py:19` — Plaid tokens get Fernet encryption; the TOTP secret (equally sensitive — generates all future MFA codes) doesn't. **Fix:** encrypt with the existing `crypto.py` pattern. One migration, ~30 min.

### 7. No login rate limiting
`backend/app/routers/auth.py` `/login` — no attempt counter, lockout, or TOTP-reuse rejection. With `valid_window=1` (~90s of valid codes), 6-digit enumeration on LAN/localhost is fast. **Fix:** in-memory failed-attempt dict keyed by IP, 5 failures → 15-min lockout; store and reject the last-used TOTP code.

### 8. `/api/demo/refresh` is unauthenticated drop_all/create_all
`backend/app/routers/demo.py:64` — anyone can POST it repeatedly. Can't touch real data, but on the Railway demo it's a free DoS lever. **Fix:** add `require_auth` dependency + a module-level "min 60s between refreshes" gate.

### 9. DEMO_LOCKED allowlist too broad
`backend/app/main.py:346` — `"/api/auth/"` lets `POST /api/auth/setup/start` (creates user + TOTP secret) through the read-only middleware on the public demo. **Fix:** narrow to `/api/auth/login`, `/api/auth/logout` explicitly; block setup paths.

### 10. CSV import: no size limit
`backend/app/routers/csv_import.py:45` — `await file.read()` with no cap; a 1 GB upload goes straight to RAM. **Fix:** reject > 10 MB with a 413 right after read; batch inserts with periodic flush.

---

## Performance (felt as data grows)

### 11. Merchant drill-down loads the whole transactions table
`backend/app/routers/transactions.py:932` — `db.query(Transaction).all()` then filters in Python on every merchant click. **Fix:** push the lowercase merchant match into SQL with `or_(func.lower(...))`, add a limit. (Longer term: a normalized-merchant column with an index.)

### 12. `income_vs_spending` fires one query per month (up to 24)
Fetch the full date range once and group by `(year, month)` in Python — the same pattern `category_trends` in analytics.py already uses correctly.

### 13. Rule creation scans all uncategorized transactions in Python
`backend/app/routers/analytics.py:121` — load-all + per-row mutation. **Fix:** SQL-side filter + single bulk `UPDATE ... synchronize_session=False` (with the `updated_at` fix from #5).

### 14. Sync path queries rules per transaction
`sync_service.py` — `db.query(CategoryRule).all()` and the BusinessRule fetch sit inside the per-transaction loop; the backfill path already hoists them. **Fix:** hoist both above the loop.

### 15. Mobile `applySync` does one bridge call per row
`mobile/src/db/sqlite.ts:203+` — hundreds of sequential `runAsync` calls during initial sync cause multi-second freezes. **Fix:** `executeBatchAsync` per table.

---

## Frontend code health

### 16. Monster files
`RetirementProjection.jsx` is **4,115 lines**; `DashboardTiles.jsx` is **2,158** (nine self-fetching tiles); seven pages exceed 850 lines (SpendingIncome 1,285, Transactions 1,223, NetWorth 1,163, ConnectAccounts 1,131, Loans 1,126, Dashboard 1,076, Investments 881). The inner components already take all data as props — extraction is mechanical. Suggested first cuts: `components/tiles/` for DashboardTiles, `components/retirement/` for the projection panels (follow the existing `RetirementScenarios.jsx` precedent).

### 17. The `lib/format.js` consolidation never finished
~20 files still define local `formatCurrency` (Dashboard, Transactions, NetWorth, Investments, ConnectAccounts, Business, TaxPrepPack, Loans, UpcomingBills, TrendStat, RetirementProjection, TransactionDrawer, MerchantDrawer, DashboardTiles, SpendingExtras…), and `cleanMerchantName` is copy-pasted in Dashboard and SpendingIncome. Each local copy also constructs `Intl.NumberFormat` per render (50+ per Transactions render). Mechanical search-and-replace; SpendingIncome.jsx is the reference for correct usage.

### 18. Light theme is broken on charts
Hardcoded dark-theme hex (`#1e2130`, `#2a2d3a`, `#9aa0a6`, `#e8eaed`) in chart tooltips/grids across Dashboard (lines 55-57, 630-635), NetWorth (×5), Investments (×5), CashFlow (×3), Business (×3), Insights (×1). Light-mode users get dark-on-light tooltips. Plus Bootstrap `#28a745`/`#dc3545` in the SpendingIncome YoY table. **Fix:** replace with CSS variables; copy SpendingIncome's `ChartTooltip`.

### 19. Year dropdowns die in 2028
`[2024, 2025, 2026, 2027]` hardcoded in Budgets.jsx:347, SpendingIncome.jsx:1005, Insights.jsx:174, ScheduleCTab.jsx:171. **Fix:** shared `yearOptions()` helper in `lib/dates.js`.

### 20. Errors render as eternal "Loading..."
~94 empty `.catch(() => {})` across the frontend. Where the loading gate is `if (!data) return <p>Loading...</p>` (Insights tabs, several tiles), a failed fetch shows "Loading…" forever. **Fix:** add an `error` state to those components and render the existing `EmptyState` — no need to touch the graceful `.catch(() => [])` fallbacks.

### 21. Accessibility gaps
Modals (`SplitModal`, `ModalShell`, drawers) lack `aria-modal="true"` and focus traps; `ThisMonthBreakdown` rows (Dashboard.jsx:929) and CommandPalette items (QuickActions.jsx:372) are click-only `<div>`s with no keyboard path. **Fix:** `<button>` conversion + `aria-modal` are cheap; focus trap can be a small shared hook.

### 22. Redundant account fetches
`getAccounts()` called independently in 11 places; Dashboard fetches it twice concurrently (page + AccountsOverview tile). **Fix:** a `useAccounts()` hook with module-level cache/TTL.

---

## UI/UX

### 23. 19 flat sidebar items, duplicate icons
TrendingUp serves both Net Worth and Cash Flow; BarChart3 both Spending & Income and Bills Calendar; Receipt both Trading Tax and Tax Prep. **Low-effort fix (per your clarify-over-refactor preference):** two divider lines splitting the nav into everyday / tools / settings groups, and three unique icons.

### 24. Month navigation is laborious
Spending & Income: comparing to the same month last year takes 4 dropdown interactions. **Fix:** `←`/`→` month-step arrows beside the selectors.

### 25. Loading-state inconsistency
Dashboard uses skeletons (good); Investments uses plain "Loading…"; Insights uses inline paragraphs that cause layout shift; SpendingIncome cards appear empty until data lands. **Fix:** adopt the existing `SkeletonCard` everywhere; Insights tabs first.

### 26. Quick-add sign convention is easy to get backwards
The `+` outflow / `−` inflow convention is only in the label. One line of helper text under the amount field prevents silently inverted entries.

---

## Mobile (read-only experience)

### 27. Pairing never stores `hostId` → Bonjour rediscovery permanently disabled
`PairingScreen.tsx:87` saves `hostId: ''`; `rediscoverIfNeeded` short-circuits on falsy `hostId`, so an IP change from DHCP means persistent "Offline" until the user happens to open Settings. **Fix:** fetch the manifest during `complete()` and store `host_id`/`hostname` before `onPaired()`.

### 28. Schema migration wipes tables but not the cursor
`sqlite.ts:141` — after a `SCHEMA_VERSION` bump, the next sync sends the old `since` and gets near-zero rows against empty tables → blank app until manual resync. **Fix:** clear the cursor inside `migrate()` (share logic with `resetMirror`).

### 29. Speculative host written before validation
`discover.ts:154` — `savePairedHost(speculative)` before the manifest check; a kill mid-validation leaves a corrupt paired host. **Fix:** validate via an explicit `baseUrl` param to `fetchManifest`, write only on success.

### 30. Stale banner false-flashes after overnight background
1-hour threshold vs up-to-8s rediscover+sync on foreground → banner flashes then vanishes every morning. **Fix:** raise threshold to ~4h or suppress during active rediscovery. Also: Small/Medium widgets show no "Synced X ago" at all — add the footer Large already has.

---

## Other notes (lower priority)

- Money is `Float` everywhere; SQLite stores REAL either way, so the pragmatic fix is `Decimal` arithmetic in calculation paths (retirement Monte Carlo especially), int-cents only if you ever migrate schema.
- `datetime.utcnow()` (~15 sites) is deprecated in Py 3.12 — switch to `datetime.now(timezone.utc)`.
- Schema validation gaps: `BudgetCategoryIn.limit_amount` accepts negatives; `TransactionUpdate.notes` and `TransactionSplitIn` fields lack max_length (siblings have them).
- Plaid webhook key cache never evicts (`webhooks.py:98`) — `lru_cache(maxsize=8)` + TTL.
- Test gap pattern on both ends: backend has zero HTTP-level tests (DEMO_LOCKED middleware, auth, read-only gate all untested — the `TestClient` test is parked in `_disabled/`); frontend tests only pure utilities, nothing on Transactions/Dashboard interaction paths. The `ThisMonthBreakdown.matchesRow()` sign-convention logic is the single highest-value frontend test to add.
- Stray files worth cleaning: `backend/tuskledger.db.testwrite`, `.db.before-applecard-*` backup in the repo root of backend/, `frontend/src/_disabled/`.

---

## Suggested order of attack

1. **One-liners with user-visible impact:** #1 (CSV import), #2 (widget publish), #3 (GROUP BY), #19 (years) — under an hour total.
2. **Data-integrity fixes:** #4 (cursor), #5 (updated_at on bulk updates), #27 (hostId), #28 (migration cursor).
3. **Security batch:** #6–#10 — roughly an afternoon, mostly small diffs.
4. **Performance batch:** #11–#15.
5. **Frontend hygiene sweep:** #17 + #18 + #20 together (they touch the same files), then #16 extraction as a background chore.
6. **UI polish:** #23–#26, all clarify-over-refactor sized.
