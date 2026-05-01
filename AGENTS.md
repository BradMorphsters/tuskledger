# AGENTS.md

> Working memory for AI assistants (Claude Code, Cursor, Cowork, GitHub
> Copilot, etc.) operating on this repository. Read this first before
> exploring the codebase — it'll save you a lot of grepping and a few
> non-obvious mistakes.
>
> **Audience:** This is written for an AI agent acting on behalf of a
> user, not for the user directly. The user-facing docs are in
> [`README.md`](README.md).

---

## What this project is

Tusk Ledger is a locally-run personal finance dashboard — a Mint-style
app. It pulls real bank, credit-card, investment, and loan data via
[Plaid](https://plaid.com), stores everything in **a single SQLite file
on the user's machine**, and serves a React UI over a FastAPI backend.

**Design pillars** (don't violate without asking):

1. **Local-first.** Everything runs on the user's laptop. There is no
   cloud component. Don't add SaaS dependencies, telemetry, analytics,
   or anything that calls home. Plaid is the only external network
   dependency, and it talks directly to the user's bank.
2. **Single-user, single-machine.** Default bind is `127.0.0.1`. Don't
   add multi-tenancy, sharded users, or anything that would only make
   sense on a hosted service.
3. **MIT, single maintainer.** Be conservative about adding heavy
   dependencies. The maintainer (BradMorphsters) keeps the whole stack
   in their head.
4. **Tax math is load-bearing.** Several features (wash-sale calculator,
   retirement projection, Schedule C bucketizer, HSA tracker) implement
   real IRS rules. Wrong math here is a real harm to users. If you're
   editing those modules, look for an existing test in `backend/tests/`
   and add one for your change.

---

## Permission boundaries

Before you act, decide which bucket the request falls into.

### Safe to do without asking
- Read any file in the repo
- Run `pytest`, `npm test`, `npm run build`, `npm run dev`
- Add a new component, new router endpoint, new test
- Refactor a function while preserving behavior (with a test that
  proves it)
- Format code, fix lint warnings, fix typos
- Add inline comments and docstrings
- Update `CHANGELOG.md` to describe what you changed
- Run `git diff`, `git log`, `git status`

### Ask the user first
- Database migrations (anything that runs `alembic revision`) — these
  modify the user's actual `tuskledger.db` next time they start the app
- Bumping dependency versions — pinned for a reason; check `.nvmrc`,
  `.python-version`, `requirements.txt`
- Removing a feature, page, or endpoint
- Changing categorization rules or tax math (see "load-bearing" above)
- Anything that touches `backend/services/crypto.py`,
  `backend/.encryption_key`, or session-secret handling
- Adding any new external network dependency
- Anything described as "performance optimization" without a measurement
  to back it (see "Don't refactor without numbers" below)

### Never do without explicit user instruction
- Delete `backend/tuskledger.db`, `backend/.encryption_key`, or anything
  in `backend/backups/`
- Push directly to `main` on the public repo (use a feature branch and
  let the user merge)
- Disable auth (`DEV_BYPASS_AUTH=true`) on a machine the user hasn't
  identified as their own dev box
- Run `git push --force` or `git filter-repo` — history rewrites have
  caused real pain in this project before
- Commit anything matching `*.db`, `*.env`, `*.encryption_key`,
  `backups/`, `uploads/`, or anything in `.gitignore`. **Run
  `git status` before every commit and double-check.**
- Send Plaid access tokens, raw transactions, or balance numbers
  anywhere outside the user's machine — including pasting them into
  your own context window for "diagnostic purposes"

---

## Repo structure

```
tuskledger/
├── AGENTS.md                  ← you are here
├── README.md                  ← user-facing docs (longer; read on demand)
├── CHANGELOG.md
├── LICENSE                    ← MIT
├── start.sh                   ← one-shot launcher (venv + npm + run both)
├── start-demo.sh              ← demo-only mode (no Plaid setup needed)
├── stop.sh                    ← kills both processes
├── Tusk Ledger.command        ← macOS double-click launcher
│
├── backend/
│   ├── app/
│   │   ├── main.py            ← FastAPI app, scheduler, backup bootstrap
│   │   ├── config.py          ← Pydantic Settings (env loading)
│   │   ├── database.py        ← SQLAlchemy engines (real + demo) + per-request routing
│   │   ├── dependencies.py    ← FastAPI dependency providers
│   │   ├── migrations.py      ← Runs Alembic on startup
│   │   ├── models/            ← SQLAlchemy ORM models
│   │   ├── routers/           ← One file per resource (transactions.py, plaid.py, …)
│   │   ├── schemas/           ← Pydantic request/response shapes
│   │   ├── services/          ← Plaid wrapper, sync, normalizer, recurring
│   │   │                        detector, db_backup, csv_classifier, crypto, …
│   │   └── scripts/           ← One-off data-fix scripts (gitignored from main repo)
│   ├── alembic/versions/      ← Migrations, numbered chronologically
│   ├── tests/                 ← pytest suite (in-memory SQLite fixtures)
│   ├── tests/_disabled/       ← Tests parked because of fixture issues; live here
│   │                            until rehabbed. Don't enable without making them green.
│   ├── backups/               ← Auto daily SQLite snapshots (gitignored)
│   ├── requirements.txt
│   └── .env.example           ← Reference for env vars; user copies to .env
│
└── frontend/
    ├── src/
    │   ├── App.jsx            ← Router + sidebar + auth gating
    │   ├── main.jsx           ← Vite entry
    │   ├── index.css          ← Brand tokens (dark theme)
    │   ├── api/client.js      ← Fetch wrapper for /api endpoints
    │   ├── components/        ← Stat, Pill, EmptyState, drawers, modals,
    │   │                        TradingTax, RetirementProjection, …
    │   ├── pages/             ← One file per route: Dashboard, Transactions,
    │   │                        SpendingIncome, CashFlow, NetWorth, Investments,
    │   │                        TradingTaxPage, Budgets, Business, Retirement,
    │   │                        Loans, TaxPrepPack, Rules, ConnectAccounts, …
    │   ├── lib/               ← Shared client utils (formatters, helpers)
    │   ├── _disabled/         ← Same convention as backend/tests/_disabled
    │   └── test/              ← Vitest setup + harness
    └── package.json
```

---

## How to run

### First-time setup (clean machine)

```bash
# 1. Backend env (and Plaid sandbox keys to start with)
cp backend/.env.example backend/.env
# Edit backend/.env — minimum needed: PLAID_CLIENT_ID, PLAID_SECRET, PLAID_ENV=sandbox

# 2. One command runs everything
./start.sh
```

`start.sh` does:
1. Creates `backend/venv` and `pip install -r backend/requirements.txt` if needed
2. Runs Alembic migrations against `backend/tuskledger.db`
3. Starts FastAPI on `127.0.0.1:8000`
4. `npm install` if needed and starts Vite on `localhost:3000`
5. Opens the browser to `localhost:3000`

`Ctrl+C` or `./stop.sh` to stop.

### Demo mode (no Plaid setup needed)

```bash
./start-demo.sh
```

Same as above but skips the Plaid env check; the app boots straight into
demo mode with synthetic data for "Alex Carter."

### Iterating without `start.sh`

If you want to run the two halves independently (faster restarts):

```bash
# Terminal 1
cd backend
source venv/bin/activate
uvicorn app.main:app --reload --host 127.0.0.1 --port 8000

# Terminal 2
cd frontend
npm run dev
```

---

## How to test

### Backend (pytest)

```bash
cd backend
source venv/bin/activate
python -m pytest tests/ -q
```

Each test is self-contained with its own in-memory SQLite fixture or
pure-function fixtures. **No Plaid credentials needed.** Don't add tests
that hit the real Plaid sandbox unless you're explicitly testing the
Plaid wrapper — mock at the service layer.

Tests in `backend/tests/_disabled/` are parked because of fixture issues
that haven't been resolved. Don't move them out without making them
green first.

### Frontend (vitest)

```bash
cd frontend
npm test
```

Same `_disabled/` convention.

### What CI runs

`.github/workflows/ci.yml` — backend pytest sweep + a `compileall` +
Vite production build. Runs on every push and PR. Match this locally
before pushing if your change is non-trivial.

---

## Common operations

### Add a new feature page

1. Add the page component at `frontend/src/pages/<Name>.jsx`
2. Add the route in `frontend/src/App.jsx`
3. Add a sidebar nav entry in `App.jsx`
4. If it needs new data, add a router at `backend/app/routers/<resource>.py`
5. Wire the router in `backend/app/main.py`
6. Add a test in `backend/tests/`

### Add a database migration

```bash
cd backend
source venv/bin/activate
alembic revision --autogenerate -m "describe your change"
# Review the generated file in alembic/versions/ before committing — autogenerate
# misses things sometimes. Check it implements what you intended.
alembic upgrade head
```

The user's running app picks up new migrations on next boot. **Ask
before committing a destructive migration** (drops, NOT NULL on a column
with NULLs, etc.).

### Restore from backup

```bash
ls backend/backups/                                            # see what's available
cp backend/tuskledger.db backend/tuskledger.db.broken          # forensics
cp backend/backups/tuskledger-2026-04-25.db backend/tuskledger.db
./start.sh
```

`backend/.encryption_key` must be the same one used when the backup was
written, or stored Plaid tokens will be unreadable. Pair them.

### Regenerate demo data

In the running app: switch to demo mode, click **Refresh demo data**
in the sidebar. Or manually:

```bash
rm backend/tuskledger_demo.db
./start.sh
# App seeds the demo DB on first boot
```

### Diagnose a Plaid sync failure

1. Check the backend log for the actual Plaid error code
2. Common ones:
   - `ITEM_LOGIN_REQUIRED` → user needs to re-auth at the bank. Click
     the warning triangle next to the account in **Accounts**.
   - `INVALID_PRODUCT` → bank doesn't support a requested product.
     Investments/Liabilities are already in `optional_products`, so
     this generally means Transactions is failing. Investigate per
     institution.
   - `INVALID_LINK_CUSTOMIZATION` → user hasn't enabled the **Data
     Transparency / Track and manage your finances** use case in their
     Plaid dashboard. See `README.md` § Plaid setup.
3. Don't paste the user's `access_token` into your own context for
   debugging. The token grants ongoing access to their bank data.

---

## Known footguns

These are all things that have hurt this project before. Memorize them.

### `.encryption_key` is paired with `tuskledger.db`
Plaid access tokens are encrypted at rest with Fernet using
`backend/.encryption_key`. If you restore `tuskledger.db` from a backup
without restoring (or preserving) the encryption key, every stored token
becomes unreadable and the user has to re-link every account. **The two
files must travel together.**

### Demo and real DBs are completely separate
`tuskledger.db` and `tuskledger_demo.db` are two distinct SQLite files.
The runtime routes per-request based on a cookie (`mode=demo` or
`mode=real`). Don't write code that assumes one global DB. Don't write
data fixtures that hit the real DB. The toggle in the UI is the user's
explicit consent — don't bypass it.

### Plaid `INVALID_LINK_CUSTOMIZATION`
Plaid Link exits immediately on Production unless the user has enabled
the **Data Transparency / Track and manage your finances** use case in
their Plaid dashboard's Link customization. This isn't documented
prominently. If a user reports "Plaid Link closes immediately on
Production but works in Sandbox," this is the cause 95% of the time.

### Wash-sale calculator is chronologically interleaved
The wash-sale logic is in
`backend/app/services/trading_tax/wash_sale.py` (or similar — confirm
by searching `recharts-bar` … wait, wrong repo, search `wash`). The
algorithm is a single chronological pass across **all relevant
trades**, not a per-symbol grouping. Per-symbol grouping produces wrong
disallowed-loss totals when round-trips are interleaved. There's a test
that catches the wrong implementation; if you "simplify" this code and
the test goes red, the test is right and your simplification is wrong.

### Don't bump Python or Node without checking CI
`.python-version` is `3.12`. CI tests against 3.12 and (when working)
3.13. `pydantic-core` historically lagged on 3.13 wheels — if you bump
versions and CI breaks on a wheel, that's why. The `_disabled/` test
folders also exist partly because of this churn. Coordinate with the
user before changing.

### `backend/scripts/` is gitignored on purpose
It tends to hold one-off data-fix scripts that hardcode the user's
actual account names, employer, or specific `roth_split_pct` values.
**Don't add these to a generic utilities folder and don't commit
anything in there.** If you write a generic utility, put it in
`backend/app/services/` and add a test.

### The `_disabled/` directories are not "trash"
Both `backend/tests/_disabled/` and `frontend/src/_disabled/` hold tests
that are parked because of fixture infrastructure issues, not because
they're wrong. Don't delete them. Don't move them back without
verifying they pass green.

### CI workflow uses `|| true` deliberately
`.github/workflows/ci.yml` may have steps that pipe to `|| true`. This
is intentional — those steps are advisory while the suite stabilizes.
Don't "fix" them by removing the `|| true` until the underlying
flakiness is gone. The user knows about each instance.

---

## Architecture notes

### State lives in three places (in priority order)
1. **`backend/tuskledger.db`** — the authoritative one. Everything the
   user has touched lives here.
2. **`backend/.encryption_key`** — the Fernet key for stored Plaid
   tokens. Lost = re-link every account.
3. **`backend/.env`** — config + Plaid keys + session secret.

Anything else (frontend localStorage, in-memory caches, daily backup
snapshots) is derived and recoverable.

### Sync is poll-based, not webhook-based
A scheduler in `backend/app/main.py` runs every `SYNC_INTERVAL_HOURS`
(default 6) and pulls fresh transactions from Plaid for every
connected item. The **Sync Now** button forces an immediate poll. We
do support Plaid webhooks (`PLAID_WEBHOOK_VERIFY` flag) but the polling
loop is the source of truth. Don't introduce a third sync path.

### Auth is opt-out (kind of)
Default behavior: bcrypt password + TOTP MFA, session cookie signed
with `SESSION_SECRET`. **`DEV_BYPASS_AUTH=true` skips all of it.** Many
single-machine users run with this on. The user has explicitly
acknowledged this for their setup. Don't try to "improve security" by
removing the bypass flag.

### Frontend doesn't know about the demo/real toggle
The cookie is set/read entirely server-side. The frontend just makes
API calls; the backend routes them to the right DB. Don't try to make
the frontend route directly to a different SQLite — it can't, by
design.

### Tax modules are pure functions
`backend/app/services/retirement_simulator.py`, the wash-sale
calculator, the Schedule C bucketizer, the HSA tracker — all are pure
functions over inputs. They don't read from the DB; they take typed
inputs and return typed outputs. The router layer is responsible for
gathering inputs and writing outputs. **Keep the math layer pure.**
Tests rely on this.

---

## Style conventions

- **Python:** standard formatting, type hints on public functions,
  docstrings on routers and services. Prefer `pathlib.Path` over `os.path`.
  Use `from __future__ import annotations` for forward references.
- **JavaScript / React:** functional components, hooks, no class
  components. Inline styles are fine in this codebase (the CSS-in-JS
  story is consistent throughout). Recharts for charts.
- **Commit messages:** imperative subject line (≤72 chars) plus a body
  explaining *why*, not just *what*. The git history is part of the
  documentation. Examples are throughout the recent log.
- **Comments:** explain *why*, not *what*. The code shows what; the
  comment should tell the reader what would be unclear or surprising.

---

## When you're stuck

Ask the user. Specifically:

- If the user gave you an ambiguous instruction, ask before guessing.
  Bad guesses on tax math or financial features create real harm.
- If you're about to do something irreversible (delete data, force-push,
  rotate keys), ask. Always.
- If a test is failing and you don't understand why, surface that
  honestly rather than working around it. The user would rather hear
  "I don't know what this test is asserting" than discover a silent
  regression next month.
- If a feature seems redundant or weird ("why are there two ways to
  enter a manual asset?"), there's usually a reason. Ask before
  consolidating.

The maintainer is one person. They will respect a question more than a
well-meaning destructive action.

---

## The `tuskledger doctor` command

When something's broken — install isn't booting, a feature page is
empty, the user reports a vague problem — run this first instead of
grepping. It's a structured health check designed to be parsed by an
AI assistant.

```bash
./tuskledger doctor              # human-readable, color output
./tuskledger doctor --json       # machine-readable, stable schema
```

It checks: Python and Node versions vs the pinned ones, `.env` presence
and required keys (with placeholder-value detection), encryption-key
file + permissions, DB file + schema-vs-migrations alignment, recent
backups, disk space, ports 8000/3000 availability, `node_modules` and
`venv` presence.

**Exit code:** 0 if every check has status `pass` or `warn`. 1 if any
check failed. Use this in scripts.

**JSON output schema** (`backend/app/cli.py` is the source of truth):

```json
{
  "ok": true,
  "version": "1",
  "summary": {"total": 13, "pass": 13, "warn": 0, "fail": 0},
  "checks": [
    {"name": "env_file", "category": "env", "status": "pass",
     "message": "backend/.env exists", "fix_hint": null},
    ...
  ]
}
```

If you (the agent) need to surface a diagnosis to the user, the
`message` and `fix_hint` fields are designed to be reproduced verbatim.

## Optional Ollama LLM (Dashboard "AI insights" card)

There's a single LLM-powered surface in the app right now: the AI
narrative card on the Dashboard, sitting directly above the rule-based
`InsightsBar`. It hands a structured bundle of pre-computed insights
(`backend/app/services/insights_narrative.py::build_insights_bundle`) to
a local Ollama model and asks it to write 2-3 plain-English paragraphs
around the numbers.

**Off by default.** Three env vars in `backend/.env`:

```
LLM_ENABLED=false               # flip to true to turn the card on
LLM_MODEL=llama3.1:8b           # any tag Ollama knows
LLM_URL=http://127.0.0.1:11434  # default Ollama port
```

When the user wants to enable it:

```bash
curl -fsSL https://ollama.com/install.sh | sh
ollama serve &                  # background daemon
ollama pull llama3.1:8b         # ~5GB one-time download
# then set LLM_ENABLED=true in backend/.env and restart the backend
./tuskledger doctor             # confirms the ollama_reachable check
```

**Behavior the agent must respect when extending this:**

- *The model never does math.* Every dollar figure in the prompt JSON
  comes pre-computed from `build_insights_bundle()` and rounded to
  whole dollars at the serializer boundary. This is the load-bearing
  invariant that keeps a local 7B model from hallucinating dollar
  amounts in a finance tool. Don't add prompt fields that ask the
  model to compute or estimate anything — just feed it more
  structured facts to write around.
- *Demo mode short-circuits Ollama.* When `fintrack_mode=demo`, the
  endpoint returns a canned `DEMO_NARRATIVE` string regardless of
  whether Ollama is reachable. Marketing screenshots depend on this
  staying deterministic.
- *Failures collapse to LLMUnavailable.* All HTTP / parsing failures
  in `services/llm_ollama.py::OllamaClient.complete()` raise
  `LLMUnavailable`, which the analytics router maps to a single 503.
  Keep this collapse — it lets the frontend handle "Ollama is acting
  up" with one error path instead of N.
- *Pre-flight checks before completion.* The router calls
  `client.health()` and `client.has_model()` before `complete()` so
  the user sees a fast, actionable error instead of a 60-second hang
  while Ollama silently downloads multi-GB weights.
- *Read-mostly.* The MCP server (`tuskledger-mcp`, separate repo) is
  the read-only entry point for AI agents querying user data; the
  Dashboard LLM card is a *write*-style surface (it generates text
  for the user). Don't conflate the two — they serve different
  audiences and live behind different toggles.

## Useful one-liners (copy / adapt)

```bash
# What's the current Python and Node version this repo expects?
cat .python-version .nvmrc

# What changed recently?
git log --oneline -20

# Show me all files that talk to Plaid
grep -rl "plaid" backend/app/ --include="*.py"

# Show me all the routers and what they handle
ls backend/app/routers/

# How big is the test suite?
find backend/tests -name "test_*.py" -not -path "*/_disabled/*" | wc -l

# Run only the wash-sale tests
cd backend && pytest tests/ -k "wash" -v

# Build the frontend for production (sanity check before pushing)
cd frontend && npm run build

# What's wrong with this install? (See "tuskledger doctor" section above.)
./tuskledger doctor --json | jq
```

---

## Direct MCP access (`tuskledger-mcp`)

If you're operating in an MCP-aware client (Claude Desktop, Cursor,
Cowork, Claude Code), the user may have `tuskledger-mcp` configured.
That gives you typed access to the user's finance data without going
through the web UI. The server lives in its own repo:
**https://github.com/BradMorphsters/tuskledger-mcp**

Tools available (v0): `list_accounts`, `list_stale_accounts`,
`query_transactions`, `search_transactions`, `get_spending_summary`,
`get_top_merchants`, `get_recurring_subscriptions`, `get_upcoming_bills`,
`get_net_worth`, `get_holdings`, `get_investments_summary`,
`get_retirement_projection`, `run_sync`.

If MCP tools are available you can use them, but **don't assume they
are**. They're configured per-user. If you're in an MCP-less context
(plain editor session), fall back to reading the codebase / running
`./tuskledger doctor`.

## Project links

- Site: https://www.tuskledger.com
- Main repo: https://github.com/BradMorphsters/tuskledger
- MCP server repo: https://github.com/BradMorphsters/tuskledger-mcp
- Issues: https://github.com/BradMorphsters/tuskledger/issues
- For LLMs browsing externally: https://www.tuskledger.com/llms.txt
