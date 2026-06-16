# Changelog

All notable changes to Tusk Ledger get logged here. The project follows
[Semantic Versioning](https://semver.org/) loosely — major bumps for
breaking schema/API changes, minor for new features, patch for bug fixes.

## [Unreleased]

### Added — Long-term-hold research layer (new "Research" tab)
- **PII-free research store** under `research/` (`<domain>.research.json` +
  `research.schema.json`, JSON Schema 2020-12). Seeded with the
  60-entity critical-minerals universe (45 equities + 15 funds). No
  balances live in the file — git-committable by design. Configurable via
  `RESEARCH_DIR` (defaults to the repo-level `research/` dir).
- **Backend** `app/services/research_store.py` (validated + atomic writes,
  SemVer version guard, append-only history) and `research_join.py`
  (tolerant ticker/alias/`plaid_security_id` join onto live holdings,
  derived alerts, coarse-period catalyst date parsing).
- **API** `app/routers/research.py` (`/api/research/*`): universe,
  positions (holdings × research cockpit), alerts, per-ticker dossier,
  meta, history, plus schema-validated `POST`/`PATCH` writes that the
  read-only middleware blocks on the demo + read-only devices.
- **Frontend** `pages/Research.jsx` — split view: held-positions cockpit
  (thesis, next catalyst with overdue flag, invalidation triggers,
  stale badge) over the sortable/filterable full universe, with an
  entity detail drawer. New `Research` nav item + route.
- **Research drawer visuals**: a thesis-drift chart (conviction/upside over
  time from snapshot history), a forward catalyst timeline (overdue flagged),
  and a **current-price-vs-analyst-target-range** bullet bar with an
  **oversold/vs-target indicator** ("Oversold vs targets" at/below the
  analyst low → "Above all targets", plus % to high) — sourced, dated,
  equities-only, labeled "not investment advice" (no Claude-asserted price
  forecast). New `price_targets` schema field populated for **all 45
  equities** (34 cited analyst ranges, 11 honestly marked no-coverage; ETFs
  excluded), a sortable "Vs target" universe column, a `current_price` (live
  holding price preferred, else parsed from the research snapshot), and a
  `POST /snapshot` heartbeat endpoint that feeds the trend chart daily. The
  daily job refreshes targets going forward.
- **Real price chart (market data)**: `services/market_data.py` —
  `GET /research/{domain}/prices/{ticker}` fetches monthly closes on demand
  (cached 12h in `research/*.prices.json`, demo-safe, degrades to
  "unavailable"; `?debug=true` reports the exact fetch result), and
  `POST /research/{domain}/refresh-prices` bulk-warms the cache + writes the
  latest close into each `fundamentals.price` so the universe/cards converge
  on real prices. The drawer's Price chart plots real monthly closes vs the
  analyst target band and uses the live close as the authoritative current
  price. Provider: **Twelve Data** when `MARKETDATA_API_KEY` is set (free
  tier), else best-effort keyless **Yahoo** fallback — keyless Stooq/Yahoo are
  now bot-walled for server requests, so the key path is the reliable one.
  Daily job refreshes prices each run; `research/*.prices.json` gitignored.
- **Signals tab (Quiver Quantitative public-purchase data)**: new `Signals`
  tab + `services/quiver.py` + `/api/signals/*`. Pulls public-purchase
  activity per ticker — federal **government contracts** (USASpending),
  **congressional** trades, **insider** Form-4 trades, and **lobbying** —
  and distills each into a directional **"Heating up / Steady / Cooling"**
  signal from 90-day-vs-prior windows (is the buying *accelerating*?).
  Universe-wide momentum table ranked by signal, expandable per name, plus a
  **"Public activity" overlay in the Research drawer**. Keyed via
  `QUIVER_API_KEY`. **Tier-aware by probing** what the key unlocks (200 vs
  403) rather than hardcoding Quiver's tiers — a free key surfaces a subset
  (basic congressional data), a paid plan unlocks the rest, and the UI shows
  which datasets are unlocked vs "upgrade to unlock" (tab header + 🔒 chips in
  the Research overlay). No key → connect-Quiver state. Tolerant field parsing (finalize via the
  `?debug` endpoint against a real key); cache `research/*.signals.json`
  gitignored; the daily job best-effort-warms it. `tests/test_quiver.py` (8).
- **Rotation watch (new tab + local-AI synthesis)**: `services/rotation.py` +
  `/api/rotation/*` roll every signal up to the *sector* level into one 0-100
  **rotation temperature** (Early → Stirring → Rotating → Hot) from four
  transparent components — public-money flow (Quiver), valuation re-rating
  (oversold-vs-target counts), score momentum (snapshot history), and catalyst
  cadence. A daily snapshot accrues the rotation curve; the **Dashboard's
  Ollama integration is reused** to write a forward-looking read (numbers
  computed in Python, model only narrates — graceful template fallback when
  `LLM_ENABLED` is off). New Rotation tab (gauge + component cards + curve +
  AI synthesis). The daily job records the snapshot + a "Rotation" briefing
  line (early-inflection read). `research/*.rotation.jsonl` gitignored.
  `tests/test_rotation.py` (3).
- **Price & volume momentum**: `market_data.compute_momentum()` now derives a
  0-100 momentum score per name from the monthly series — where price sits in
  its ~52-week range, the 3-month return, and whether volume is rising. Surfaced
  under the Research drawer price chart ("Momentum NN/100 · +X% off 52w low ·
  3mo +Y% · volume up") and blended into the Rotation momentum component. Volume
  is now captured from both Twelve Data and Yahoo rows.
- **Commodity / sector-ETF relative strength**: `market_data.relative_strength()`
  measures the critical-minerals proxy ETFs (URA/LIT/COPX/REMX) against the
  broad market (SPY) — the cleanest "is capital actually rotating into the
  sector" tell. The daily `refresh-prices` job now also warms SPY + the proxy
  ETFs. Rotation's momentum component shows the sector verdict (outperforming /
  inline / lagging) and feeds the rotation temperature; the AI synthesis can
  cite it.
- **Free SEC EDGAR signals (no key)**: `services/sec_edgar.py` +
  `/api/edgar/*` pull each name's recent SEC filings directly from EDGAR —
  insider Form-4 *filing activity* (count-based; fills the gap left by Quiver's
  tier-gated insider feed), 8-K material events, and S-1/424B capital-raise
  (dilution) filings. New **"SEC filings (free · no key)"** section on the
  Signals page (shown even without a Quiver key) and an SEC block in the
  Research drawer. Ticker→CIK map + filing cache gitignored; `SEC_USER_AGENT`
  configurable. `tests/test_edgar.py` (7).
- **Cross-plane tie-backs (one system, not three tabs)**: the Research alert
  engine now reads the flow (Quiver) + filing (SEC EDGAR) caches and emits
  single-source, self-disabling tripwire alerts for held + high-conviction
  names — `flow_contract` / `flow_congress` / `flow_lobbying` / `flow_darkpool`
  (Quiver) and `dilution_watch` / `insider_cluster` (EDGAR, with dilution on a
  below-cost held name escalated to high). Each rule reads only its own cache,
  so EDGAR and Quiver never depend on each other. The Research universe gained a
  compact **Flow** column (signal pill + dark-pool DPI arrow, shown only when
  Quiver is configured), and the **Rotation flow component now folds in EDGAR**
  (insider clustering lifts it; capital raises drag it).
- **Industry-configurable (retarget to any sector/theme)**: the whole stack is
  driven by one research file per industry. Sector knobs moved out of code into
  a standard, schema-validated `meta.industry` block (`label`, `benchmark`,
  `sector_etfs`, `proxy_keywords`); `rotation.industry_config()` reads them per
  domain (sector ETFs default to none → relative strength simply doesn't compute
  for industries that don't declare them). `refresh-prices` warms each domain's
  own benchmark + ETFs; the AI narrative uses the industry label. New
  `ACTIVE_RESEARCH_DOMAIN` setting focuses the app on one industry at a time
  (sorted first in the domains list). Added `docs/adding-an-industry.md` + a
  copy-and-fill `docs/industry-template.research.json`. Critical-minerals reads
  identically — its knobs now live in its own file.
- **In-app industry admin (switch without a restart)**: a runtime active-industry
  pointer (`research/.active-domain.json`, gitignored; env is the fallback) plus
  `GET/POST /api/research/active` and `POST /api/research/industries` let you
  **switch the focused industry and scaffold a new one from the UI** — an
  IndustrySwitcher in the Research header (dropdown + "＋ New" form), not a value
  in a code/.env file. Switching persists server-side so all tabs follow.
- **Industry-fit rotation model**: `meta.industry.rotation_weights` (per-industry
  component weighting, auto-normalized) and `meta.industry.flow_signals` (which
  public-money-flow inputs apply — e.g. retail uses `["edgar"]` and drops the
  irrelevant federal-contract/lobbying/congress credit). Defaults preserve
  critical-minerals exactly.
- **Sharper rotation insight (local LLM)**: the rotation AI bundle now includes
  `names_to_watch` — the specific tickers where the holder's thesis and the live
  flow/filing/valuation signals line up (`rotation._confluence()`: conviction +
  oversold-vs-target + public-money flow + insider/dilution filings + near-term
  catalyst), each with plain reasons, dilution caveats, and the thesis +
  invalidation notes. The prompt is rewritten to lead with what changed, name
  the 1–2 names that matter and why, and end on one tripwire — still
  Python-computed numbers, no forecasts/buy-sell. Trend now accrues: a rotation
  history row is recorded once per day (deduped, demo-guarded) from
  snapshot()/narrative(), so "what changed" populates without the 4am job.
- **Rate-limit resilience**: the Quiver + EDGAR bulk refreshes now throttle and
  **preserve good cached data on a failed pass** (flagged `stale`) instead of
  overwriting it, so repeated runs / the nightly job *accumulate* coverage.
- **Deps**: `jsonschema==4.25.1`; market data, Quiver, EDGAR, and the rotation
  AI reuse the existing `httpx`/Ollama integration (no new deps). Tests:
  `test_research.py` (19), `test_market_data.py` (15), `test_quiver.py` (11),
  `test_rotation.py` (9), `test_edgar.py` (7), `test_signals_refresh.py` (1).

### Changed — June 2026 full-codebase review sweep
- **Mobile UI redesign**: new design system around the tusk-gold brand
  (semantic color tokens, 34pt tabular-numeral money type, uppercase
  letterspaced section labels), 14 reusable zero-dependency components,
  and rebuilt screens — Dashboard net-worth hero with 30-day delta and
  full-bleed sparkline, Transactions with debounced search / date-range
  chips / sticky day headers, Investments allocation bar, iOS-grouped
  Settings, branded pairing flow. Read-only design unchanged.
- **Security hardening**: TOTP secret encrypted at rest (lazy,
  migration-free); login lockout + TOTP replay rejection; demo refresh
  throttled; DEMO_LOCKED allowlist narrowed (setup endpoints blocked);
  CSV import capped at 10 MB with content-type check.
- **Sync integrity**: bulk transaction updates now bump `updated_at` so
  rule/tag changes reach the phone; mobile sync cursor only persists
  after all pages land; pairing stores `host_id` so Bonjour rediscovery
  works; schema migrations clear the stale cursor; iOS widget publishes
  after every sync and shows staleness on all sizes.
- **Performance**: merchant drill-down, monthly income-vs-spending, and
  rule application no longer scan/hydrate whole tables; Plaid sync stops
  re-querying rules per transaction; mobile applySync uses prepared
  statements (was one bridge round-trip per row).
- **Frontend health**: page-level smoke tests for all 21 pages plus a
  route ErrorBoundary (a crashing page now degrades to a friendly card
  with Copy-to-Assistant instead of white-screening the app); light
  theme fixed across charts; formatter/merchant-name helpers
  consolidated into lib/format; DashboardTiles and RetirementProjection
  monoliths split (4,117 → 290 lines); dialogs got aria-modal, Escape,
  and focus traps; sidebar grouped with unique icons.
- **Fixed**: CSV import ReferenceError (undefined API_BASE); mobile Top
  Categories GROUP BY bug; year dropdowns hardcoded through 2027; four
  null-shape page crashes caught by the new smoke tests; eternal
  "Loading…" on fetch errors in Insights.

### Added
- **Native iOS companion app** (currently in private TestFlight). New
  `mobile/` directory: Expo + React Native + TypeScript app that pairs
  with the laptop over home Wi-Fi via a one-time QR code, mirrors
  accounts / transactions / holdings / manual_assets to a local
  SQLite on the phone, and reads from that mirror so screens are
  instant and work when the laptop is asleep. Read-only by design;
  edits stay on the laptop. Includes a Demo Mode toggle that swaps
  the mirror to the laptop's synthetic dataset for safe screenshots.
- **`/api/mobile/*` namespace** on the backend, gated by per-device
  bearer tokens (`X-Device-Token`) issued through the QR pairing
  flow. New `DeviceToken` model, migration `0017_device_tokens`,
  `pair/start`, `pair/claim`, `manifest`, `sync`, and
  `devices/:id/revoke` endpoints. Auth uses `get_real_db` so the
  demo-mode cookie never breaks token lookup.
- **Bonjour/mDNS advertisement** (`services/bonjour.py`) on a daemon
  thread so Zeroconf I/O never blocks FastAPI startup. Advertises
  `_tuskledger._tcp.local.` so the iPhone re-discovers the laptop
  if its DHCP lease changes.
- **`LAN_SYNC_ENABLED` setting** in `backend/.env`. Tells the
  launchers (`Tusk Ledger.command` / `start.sh`) to bind the
  backend to `0.0.0.0:8000` instead of `127.0.0.1` so the phone
  can reach it. Startup guard in `main.py` updated to allow this
  bind alongside `DEV_BYPASS_AUTH=true` — the mobile API has its
  own auth, independent of session cookies.
- **"Pair phone" page** in the laptop frontend. Generates a code +
  QR via the existing `qrcode[pil]` dep, lists paired devices,
  supports per-device revoke.

### Changed
- **Dependency bumps applied directly** (Dependabot's first-week backlog,
  consolidated into one commit so the 12 auto-opened PRs close as superseded
  rather than each requiring a per-PR merge):
  - `sqlalchemy` 2.0.31 → 2.0.43 (patch — safe)
  - `bcrypt` 4.2.0 → **5.0.0** (major — covered by `test_auth_flow.py`)
  - `qrcode` 7.4.2 → **8.2** (major — only used in MFA setup)
  - `cryptography` 42.0.8 → **47.0.0** (5 majors — covered by `test_crypto.py`,
    the encrypt/decrypt round-trip is the load-bearing assertion)
  - `actions/checkout` v4 → v6, `actions/setup-python` v5 → v6,
    `actions/setup-node` v4 → v6 (GH Actions runner image bumps)
- **Deferred for separate sessions** (each needs the migration guide read first):
  - `react-router-dom` 6 → 7 (data routers, hook signature changes)
  - `recharts` 2 → 3 (chart API restructured)
  - `react-plaid-link` 3 → 4 (Plaid Link wrapper API)
  - `@vitejs/plugin-react` 4 → 6 (build-system shifts)
  - the `backend-minors` group of 9 minor bumps — left to next week's
    Dependabot run for proper per-dep changelog review

### Added
- Pinned runtimes via `.python-version` (3.12) and `.nvmrc` (22 LTS)
- `engines` field in `frontend/package.json` (Node ≥20, npm ≥10)
- `.github/dependabot.yml` opens grouped weekly PRs for backend, frontend,
  and GitHub Actions dependencies. Patches and minors are bundled per
  ecosystem; majors and React/Vite/Vitest stay per-PR for human review
- Pre-OSS-release test coverage expansion: 39 new tests across
  `test_crypto.py`, `test_auth_flow.py`, `test_alembic_migrations.py`,
  `test_sync_service.py`, `test_spending_summary_http.py`,
  `frontend/src/App.test.jsx`. Targets the highest-risk areas for
  runtime/dep upgrades — encryption, auth flow, migrations, Plaid sync,
  HTTP routing, and the auth-gated frontend routing
- CI workflow now runs Vitest on the frontend matrix and pip-audit /
  npm audit (soft-fail) on every push so security advisories surface
  in the run output

### Changed
- CI matrix bumped: Python 3.11/3.12 → **3.12/3.13**, Node 20 → **20/22**
- README "Prerequisites" updated to reflect the new pins

## [1.0.0] — 2026-04-30

Initial open-source release.
