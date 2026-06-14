"""SEC EDGAR filing activity (free, no API key).

Pulls each name's recent SEC filings directly from the SEC's public JSON
endpoints and distills three things a long-term thesis-holder actually cares
about:

  • insider Form-4 activity — a *count* of insider transactions in the last
    90 days vs the prior 90 (EDGAR submissions don't carry dollar amounts
    without parsing each Form-4 XML, so this is volume-of-filings, not $; it
    nonetheless fills the gap left by Quiver's tier-gated insider feed)
  • 8-K material events — recent "something happened" filings, a free
    catalyst/news proxy per name
  • S-1 / 424B capital raises — dilution watch, which matters a lot for the
    cash-burning junior miners in this universe

Two SEC endpoints, both keyless:
  • https://www.sec.gov/files/company_tickers.json   (ticker → CIK map)
  • https://data.sec.gov/submissions/CIK##########.json (a filer's filings)

The SEC asks for a descriptive User-Agent with a contact (settings.SEC_USER_AGENT)
and rate-limits to ~10 req/s. Every call is bounded (timeout + byte cap) and
degrades to ``None``/"unavailable" rather than raising, so the research layer
stays usable offline. This is public-filing data, informational — not advice.
"""
from __future__ import annotations

import json
import threading
import time
from datetime import date, datetime, timedelta
from typing import Any, Optional

import httpx

from app.config import settings
from app.services import research_store as store

TICKERS_URL = "https://www.sec.gov/files/company_tickers.json"
SUBMISSIONS_URL = "https://data.sec.gov/submissions/CIK{cik}.json"
_TIMEOUT = 12.0
_MAX_BYTES = 8 * 1024 * 1024  # submissions JSON for a big filer can be ~5 MB
_WINDOW = 90  # days

# Form types we care about, grouped.
_INSIDER_FORMS = {"4", "4/A"}
_EVENT_FORMS = {"8-K", "8-K/A"}
_RAISE_FORMS = {"S-1", "S-1/A", "424B5", "424B4", "424B3", "S-3", "S-3/A"}

# ticker → CIK map, cached in-process (refreshed from disk/network on a TTL).
_LOCK = threading.Lock()
_CIK: dict = {"map": None, "ts": 0.0}
_CIK_TTL = 7 * 24 * 3600.0  # the ticker→CIK map barely changes; refresh weekly


def _headers() -> dict:
    return {"User-Agent": settings.SEC_USER_AGENT, "Accept-Encoding": "gzip, deflate",
            "Host": "www.sec.gov"}


def _get(url: str, host: str) -> tuple[Optional[Any], Optional[str]]:
    """Bounded GET → (parsed json, None) | (None, error). Caps body size."""
    headers = {"User-Agent": settings.SEC_USER_AGENT,
               "Accept-Encoding": "gzip, deflate", "Host": host}
    try:
        with httpx.stream("GET", url, headers=headers, timeout=_TIMEOUT,
                          follow_redirects=True) as r:
            if r.status_code != 200:
                return None, f"http {r.status_code}"
            chunks, total = [], 0
            for chunk in r.iter_bytes():
                chunks.append(chunk)
                total += len(chunk)
                if total > _MAX_BYTES:
                    return None, "response too large"
            body = b"".join(chunks)
        return json.loads(body), None
    except Exception as e:  # noqa: BLE001 — never raise into the request path
        return None, f"{type(e).__name__}: {e}"


def _ticker_cik_map(force: bool = False) -> dict[str, str]:
    """{TICKER: zero-padded-10-digit-CIK}. Disk-cached (sec_ciks.json) with a
    weekly TTL; network only on first use / expiry."""
    with _LOCK:
        if not force and _CIK["map"] is not None and (time.time() - _CIK["ts"]) < _CIK_TTL:
            return _CIK["map"]
        # Try disk cache first.
        path = store.research_dir() / "sec_ciks.json"
        if not force and path.exists():
            try:
                age = time.time() - path.stat().st_mtime
                if age < _CIK_TTL:
                    with open(path, encoding="utf-8") as f:
                        m = json.load(f)
                    if isinstance(m, dict) and m:
                        _CIK.update(map=m, ts=time.time())
                        return m
            except (OSError, json.JSONDecodeError):
                pass
        data, _err = _get(TICKERS_URL, "www.sec.gov")
        m: dict[str, str] = {}
        if isinstance(data, dict):
            for row in data.values():
                tk, cik = row.get("ticker"), row.get("cik_str")
                if tk and cik is not None:
                    m[str(tk).strip().upper()] = str(int(cik)).zfill(10)
        if m:
            try:
                store.research_dir().mkdir(parents=True, exist_ok=True)
                with open(path, "w", encoding="utf-8") as f:
                    json.dump(m, f)
            except OSError:
                pass
            _CIK.update(map=m, ts=time.time())
        return m or (_CIK["map"] or {})


def cik_for(ticker: str) -> Optional[str]:
    return _ticker_cik_map().get((ticker or "").strip().upper().replace(".", "-")) \
        or _ticker_cik_map().get((ticker or "").strip().upper())


def _parse_date(s: str) -> Optional[date]:
    try:
        return datetime.strptime(s, "%Y-%m-%d").date()
    except (TypeError, ValueError):
        return None


def aggregate(recent: dict, today: date) -> dict:
    """Roll EDGAR ``filings.recent`` parallel arrays into the activity summary."""
    forms = recent.get("form") or []
    dates = recent.get("filingDate") or []
    accns = recent.get("accessionNumber") or []
    docs = recent.get("primaryDocument") or []
    cutoff = today - timedelta(days=_WINDOW)
    prior_cutoff = today - timedelta(days=2 * _WINDOW)

    insider_recent = insider_prior = 0
    events: list[dict] = []
    raises: list[dict] = []
    latest: Optional[dict] = None

    for i, form in enumerate(forms):
        d = _parse_date(dates[i]) if i < len(dates) else None
        if d is None:
            continue
        if latest is None:
            latest = {"form": form, "date": dates[i]}  # arrays are newest-first
        if form in _INSIDER_FORMS:
            if d >= cutoff:
                insider_recent += 1
            elif d >= prior_cutoff:
                insider_prior += 1
        if form in _EVENT_FORMS and d >= cutoff and len(events) < 6:
            events.append({"form": form, "date": dates[i],
                           "accession": accns[i] if i < len(accns) else None,
                           "doc": docs[i] if i < len(docs) else None})
        if form in _RAISE_FORMS and d >= cutoff and len(raises) < 6:
            raises.append({"form": form, "date": dates[i]})

    trend = "up" if insider_recent > insider_prior else "down" if insider_recent < insider_prior else "flat"
    return {
        "insider_filings_90d": insider_recent,
        "insider_filings_prior_90d": insider_prior,
        "insider_trend": trend,
        "events_8k_90d": len(events),
        "recent_8k": events,
        "capital_raises_90d": len(raises),
        "recent_raises": raises,
        "latest_filing": latest,
    }


def fetch_activity(ticker: str, today: Optional[date] = None) -> dict:
    """Recent SEC filing activity for one ticker. Always returns a dict with
    an ``available`` flag (never raises)."""
    today = today or date.today()
    cik = cik_for(ticker)
    if not cik:
        return {"available": False, "reason": "no CIK for ticker", "ticker": ticker}
    data, err = _get(SUBMISSIONS_URL.format(cik=cik), "data.sec.gov")
    if err or not isinstance(data, dict):
        return {"available": False, "reason": err or "no submissions", "ticker": ticker, "cik": cik}
    recent = ((data.get("filings") or {}).get("recent")) or {}
    agg = aggregate(recent, today)
    return {"available": True, "ticker": ticker, "cik": cik,
            "company": data.get("name"), **agg,
            "source": "sec_edgar", "as_of": today.isoformat()}


def diagnose(ticker: str) -> dict:
    """Uncached fetch with raw error detail (for the ?debug path)."""
    cik = cik_for(ticker)
    if not cik:
        return {"ticker": ticker, "cik": None, "error": "no CIK mapping",
                "map_size": len(_ticker_cik_map())}
    data, err = _get(SUBMISSIONS_URL.format(cik=cik), "data.sec.gov")
    return {"ticker": ticker, "cik": cik, "error": err,
            "forms_sample": ((data or {}).get("filings", {}).get("recent", {}).get("form", [])[:8]
                             if isinstance(data, dict) else None)}
