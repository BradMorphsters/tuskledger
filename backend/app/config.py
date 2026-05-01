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

    class Config:
        env_file = ".env"
        env_file_encoding = "utf-8"


settings = Settings()
