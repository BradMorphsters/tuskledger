# Mobile access (iPhone read-only)

This runbook covers reaching your Tusk Ledger laptop from your phone — first
on your home WiFi (works today) and then off WiFi via Cloudflare Tunnel +
Cloudflare Access (the secure exit path).

The model is intentionally narrow: **the laptop is the only source of truth.
The phone is a thin client that renders read-only views over the network.**
Nothing syncs. Nothing replicates. If the laptop is asleep, the phone shows
a connection error — that's the design, not a bug.

---

## When to use this runbook

- First time setting up phone access
- Setting up a second device (iPad, partner's phone)
- After a router swap, a new ISP, or a Cloudflare account migration
- When `https://tusk.<your-domain>` stopped working and you need to retrace
  the chain

---

## Architecture in one paragraph

Phone Safari hits a public URL on your domain. Cloudflare's edge accepts the
TLS connection, checks Cloudflare Access (an OAuth-style gate that lets only
you in), and then forwards the request through a long-lived `cloudflared`
tunnel running on your laptop. `cloudflared` proxies it to Vite (port 3000)
or FastAPI (port 8000) on `127.0.0.1`. The backend's `tuskledger_view=readonly`
cookie middleware blocks any non-GET that isn't on the allowlist, so even if
the auth gate is misconfigured the phone can't mutate state.

---

## Prerequisites

- Tusk Ledger running locally (frontend on `:3000`, backend on `:8000`)
- A domain you control on Cloudflare (free tier is fine)
- Apple ID or Google account for the Access identity provider
- ~20 minutes for the first-time setup

---

## Stage 1 — LAN-only access (works today, no Cloudflare)

This is what `vite.config.js`'s `host: true` already enables. Use this when
you're on your home WiFi.

1. **Find your laptop's LAN IP:**
   ```
   ipconfig getifaddr en0
   ```
   Note the address (e.g. `192.168.1.42`). On a router restart this can
   change — pin it via your router's DHCP reservation if you want it stable.

2. **Make sure both servers are running:**
   ```
   # In one terminal
   cd backend && uvicorn app.main:app --reload --host 0.0.0.0 --port 8000

   # In another
   cd frontend && npm run dev
   ```

3. **On the phone**, open Safari to:
   ```
   http://<laptop-ip>:3000/?view=readonly
   ```
   The `?view=readonly` flag posts to `/api/view/readonly`, sets the
   `tuskledger_view` cookie (90-day TTL), and strips the param from the URL.

4. **Add to Home Screen:** Share → Add to Home Screen. The PWA manifest +
   service worker take over: custom icon, no Safari chrome, themed status
   bar, app-shell cache for snappy launches.

After this, the laptop must be (a) awake, (b) on the same network, and (c)
running both servers. That's the constraint Stage 2 lifts for the network
piece.

---

## Stage 2 — Off-WiFi access via Cloudflare Tunnel

### 2a. Install cloudflared

```
brew install cloudflare/cloudflare/cloudflared
cloudflared tunnel login
```

The login command opens a browser, prompts you to authorize the tunnel for
the Cloudflare account that owns your domain, and drops a cert at
`~/.cloudflared/cert.pem`.

### 2b. Create a named tunnel

```
cloudflared tunnel create tuskledger
```

This prints a tunnel UUID and writes a credentials JSON to
`~/.cloudflared/<UUID>.json`. **Treat that file like a private key** — anyone
who has it can stand up a process that impersonates your tunnel. It's
already gitignored by virtue of being outside the repo; don't move it in.

### 2c. Configure ingress

Create `~/.cloudflared/config.yml`:

```yaml
tunnel: <UUID>
credentials-file: /Users/<you>/.cloudflared/<UUID>.json

ingress:
  # Frontend (Vite dev server or vite preview / static build)
  - hostname: tusk.<your-domain>
    service: http://127.0.0.1:3000

  # Backend API. Same hostname is fine — the Vite dev proxy already
  # forwards /api/* to :8000, so for dev we only need one route. If you
  # serve a built bundle from a static host, split this out:
  # - hostname: api.tusk.<your-domain>
  #   service: http://127.0.0.1:8000

  # Catch-all is required by the cloudflared schema
  - service: http_status:404
```

### 2d. Point DNS at the tunnel

```
cloudflared tunnel route dns tuskledger tusk.<your-domain>
```

This creates a `CNAME` to `<UUID>.cfargotunnel.com`. Verify in the Cloudflare
DNS dashboard.

### 2e. Stand up Cloudflare Access (the auth gate)

This is the step you do not skip. Without Access, your finance dashboard is
on the public internet behind only a long URL.

1. Cloudflare dashboard → Zero Trust → Access → Applications → **Add an
   application** → Self-hosted.
2. Application name: `Tusk Ledger`. Domain: `tusk.<your-domain>`.
3. **Identity provider:** add Google (or Apple, GitHub — pick one). For
   Google you'll create OAuth credentials in Google Cloud Console; the
   Cloudflare wizard walks through it.
4. **Policy:** `Allow` rule with `Emails` → your one email address.
   That's the entire allowlist.
5. **Session duration:** 24 hours is a reasonable default for a phone — long
   enough you don't re-auth daily, short enough that a stolen session
   expires.

Now `https://tusk.<your-domain>` will redirect to a Cloudflare-hosted login
page before reaching cloudflared. Approved devices get a session cookie
scoped to the hostname.

### 2f. Run the tunnel

For a manual test:

```
cloudflared tunnel run tuskledger
```

You should be able to hit `https://tusk.<your-domain>/?view=readonly` from
your phone (off WiFi, on cellular) and see the read-only banner.

### 2g. Run the tunnel as a launchd service (so it survives reboot)

```
sudo cloudflared service install
```

This installs a launchd plist at `/Library/LaunchDaemons/com.cloudflare.cloudflared.plist`
that starts the tunnel on boot and restarts it if it crashes. Logs go to
`/Library/Logs/com.cloudflare.cloudflared.out.log`.

---

## What's protected and what isn't

**Cloudflare Access protects:** anyone hitting `https://tusk.<your-domain>`
must pass the Allow policy (your email + Google OAuth) before any request
reaches `cloudflared`.

**The read-only middleware protects:** even an authenticated session that
sets `tuskledger_view=readonly` cannot POST/PUT/DELETE anything outside the
allowlist (`/api/auth/`, `/api/view/`, `/api/demo/mode`). See
`backend/app/main.py` for the gate.

**The Plaid sync button** is hidden client-side when `readOnly === true` and
would 403 server-side anyway. Same for the QuickAddFab.

**What is not protected:** if you sign into Cloudflare Access on a device
and someone else picks up the unlocked phone, they can browse your data.
The session is bound to the device, not to a TouchID prompt. The mitigation
is screen lock — which iOS already enforces on a stolen phone — and short
Access session duration.

---

## Sleep-mode caveat

When the laptop sleeps, `cloudflared` pauses. Phone requests will time out
or 502. The fixes, in increasing order of effort:

1. **`pmset` keep-awake when on power:**
   ```
   sudo pmset -c sleep 0
   ```
   Sleeps on battery, awake on power. Easiest. Costs some idle power.

2. **`caffeinate` in the tunnel's launchd wrapper:** modify the plist to
   wrap the cloudflared invocation. Same effect, scoped to when the tunnel
   needs to be up.

3. **Stage v2 (snapshot replication):** publish an encrypted SQLite snapshot
   to user-controlled storage (S3, Cloudflare R2) on a cron and have the
   phone hydrate it via `sql.js`. Phone works when laptop is asleep at the
   cost of being a separate point-in-time copy. Out of scope for this
   runbook; tracked separately.

For the current single-user, mostly-at-home pattern, option 1 is the right
default.

---

## Rollback

To take the public hostname offline without uninstalling anything:

```
cloudflared tunnel route dns --overwrite-dns tuskledger tusk.<your-domain>
# then in the Cloudflare DNS dashboard, delete the CNAME row
```

To stop the tunnel service:

```
sudo cloudflared service uninstall
```

To revoke all sessions (if you suspect a stolen device):

```
# Cloudflare Zero Trust → My Team → Users → click your user → Revoke sessions
```

The tunnel credentials in `~/.cloudflared/<UUID>.json` keep working until
explicitly revoked. To rotate:

```
cloudflared tunnel delete tuskledger
cloudflared tunnel create tuskledger    # new UUID, new credentials
# then redo 2c, 2d
```

---

## Troubleshooting

**"Bad gateway" in the browser, but the URL loads.**
cloudflared is reachable but can't reach the backing service. Either Vite
or FastAPI is down — check both terminals.

**"This site can't be reached" / DNS_PROBE_FINISHED_NXDOMAIN.**
The CNAME for `tusk.<your-domain>` isn't there. Re-run 2d. If it's there
but Cloudflare proxy is grey-clouded, click the cloud to orange.

**Phone gets the Access login page but Google OAuth fails with
`redirect_uri_mismatch`.**
The redirect URI in your Google OAuth credential must match exactly. The
Cloudflare wizard prints the right value — copy/paste, no trailing slash.

**`?view=readonly` doesn't take.**
Confirm the request hits `POST /api/view/readonly` (200) and that
`tuskledger_view` shows up in Safari's cookies for the host. If it doesn't,
the backend probably isn't reachable through the tunnel — check 2c's
`service:` URL matches your FastAPI port.

**Want to flip a phone back to edit mode (for debugging from the phone).**
Append `?view=edit` to any URL once. The cookie flips and persists for 90
days.

---

## Related

- `frontend/src/components/ReadOnlyMode.jsx` — phone mode plumbing
- `backend/app/main.py` — read-only middleware, CORS allow_origin_regex
- `backend/app/routers/view.py` — cookie endpoints
- `frontend/public/manifest.webmanifest` — PWA manifest (start_url defaults
  to `?view=readonly` so home-screen launches land in the right mode)
- `frontend/public/sw.js` — app-shell cache, never caches `/api/*`
