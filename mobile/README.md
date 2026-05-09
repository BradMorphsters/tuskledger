# Tusk Ledger — iOS app

Native(-ish) iPhone client for Tusk Ledger. Built with Expo + React
Native + TypeScript. Talks to your **laptop** over your **home Wi-Fi**.

The phone keeps a local SQLite mirror of your accounts and
transactions, syncs deltas from the laptop in the background, and
renders everything from local storage — so the app feels instant and
keeps working when the Wi-Fi drops or the laptop is asleep.

By design, the phone is **read-only**. Edits, categorization, budgets
— that all stays on the laptop. The phone is a window, not a workshop.

---

## Architecture, in one paragraph

When `LAN_SYNC_ENABLED=true` is set on the laptop's backend, FastAPI
binds to `0.0.0.0:8000` and exposes `/api/mobile/*`. Those endpoints
are authenticated by **device tokens** (not session cookies), issued
once through a QR-code pairing flow. The phone stores the token in iOS
SecureStore and sends it as `X-Device-Token` on every request.
`GET /api/mobile/sync?since=<cursor>` returns rows whose `updated_at`
is at or after the cursor; the phone applies them to its local SQLite
mirror in a single transaction and persists the new cursor. All UI
reads come from SQLite.

```
       ┌──────────────────┐                      ┌────────────────────┐
       │  laptop          │   home Wi-Fi (HTTP)  │  iPhone            │
       │                  │                      │                    │
       │  Plaid → Postgres│ ───/api/mobile/sync─▶│  SyncManager       │
       │  + FastAPI       │                      │   ↓ delta upsert   │
       │                  │                      │  SQLite mirror     │
       │                  │                      │   ↓ all reads      │
       │                  │                      │  Dashboard / Txns  │
       └──────────────────┘                      └────────────────────┘
```

---

## One-time setup

### 1. Backend — turn on LAN sync

Add to `backend/.env`:

```
LAN_SYNC_ENABLED=true
```

Install the new Python deps (Bonjour for auto-discovery):

```sh
cd backend
source venv/bin/activate     # or however you activate yours
pip install -r requirements.txt
```

Run uvicorn bound to **all interfaces**, not just localhost. The
`./start.sh` shipped with Tusk Ledger binds to `127.0.0.1` — for LAN
sync, run it manually:

```sh
cd backend
uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload
```

You should see this line in the logs:

```
[bonjour] advertising _tuskledger._tcp.local. at 192.168.1.42:8000
```

If you don't, the phone can still pair via QR — Bonjour is convenience,
not a requirement.

> `LAN_SYNC_ENABLED=true` is required to permit the LAN bind alongside
> `DEV_BYPASS_AUTH=true`. The startup guard in `main.py` would
> otherwise refuse to boot. The mobile API has its own device-token
> auth, so DEV_BYPASS_AUTH on the web UI only affects the laptop
> browser, not the phone.

### 2. Mobile — install dependencies

```sh
cd mobile
npm install
```

You'll need:

- Node 20+ and npm.
- The Expo CLI is invoked via `npx`; nothing global to install.
- Expo Go on your iPhone (App Store, free) — for the fastest "see it
  on the phone" loop. **Note:** Expo Go SDK 51 doesn't include
  expo-camera by default; for QR scanning you need a development build
  (Step 4) or just use the manual-code fallback while testing.

### 3. Run in Expo Go (fastest)

```sh
cd mobile
npm start
```

Press `i` in the Expo CLI to open in the iOS simulator, or scan the
shown QR with your iPhone's Camera app to launch in Expo Go.

In Expo Go, the camera-based QR pair flow is unavailable; tap **Enter
code manually** instead. On the laptop, open Tusk Ledger →
**Pair phone** in the sidebar, click **Generate code**, and type the
laptop IP + the 8-character code into the app.

### 4. Run a development build (camera + full native)

For QR scanning, Bonjour discovery, and TestFlight, you need a
development build instead of Expo Go.

```sh
cd mobile
npm install -g eas-cli
eas login                     # sign in with your Apple/Expo account
eas build:configure
eas build --profile development --platform ios
```

EAS prompts you to set up provisioning. When it finishes, install the
build via the link it prints (also visible at expo.dev). Now `npm
start` will boot into your dev build, which has the camera plugin and
local network entitlements baked in.

### 5. Pair the phone

1. On the laptop browser, open Tusk Ledger → **Pair phone** in the
   sidebar.
2. Click **Generate code**. A QR appears.
3. On the phone, open Tusk Ledger.
4. Tap **Allow camera** → point at the QR. Done.

The phone immediately runs its first full sync. After that, it
incremental-syncs every 5 minutes when the app is open + on every
foreground.

---

## Going to TestFlight

You'll need:

- An [Apple Developer Program](https://developer.apple.com/programs/)
  membership ($99/year).
- A unique Bundle ID. Default is `com.tuskledger.mobile` — change it
  in `app.json` if you want.
- An App Store Connect record for the app (create at
  https://appstoreconnect.apple.com).

Then:

```sh
cd mobile
eas build --profile preview --platform ios   # internal-distribution build
eas submit --platform ios                    # uploads to App Store Connect
```

EAS handles signing, provisioning profiles, and the upload. Once the
build is processed in App Store Connect (15–30 min), invite testers
under TestFlight → Internal Testing.

**Reminder:** TestFlight builds connect to *your home laptop's IP*
just like the dev build. If a tester wants to actually use the app
they need to be on your home Wi-Fi at the moment they pair. There's
no cloud server involved — that's the whole point of this
architecture.

---

## How sync actually works

- **Cursor:** the phone stores `server_time` from the previous
  response and sends it as `?since=…` next time. The backend filters
  rows by `updated_at >= since`. We use server time (not
  `max(updated_at)`) so rows updated mid-request aren't lost.
- **Full vs. incremental:** first sync after pair has no cursor →
  full table dump. Settings → "Resync from scratch" forces this any
  time. Schema bumps in `db/sqlite.ts` also trigger a full re-pull.
- **Pagination:** transactions are paged at 2000 per response with a
  `has_more` flag. The SyncManager drains the page chain on a single
  `syncNow()` call, up to a `MAX_PAGES_PER_SYNC` safety stop.
- **Deletions:** v1 doesn't propagate deletions through the delta
  endpoint. Plaid rarely deletes transactions; when it does
  (chargeback reversals), the local mirror keeps a stale row until
  the next "Resync from scratch." This is a deliberate v1 trade-off.
- **Auth failure:** a 401 anywhere in the sync loop wipes the local
  token + mirror and bounces the user back to the pairing screen.
  The laptop's "Devices → Revoke" button works this way: revoke,
  next sync 401s, phone re-pairs.

---

## Troubleshooting

**"Couldn't reach 192.168.1.x:8000"**
→ The laptop is asleep, Tusk Ledger isn't running, or you're not on
the same Wi-Fi. Check that uvicorn is bound to `0.0.0.0` (not
`127.0.0.1`) and that `LAN_SYNC_ENABLED=true` is set.

**"Pairing code expired"**
→ The 5-minute window passed before you scanned. Click **Generate
code** again on the laptop.

**"Pairing code not recognized"**
→ The code's been claimed already (single-use), or you typed it
wrong. Generate a fresh one.

**Camera permission denied**
→ iOS Settings → Tusk Ledger → Camera → On. Or use the
**Enter code manually** flow.

**Sync says "Offline" even on Wi-Fi**
→ Open Settings → check the laptop hostname there. If it's empty or
mismatches, the manifest call is failing. Most likely cause:
NSAllowsLocalNetworking didn't take effect (this happens with old
Expo Go builds). Use a development build instead.

**Local Network permission prompt never appeared**
→ iOS only asks once per app install. To re-trigger:
Settings → Tusk Ledger → toggle Local Network off then on, or delete
and reinstall.

---

## Demo mode

**Settings tab → Switch to demo mode.** The phone wipes its local copy
and pulls synthetic data from the laptop's demo database
(`tuskledger_demo.db`, ~12 months of fake "Alex Carter" transactions
+ accounts). The Sync badge in the top-right of every screen turns
into a bright orange **DEMO** pill so it's unmistakable in screenshots.

Use this when:
- You want to share a screenshot of the app without exposing real
  balances.
- Showing the app to someone (friend, dev, beta tester) and don't want
  them to see real numbers.

The toggle is gated by the laptop's `DEMO_ENABLED` setting (default
`true`). If the laptop has `DEMO_ENABLED=false`, the toggle in
Settings is greyed out.

Switching modes is reversible — **Exit demo mode** in Settings wipes
the synthetic data and re-pulls your real finances.

## What's NOT in v1

- Bonjour discovery on the phone — code's wired up via
  `react-native-zeroconf` but only fires inside development/TestFlight
  builds. The QR carries the host directly so the phone doesn't need
  mDNS to function on first pair.
- Push notifications when budgets cross thresholds — out of scope
  for "read-only window."
- Apple Watch complications.
- Two-way sync. Phone is read-only by design.
- Plaid Link from the phone. Adding accounts stays on the laptop.
- Native screens optimization. Currently disabled via
  `enableScreens(false)` in `App.tsx` to dodge a react-native-screens
  v4 + Fabric prop-type bug. Re-enable once upstream patches it.

---

## File map

```
mobile/
├── App.tsx                       # root, decides paired-vs-pairing, tabs
├── app.json                      # Expo config + iOS Info.plist entries
├── eas.json                      # EAS Build profiles
├── package.json
├── tsconfig.json
└── src/
    ├── theme.ts                  # colors, spacing, formatters
    ├── db/
    │   ├── sqlite.ts             # SQLite open/migrate, applySync, reset
    │   └── queries.ts            # screen-shaped read helpers
    ├── sync/
    │   ├── api.ts                # HTTP client, errors
    │   ├── manager.ts            # the sync engine + Zustand store
    │   ├── storage.ts            # SecureStore wrappers
    │   └── types.ts              # wire-format types matching backend
    └── screens/
        ├── PairingScreen.tsx     # QR + manual code first-run
        ├── DashboardScreen.tsx   # net cash, top categories, net worth
        ├── TransactionsScreen.tsx# searchable list, infinite scroll
        ├── SettingsScreen.tsx    # paired host, sync state, unpair
        └── SyncBadge.tsx         # status pill used by other screens
```
