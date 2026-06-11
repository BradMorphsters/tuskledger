# Changelog

All notable changes to Tusk Ledger get logged here. The project follows
[Semantic Versioning](https://semver.org/) loosely — major bumps for
breaking schema/API changes, minor for new features, patch for bug fixes.

## [Unreleased]

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
