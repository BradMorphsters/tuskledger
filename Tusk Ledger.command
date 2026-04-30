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

# Sanity check: .env present?
if [ ! -f "$PROJECT_DIR/backend/.env" ]; then
  echo "WARNING: No backend/.env file found."
  echo "  Copy backend/.env.example to backend/.env and add your Plaid keys."
  echo ""
fi

# --- Backend ---
echo "Starting backend (FastAPI on http://127.0.0.1:8000)..."
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

uvicorn app.main:app --host 127.0.0.1 --port 8000 --reload &
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
