#!/bin/bash
# Tusk Ledger — Start both backend and frontend

set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "================================="
echo "  Tusk Ledger — Personal Finance    "
echo "================================="

# Check for .env file AND that the Plaid keys are actually filled in
# (not still the placeholders shipped in .env.example). A bare existence
# check would silently let the user past `touch backend/.env`; this
# catches the much more common "I copied the example but forgot to edit
# it" case so the failure happens at boot instead of at first sync.
ENV_FILE="$SCRIPT_DIR/backend/.env"
env_warning=""
if [ ! -f "$ENV_FILE" ]; then
  env_warning="No .env file found in backend/ — copy backend/.env.example to backend/.env and add your Plaid keys."
elif grep -qE '^PLAID_CLIENT_ID=(your_plaid_client_id_here)?$' "$ENV_FILE" || \
     grep -qE '^PLAID_SECRET=(your_plaid_secret_here)?$' "$ENV_FILE"; then
  env_warning="backend/.env exists but PLAID_CLIENT_ID / PLAID_SECRET still look unset — edit it and add your Plaid dashboard keys."
fi
if [ -n "$env_warning" ]; then
  echo ""
  echo "⚠  $env_warning"
  echo "   The app will still start, but account syncing won't work until configured."
  echo ""
fi

# ── Port preflight ────────────────────────────────────────────────────
# The backend port is shared knowledge across four places: uvicorn binds it,
# the Vite proxy forwards /api to it, services/bonjour advertises it over
# mDNS, and routers/mobile builds the phone-pairing QR from it. They all read
# TUSKLEDGER_PORT, so exporting it here keeps the whole stack on one number.
#
# We refuse to start when a port is taken rather than starting anyway.
# Previously uvicorn exited with "address already in use", this script kept
# going, and `open http://localhost:3000` served a UI whose every /api call
# landed on whatever OTHER app owned 8000 — which the frontend rendered as a
# login prompt. Failing loudly here, naming the process, turns a baffling
# half-hour into a one-line fix.
TL_PORT="${TUSKLEDGER_PORT:-8000}"
TL_WEB_PORT="${TUSKLEDGER_WEB_PORT:-3000}"
export TUSKLEDGER_PORT="$TL_PORT"
export TUSKLEDGER_WEB_PORT="$TL_WEB_PORT"

port_conflict() {
  # $1 = port, $2 = human label. Prints a report and returns 0 if occupied.
  pid="$(lsof -nP -tiTCP:"$1" -sTCP:LISTEN 2>/dev/null | head -1)" || true
  [ -z "$pid" ] && return 1
  cmd="$(ps -p "$pid" -o command= 2>/dev/null | head -1 | cut -c1-88)"
  alt=$(( $1 + 10 ))   # a concrete port to suggest that is NOT the busy one
  echo ""
  echo "============================================================"
  echo "  Port $1 ($2) is already in use."
  echo "  Tusk Ledger did NOT start."
  echo ""
  echo "     PID $pid  ${cmd:-(unknown process)}"
  echo ""
  echo "  Stop that process, then try again:"
  echo "     kill $pid"
  echo ""
  echo "  Or run Tusk Ledger alongside it on a different port:"
  echo "     TUSKLEDGER_PORT=$alt ./start.sh"
  echo ""
  echo "  Note: the iOS app follows TUSKLEDGER_PORT too, so after changing"
  echo "  it, re-pair from http://localhost:$TL_WEB_PORT/pair-phone"
  echo "============================================================"
  echo ""
  return 0
}

if port_conflict "$TL_PORT" "backend API"; then exit 1; fi
if port_conflict "$TL_WEB_PORT" "web UI"; then exit 1; fi

# Start backend
# Bind to 0.0.0.0 instead of 127.0.0.1 when LAN_SYNC_ENABLED=true, so a
# phone on the same Wi-Fi can reach /api/mobile/*. Default stays
# localhost — see the Tusk Ledger.command launcher for the rationale.
BACKEND_HOST="127.0.0.1"
if [ -f "$SCRIPT_DIR/backend/.env" ] && \
   grep -q '^LAN_SYNC_ENABLED=true' "$SCRIPT_DIR/backend/.env"; then
  BACKEND_HOST="0.0.0.0"
  echo "LAN_SYNC_ENABLED=true detected — binding backend to 0.0.0.0 for mobile sync."
fi
echo "Starting backend (FastAPI on ${BACKEND_HOST}:${TL_PORT})..."
cd "$SCRIPT_DIR/backend"
if [ ! -d "venv" ]; then
  echo "Creating Python virtual environment..."
  python3 -m venv venv
fi
source venv/bin/activate
pip install -r requirements.txt --quiet
uvicorn app.main:app --host "$BACKEND_HOST" --port "$TL_PORT" &
BACKEND_PID=$!

# Start frontend
echo "Starting frontend (React on :${TL_WEB_PORT})..."
cd "$SCRIPT_DIR/frontend"
if [ ! -d "node_modules" ]; then
  echo "Installing frontend dependencies..."
  npm install
fi
npm run dev &
FRONTEND_PID=$!

echo ""
echo "✓ Tusk Ledger is running!"
echo "  → Dashboard: http://localhost:${TL_WEB_PORT}"
echo "  → API:       http://localhost:${TL_PORT}/api/health"
echo ""
echo "Press Ctrl+C to stop."

# Handle shutdown
trap "kill $BACKEND_PID $FRONTEND_PID 2>/dev/null; exit" INT TERM
wait
