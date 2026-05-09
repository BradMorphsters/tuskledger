#!/bin/bash
# Tusk Ledger — Start both backend and frontend

set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "================================="
echo "  Tusk Ledger — Personal Finance    "
echo "================================="

# Check for .env file
if [ ! -f "$SCRIPT_DIR/backend/.env" ]; then
  echo ""
  echo "⚠  No .env file found in backend/"
  echo "   Copy backend/.env.example to backend/.env and add your Plaid keys."
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
