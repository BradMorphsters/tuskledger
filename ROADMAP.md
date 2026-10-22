# Roadmap

What's being worked on, what's next, what's later, and what's out of scope.
This file replaces the pinned roadmap issue
([#14](https://github.com/BradMorphsters/tuskledger/issues/14)) so it can be
versioned and reviewed like the rest of the repo.

- Dates are aspirational and order can change. Tusk Ledger is maintained by one
  person.
- For what already shipped, and why, see [CHANGELOG.md](CHANGELOG.md).
- For what's in and out of scope, see [CONTRIBUTING.md](CONTRIBUTING.md).
- Agent trading has its own sprint plan:
  [docs/agent-trading-roadmap.md](docs/agent-trading-roadmap.md).

_Last updated: October 2026._

---

## Now

- **Dependency refresh, in waves.** Security-only bumps first (no API changes),
  then runtimes (Python 3.13), then the Pydantic / SQLAlchemy / Alembic group,
  then FastAPI and Starlette, then `plaid-python`, then the Expo SDK for the
  iOS app. Each wave lands separately with the full test suite green. CI now
  tests on Node 22 and 24. Node 20 was dropped after it reached end-of-life.
- **Closed accounts on the iPhone app.** The web app can mark an account
  closed so its history stays while its balance stops counting. The phone
  mirror doesn't know about the status yet, so closed accounts still show
  there at $0.
- **CSV import ↔ bank-sync reconciliation.** When a bank feed later backfills
  transactions you already imported from a CSV, the synced row should adopt
  the matching imported row instead of creating a duplicate. Today sync
  de-duplicates only by the bank feed's own transaction ID.
- **More CSV formats.** Recognize more card-issuer exports in the importer
  (for example, files with a separate clearing-date column or an
  `Amount (USD)` header).

## Next

- **Connection health on the Accounts page.** Per-institution status next to
  each bank, plus feedback from "Sync now". It currently surfaces only as a
  Dashboard banner.
- **Plaid update mode for adding product scopes.** Update mode is in place for
  reconnecting a broken connection. Using it to add Investments or Liabilities
  to an existing connection, without relinking, is still to do.
- **More mutating MCP tools**: budget category, bill paid, manual transaction,
  tax bucket, manual assets. This is a strategy decision, because the MCP
  server is read-mostly by design.
- **Technical write-up on the no-hallucination invariant**: numbers come from
  Python, and only the prose comes from the model. See
  [ARCHITECTURE.md](ARCHITECTURE.md).
- **Clean-environment test of the Cowork plugin**, end to end, with fixes for
  whatever breaks.

## Later

- Auth-aware MCP server (today it assumes a single-machine backend with
  `DEV_BYPASS_AUTH=true`).
- Windows-native start script (today's launchers are bash/macOS).
- Broader institution support in the manual-asset flow.
- A monthly digest of codebase and dataset changes, modeled on the weekly
  security sweep.
- Claim and maintain the MCP directory listings (Glama, LobeHub).
- Multi-account scope on the Trading Tax page (choose several accounts, not
  just one).

## Not planned

These would change what Tusk Ledger is. See [CONTRIBUTING.md](CONTRIBUTING.md).

- Multi-user or shared budgets
- A second bank-sync provider alongside Plaid
- A cloud-hosted SaaS version
- A mobile app as the *primary* interface. The iOS app stays a read-only
  companion that pairs with your own machine over the local network.
- Internationalization beyond cosmetic changes
- Envelope budgeting layered on top of category budgets
- Telemetry or analytics, including opt-in

---

## Changes in direction since the May roadmap

- **Offline phone access** was planned as an encrypted SQLite snapshot opened
  in the browser with sql.js. It shipped instead as the **native iOS companion
  app**, with an on-device SQLite mirror that syncs from your machine over the
  local network. It is read-only by default and works offline between syncs.
- **Wash-sale account filtering.** The Trading Tax page can now scope its view
  to one account. Wash-sale detection itself still looks across all accounts,
  as the IRS rule requires. Selecting several accounts at once is still open
  (see Later).
- **Stale reminders for manual entries** use a calendar-month rule instead of a
  longer day threshold. A manual account is flagged only once a full month's
  statement is overdue.
- **Agent trading** grew into its own area, with a human-approval queue,
  guardrails, backtests and a research layer. It now has a separate roadmap,
  linked above.

## Shipped since May 2026

Highlights only. [CHANGELOG.md](CHANGELOG.md) has the details.

- **June:** the agent-trading suite (read-only loop, two-gate guardrails,
  human approval queue, backtests, rotation), the long-term-hold Research
  tab, the iOS home-screen widget, a redesigned mobile UI, Ask Tusk (a
  local-LLM assistant), the spending-pace tile, the light theme, security
  hardening, and a full codebase review sweep.
- **July:** Plaid update-mode reconnect, six audit passes across backend,
  frontend and mobile, and the spending-pace tile on the phone.
- **August:** a range-filter-driven Spending & Income page.
- **September:** budgets that carry forward, one category taxonomy, refunds
  netted against spending, per-payee transfer rules, safe-to-spend and a
  weekly digest, Ask Tusk on the phone, honest connection health with a
  Dashboard alert, and learned pay schedules on the Paychecks page.
- **October:** closed accounts that keep their history, and Node 20 dropped
  from CI.
