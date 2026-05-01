"""
Entry point for `python -m tuskledger_mcp` (and the `tuskledger-mcp`
console script defined in pyproject.toml).

Just dispatches to the stdio server. If we ever add other transports
(HTTP, etc.), this is where the flag handling lives.
"""
from __future__ import annotations

import asyncio
import sys

from .server import serve_stdio


def main() -> int:
    try:
        asyncio.run(serve_stdio())
        return 0
    except KeyboardInterrupt:
        print("tuskledger-mcp: interrupted, shutting down.", file=sys.stderr)
        return 130


if __name__ == "__main__":
    sys.exit(main())
