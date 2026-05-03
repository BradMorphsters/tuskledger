# Architecture

This document covers the load-bearing design choices in Tusk Ledger — the
ones you would need to understand before changing them. It is deliberately
short. The full surface is the code.

There are three pieces of architecture here that are worth writing down
because they are not obvious from reading any single file: the **process
topology** (what runs where), the **no-hallucination invariant** (the
contract between the LLM and the rest of the app), and the **read-only
mode** (how the phone can safely talk to the laptop).

---

## 1. Process topology

The whole app is four optional processes, all on `127.0.0.1`:

```
                   ┌── Browser (Vite, :3000) ───── React UI
                   │
                   │── FastAPI (:8000) ────────── SQLite (~/tuskledger.db)
Your laptop ───────┤                                  │
                   │── Ollama (:11434, optional) ─────┘  (LLM reads bundles
                   │                                      built by FastAPI)
                   │
                   └── tuskledger-mcp (stdio, optional) ── AI assistant
                          │
                          └── HTTP → FastAPI (same one)
```

There is no Tusk Ledger server. There is no remote endpoint. Your bank
talks to Plaid, Plaid talks to your laptop over HTTPS, your laptop writes
to a SQLite file in your home folder. The frontend, backend, optional
LLM, and optional MCP server are all separate processes on the same
machine. If you turn off your wifi, only the Plaid sync stops working —
everything else keeps running against what's already in SQLite.

The MCP server lives in [its own repo](https://github.com/BradMorphsters/tuskledger-mcp)
because it has a different release cadence and a different audience (AI
assistants, not humans). It does not embed FastAPI; it makes HTTP calls
to the same backend the React UI uses. There is one source of truth for
"what does it mean to query my transactions" — the FastAPI route — and
both the UI and the MCP server consume it.

---

## 2. The no-hallucination invariant

This is the most important architectural decision in the codebase, and
the reason a local 8B-parameter model can be trusted in a finance app at
all.

**The rule:** Every dollar figure, percentage, and merchant name in any
LLM-generated text was computed by Python *before* the model saw it. The
model's only job is to write English prose around a JSON bundle it was
handed. The model is never asked "what did I spend on groceries?" — it
is handed `{"groceries": 687.21, "vs_prior_month_pct": 12.4}` and asked
to write a sentence.

Why this matters: LLMs hallucinate numbers. An 8B local model
hallucinates more than a frontier model. In a domain where one wrong
figure breaks the whole trust contract — would you use a budget app that
told you "you spent $400 on Uber this month" when the real answer was
$80? — you cannot afford even a 1% hallucination rate on dollar amounts.

**How it's enforced:**

1. **Bundle builders are pure functions** in `backend/app/services/chat_prompts.py`
   and `backend/app/services/insights_narrative.py`. Each builder takes a
   SQLAlchemy session + parameters and returns a typed JSON dict. No LLM
   in sight.

2. **All numbers are rounded to whole dollars at the bundle boundary.**
   The model literally cannot see fractional cents. There is nothing in
   the prompt for the model to misread as 7-decimal float precision.

3. **The system prompt explicitly forbids invention.** It tells the
   model: write prose around the bundle, do not introduce numbers that
   are not in the bundle, do not aggregate or estimate.

4. **The bundle is round-tripped to the client.** The same JSON the LLM
   was handed comes back to the frontend in the response payload, so a
   curious user (or auditing tool) can compare the prose against the
   ground-truth numbers.

The cost: less LLM autonomy. The model cannot "decide" to compare your
spending to last year if last year's number isn't in the bundle. That
trade-off is correct. The point of the LLM is not to reason about your
finances; the point is to write a paragraph in English that's nicer to
read than a table.

**Where this generalizes:** any domain where being wrong-with-confidence
is worse than not-knowing. Medical, legal, financial, scientific.
Pre-compute the facts; let the model write the sentence. The pattern is
not novel as math — every reporting tool has done it forever — but it is
counter-cultural in 2026 LLM design where the default reflex is "let the
agent figure it out."

The two surfaces using this pattern today:

- **AI Insights tile** (Dashboard) — one paragraph per day summarizing
  the month. Bundle: monthly totals, category leaders, anomaly flags.
- **Ask panel** (floating button on every page) — nine curated prompts.
  Bundle: the specific numbers needed to answer that prompt at that
  horizon. Streamed token-by-token via Server-Sent Events.

---

## 3. Read-only mode

The phone (or any device) can be flagged read-only by setting the
`tuskledger_view=readonly` cookie. This happens automatically when a
device loads `?view=readonly`; the PWA's `start_url` includes this
param so Add-to-Home-Screen installs land in read-only by default.

Read-only is **enforced server-side** by a FastAPI middleware in
`backend/app/main.py`. Every mutating method (POST/PUT/PATCH/DELETE)
gets 403'd if the request carries the readonly cookie, except for a
small allowlist:

- `/api/auth/` — login, MFA, logout. Needed before the cookie is set.
- `/api/view/` — the mode toggle itself. Self-evidently can't lock
  yourself out of unlocking yourself.
- `/api/demo/mode` — demo↔real toggle, same lockout-paradox reasoning.

**Why a middleware, not a per-route dependency:** A dependency would
require importing `Depends(require_readonly_check)` on every mutating
endpoint, and a forgotten import would silently leave a write surface
open. A middleware blocks the whole class with one ~20-line check; new
endpoints inherit it for free. The trade-off is exactly the same as
`require_auth` (also wired as `dependencies=protected` at the include
level for the same reason): one place to look, no per-route drift.

**This is layered above auth, not in place of it.** The middleware runs
after authentication has already happened — an unauthenticated request
from a read-only device is rejected by `require_auth` first, and only
authenticated-but-read-only requests reach the read-only check. Two
gates, two failure modes, both well-defined.

**The cookie is per-device.** This is the entire reason for choosing a
cookie over a config file. Your laptop browser never sets the cookie;
your phone (loaded once with `?view=readonly`) gets it set with a 90-day
TTL. Each device is independent. No redeploy needed to flip a device's
mode.

For the off-WiFi extension of this architecture (Cloudflare Tunnel +
Cloudflare Access in front of `cloudflared`), see [MOBILE.md](MOBILE.md).

---

## 4. Why SQLite

Two reasons that show up over and over when shipping changes:

1. **It is one file.** Backups are `cp tuskledger.db tuskledger.db.bak`.
   Migration to a new machine is `scp`. The auto-backup machinery uses
   SQLite's online-backup API to take snapshots without locking. There
   is no operational story for "running the database" because there is
   no database to run.

2. **Schemas are migratable without ceremony.** Alembic generates
   migrations from SQLAlchemy model diffs; a `alembic upgrade head` at
   startup picks them up. Demo and real DBs run the same migration set
   (we explicitly fixed this — see commit history around the demo
   schema-sync bug).

The cost: you do not get a multi-user database. That is fine. This is a
single-user tool by design.

---

## 5. Why FastAPI auto-generates everything

Two surfaces are auto-derived from the FastAPI route definitions and
their Pydantic schemas:

1. The **OpenAPI spec** at `/openapi.json` — and from it, the Swagger UI
   at `/docs` and ReDoc at `/redoc`. Both live and current with the
   actual implementation by construction.

2. The **MCP server** in `tuskledger-mcp` reads the same routes through
   HTTP and exposes them as typed MCP tools. When a route is added in
   FastAPI with proper `response_model=`, the MCP server picks it up
   without code changes on its side.

There is no separate API documentation to keep in sync with the code,
and no separate type definitions to drift. The cost is that you have to
care about response models — endpoints that return raw `dict`s lose the
type information downstream. The codebase does this consistently; that
discipline is load-bearing.

---

## Where to learn more

- **AGENTS.md** — working-memory doc for AI assistants, covers permission
  boundaries, common operations, and known footguns.
- **MOBILE.md** — phone-access runbook, including the Cloudflare Tunnel
  + Cloudflare Access setup for off-WiFi access.
- **README.md** — user-facing surface area, install paths, configuration.
- **CHANGELOG.md** — what shipped when.
- **`backend/app/services/chat_prompts.py`** — the bundle builders for
  the Ask panel; the no-hallucination invariant in code form.
- **`backend/app/main.py`** — middleware stack (auth, read-only mode,
  CORS, sessions) all in one file, deliberately.
