"""Market price data (Yahoo Finance chart API, keyless) for the price chart.

Yahoo's ``/v8/finance/chart`` endpoint returns JSON with no API key, but it
429s requests that arrive without its session cookie (browsers carry one;
a bare ``httpx`` call doesn't). So we first hit ``fc.yahoo.com`` to pick up
the cookie and ``/v1/test/getcrumb`` for a crumb, cache them, and send both on
the chart request — the same handshake yfinance uses.

We switched off Stooq because it now gates its CSV behind a JavaScript
bot-check a server can't pass.

Every network call is wrapped so a timeout, a 401/429, or an unknown symbol
degrades to ``None`` ("no data") rather than raising — the research layer
stays usable offline.
"""
from __future__ import annotations

import threading
import time
from datetime import datetime, timezone
from typing import Optional

import httpx

from app.config import settings

TWELVEDATA_URL = "https://api.twelvedata.com/time_series"
YAHOO_HOSTS = ("query1.finance.yahoo.com", "query2.finance.yahoo.com")
_TIMEOUT = 12.0
_UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)
_BASE_HEADERS = {
    "User-Agent": _UA,
    "Accept-Language": "en-US,en;q=0.9",
    # Yahoo 429s API requests that don't look like they came from its own site.
    "Referer": "https://finance.yahoo.com/",
    "Origin": "https://finance.yahoo.com",
    "Sec-Fetch-Site": "same-site",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Dest": "empty",
}

# Cached Yahoo auth (cookie + crumb), refreshed on a TTL. Cookie string is
# thread-safe to read; we guard refresh with a lock.
_LOCK = threading.Lock()
_AUTH: dict = {"cookie": None, "crumb": None, "ts": 0.0}
_AUTH_TTL = 1800.0  # 30 min


def to_yahoo_symbol(ticker: str, exchange: Optional[str] = None) -> str:
    """Research ticker → Yahoo symbol. US tickers used as-is (uppercase);
    class shares use '-' for the dot (BRK.B → BRK-B)."""
    return (ticker or "").strip().upper().replace(".", "-")


def _range_for_months(months: int) -> str:
    if months <= 12:
        return "1y"
    if months <= 24:
        return "2y"
    if months <= 60:
        return "5y"
    return "10y"


def _refresh_auth() -> None:
    """Pick up Yahoo's consent cookie + crumb (best-effort)."""
    try:
        with httpx.Client(timeout=_TIMEOUT, follow_redirects=True,
                          headers={**_BASE_HEADERS, "Accept": "*/*"}) as c:
            try:
                c.get("https://fc.yahoo.com")  # sets A1/A3 cookies; often 404 — fine
            except httpx.HTTPError:
                pass
            cookie = "; ".join(f"{k}={v}" for k, v in c.cookies.items()) or None
            crumb = None
            try:
                r = c.get("https://query1.finance.yahoo.com/v1/test/getcrumb")
                if r.status_code == 200 and r.text and "<" not in r.text:
                    crumb = r.text.strip()
            except httpx.HTTPError:
                pass
        _AUTH.update(cookie=cookie, crumb=crumb, ts=time.time())
    except Exception:  # noqa: BLE001 — never let auth setup raise
        _AUTH.update(ts=time.time())  # mark attempted so we don't hammer


def _get_auth(force: bool = False) -> tuple[Optional[str], Optional[str]]:
    with _LOCK:
        if force or _AUTH["ts"] == 0.0 or (time.time() - _AUTH["ts"]) > _AUTH_TTL:
            _refresh_auth()
        return _AUTH["cookie"], _AUTH["crumb"]


def _fetch_json(symbol: str, rng: str, interval: str, _retry: bool = True) -> tuple[Optional[dict], Optional[str]]:
    """``({chart json}, None)`` on success, else ``(None, error_detail)``.

    Sends Yahoo's cookie + crumb; on a blocking status (401/403/429) it
    re-auths once and retries (the cookie may be missing/stale on first run).
    """
    cookie, crumb = _get_auth()
    headers = {**_BASE_HEADERS, "Accept": "application/json,text/plain,*/*"}
    if cookie:
        headers["Cookie"] = cookie
    last_err = "no response"
    blocked = False
    for host in YAHOO_HOSTS:
        url = f"https://{host}/v8/finance/chart/{symbol}"
        params = {"range": rng, "interval": interval}
        if crumb:
            params["crumb"] = crumb
        try:
            resp = httpx.get(url, params=params, headers=headers, timeout=_TIMEOUT, follow_redirects=True)
        except Exception as e:  # noqa: BLE001
            last_err = f"{type(e).__name__}: {e}"
            continue
        if resp.status_code == 200:
            try:
                return resp.json(), None
            except ValueError:
                last_err = f"non-json from {host}"
                continue
        last_err = f"http {resp.status_code} from {host}"
        if resp.status_code in (401, 403, 429):
            blocked = True
    if _retry and blocked:
        _get_auth(force=True)  # refresh cookie/crumb, then one more attempt
        return _fetch_json(symbol, rng, interval, _retry=False)
    return None, last_err


def parse_chart(data: dict) -> Optional[dict]:
    """Yahoo chart JSON → ``{meta, history:[{as_of,close}], current, currency}``."""
    try:
        result = data["chart"]["result"][0]
    except (KeyError, IndexError, TypeError):
        return None
    meta = result.get("meta") or {}
    timestamps = result.get("timestamp") or []
    quote = ((result.get("indicators") or {}).get("quote") or [{}])[0]
    closes = quote.get("close") or []
    volumes = quote.get("volume") or []
    by_month: dict[str, dict] = {}
    for i, ts in enumerate(timestamps):
        close = closes[i] if i < len(closes) else None
        if close is None:
            continue
        vol = volumes[i] if i < len(volumes) else None
        ym = datetime.fromtimestamp(ts, tz=timezone.utc).strftime("%Y-%m")
        by_month[ym] = {"as_of": ym, "close": round(float(close), 4), "volume": _to_int(vol)}  # last bar in month wins
    monthly = [by_month[k] for k in sorted(by_month)]
    current = meta.get("regularMarketPrice")
    if current is None and monthly:
        current = monthly[-1]["close"]
    return {"meta": meta, "history": monthly, "current": current, "currency": meta.get("currency", "USD")}


# ── Twelve Data (keyed, reliable) ────────────────────────────────────────
def _fetch_twelvedata(symbol: str, months: int, key: str) -> tuple[Optional[dict], Optional[str]]:
    params = {
        "symbol": symbol, "interval": "1month",
        "outputsize": str(min(max(months, 2), 5000)), "apikey": key,
    }
    try:
        resp = httpx.get(TWELVEDATA_URL, params=params, timeout=_TIMEOUT, headers={"User-Agent": _UA})
    except Exception as e:  # noqa: BLE001
        return None, f"{type(e).__name__}: {e}"
    if resp.status_code != 200:
        return None, f"http {resp.status_code}"
    try:
        data = resp.json()
    except ValueError:
        return None, "non-json"
    if data.get("status") != "ok" or not data.get("values"):
        return None, f"twelvedata: {data.get('message') or data.get('status') or 'no values'}"
    return data, None


def _parse_twelvedata(data: dict) -> Optional[dict]:
    rows: list[dict] = []
    for v in reversed(data.get("values") or []):  # Twelve Data returns newest-first
        c = v.get("close")
        dt = v.get("datetime") or ""
        if c is None or not dt:
            continue
        try:
            rows.append({"as_of": dt[:7], "close": round(float(c), 4), "volume": _to_int(v.get("volume"))})
        except ValueError:
            continue
    if len(rows) < 2:
        return None
    return {"history": rows, "current": rows[-1]["close"],
            "currency": (data.get("meta") or {}).get("currency", "USD")}


def _api_key() -> str:
    return (settings.MARKETDATA_API_KEY or "").strip()


def _to_int(x) -> Optional[int]:
    try:
        return int(float(x))
    except (TypeError, ValueError):
        return None


def compute_momentum(history: list[dict], current: Optional[float]) -> Optional[dict]:
    """Price/volume momentum from the monthly series — the 'is money rotating
    in' read: where price sits in its ~52-week range, 3-month return, and
    whether volume is rising. 0-100 score (low = near lows/quiet, high =
    breaking out on volume)."""
    closes = [h["close"] for h in history if h.get("close") is not None]
    if len(closes) < 3 or not current:
        return None
    lo, hi = min(closes), max(closes)
    rng = hi - lo
    range_pos = round((current - lo) / rng, 2) if rng else None
    ref = closes[-4] if len(closes) >= 4 else closes[0]
    ret_3mo = round((current - ref) / ref * 100, 1) if ref else None
    vols = [h.get("volume") for h in history if h.get("volume")]
    vol_trend = "flat"
    if len(vols) >= 4:
        recent, prior = sum(vols[-2:]) / 2, sum(vols[-4:-2]) / 2
        if prior:
            ch = (recent - prior) / prior
            vol_trend = "up" if ch > 0.2 else "down" if ch < -0.2 else "flat"
    score = round((range_pos or 0) * 60)
    if ret_3mo is not None:
        score += min(25, round(ret_3mo / 2)) if ret_3mo > 0 else max(-15, round(ret_3mo / 4))
    if vol_trend == "up":
        score += 15
    return {
        "score": max(0, min(100, score)),
        "range_pos": range_pos,
        "pct_off_low": round((current - lo) / lo * 100, 1) if lo else None,
        "pct_off_high": round((current - hi) / hi * 100, 1) if hi else None,
        "ret_3mo_pct": ret_3mo,
        "vol_trend": vol_trend,
    }


def _period_return(history: list[dict], n: int) -> Optional[float]:
    """% return over the last ``n`` monthly steps from an ascending history."""
    closes = [h["close"] for h in history if h.get("close") is not None]
    if len(closes) < n + 1:
        return None
    ref = closes[-(n + 1)]
    return (closes[-1] - ref) / ref * 100 if ref else None


def relative_strength(symbol_history: list[dict], bench_history: list[dict]) -> Optional[dict]:
    """Relative strength of a symbol vs a benchmark from two monthly series.

    The 'is this sector outperforming the broad market' read. Returns
    ``{rs_1mo, rs_3mo, score, verdict}`` where each ``rs_*`` is the symbol's
    return minus the benchmark's over that window (percentage points), and
    ``score`` is 0-100 with 50 = inline with the benchmark, >50 outperforming.
    ``None`` when neither window can be computed."""
    out: dict[str, Any] = {}
    parts: list[float] = []
    for label, n in (("rs_1mo", 1), ("rs_3mo", 3)):
        s, b = _period_return(symbol_history, n), _period_return(bench_history, n)
        rs = round(s - b, 1) if (s is not None and b is not None) else None
        out[label] = rs
        if rs is not None:
            parts.append(rs)
    if not parts:
        return None
    avg = sum(parts) / len(parts)
    score = max(0, min(100, round(50 + avg * 2)))  # ±25pp relative spans the scale
    out["score"] = score
    out["verdict"] = "outperforming" if score >= 60 else "lagging" if score <= 40 else "inline"
    return out


def fetch_prices(ticker: str, months: int = 14, exchange: Optional[str] = None) -> Optional[dict]:
    """Fetch ~``months`` of monthly closes + current price, or ``None`` on failure.

    Uses Twelve Data when ``MARKETDATA_API_KEY`` is set (reliable), else falls
    back to best-effort keyless Yahoo (often bot-blocked).
    """
    symbol = to_yahoo_symbol(ticker, exchange)
    key = _api_key()
    if key:
        data, _err = _fetch_twelvedata(symbol, months, key)
        if not data:
            return None
        parsed = _parse_twelvedata(data)
        if not parsed:
            return None
        monthly = parsed["history"][-months:]
        return {"source": "twelvedata", "symbol": symbol, "currency": parsed["currency"],
                "history": monthly, "current": parsed["current"], "current_date": monthly[-1]["as_of"],
                "momentum": compute_momentum(monthly, parsed["current"])}

    data, _err = _fetch_json(symbol, _range_for_months(months), "1mo")
    if not data:
        return None
    parsed = parse_chart(data)
    if not parsed or len(parsed["history"]) < 2:
        return None
    monthly = parsed["history"][-months:]
    return {"source": "yahoo", "symbol": symbol, "currency": parsed["currency"],
            "history": monthly, "current": parsed["current"], "current_date": monthly[-1]["as_of"],
            "momentum": compute_momentum(monthly, parsed["current"])}


def diagnose(ticker: str, months: int = 14, exchange: Optional[str] = None) -> dict:
    """Detailed fetch result for troubleshooting (surfaced via ?debug=true)."""
    symbol = to_yahoo_symbol(ticker, exchange)
    key = _api_key()
    if key:
        data, err = _fetch_twelvedata(symbol, months, key)
        if err or not data:
            return {"symbol": symbol, "provider": "twelvedata", "ok": False, "error": err}
        parsed = _parse_twelvedata(data)
        if not parsed:
            return {"symbol": symbol, "provider": "twelvedata", "ok": False, "error": "no usable values"}
        hist = parsed["history"]
        return {"symbol": symbol, "provider": "twelvedata", "ok": True, "rows": len(hist),
                "current": parsed["current"], "last": hist[-1]}

    data, err = _fetch_json(symbol, _range_for_months(months), "1mo")
    if err or not data:
        return {"symbol": symbol, "provider": "yahoo (keyless fallback)", "ok": False,
                "error": err or "no data", "hint": "set MARKETDATA_API_KEY in backend/.env",
                "have_cookie": bool(_AUTH.get("cookie")), "have_crumb": bool(_AUTH.get("crumb"))}
    parsed = parse_chart(data)
    if not parsed:
        return {"symbol": symbol, "provider": "yahoo (keyless fallback)", "ok": False, "error": "unparseable chart"}
    hist = parsed["history"]
    return {"symbol": symbol, "provider": "yahoo (keyless fallback)", "ok": len(hist) >= 2,
            "rows": len(hist), "current": parsed["current"], "last": hist[-1] if hist else None}
