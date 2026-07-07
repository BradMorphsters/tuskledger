# Audit Log

## 2026-07-07 — Pass 4 (mobile: audit + read-only UX improvements)

**Scope:** mobile/src + App.tsx + backend routers/mobile.py. Eduardo asked for
improvements this pass, not just defects. 2 subagents (code audit + UX gap scan);
5 claims rejected on verification. Eduardo approved all 5 proposals.

### Rejected before proposing (verified false)
- "transactions cursor should be DESC" — backwards; ASC + last-row updated_at is what
  makes resume pagination correct.
- "net refunds into category totals" — would BREAK parity; web semantics are gross
  spend (amount > 0), mobile matches.
- pagination limit+1 boundary and Settings hydrate race — self-retracted by the agent.
- manifest schema_version constant — no-op until v3 (which this pass then shipped anyway).

### Fixed / built (5/5 approved)
1. **Fix** queries.investmentsRollup: manual investment accounts with NEGATIVE balances
   were excluded from portfolio value (`> 0` → `!= 0`; still skips zero stubs).
2. **UX** Category drill-down: Dashboard top-category rows are now Pressable → set
   appStore.txCategory → navigate to Transactions pre-filtered. Store field, not a nav
   param (tabs stay mounted).
3. **UX** Transactions category filter: horizontal chip row of this month's top spend
   categories (spendCategories()); active chip shows ✕; drilled-in category outside the
   top set is prepended so it's always clearable. listTransactions gained a `category`
   param (COALESCE(custom_category, category, 'Uncategorized') = ?).
4. **UX** Net-worth sparkline range picker: 1M/3M/1Y chips; sparkline re-queries on
   range change; the 30d delta chip keeps its own fixed 90d history so it doesn't
   degrade on 1M.
5. **Feature** Budgets on the phone (read-only): backend /sync now ships ALL budgets +
   per-category limits (BudgetOut; complete set each sync — tiny table, wipe+reinsert
   on the phone so laptop deletions propagate; no tombstones needed). Manifest
   schema_version 2→3. Mobile: budgets/budget_categories tables (SCHEMA_VERSION 3→4 —
   forces one-time wipe + full re-pull on next launch), budgetProgress() computes MTD
   spent locally per category (same gross-spend semantics as the web), Dashboard
   Budgets card with green/amber/red bars sorted most-over first, hidden when no
   budget exists for the current month.

### Verification
- mobile: `tsc --noEmit` clean. backend: py_compile clean; pytest 711 passed / same 35
  pre-existing env-drift failures.
- Data note: laptop DB has budgets for Apr + May 2026 only — the phone card stays
  hidden until a July budget exists on the laptop.

### Deferred
- Month-by-month navigation; upcoming-bills teaser (where does derived data live in
  /sync?); full iOS widget (blocked on App-Group entitlement stopgap).
- backend routers/mobile.py has NO pytest coverage (pairing/sync) — worth a harness.

## 2026-07-07 — Pass 3 (deep line-audit of pattern-scanned areas)

**Scope:** assistant_retrieval.py (1,923 ln) + Ask Tusk feedback loop, agent_trading
internals beyond Pass-1/2 coverage (guardrails, wash_sale, sizing, order_policy,
execution, bridge, rotation_coupling), tuskledger-mcp + research/signals/mobile
routers + market-data/quiver/research_store services. 3 parallel subagents; 19 claims
raised, 8 rejected on verification. Eduardo approved all 8 proposals.

### Rejected before proposing (verified false or standing-constraint)
- "missing DEMO_LOCKED on refresh endpoints" — the read-only middleware gates every
  mutating method on demo; new endpoints inherit it by design (main.py:380).
- "device-token timing attack" — DB equality on SHA-256 of a 256-bit random token;
  documented deliberate (routers/mobile.py:123).
- Twelve Data key in query params — their API's standard auth; local app.
- execution.py `unknown` timeout state — IS the Pass-1 approved design (never silent-retry).
- proposals.mark_placed accepting APPROVED — documented fallback, lock-guarded.
- gain_pct on tiny cost basis — big % on near-zero basis is factually correct.
- MTD "midnight boundary" — Transaction.date is a Date column; no time component.
- quiver "timeout" mislabel path — unreachable (_get catches internally).

### Fixed (8/8 approved)
1. **P1** assistant_feedback.py: plain write_text + unlocked RMW → _STORE_LOCK (RLock)
   + tmp-file/os.replace atomic writes on open.json/overrides.json; approve()/reject()
   now atomic across both stores. (A torn write previously nuked ALL pending feedback +
   learned overrides silently — loader swallowed the parse error into {}.)
2. **P1** research_store.py: public STORE_LOCK; upsert_entity/upsert_entities/
   remove_entity/remove_entities/append_history RMW now locked. signals router:
   single-ticker write re-loads under the lock; bulk refresh merges only ITS updates
   into a fresh load (the minutes-long loop no longer clobbers concurrent writes).
3. **P2** bridge._apply buy path: 1e-9 near-zero guard before avg-price division
   (mirrors sell path) — no Inf/NaN into same-cycle projections.
4. **P2** guardrails settled_cash: when require_settled_cash=True but the snapshot has
   no settled_cash, the skip is now a visible warning in the report (was silent).
5. **P2** rotation_coupling: wash-sale deferral message parameterized from
   WASH_WINDOW_DAYS (was hardcoded "30-day").
6. **P3** wash_sale.py: comment documenting inclusive ±30 CALENDAR-day window semantics.
7. **P3** order_policy.build_order_args now REFUSES sub-share limit orders (ValueError)
   instead of silently inflating to 1 share; bridge.plan loop skips them like
   /proposals/generate does (execution/events/runner call plan_cycle unfiltered);
   test_limit_floors_to_whole_shares updated — the old "never floors below 1 share"
   assertion codified the hazard; new test_sub_share_limit_refused_not_inflated.
8. **P3** assistant_retrieval.category_spend: category filter pushed into SQL
   (coalesce(nullif(custom_category,''), nullif(category,''), 'Uncategorized') to match
   the display_category property exactly, including empty-string precedence).

### Verification
- pytest (sandbox system Python): 711 passed / 35 failed — same 35 pre-existing
  env-drift failures as Pass 2 (still confirm locally). Agent-trading suites 33/33;
  assistant/signals/research/rotation/wash subset 258/258.
- py_compile clean on all 9 touched backend files. No frontend/mobile changes this pass.

### Still deferred
- Recurring-detector full consolidation; Dockerfile non-root Railway test;
  weekly-security-sweep skill install decision; the 35 env-drift pytest failures
  (verify green in the macOS venv).

## 2026-07-06 — Pass 2 (delta since Pass 1 + deferrals)

**Scope:** files changed since 4f5e227 (Plaid update-mode, robinhood_agent error surfacing,
rank_history, AgentRanking/ConnectAccounts), Pass-1 deferrals (ResultsPanel line-audit,
site dist rebuild), launcher + scripts, mobile sync spot-check. 3 parallel subagents;
findings cross-verified before proposing. Eduardo approved all 8.

### Rejected before proposing (verified false or standing-constraint)
- "plaid update-link-token missing auth" — no plaid route has auth; DEV_BYPASS_AUTH accepted.
- "analytics.py `.date.month` bug" — not a bug; `d` is a Transaction, `.date` is the column.
- "site .command `-nt` fails on missing target" — bash `-nt` is true when file2 is absent.
- stop.sh pkill patterns — Pass-1 approved form; left as-is.

### Fixed (8/8 approved)
1. **P1** cash_flow_forecast (routers/analytics.py): inflow-baseline tolerance drift — events
   detector allowed 60% variance on income but baseline netting hardcoded 25%, so lumpy
   paychecks were event-modeled yet not netted from the flat salary rate (income
   double-count). Baseline inflow loop now uses 0.60; dead `else` branch removed.
   Forecast numbers change (correctly) for lumpy-income cases.
2. **P2** ResultsPanel.jsx hardening: null-safe `year_by_year_pct`/`depletion_ages`
   (no more "age undefined"), tooltip formatter null guard, `??` instead of `||` on
   inflation_rate (explicit 0% no longer silently replaced by 2.5% default).
3. **P2** tuskledger-site/dist rebuilt (was 17 days stale; Pass-1 tool-count changes now
   shipped). Built on Linux in /tmp (macOS node_modules can't run rollup natives in sandbox).
4. **P2** launcher: "Research layer: loaded" misleading fallback → "no domains found".
5. **P3** ConnectAccounts.jsx: two silent catches now console.warn (behavior unchanged).
6. **P3** mobile sync manager.ts: cursor-persistence comment corrected (logic untouched).
7. **P3** AgentRanking.jsx: baselineLabel/lastChangeLabel/anyMoved memoized (hoisted above
   early returns for rules-of-hooks).
8. **P3** stale `.claude/worktrees/peaceful-joliot-5d5a99` worktree deleted + pruned.

### Verification
- Backend: deps installed into sandbox system Python → **full pytest now runs in sandbox**:
  710 passed / 35 failed, but the same 35 fail on stashed pre-change code — pre-existing,
  almost certainly env-version drift (system Python vs macOS venv). **Run pytest locally to
  confirm the 35 are env-only.** test_cash_flow_forecast: 13/13 green with the tolerance fix.
- Frontend: vitest 166/166 (fresh Linux install in /tmp). py_compile + bash -n clean.
- Mobile: comment-only change, tsc skipped.

### Still deferred
- Recurring-detector full consolidation (4 drifted copies; #1 above is the surgical subset).
- Dockerfile non-root Railway test; weekly-security-sweep skill install decision.

## 2026-07-01 — Pass 1 (full top-down audit)

**Scope:** backend, frontend, mobile, tuskledger-mcp, site, marketplace, scripts.
**Outcome:** 35 findings proposed; Eduardo approved ALL. Fixes applied by 6 parallel Opus
subagents (disjoint file ownership) + 1 handoff fix. 52 files changed (+1671/−565).

### Fixed

**P0 (agent trading):** approve double-tap race → atomic `approved→placing` CAS + new
`placing`/`unknown` statuses (409 on concurrent approve); client_order_id attached to orders,
timeout → duplicate-check via get_equity_orders then `unknown`/needs-reconcile (never silent
retry); threading.Lock on proposals/state/decision-log stores.

**P1 backend:** sub-share limit orders skipped at generation (no more round-up to 1 share);
/proposals/generate now loads persisted AgentState (halt/drawdown/daily-cap enforced) and
persists back; cash parse falls back to buying_power only; partial-holdings guard runs BEFORE
deletion; sync_all_items rolls back failed items; Plaid item delete removes holdings/inv-txns/
liability details explicitly; trading-tax loads full buy history (matches filtered by sell date
— reported numbers changed, correctly; unmatched sells → zero-basis + flagged in
`unmatched_sells`); by-merchant 500 fixed; splits honored in monthly_report, category_trends,
insights, AND narrative bundle (insights_narrative._aggregate_by_category routed through
transaction_view.expand — done by coordinator, was outside agent file sets); cash-flow forecast
models paychecks (abs-median; evented income netted from flat rate); import-time year defaults
→ resolved per-request; pairing-claim per-IP lockout (10/15min); DEMO_LOCKED guard moved above
?debug=true on research prices.

**P1 frontend/mobile:** stale bulk-selection cleared on filter change + guards; shared
toLocalISODate() fixes UTC evening-date cluster (quick-add, presets, calendar Today ring,
backfill); AskTusk aborts prior SSE stream + busy-gates form + revokes TTS blob URLs; Budgets
save try/finally + error banner; mobile sync cursor only advances highwater when drained
(else last row updated_at); force-resync chains after inflight; lastSyncedAt persisted to meta
table + hydrated at boot; QR scan sync ref guard; widget snapshot cleared on unpair/401.

**P2:** webhook handler → def + per-item lock; investments pagination empty-page guard; sync
insert N+1 → batch preload; insights scans date-bounded, narrow except, avg_amount key fixed
(price-hike alerts now live); encryption key anchored to backend root w/ legacy-key migration
(NO regeneration); useLatestRequest hook applied to 6 worst fetch-race pages; FinancialPulse
debounced + stays mounted; Dashboard outage no longer shows onboarding CTA (retry card);
CashFlow retry banners; Transactions double-fetch removed; Dockerfile non-root user
(**needs Railway testing**); stop.sh scoped pkill; wire-claude-desktop.sh merges JSON instead
of clobbering.

**P3:** csv_import Merchant precedence; dead tax indexes/helper removed; retirement actuarial
factor interpolates 63-69; TOTP replay guard on setup_verify; atomic db_backup; month helpers
added to app/utils.py (recurring-detector consolidation left as TODO — divergent logic, higher
risk); colSpan/key/formatter nits; mobile resetMirror bumps version, local month-start,
InvestmentsScreen FlatList; MCP/site/marketplace tool count 23 + versions aligned to 0.3.0,
"read-only" claim corrected to 20 read + 3 write; merchant URL-encoding in mcp client; run_sync
description softened; publish-mcp.sh reads version from pyproject + guarded commit.

### Deferred / follow-ups
- `tuskledger-site/dist/` needs rebuild to ship App.jsx/llms.txt tool-count changes.
- Dockerfile non-root: test demo boot on Railway before next deploy.
- `tuskledger-weekly-security-sweep.SKILL.md.patched` is the ONLY copy of that skill — not
  deleted; decide whether to install it properly.
- Recurring-detector consolidation in analytics.py (4 drifted copies) — TODO, higher-risk.
- Retirement `ResultsPanel.jsx` (1,231 lines) pattern-scanned only, not line-audited.

### Verification
- Backend: py_compile clean on all services/routers/agent_trading; pure-module pytest green
  (58 + 37 tests) — full FastAPI suite can't run in the Linux sandbox (venv is macOS build);
  run `pytest` locally before next use.
- Frontend: vitest 166/166 pass. Mobile: `tsc --noEmit` clean. MCP: 10/10 tests pass.
- Not committed — working tree only.

### Rejected findings (standing constraints)
None rejected this pass; constraints list lives in AUDIT_LOOP.md.
