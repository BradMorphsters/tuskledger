# Public demo deployment runbook (demo.tuskledger.com)

This runbook covers standing up a public, read-only Tusk Ledger instance
at `demo.tuskledger.com` so visitors can poke around the UI without
installing anything. Different from MOBILE.md, which covers reaching
**your laptop** from your phone — DEMO.md is about a **separate hosted
instance** running on Azure App Service with synthetic Alex-Carter data.

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
Visitor → GoDaddy DNS → Azure App Service → uvicorn → FastAPI
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
  an 8B model on a small shared App Service plan is a bad fit. The Ask panel and
  AI Insights tile both fall back to canned responses in demo mode
  (which they already do client-side; no extra wiring needed).
- **No auth.** `DEV_BYPASS_AUTH=true` so visitors don't hit a login
  wall. The read-only middleware is the actual security boundary; auth
  would just be a nuisance with nothing to protect.
- **No persistent user state.** The demo DB is read at boot and any
  cookies are per-visitor; one visitor can't affect another.

---

## Hosting (Azure)

| Piece | Value |
| --- | --- |
| Web app | `tuskledger-demo-f64109` in resource group `rg-tuskledger-demo` (Central US), on the shared Linux plan `asp-sites-linux` |
| Image | `ghcr.io/bradmorphsters/tuskledger-demo` (public package), built by `.github/workflows/azure-demo.yml` |
| Container port | 8000 (`WEBSITES_PORT=8000`) |
| Health check | `/api/health` |
| Secrets | `SESSION_SECRET` is a Key Vault reference to `tuskledger-demo-session-secret` in `kv-sites-f64109` (generated in Azure, never displayed) |

## Required app settings

```
DEMO_LOCKED=true
DEMO_ENABLED=true
DEV_BYPASS_AUTH=true
LLM_ENABLED=false
WEBSITES_PORT=8000
SESSION_SECRET=@Microsoft.KeyVault(VaultName=kv-sites-f64109;SecretName=tuskledger-demo-session-secret)
```

The Plaid keys are deliberately absent.

---

## Deploy

Every push to `main` runs `.github/workflows/azure-demo.yml`: it builds the
image (seeding a fresh demo DB), pushes it to ghcr.io, points the web app at
the new tag and waits for `/api/health`. GitHub signs in to Azure with OIDC,
so no Azure secret lives in GitHub. The job only runs in the `production`
environment, which is restricted to `main`.

The same workflow runs daily at 09:00 UTC, so the demo's dates are
re-anchored to "today" without anyone redeploying by hand.

### Verify the lockdown after a deploy

Hit `https://tuskledger-demo-f64109.azurewebsites.net/api/health` — it should
return `{"status":"ok"}` — then poke the UI:

- The startup log shows the `📣 DEMO_LOCKED is ON` banner
  (`az webapp log tail -g rg-tuskledger-demo -n tuskledger-demo-f64109`).
- Trying to flip a budget value gives a 403 with `code: read_only_mode`.
- The Sync button is hidden.
- All visible data is the Alex-Carter synthetic dataset.

If any of those don't match, don't point DNS at it. Fix first.

### DNS (GoDaddy, `tuskledger.com`)

```
Type   Name        Value                                   
CNAME  demo        tuskledger-demo-f64109.azurewebsites.net
TXT    asuid.demo  <the subscription's custom-domain verification ID>
```

Then bind the hostname and a free managed certificate:

```
az webapp config hostname add -g rg-tuskledger-demo --webapp-name tuskledger-demo-f64109 --hostname demo.tuskledger.com
az webapp config ssl create -g rg-tuskledger-demo -n tuskledger-demo-f64109 --hostname demo.tuskledger.com
```

---

## What to monitor

- **Uptime:** the App Service health check pings `/api/health` and
  restarts the container if it stops answering.
- **Logs:** after each deploy, check the `DEMO_LOCKED` banner is present.
  If it's missing, the setting got dropped — visitors could mutate data,
  which is the failure this runbook exists to prevent.
- **Cost:** the demo shares the B1 plan with the other sites, so it adds
  nothing on its own. The subscription's $20/month budget alert covers it.

---

## Rollback

Re-point the app at a known-good image tag (tags are `<commit>-<run>`):

```
az webapp config container set -g rg-tuskledger-demo -n tuskledger-demo-f64109 \
  --container-image-name ghcr.io/bradmorphsters/tuskledger-demo:<good-tag>
```

To take the public URL offline: `az webapp stop -g rg-tuskledger-demo -n tuskledger-demo-f64109`.

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
