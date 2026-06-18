"""Integration / API-key status — every external service is bring-your-own-key.

Read-only: reports which BYO keys are configured (booleans only, never the key
values), so the Accounts page can show one consistent "API keys" panel. Keys
live in ``backend/.env`` and are read at startup — nothing is hosted or shared;
each person running Tusk Ledger uses their own.
"""
from __future__ import annotations

from fastapi import APIRouter

from app.config import settings

router = APIRouter(prefix="/api/integrations", tags=["integrations"])


@router.get("/status")
def integrations_status():
    s = settings
    return {
        "integrations": [
            {
                "key": "plaid",
                "label": "Plaid — bank, card & brokerage sync",
                "env": "PLAID_CLIENT_ID / PLAID_SECRET",
                "configured": bool(s.PLAID_CLIENT_ID and s.PLAID_SECRET),
                "url": "https://dashboard.plaid.com/",
            },
            {
                "key": "market_data",
                "label": "Market data — price chart",
                "provider": "Twelve Data",
                "env": "MARKETDATA_API_KEY",
                "configured": bool((s.MARKETDATA_API_KEY or "").strip()),
                "url": "https://twelvedata.com/pricing",
            },
            {
                "key": "quiver",
                "label": "Quiver — public-purchase signals",
                "provider": "Quiver Quantitative",
                "env": "QUIVER_API_KEY",
                "configured": bool((s.QUIVER_API_KEY or "").strip()),
                "url": "https://api.quiverquant.com/pricing/",
            },
            {
                "key": "finnhub",
                "label": "Finnhub — analyst estimates & earnings calendar",
                "provider": "Finnhub",
                "env": "FINNHUB_API_KEY",
                "configured": bool((s.FINNHUB_API_KEY or "").strip()),
                "url": "https://finnhub.io/register",
                "note": "Free tier covers estimates, earnings dates & news. Powers the "
                        "earnings-blackout gate and the estimate-revision tilt in Agent Trading.",
            },
            {
                "key": "fred",
                "label": "FRED — commodity & macro series for the sector theme",
                "provider": "St. Louis Fed (FRED)",
                "env": "FRED_API_KEY",
                "configured": bool((s.FRED_API_KEY or "").strip()),
                "optional": True,
                "url": "https://fredaccount.stlouisfed.org/apikeys",
                "note": "Optional — the public CSV works with no key. A free key only raises "
                        "rate limits. Blends commodity/macro trend into the sector tailwind.",
            },
        ]
    }
