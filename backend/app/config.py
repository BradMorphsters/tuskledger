import os
from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    APP_NAME: str = "Tusk Ledger"
    DATABASE_URL: str = "sqlite:///./tuskledger.db"

    # Plaid configuration
    PLAID_CLIENT_ID: str = ""
    PLAID_SECRET: str = ""
    PLAID_ENV: str = "sandbox"  # sandbox | development | production

    # Auto-sync interval in hours
    SYNC_INTERVAL_HOURS: int = 6

    # Session signing key. If blank, a fresh random key is generated on
    # each backend start (invalidating prior sessions — fine for local use).
    # Set this to a long random string in .env to keep sessions alive
    # across restarts.
    SESSION_SECRET: str = ""

    # When true, verify the Plaid-Verification JWT on every incoming webhook.
    # Leave false for local tunneled dev; turn on once you're pointing Plaid
    # at a stable public URL.
    PLAID_WEBHOOK_VERIFY: bool = False

    # TEMPORARY development escape hatch: when true, skip the login page and
    # treat every request as authenticated. Intended for iterating on UI/API
    # changes without re-entering MFA on every restart. ALL gating is bypassed
    # while this is on — do not set this in any environment that touches real
    # Plaid production data. Flip back to false (or remove from .env) to
    # restore normal login + TOTP flow.
    DEV_BYPASS_AUTH: bool = False

    # Demo mode plumbing.
    #
    # The app boots both a "real" database (DATABASE_URL) and a "demo"
    # database (DEMO_DATABASE_URL) in one process. Each request picks one
    # via the `fintrack_mode` cookie — so a user can flip between their
    # real data and synthetic Alex Carter data without restarting the app.
    #
    # `DEMO_ENABLED` gates the entire feature. Turn it off and the demo
    # engine isn't created, the toggle disappears, and the demo router
    # 403s — useful if you want to run a "production-shaped" deploy without
    # any synthetic plumbing.
    DEMO_ENABLED: bool = True
    DEMO_DATABASE_URL: str = "sqlite:///./tuskledger_demo.db"
    DEMO_ENCRYPTION_KEY_FILE: str = "./.encryption_key.demo"

    # When DEMO_LOCKED=true, this instance is a public read-only demo
    # (e.g. demo.tuskledger.com). The whole app is forced into:
    #   - demo database for every request (cookie ignored — visitors
    #     can't bypass by clearing it)
    #   - read-only middleware on for every request (cookie ignored —
    #     visitors can't mutate anything)
    #   - no Plaid sync scheduler
    #   - no auto-backup of the SQLite file (demo DB is disposable;
    #     backups would just churn disk on a free-tier host)
    # This is the env var that turns a normal Tusk Ledger deployment
    # into a public demo instance. Default off; only flip on when the
    # bind is actually reachable from the public internet.
    DEMO_LOCKED: bool = False

    # ── LAN sync for the mobile app ───────────────────────────────
    #
    # Tusk Ledger normally binds to 127.0.0.1 — only the laptop's
    # browser can reach it. When LAN_SYNC_ENABLED=true we expect the
    # process to be bound to 0.0.0.0 (or a LAN-routable interface) so
    # a phone on the same Wi-Fi can hit the mobile sync endpoints.
    #
    # Two effects:
    #   1. The DEV_BYPASS_AUTH startup guard is loosened — non-localhost
    #      bind is OK because the mobile API has its own device-token
    #      auth (see routers/mobile.py). The web UI on the LAN is the
    #      user's deliberate choice on their own home network; treat it
    #      the same way the desktop session is treated.
    #   2. Bonjour advertisement (services/bonjour.py) registers
    #      _tuskledger._tcp.local. so the phone discovers the host
    #      without the user typing an IP.
    #
    # Off by default — enabling it is an explicit "I'm running this on
    # my home Wi-Fi and want my phone to see it" decision.
    LAN_SYNC_ENABLED: bool = False

    # ── Optional local LLM (Ollama) ───────────────────────────────
    # When LLM_ENABLED=true, the Dashboard's "AI narrative" card calls
    # Ollama at LLM_URL with LLM_MODEL to summarize this month's
    # spending in plain English. Off by default — the app works fine
    # without it. Demo mode renders canned narrative text so the
    # screenshots don't depend on Ollama being installed.
    #
    # Install Ollama:  curl -fsSL https://ollama.com/install.sh | sh
    # Pull the model:  ollama pull llama3.1:8b
    # Verify:          ./tuskledger doctor   (look for ollama_reachable)
    LLM_ENABLED: bool = False
    LLM_MODEL: str = "llama3.1:8b"
    LLM_URL: str = "http://127.0.0.1:11434"

    # ── Long-term-hold research layer ─────────────────────────────
    # Directory holding the PII-free research files (<domain>.research.json)
    # and the contract (research.schema.json). The research layer joins
    # this scored universe onto live holdings at query time — no balances
    # ever live in these files, so the directory is safe to commit to git
    # (which is exactly how the spec wants version history).
    #
    # Blank (the default) resolves to the repo-level ./research directory
    # (see services/research_store.py:research_dir). Override with an
    # absolute path — e.g. ~/.tuskledger/research — to keep the data
    # outside the repo. "~" is expanded.
    RESEARCH_DIR: str = ""

    # The app focuses on ONE industry/theme at a time. When several research
    # files exist in RESEARCH_DIR (e.g. critical-minerals + retail), this names
    # the active one — it sorts first so the UI defaults to it. Blank → the
    # first domain found. Set this to a file's meta.domain (e.g. "retail") to
    # switch the whole app's focus to a different industry. See the
    # "Adding an industry" guide in docs/.
    ACTIVE_RESEARCH_DOMAIN: str = ""

    # ── Market price data (research price chart) ──────────────────
    # The price chart pulls real monthly closes from a market-data provider.
    # Keyless sources (Stooq, Yahoo) are now bot-walled for server requests,
    # so set a free Twelve Data API key here for reliable price history:
    #   1. Sign up at https://twelvedata.com/pricing (Basic/free — no card)
    #   2. Copy the API key from the dashboard
    #   3. Put it in backend/.env as: MARKETDATA_API_KEY=your_key_here
    #   4. Restart the backend.
    # Free tier is ~800 calls/day / 8 per minute — plenty for the daily
    # refresh + on-demand chart loads. Leave blank to fall back to
    # best-effort keyless Yahoo (frequently blocked → "price unavailable").
    MARKETDATA_API_KEY: str = ""

    # ── Quiver Quantitative (public-purchase signals) ─────────────
    # Powers the Signals tab + the "Public activity" overlay in Research:
    # federal government contracts, congressional trades, insider Form-4
    # trades, and corporate lobbying — distilled into a direction (heating
    # up / steady / cooling) per name. Needs a paid Quiver API key:
    #   1. Sign up at https://api.quiverquant.com/ (Hobbyist ~$30/mo Tier 1
    #      covers congressional trades + government contracts; Trader ~$75/mo
    #      adds insider, lobbying, etc.)
    #   2. Put the key in backend/.env as: QUIVER_API_KEY=your_key_here
    #   3. Restart the backend.
    # Blank → the Signals tab shows a "connect Quiver" state and the
    # Research overlay is hidden; nothing else is affected.
    QUIVER_API_KEY: str = ""

    # ── SEC EDGAR (free, no key) ──────────────────────────────────
    # The EDGAR block in Signals / Research pulls each name's recent SEC
    # filings straight from the SEC — insider Form-4 activity (count-based,
    # which fills the gap left by Quiver's tier-gated insider feed), 8-K
    # material events, and S-1/424B capital-raise (dilution) flags. No key
    # is needed, but the SEC requires a descriptive User-Agent identifying
    # the caller with a contact address. Override only if you want your own
    # contact on the requests; the default is fine for local use.
    SEC_USER_AGENT: str = "TuskLedger/1.0 (+https://www.tuskledger.com)"

    # ── Agentic trading (experiment) ──────────────────────────────
    # JSONL decision log written by the agentic-trading executor
    # (app.agent_trading). The Agent Trading tab reads this file read-only.
    # Blank → defaults to backend/var/agent_trading/decisions.jsonl, and the
    # tab shows a "no runs yet" state until the experiment has run.
    AGENT_TRADING_LOG: str = ""
    # Persisted policy state (equity high-water mark + halt/pause flag) the broker
    # can't track for us. Blank → backend/var/agent_trading/state.json.
    AGENT_TRADING_STATE: str = ""
    # Live agent-activity event stream (the "watch it think" timeline), tailed by the
    # SSE endpoint. Blank → backend/var/agent_trading/events.jsonl.
    AGENT_TRADING_EVENTS: str = ""
    # The Analyst's trading philosophy (Gate 1 decision rules). One of:
    # signal_event | momentum | mean_reversion | rotation. See agent_trading/strategy.py.
    AGENT_TRADING_STRATEGY: str = "signal_event"
    # Human-in-the-loop approval queue: gate-approved orders awaiting the user's Approve/Reject
    # tap in the app. Blank → backend/var/agent_trading/proposals.json. Placement of an approved
    # proposal is bound to the user's in-app action — never an agent-callable path.
    AGENT_TRADING_PROPOSALS: str = ""
    # Failure-alert log (cycle errors, guardrail vetoes, drawdown halt, placement failures) the
    # tab + digest surface. Blank → backend/var/agent_trading/alerts.jsonl.
    AGENT_TRADING_ALERTS: str = ""
    # Encrypted store for the backend's own Robinhood agentic-MCP OAuth token (when Tusk Ledger is
    # the bound agent). Blank → backend/var/agent_trading/rh_agent.json.enc.
    AGENT_TRADING_AGENT_STORE: str = ""
    # LIVE arming. False (default) → even after Connect, Approve only marks approved; the backend
    # never places. Set true ONLY as the deliberate go-live step (Phase 4 of the runbook).
    AGENT_TRADING_ARMED: bool = False
    # Hard ceiling (USD) on TOTAL capital the sleeve may deploy. 0 = unlimited. Start small
    # (e.g. 300) to go live with a restriction, then raise it to scale up. Enforced by the gate
    # at generation, so an over-cap order never reaches the approval queue.
    AGENT_TRADING_MAX_DEPLOYED: float = 0.0

    class Config:
        env_file = ".env"
        env_file_encoding = "utf-8"


settings = Settings()
