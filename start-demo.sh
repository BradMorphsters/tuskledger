#!/bin/bash
# This script is now redundant. As of the unified-toggle change, ./start.sh
# boots the app with both real and demo databases simultaneously, and you
# can flip between them in the sidebar.
#
# Kept around so anyone with muscle memory still gets the right behavior:
# this just delegates to start.sh.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
echo "ℹ  ./start-demo.sh is now an alias for ./start.sh — use the Real/Demo"
echo "   toggle in the sidebar to switch databases."
echo ""
exec "$SCRIPT_DIR/start.sh" "$@"
