"""
tuskledger-mcp — Model Context Protocol server for Tusk Ledger.

Runs locally on the user's machine, talks to their Tusk Ledger backend
on localhost:8000 over HTTP, exposes ~13 typed tools to AI assistants
(Claude Desktop, Cursor, Cowork, Claude Code) so the assistant can
query the user's finance data without going through the web UI.

Local-first all the way down: nothing here calls out to the network.
The only HTTP calls are to 127.0.0.1.
"""
__version__ = "0.1.0"
