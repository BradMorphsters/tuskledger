"""Read-only diagnostic: ask Robinhood what's ACTUALLY on the agentic account.

Places nothing. Pulls recent equity orders, positions, and the portfolio for the bound agentic
account and writes them to var/agent_trading/diag.json so we can confirm whether the orders the
backend marked "placed" really exist at Robinhood (and their state: filled / queued / rejected).

Run from the backend/ folder with the venv active:  python check_live_orders.py
"""
import json
from pathlib import Path

from app.agent_trading.brokers import MODE_READ_ONLY
from app.agent_trading.robinhood_agent import EncryptedJsonStore, make_broker, store_path, connection_status
from app.config import settings

store = EncryptedJsonStore(store_path(settings.AGENT_TRADING_AGENT_STORE))
status = connection_status(store)
if not status["connected"]:
    raise SystemExit("Not connected — connect Tusk Ledger in the Accounts tab first.")

broker = make_broker(store, mode=MODE_READ_ONLY)
acct = broker.account_number

# Raw MCP envelopes (so we see the exact shapes Robinhood returns).
out = {"account_number": acct}
for label, tool, args in (
    ("orders", "get_equity_orders", {"account_number": acct}),
    ("positions", "get_equity_positions", {"account_number": acct}),
    ("portfolio", "get_portfolio", {"account_number": acct}),
):
    try:
        out[label] = broker._read(tool, args)
    except Exception as e:  # noqa: BLE001
        out[label] = {"ERROR": f"{type(e).__name__}: {e}"}

p = Path("var/agent_trading/diag.json")
p.parent.mkdir(parents=True, exist_ok=True)
p.write_text(json.dumps(out, indent=2, default=str))
print(f"Wrote {p}. Account {acct}. orders/positions/portfolio captured.")
