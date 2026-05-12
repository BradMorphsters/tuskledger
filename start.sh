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
echo "Starting backend (FastAPI on ${BACKEND_HOST}:8000)..."
cd "$SCRIPT_DIR/backend"
if [ ! -d "venv" ]; then
  echo "Creating Python virtual environment..."
  python3 -m venv venv
fi
source venv/bin/activate
pip install -r requirements.txt --quiet
uvicorn app.main:app --host "$BACKEND_HOST" --port 8000 &
BACKEND_PID=$!

# Start frontend
echo "Starting frontend (React on :3000)..."
cd "$SCRIPT_DIR/frontend"
if [ ! -d "node_modules" ]; then
  echo "Installing frontend dependencies..."
  npm install
fi
npm run dev &
FRONTEND_PID=$!

echo ""
echo "✓ Tusk Ledger is running!"
echo "  → Dashboard: http://localhost:3000"
echo "  → API:       http://localhost:8000/api/health"
echo ""
echo "Press Ctrl+C to stop."

# Handle shutdown
trap "kill $BACKEND_PID $FRONTEND_PID 2>/dev/null; exit" INT TERM
wait
