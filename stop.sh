#!/bin/bash
# Tusk Ledger — Stop all running processes
echo "Stopping Tusk Ledger..."
pkill -f "uvicorn app.main:app" 2>/dev/null || true
pkill -f "tuskledger.*vite" 2>/dev/null || true
echo "Done."
