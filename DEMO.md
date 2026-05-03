# Public demo deployment runbook (demo.tuskledger.com)

This runbook covers standing up a public, read-only Tusk Ledger instance
at `demo.tuskledger.com` so visitors can poke around the UI without
installing anything. Different from MOBILE.md, which covers reaching
**your laptop** from your phone — DEMO.md is about a **separate hosted
instance** running on Railway with synthetic Alex-Carter data.

The lockdown is the entire point: a public hosted instance can't share
the security posture of a single-user laptop install. Every gate is on
by default, the demo DB is the only DB, and visitors literally cannot
mutate state.

---

## Architecture

One container, one process, one SQLite file. The Dockerfile builds the
React bundle (stage 1) and copies it into the FastAPI container (stage
2), which serves both the static bundle at `/` and the API at `/api/*`.
The synthetic demo DB is **seeded at build time**, so cold starts don't
pay the seeding cost and every redeploy gets a fresh dataset re-anchored
to "today."

```
Visitor → Cloudflare DNS → Railway → uvicorn → FastAPI
                                                 │
                                                 ├── static bundle (React)
                                                 ├── /api/* (FastAPI routes)
                                                 └── tuskledger_demo.db (synthetic)
```

The `DEMO_LOCKED=true` env var is the master switch. When on, the
backend:

- Forces every request onto the demo DB (cookie ignored — visitors
  can't bypass by clearing or forging it).
- Runs every mutating request through the read-only middleware
  (cookie ignored — same reason). The auth/view/demo-mode allowlist
  is the only writable surface.
- Skips the Plaid sync scheduler entirely (no real items, no outbound
  Plaid calls).
- Skips the auto-backup machinery (the demo DB is disposable).
- Prints a loud banner at startup so the operator can confirm the
  lockdown is active in logs.

---

## What the demo does NOT do

- **No Plaid keys.** The container has no `PLAID_CLIENT_ID` set, so
  Plaid Link won't initialize and Plaid sync won't run.
- **No local LLM.** Ollama isn't installed in the container — running
  an 8B model on a $5/mo Railway dyno is a bad fit. The Ask panel and
  AI Insights tile both fall back to canned responses in demo mode
  (which they already do client-side; no extra wiring needed).
- **No auth.** `DEV_BYPASS_AUTH=true` so visitors don't hit a login
  wall. The read-only middleware is the actual security boundary; auth
  would just be a nuisance with nothing to protect.
- **No persistent user state.** The demo DB is read at boot and any
  cookies are per-visitor; one visitor can't affect another.

---

## Required environment variables on Railway

```
DEMO_LOCKED=true
DEMO_ENABLED=true
DEV_BYPASS_AUTH=true
LLM_ENABLED=false
PLAID_CLIENT_ID=
PLAID_SECRET=
SESSION_SECRET=<a long random string — `openssl rand -hex 32`>
```

The blank Plaid keys are deliberate. `SESSION_SECRET` should be a real
random string so session cookies are stable across container restarts
(otherwise visitors get logged-out-looking weirdness on every redeploy).

---

## Deploy steps

### 1. Push the deploy artifacts

```
cd ~/Documents/Claude/Projects/Personal\ finance\ tracking/tuskledger
git push
```

The Dockerfile, .dockerignore, and railway.json are all at the repo
root.

### 2. Create the Railway service

```
# from the tuskledger repo root
railway login
railway init        # pick "Empty Project" → name it tuskledger-demo
railway up          # builds + deploys; first build takes ~3–5 min
```

If you'd rather click through the UI: railway.app → New Project →
Deploy from GitHub repo → BradMorphsters/tuskledger → main branch.
Railway picks up `railway.json` automatically.

### 3. Set the env vars

```
railway variables --set DEMO_LOCKED=true \
                  --set DEMO_ENABLED=true \
                  --set DEV_BYPASS_AUTH=true \
                  --set LLM_ENABLED=false \
                  --set SESSION_SECRET=$(openssl rand -hex 32)
```

Or in the Railway dashboard: Project → Variables tab → paste each one.
A redeploy auto-fires on save.

### 4. Verify the lockdown

Once the build finishes, Railway gives you a `*.up.railway.app` URL.
Hit `/api/health` first — should return `{"status":"ok"}`. Then poke
the UI. Look for these signals that the lockdown is on:

- The startup logs show the `📣 DEMO_LOCKED is ON` banner (Railway →
  Deployments → latest → View Logs).
- Trying to flip a budget value gives a 403 with `code: read_only_mode`.
- The Sync button is hidden (read-only middleware blocks the underlying
  POST so the frontend hides the affordance).
- All visible data is the Alex-Carter synthetic dataset (Costco, NYT,
  fictional checking + brokerage + mortgage).

If any of those don't match, **don't point DNS at it yet.** Fix first.

### 5. Point DNS at it

In GoDaddy DNS for `tuskledger.com`:

```
Type   Name   Value                              TTL
CNAME  demo   <your-service>.up.railway.app      1 hour
```

In Railway: Project → Settings → Domains → "Custom Domain" → enter
`demo.tuskledger.com`. Railway provisions a TLS cert (a few minutes).

### 6. Add to marketing site

`tuskledger-site/src/App.jsx` — add a "Try the live demo" CTA pointing
at `https://demo.tuskledger.com`. One-line change in the hero or the
ForAgents section.

---

## Daily reset (optional but recommended)

Visitors can't mutate state thanks to the read-only middleware, but the
demo dates are anchored to the build time. To keep the demo feeling
"current" without redeploying by hand, add a Railway cron service:

```
railway service add --name tuskledger-demo-reset
railway variables --service tuskledger-demo-reset --set CRON_SCHEDULE="0 9 * * *"
```

Schedule a daily redeploy at 9 AM UTC. The image rebuilds (re-running
`seed_demo.py` against today's date) and restarts the main service.

If you don't set this up, a stale demo isn't broken — the dates just
drift further from "today" the longer between deploys.

---

## Cost expectations

Railway's free tier gives 500 hours of execution per month with $5 of
usage credit. A demo container at the smallest tier (~256MB RAM) sized
for the demo's traffic should fit well inside that. If the demo gets
real traffic, the next tier is $5/mo for 8GB / always-on.

Things to watch:

- **Cold starts.** Free tier sleeps after inactivity. First visitor
  after sleep waits ~10–15 seconds for boot. Acceptable for a demo.
- **Memory.** SQLite + FastAPI + the seeded DB fits in 256MB. If you
  ever add the LLM (don't), memory blows up.
- **Outbound bandwidth.** No real-time data fetched, so this should
  stay near-zero.

---

## What to monitor

- **Uptime:** Railway's built-in dashboard plus `/api/health`. If
  `/api/health` doesn't return `{"status":"ok"}` within 30 seconds,
  the healthcheck-driven restart kicks in.
- **Logs:** spot-check after each deploy that the `DEMO_LOCKED` banner
  is present. If it's missing, the env var got dropped — visitors can
  mutate things, which is the entire failure mode this runbook exists
  to prevent.
- **Cost:** Railway dashboard → Usage. If you cross half the free
  tier in a normal week, the demo is getting more traffic than
  expected (good news, but plan accordingly).

---

## Rollback

If the demo goes sideways:

```
railway service redeploy --service tuskledger-demo --version <prior>
```

Or in the dashboard: Deployments → pick the last known-good → Redeploy.

To take the URL offline without uninstalling anything:

```
# Railway dashboard → Settings → Domains → remove demo.tuskledger.com
```

The `*.up.railway.app` URL keeps working for debugging.

---

## Related

- **README.md** — main project doc.
- **MOBILE.md** — phone access to YOUR laptop (different problem; same
  read-only middleware).
- **ARCHITECTURE.md** — process topology, no-hallucination invariant,
  read-only middleware.
- **`backend/app/main.py`** — middleware wiring; look for the
  `DEMO_LOCKED` checks.
- **`backend/app/scripts/seed_demo.py`** — synthetic Alex-Carter
  dataset generator. Re-running it produces a fresh DB anchored to
  today.
