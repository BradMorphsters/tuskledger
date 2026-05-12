#!/bin/bash
# Tusk Ledger — Personal Finance Dashboard
# Double-click this file to launch Tusk Ledger.
#
# Lives inside the project folder (alongside backend/ and frontend/),
# so it locates the project via its own path — no search list needed.
# After macOS rename / move, just keep this file in the same directory
# as backend/ and frontend/ and it'll keep working.

set -e

# Resolve the project directory from the script's own location.
# This is robust to the user dragging the project folder anywhere
# on disk, including paths with spaces.
PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"

if [ ! -d "$PROJECT_DIR/backend" ] || [ ! -d "$PROJECT_DIR/frontend" ]; then
  echo "ERROR: Can't find backend/ or frontend/ alongside this script."
  echo "  Script: $0"
  echo "  Resolved project dir: $PROJECT_DIR"
  echo ""
  echo "Move 'Tusk Ledger.command' next to the backend/ and frontend/ folders."
  echo "Press any key to close."
  read -n 1
  exit 1
fi

clear
echo "================================="
echo "  Tusk Ledger — Personal Finance "
echo "================================="
echo ""
echo "Project: $PROJECT_DIR"
echo ""

# Sanity check: .env present AND populated?
# A bare existence check would silently pass when the user has run
# `cp .env.example .env` but not edited the placeholders yet — the most
# common first-run mistake. Catch both "file missing" and "still the
# .env.example placeholders" so the warning fires before Plaid does.
ENV_FILE="$PROJECT_DIR/backend/.env"
env_warning=""
if [ ! -f "$ENV_FILE" ]; then
  env_warning="No backend/.env file found — copy backend/.env.example to backend/.env and add your Plaid keys."
elif grep -qE '^PLAID_CLIENT_ID=(your_plaid_client_id_here)?$' "$ENV_FILE" || \
     grep -qE '^PLAID_SECRET=(your_plaid_secret_here)?$' "$ENV_FILE"; then
  env_warning="backend/.env exists but PLAID_CLIENT_ID / PLAID_SECRET still look unset — edit it and add your Plaid dashboard keys."
fi
if [ -n "$env_warning" ]; then
  echo "WARNING: $env_warning"
  echo "         The app will still start, but account syncing won't work until configured."
  echo ""
fi

# --- Backend ---
# Bind decision: localhost-only by default (the original Tusk Ledger
# trust model — only the laptop's browser can reach the API). When the
# user has set LAN_SYNC_ENABLED=true in backend/.env, expose to 0.0.0.0
# instead so the iOS companion app on the same Wi-Fi can hit the
# /api/mobile/* endpoints. The mobile API has its own X-Device-Token
# auth, independent of DEV_BYPASS_AUTH, so this isn't loosening the
# security model — it's only making the LAN bind possible.
BACKEND_HOST="127.0.0.1"
if [ -f "$PROJECT_DIR/backend/.env" ] && \
   grep -q '^LAN_SYNC_ENABLED=true' "$PROJECT_DIR/backend/.env"; then
  BACKEND_HOST="0.0.0.0"
  echo "Detected LAN_SYNC_ENABLED=true — binding backend to 0.0.0.0 for mobile sync."
fi
echo "Starting backend (FastAPI on http://${BACKEND_HOST}:8000)..."
cd "$PROJECT_DIR/backend"

# Python venvs aren't relocatable — every script in venv/bin/ (pip,
# uvicorn, alembic, …) has the absolute venv path baked into its
# shebang line. After a parent-folder rename or move, those binaries
# point at a path that no longer exists and you get "pip: command not
# found" or similar even though `source activate` appears to succeed.
# Detect that case and rebuild the venv automatically.
NEED_VENV=0
if [ ! -d "venv" ]; then
  NEED_VENV=1
elif ! ./venv/bin/python -c "import sys" 2>/dev/null; then
  echo "Detected broken venv (likely from folder rename or Python upgrade). Rebuilding..."
  rm -rf venv
  NEED_VENV=1
fi
if [ "$NEED_VENV" = "1" ]; then
  echo "Creating Python virtual environment..."
  python3 -m venv venv
fi

# shellcheck disable=SC1091
source venv/bin/activate
pip install -r requirements.txt --quiet 2>&1

uvicorn app.main:app --host "$BACKEND_HOST" --port 8000 --reload &
BACKEND_PID=$!

# --- Frontend ---
echo "Starting frontend (Vite on http://localhost:3000)..."
cd "$PROJECT_DIR/frontend"

if [ ! -d "node_modules" ]; then
  echo "Installing frontend dependencies (first run)..."
  npm install
fi

npm run dev &
FRONTEND_PID=$!

# Give servers a moment to bind their ports before opening the browser.
sleep 3

# Open the dashboard in the default browser.
open "http://localhost:3000"

echo ""
echo "Tusk Ledger is running:"
echo "  Dashboard: http://localhost:3000"
echo "  API:       http://localhost:8000/api/health"
echo ""
echo "Press Ctrl+C or close this window to stop both servers."

# Clean shutdown — kill child processes when the user closes the window
# or hits Ctrl+C.
cleanup() {
  echo ""
  echo "Shutting down Tusk Ledger..."
  kill "$BACKEND_PID" 2>/dev/null || true
  kill "$FRONTEND_PID" 2>/dev/null || true
  echo "Done."
  exit 0
}

trap cleanup INT TERM
wait
