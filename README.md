# Tusk Ledger

**🌐 Project site: [www.tuskledger.com](https://www.tuskledger.com)** — feature tour, comparison vs Mint/Empower/Quicken, FAQ, and architecture diagram.

A locally-run personal finance dashboard — a Mint-style app that pulls real bank, credit-card, investment, and loan data via [Plaid](https://plaid.com), stores everything in a single SQLite file on your machine, and gives you a clean interface to track spending, budgets, net worth, and recurring charges.

Everything stays on your computer. No cloud. No third-party analytics. Just your data, your rules.

[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![Python 3.12+](https://img.shields.io/badge/python-3.12+-blue.svg)](https://www.python.org)
[![Node 22 LTS](https://img.shields.io/badge/node-22%20LTS-blue.svg)](https://nodejs.org)
[![Local-first](https://img.shields.io/badge/local--first-yes-brightgreen.svg)](https://www.tuskledger.com#architecture)

**Follow the project:**
[![Bluesky](https://img.shields.io/badge/Bluesky-@tuskledger-1185fe?logo=bluesky&logoColor=white)](https://bsky.app/profile/tuskledger.bsky.social)
[![X](https://img.shields.io/badge/X-@TuskLedger-000000?logo=x&logoColor=white)](https://x.com/TuskLedger)
[![Dev.to](https://img.shields.io/badge/Dev.to-tuskledger-0a0a0a?logo=devdotto&logoColor=white)](https://dev.to/tuskledger)
[![TikTok](https://img.shields.io/badge/TikTok-@tuskledger-ff0050?logo=tiktok&logoColor=white)](https://www.tiktok.com/@tuskledger)
[![Reddit](https://img.shields.io/badge/Reddit-maintainer-ff4500?logo=reddit&logoColor=white)](https://www.reddit.com/user/ShapeObjective9727/)
[![LinkedIn](https://img.shields.io/badge/LinkedIn-maintainer-0a66c2?logo=linkedin&logoColor=white)](https://www.linkedin.com/in/eduardothomasdiaz)

> **TL;DR** — Eight pages doing real work: Dashboard, Transactions, Spending & Income, Bills calendar, Loans, Investments / Trading Tax (FIFO + chain-correct wash sale + Form 8949), Retirement projection (Monte Carlo + Roth ladder + IRMAA + RMDs), Tax Prep Pack (HSA + capital loss + Schedule C + QBI). All running on your laptop. Plaid for bank data, SQLite for storage, FastAPI + React for the surface. No SaaS, no telemetry, no subscription.

> **🤖 Working with an AI assistant?** Read [AGENTS.md](AGENTS.md) — it's a working-memory doc written for Claude Code, Cursor, Cowork, and similar agents. It covers permission boundaries, common operations, and the project's known footguns so an agent can be productive without grepping the whole tree first.

---

## Try the demo first (no Plaid required)

Want to play with the app before committing to Plaid setup? It ships with a demo dataset — 12 months of synthetic transactions for a fictional "Alex Carter" household: checking, savings, mortgage, auto loan, two credit cards, 401(k), and brokerage. All real merchant names, fake amounts, fake user.

```bash
git clone https://github.com/<your-username>/tuskledger.git
cd tuskledger
chmod +x start.sh
./start.sh
```

`./start.sh` boots the app with **both databases** (real and demo) running side-by-side. The first time it launches, it seeds `backend/tuskledger_demo.db` automatically; on later runs it reuses what's there.

Inside the app you'll see a small **Real / Demo** toggle in the sidebar (also a "Try the demo →" button on the Setup/Login screen if you haven't done MFA setup yet). Flip the toggle to switch which database the UI is reading from — the change takes effect immediately and is remembered via a cookie. Real-mode auth still applies in real mode; demo mode bypasses auth entirely since the data is synthetic.

When you're in demo mode, a **Refresh demo data** button appears in the sidebar. Clicking it wipes the demo DB and regenerates 12 months of fresh data anchored to today, so the demo never feels stale. Your real `tuskledger.db` is never touched.

---

## What you get

**Dashboard.** Net worth, monthly spending, top categories, and upcoming bills at a glance. **Trend snapshot** with a 2/3/6/12mo/YTD selector showing range totals + per-month averages, driving the Income vs Spending chart in lock-step. **Anomaly insight cards** surface when a category trends >30% over its trailing 3-month average, when a brand-new merchant appears, or when a single charge dwarfs the historical norm at that merchant — dismissable per-card for 7 days. **Stale-balance banner** flags accounts that haven't synced in a week.

**Spending & Income.** Sparklines, MoM/YoY deltas, day-of-week heatmap, cash-flow waterfall, top-merchants chart, recurring/subscriptions detection with seasonal awareness. **Year-over-year toggle** flips the page to side-by-side current-vs-prior-year comparisons. **Per-merchant drill-down** — click any merchant to open a slide-out with YTD total, monthly trend, and the full transaction list.

**Cash Flow forecast.** Median-of-monthly baseline (rather than a noisy rolling mean) with adaptive salary-source detection — the forecast pulls real paychecks even when you have one-off bonuses muddying the picture. **Emergency runway** tile that includes taxable brokerage holdings alongside cash, so the runway number reflects what's actually liquid in a pinch (matching the Financial Pulse definition). Subscriptions tab with a **cut-simulator**: toggle items off and watch a live "save \$X/mo · \$Y/yr" banner, plus per-row **Mark as subscription / Not a subscription** buttons backed by a `SubscriptionRule` table so you can hand-correct the auto-detector's misses without losing the override on the next sync.

**Bills Calendar.** 30-day forward calendar plotting recurring charges + paychecks on the days they're expected, so tight weeks are visible at a glance. Confidence scores derive from how many times each event has actually occurred. **Inline +/− amounts**, a **per-day running balance** so you can spot the week the account dips, **starting-cash + projected end-of-window + projected low-point** tiles up top, and **drag-to-reschedule** for one-off events with override persistence.

**Transactions.** Splits, custom recategorization, transfer detection, business tagging, **free-text notes** per transaction. **Bulk operations** — multi-select with a floating action bar to recategorize, mark/clear transfer in batches. **Auto-suggest rules** — after a manual recategorization the app offers to apply the same category to other transactions from the same merchant. **Search** across name and merchant_name composes with the existing account/category/date filters.

**Rules.** Pattern-based **category rules** AND **business-tagging rules**, both with per-rule "Apply to past transactions" so a new rule retroactively cleans up history in one click. Both rule types also fire on every new sync/import.

**Budgets** per category with progress tracking and **Goals** (savings goals with pace-per-month and projected target date).

**Net Worth** history with manual-asset support (homes, vehicles, etc.) and **manual-liability pairing** so a vehicle's auto loan (often unsupported by Plaid) can sit alongside its asset entry, with equity computed inline. Plaid-paired liabilities for mortgages. Built-in **debt payoff calculator** (snowball/avalanche). **Projection toggle** extends the chart 6/12 months forward at the current 90-day pace.

**Loans.** Full amortization with **extra-payment slider** + live months-saved / interest-saved math, **bi-weekly comparison** mode, **refinance modeler** (break-even months + lifetime savings vs current loan), **PMI drop-off detection** combining amortized LTV with original purchase price, **HELOC draw / repayment period** modeling, and a **multi-loan stacked timeline** so you can see mortgage / auto / student loans winding down together. Surfaces both Plaid-paired liabilities and manual liabilities (auto loans Plaid can't connect to, private student loans, etc.). A **payoff-countdown dashboard tile** ticks each mortgage down month-by-month so progress is visible at a glance.

**Investments** roll-up by account with holdings, asset allocation donut, top-5 holdings, % gain/loss, **manual investment accounts** for held-away balances (Fidelity NetBenefits, Voya, PlanMember, etc. that Plaid can't connect to), and a **capital-loss carryover tracker** that estimates how many years of $3k ordinary-income offset you can claim.

**Trading Tax** — dedicated page for swing/active traders. Per-(account, security) FIFO matching that mirrors how brokerages report on the 1099-B, with a chain-correct interleaved chronological pass so a string of round-trip wash sales propagates disallowed basis end-to-end. Surfaces locked-vs-captured wash-sale dollars separately so you can see what's truly stuck vs what's been recovered downstream. **Wash-sale scope toggle** (all-accounts / per-account / selected) for users with multiple brokerage logins. **Cross-account transfer reconciliation** — when shares move between accounts without a clean Plaid transfer event, the calculator pulls FIFO lots from sibling accounts to satisfy the oversell instead of inventing phantom open positions. **Per-symbol P&L**, **top winners / losers**, **quarterly estimated-tax pacing** (linear annualized obligation aligned to IRS 1040-ES due dates), and **Form 8949 CSV export** with proper Box A / Box D bucketing and code W on wash-sale rows. **Pre-flight sell modal** — type a symbol + qty before you hit sell and see the realized gain, ST vs LT classification, wash-sale risk, and a recommendation tier (proceed / caution / avoid). **Tax-loss harvesting finder** scans current losers and surfaces candidates ranked by tax savings, flags wash-sale risk inside the 30-day window, and suggests an IRS-safe replacement security from a curated pair list (VTI ↔ ITOT, VOO ↔ IVV, etc.). **Per-investment-account freshness panel** with one-click sync and surfacing of demo-mode no-ops + partial Plaid item failures, since stale holdings will silently produce wrong wash-sale numbers if you don't notice.

**Retirement projection** — multi-decade two-phase simulator (accumulation + withdrawal) over investable assets, with pension and Social Security streams, real wage and healthcare growth, age-banded spending phases (go-go / slow-go / no-go), bracket-aware federal + state tax math, RMDs starting at 73, and a 4-bucket model (taxable, tax-deferred, Roth, HSA). Per-account `roth_split_pct` field handles mixed 401(k)s where Plaid only sees the total balance. **Roth conversion ladder** with side-by-side lifetime-tax comparison vs no-conversion baseline. **Max sustainable spending** calculator that bisects on `desired_income` to find the highest spend that drains your portfolio to ~$0 at a configurable target age, with after-tax estimate and headroom-led metric tile. **Step events** for permanent or duration-bound shifts to contribution or spending (mortgage payoff, kid college, sabbatical). **One-time events** with positive amounts as expenses and negative amounts as inflows (cash inheritance lands in the taxable bucket). **LTC sensitivity comparison**, **survivor scenario**, **sequence-of-returns stress presets**, **Monte Carlo runs** with fan chart + probability of success, **state-tax presets** with retiree-relevant exemption notes for MI/CA/NY/OH/IL/TX/FL/WA. Save/compare named scenarios; print-to-PDF for sharing with an advisor.

**Business** tagging for LLCs / side businesses with per-business reports, **CSV export** for tax prep, and a **Schedule C bucketizer** that classifies tagged business transactions into IRS categories (advertising, supplies, COGS, etc.) with capital-vs-expense routing for assets that should hit Form 4562 instead of Schedule C.

**Tax tools.** **HSA contribution tracker** with payroll-deduction mode and on-pace-to-max recommendation against the IRS limit (self / family + age-55 catch-up). **DCFSA contribution tracker** with the same payroll-aware on-pace metric. **Capital-loss carryover tracker** on Investments. **Schedule C bucketizer** with capital-vs-expense routing under Business. **Trading Tax** page with realized P&L, wash-sale tracking, quarterly pacing, Form 8949 CSV, pre-flight sell modal, and tax-loss harvest finder (above). **Tax Prep Pack** — a single PDF report aggregating HSA, capital loss, Schedule C totals, business mileage, and other year-end inputs into one printable document for your CPA. All driven by data already in the app — no separate tax-prep workflow.

**Importing data outside Plaid.** Two paths for filling history Plaid doesn't have: **CSV import** with drag-and-drop, format auto-detection (LMCU, Chase activity, generic 4-column), reusable per-account; and **Plaid backfill** which calls `/transactions/get` for an explicit date range when the cursor has already advanced past a window you care about. Both dedupe against existing transactions so they're safe to re-run.

**Bank-grade hygiene.** Plaid access tokens encrypted at rest with Fernet. Auth is username + TOTP MFA. **Auto-backup** of the SQLite DB on every boot to `backend/backups/` (last 14 dailies, online-backup API so no torn pages).

---

## Tech stack

| Layer | Stack |
|---|---|
| Backend | Python 3.11 · FastAPI · SQLAlchemy 2 · Alembic · APScheduler · Plaid Python SDK |
| Frontend | React 18 · Vite · React Router · Recharts · Lucide |
| Database | SQLite (single file, WAL mode) |
| Auth | bcrypt + PyOTP (TOTP MFA) |

---

## Prerequisites

- **Python 3.12+** (pinned in `.python-version`; CI tests against 3.12 and 3.13)
- **Node.js 22 LTS** (pinned in `.nvmrc`; CI tests against 20 and 22)
- **A Plaid account** — free to sign up. Sandbox keys are immediate; Production requires approval (see [Plaid setup](#plaid-setup) below)
- **macOS, Linux, or WSL** — the launcher scripts assume a Unix-y shell. Windows users should run via WSL or call the start commands manually.

If you use [`pyenv`](https://github.com/pyenv/pyenv) and [`nvm`](https://github.com/nvm-sh/nvm), the version files are picked up automatically when you `cd` into the project directory.

---

## Quick start

```bash
# 1. Clone
git clone https://github.com/<your-username>/tuskledger.git
cd tuskledger

# 2. Configure backend
cp backend/.env.example backend/.env
# Open backend/.env in your editor and paste your Plaid keys

# 3. Run
chmod +x start.sh
./start.sh
```

`start.sh` will:

1. Create a Python virtualenv at `backend/venv` (if it doesn't exist) and install `requirements.txt`
2. Run any pending Alembic migrations against `backend/tuskledger.db`
3. Start the FastAPI backend on `http://127.0.0.1:8000`
4. Install `node_modules` (if missing) and start Vite on `http://localhost:3000`
5. Open `http://localhost:3000` in your browser

Stop with `Ctrl+C` (or `./stop.sh`).

---

## First-run flow

1. Open `http://localhost:3000`. You'll land on the **Setup** page — pick a username + password and scan the TOTP QR code with any authenticator app (1Password, Authy, Google Authenticator).
2. Sign in with your username + password + 6-digit code.
3. Go to **Accounts** → **Connect Account** to launch Plaid Link.
4. Pick your bank, log in, choose which accounts to share, finish the handoff.
5. Transactions and balances start flowing into the dashboard. The background scheduler refreshes every `SYNC_INTERVAL_HOURS` (default 6); the **Sync Now** button forces an immediate pull.

---

## Plaid setup

This is the part that trips people up. Plaid is free to sign up for, but Production access requires approval, and there are a couple of gotchas.

### Sandbox (5 minutes — start here)

1. Sign up at [dashboard.plaid.com/signup](https://dashboard.plaid.com/signup).
2. Go to **Developers → Keys**. You'll see a `client_id` and a `Sandbox secret`.
3. Paste them into `backend/.env`:
   ```
   PLAID_CLIENT_ID=<your client_id>
   PLAID_SECRET=<your sandbox secret>
   PLAID_ENV=sandbox
   ```
4. In Plaid Link, log in with the test credentials `user_good` / `pass_good`. You'll get fake but realistic-looking transactions to play with.

### Production (real banks — takes 1–3 days for approval)

To connect actual accounts, you need a Production secret. Here's the path that works for personal/single-user apps:

1. **Request Production access** in the dashboard under **Team Settings → API Access**. Fill out the form honestly:
   - Use case: *Personal financial management*
   - User base: *Just me / my household*
   - Data sources: check Transactions + Investments + Liabilities (the ones Tusk Ledger uses)
2. **Configure the Data Transparency use case.** This is the gotcha — without it, Plaid Link will exit immediately on Production with `INVALID_LINK_CUSTOMIZATION`.
   - Go to **Link → Customizations → [your customization] → Use cases**.
   - Enable **"Track and manage your finances."**
   - Save. Without this enabled the Production link flow is dead in the water.
3. **Wait for approval.** Plaid will email when your Production secret is unlocked. You can re-use the same `client_id`; just swap the secret and flip `PLAID_ENV=production` in `.env`.
4. **Pricing.** Production is free for the first 100 connected items, then per-item per-month after that — see [plaid.com/pricing](https://plaid.com/pricing). For a personal household this stays free.

### Plaid products this app uses

The link token is created with `products=[transactions]` and `optional_products=[investments, liabilities]`. The optional products gracefully degrade — if your bank doesn't support Investments or Liabilities, the connection still succeeds, you just don't get those tabs populated for that institution. To enable Liabilities/Investments scope on a previously-connected item you'll need to relink it (Plaid update mode is on the roadmap but not implemented).

---

## Configuration reference

Everything lives in `backend/.env`. See [`backend/.env.example`](backend/.env.example) for the full list with comments. Highlights:

| Var | Default | Notes |
|---|---|---|
| `PLAID_CLIENT_ID` | _(required)_ | From Plaid dashboard |
| `PLAID_SECRET` | _(required)_ | Sandbox or Production secret depending on `PLAID_ENV` |
| `PLAID_ENV` | `sandbox` | `sandbox` or `production` |
| `SESSION_SECRET` | random per restart | Set to a long random string to keep sessions across restarts |
| `SYNC_INTERVAL_HOURS` | `6` | Background sync cadence |
| `DEV_BYPASS_AUTH` | `false` | Set `true` to skip login while iterating on UI. **Never enable this on a machine that anyone else can reach.** |
| `PLAID_WEBHOOK_VERIFY` | `false` | Verify Plaid-Verification JWT on incoming webhooks |
| `LLM_ENABLED` | `false` | Optional. Flip on to render the Dashboard "AI insights" card via a local Ollama model. See below. |
| `LLM_MODEL` | `llama3.1:8b` | Any tag Ollama knows (`phi3:mini` for older hardware, `llama3.1:70b` if you have the RAM). |
| `LLM_URL` | `http://127.0.0.1:11434` | Where Ollama listens. Override only if you've moved the daemon. |

The Fernet encryption key for stored Plaid access tokens is auto-generated on first run as `backend/.encryption_key` (chmod 600). If you back up `tuskledger.db`, back up that key file too — without it your stored tokens become unreadable.

### Optional: AI insights card (local LLM via Ollama)

When `LLM_ENABLED=true`, the Dashboard's "AI insights" card calls a locally-running Ollama instance to summarize this month's spending in plain English. Off by default — the rest of the app works without it. Nothing leaves the machine; Ollama binds to `127.0.0.1` and the model runs against your CPU/GPU.

```bash
# 1. Install Ollama (Apple Silicon / Linux)
curl -fsSL https://ollama.com/install.sh | sh

# 2. Pull a model. llama3.1:8b is a good default on 16GB+ Apple Silicon.
ollama pull llama3.1:8b

# 3. Start the daemon (it runs in the background)
ollama serve &

# 4. Flip LLM_ENABLED=true in backend/.env, restart the backend.
# 5. Verify with the doctor — look for ollama_reachable.
./tuskledger doctor
```

Hardware notes: 8B-class models need ~5GB of free RAM and run at 10–30 tok/s on Apple Silicon. On older Intel hardware, drop to `phi3:mini` or leave the feature off. Demo mode renders a canned narrative so screenshots work without Ollama installed.

The model never invents dollar figures — every number in the prompt is pre-computed in Python and the model is only asked to write prose around them. Details in `backend/app/services/insights_narrative.py` and `AGENTS.md`.

---

## Testing

The backend ships with a pytest suite under `backend/tests/` covering the analytics-heavy and tax-math-heavy bits where regressions are easiest to introduce silently — recurring detection, transfer detection, debt payoff math, cash flow forecasting, anomaly insights, transactions search, retirement simulator, loan amortization, the trading-tax / wash-sale calculator (chronological interleaved pass, cross-account transfers, harvest candidate ranking, Form 8949 row builder, quarterly pacing), and the DB backup machinery. Each test is self-contained with its own in-memory SQLite fixture or pure-function fixtures, no Plaid credentials required.

```bash
cd backend
source venv/bin/activate
python -m pytest tests/ -q
```

The frontend has a Vitest harness under `frontend/src/**/*.test.{js,jsx}` covering format helpers, storage helpers, and several pages/components (TradingTax, PreflightSellModal, TradingDataFreshness, Toast, Budgets, CashFlowCalendar, Loans).

```bash
cd frontend
npm test
```

CI ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) runs the backend suite plus a `compileall` sweep and a Vite production build on every push and PR, against Python 3.11 and 3.12.

---

## Project layout

```
tuskledger/
├── backend/
│   ├── app/
│   │   ├── main.py              FastAPI app + scheduler + backup bootstrap
│   │   ├── config.py            Pydantic Settings — env loading
│   │   ├── database.py          SQLAlchemy engines (real + demo) + per-request routing
│   │   ├── models/              ORM models (Account, Transaction, Holding,
│   │   │                        SavingsGoal, BusinessRule, …)
│   │   ├── routers/             API endpoints, one file per resource
│   │   │                        (incl. business_rules, csv_import)
│   │   ├── schemas/             Pydantic request/response shapes
│   │   └── services/            Plaid wrapper, sync, normalizer, recurring/transfer
│   │                            detectors, db_backup, csv_classifier, crypto, …
│   ├── alembic/versions/        Migrations (numbered chronologically — 0016 is latest)
│   ├── tests/                   Pytest harness — recurring detector, debt payoff,
│   │                            cash flow forecast, transfer detection, insights,
│   │                            transactions search, db_backup. Each test is
│   │                            self-contained with its own in-memory SQLite.
│   ├── backups/                 Daily DB snapshots (gitignored, last 14 kept)
│   ├── requirements.txt
│   └── .env.example
├── frontend/
│   ├── src/
│   │   ├── api/client.js        Fetch wrapper for /api endpoints
│   │   ├── components/          Stat, Pill, EmptyState, TransactionDrawer,
│   │   │                        MerchantDrawer, StaleBalanceAlert,
│   │   │                        InsightsBar, TrendStat, BackfillPanel,
│   │   │                        CSVImportPanel, TradingTax, PreflightSellModal,
│   │   │                        TradingDataFreshness, CapitalLossTracker,
│   │   │                        ScheduleCTab, RetirementProjection, …
│   │   ├── pages/               Dashboard, Transactions, SpendingIncome,
│   │   │                        CashFlow, CashFlowCalendar, Goals, NetWorth,
│   │   │                        Investments, TradingTaxPage, Insights, Budgets,
│   │   │                        Business, Retirement, Loans, TaxPrepPack,
│   │   │                        Rules, ConnectAccounts, …
│   │   └── App.jsx              Router + sidebar + auth gating
│   └── package.json
├── .github/workflows/ci.yml     Backend (Python 3.11/3.12) + frontend build on every push
├── start.sh                     One-shot launcher (recommended)
├── stop.sh                      Kills both processes
├── Tusk Ledger.command             macOS double-click launcher
├── LICENSE
└── README.md
```

---

## Common operations

```bash
# Run a new Alembic migration
cd backend
source venv/bin/activate
alembic revision --autogenerate -m "describe your change"
alembic upgrade head

# Run the test suite
python -m pytest tests/ -q

# Rebuild the frontend for production
cd frontend
npm run build

# Restore from a backup (when something has gone sideways)
ls backend/backups/                          # see what dailies you have
cp backend/tuskledger.db backend/tuskledger.db.broken   # keep the bad one for forensics
cp backend/backups/tuskledger-2026-04-25.db backend/tuskledger.db
./start.sh

# Wipe everything and start fresh (DESTRUCTIVE — deletes all your data)
rm backend/tuskledger.db backend/.encryption_key
./start.sh
```

Backups happen automatically: every backend boot writes today's snapshot of `tuskledger.db` to `backend/backups/tuskledger-YYYY-MM-DD.db` using SQLite's online-backup API (no risk of capturing a torn page mid-WAL-checkpoint), and prunes anything older than the most recent 14 dailies. Idempotent within a day, so restarts during dev don't pile up duplicates.

---

## Importing data outside of Plaid

Plaid only feeds back as much history as the institution exposes — often 30–90 days for credit cards, longer for checking. Two ways to fill the gap:

**CSV import** (Connect Accounts page → drag-and-drop zone). Auto-detects three formats:
- **LMCU** — `Date,Description,Comments,Check Number, Amount, Balance` with `($X)` debits and `$X` credits
- **Chase activity export** — `Transaction Date,Post Date,Description,Category,Type,Amount,Memo`
- **Generic** — any 3+ column CSV with `Date,Description,Amount` headers (case-insensitive)

Import dedupes by `(account_id, date, amount, normalized merchant)` so you can re-run the same file safely. Sign convention is auto-flipped to Tusk Ledger's internal one (positive = money out, negative = money in).

**Plaid backfill** (Connect Accounts page → date-range card). Calls Plaid's `/transactions/get` for an explicit window, useful when sync's cursor has already advanced past a period that you've discovered was incomplete. Doesn't disturb the cursor; same dedupe rules. Note: this only retrieves transactions Plaid already has — it can't deepen the bank's history limit. To go further back than the bank feeds Plaid, the only reliable path is CSV.

---

## Troubleshooting

### `INVALID_LINK_CUSTOMIZATION` when opening Plaid Link in Production
Go enable the **Data Transparency / Track and manage your finances** use case in your Plaid Link customization (see [Plaid setup](#plaid-setup) above).

### `Connectivity not supported` for a specific institution
Plaid platform-blocks some institutions (e.g. Fidelity NetBenefits). Workaround: use the manual-asset / manual-investment flow under the relevant page to enter balances and holdings by hand.

### "I can't decrypt my Plaid tokens"
You restored `tuskledger.db` from a backup but didn't restore `backend/.encryption_key`. The two files are paired — keep them together. If the key is truly lost, your only path forward is to wipe both files and re-link your accounts.

### "My DB is corrupted / a migration ate my data"
Check `backend/backups/` — there should be a daily snapshot from before things went sideways. Stop the backend, copy the desired backup over `tuskledger.db` (see the restore command in [Common operations](#common-operations)), and restart. As long as `backend/.encryption_key` hasn't changed, your Plaid tokens will keep working without re-linking.

### Backend boots but sync silently fails
Tail the backend log and look for Plaid API errors. The most common ones are:
- `ITEM_LOGIN_REQUIRED` — your bank wants you to re-login. Click the warning triangle next to the account in **Accounts** to start update mode.
- `INVALID_PRODUCT` — that institution doesn't support a product you requested. Already handled via `optional_products` for Investments/Liabilities, but Transactions failures will surface here.

### Need help getting Plaid integration working?
This is the kind of plumbing where having a coding assistant in the loop saves hours. **[Cowork](https://www.anthropic.com/news/cowork)** (Anthropic's desktop tool for non-developers) and **[Claude Code](https://www.anthropic.com/claude-code)** both have direct access to Plaid documentation, can read your `.env` and backend logs, and can drive Plaid's dashboard for you while you authenticate. If you hit something stuck — `INVALID_LINK_CUSTOMIZATION`, missing investments, a webhook signature mismatch — open the project in one of those, hand it the error, and let it dig in.

---

## Security notes

- This app is designed to run on a single machine that you trust. The default bind is `127.0.0.1`, so it's not exposed on your network.
- Plaid access tokens are encrypted at rest in SQLite using Fernet.
- Auth is bcrypt-hashed password + TOTP MFA. The session cookie is signed with `SESSION_SECRET`.
- **Never** enable `DEV_BYPASS_AUTH=true` on a machine reachable from outside your local network.
- **Never** commit your `.env`, `tuskledger.db`, `.encryption_key`, or anything in `backend/backups/` — they're all in `.gitignore`, but double-check `git status` before pushing.
- Daily DB backups land in `backend/backups/` and contain the same sensitive data as the live DB — treat them with the same care (don't sync them to consumer cloud storage unless you're comfortable with that data being there).
- This is not a hardened multi-tenant SaaS. It's a single-user personal app. Treat it accordingly.

---

## Contributing

PRs welcome. Some areas that would benefit from a hand:

- Plaid update-mode flow for re-linking with additional product scopes
- Mobile / responsive layout pass
- Windows-native start script (currently bash-only)
- More institution support in the manual-asset flow
- Light theme

Run `npm run dev` and `uvicorn app.main:app --reload` separately if you want to iterate without `start.sh`.

---

## License

[MIT](LICENSE) — do whatever you want, no warranty.

---

## Acknowledgements

Built with [Plaid](https://plaid.com), [FastAPI](https://fastapi.tiangolo.com), [React](https://react.dev), [Vite](https://vitejs.dev), [Recharts](https://recharts.org), and [Lucide](https://lucide.dev). Inspired by the Mint that we lost.
