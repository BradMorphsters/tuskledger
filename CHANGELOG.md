# Changelog

All notable changes to Tusk Ledger get logged here. The project follows
[Semantic Versioning](https://semver.org/) loosely — major bumps for
breaking schema/API changes, minor for new features, patch for bug fixes.

## [Unreleased]

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
