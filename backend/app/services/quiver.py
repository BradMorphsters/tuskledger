"""Quiver Quantitative integration — public-purchase signals for the universe.

Pulls publicly-disclosed activity per ticker — federal **government contracts**
(USASpending), **congressional trades**, **insider** Form-4 trades, and
corporate **lobbying** — and distills each into a *direction*: is federal money
/ political / insider buying accelerating, steady, or cooling? Scoped to the
research universe so it's signal not noise, and cross-linked into Research.

Keyed: needs ``QUIVER_API_KEY`` (paid Quiver plan, ``Authorization: Bearer``).
Every call degrades to "unavailable" on missing key / error / gated tier, so
the app stays usable. Field mapping is deliberately TOLERANT (case-insensitive,
multiple candidate keys) because Quiver's exact JSON keys vary by dataset/tier;
finalise against a real response via the ``?debug`` endpoint once a key is set.
"""
from __future__ import annotations

import json
import re
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timedelta, timezone
from typing import Any, Optional

import httpx

from app.config import settings

BASE = "https://api.quiverquant.com/beta"
# Read timeout is modest; the live insider feed can stream a large payload, so
# we ALSO cap each fetch with a hard wall-clock deadline in _fetch_all.
_TIMEOUT = httpx.Timeout(8.0, connect=6.0)
PER_CALL_DEADLINE = 10.0
MAX_BYTES = 4_000_000  # abandon a feed that streams more than this (unfiltered live feeds)
_UA = "tuskledger/1.0"
WINDOW_DAYS = 90  # "recent" window; compared against the prior equal window

# Per-ticker historical endpoints. Kept here so they're easy to correct once a
# real key confirms the exact paths.
# Verified against Quiver's official python client. Insider is a live endpoint
# with a ?ticker= query param (not a historical path), which is why the path
# form 404'd.
_ENDPOINTS = {
    "govcontracts": "/historical/govcontracts/{t}",
    "congress": "/historical/congresstrading/{t}",
    "insider": "/live/insiders?ticker={t}",
    "lobbying": "/historical/lobbying/{t}",
    # Off-exchange / dark-pool volume (DPI + OTC short) — accumulation &
    # short-pressure signal, available on Hobbyist and far more active for
    # junior miners than congress/contracts.
    "offexchange": "/historical/offexchange/{t}",
}
DATASET_LABELS = {
    "govcontracts": "Government contracts",
    "congress": "Congressional trades",
    "insider": "Insider trades",
    "lobbying": "Lobbying",
    "offexchange": "Off-exchange / dark pool",
}

# Broader Quiver dataset list (paths verified against the official python
# client) used to DISCOVER what a given key actually unlocks. Many are likely
# Tier 2, but we probe rather than assume.
CANDIDATE_ENDPOINTS = {
    "offexchange": "/historical/offexchange/{t}",
    "news": "/live/quivernews?ticker={t}",
    "wikipedia": "/historical/wikipedia/{t}",
    "wallstreetbets": "/historical/wallstreetbets/{t}",
    "twitter": "/historical/twitter/{t}",
    "patents": "/historical/allpatents/{t}",
    "flights": "/historical/flights/{t}",
    "spacs": "/historical/spacs/{t}",
    "top_shareholders": "/live/topshareholders/{t}",
    "senate": "/historical/senatetrading/{t}",
    "house": "/historical/housetrading/{t}",
}


def probe_access(sample: str = "TSLA") -> dict:
    """Hit each candidate endpoint with the configured key and report access
    (ok / gated / large / error) + a sample of keys, so we can see what a
    Hobbyist key really unlocks. Uses a liquid ticker so retail datasets have
    data to show."""
    def one(path: str) -> dict:
        data, err = _get(path)
        if err:
            low = err.lower()
            if "too large" in low or "deadline" in low:
                return {"status": "accessible (large payload)", "note": err[:60]}
            return {"status": _status_from_err(err), "detail": err[:90]}
        rows = _rows(data)
        return {"status": "ok", "rows": len(rows),
                "sample_keys": sorted(rows[0].keys())[:12] if rows else []}

    out: dict[str, dict] = {}
    with ThreadPoolExecutor(max_workers=8) as ex:
        futs = {name: ex.submit(one, tmpl.format(t=sample)) for name, tmpl in CANDIDATE_ENDPOINTS.items()}
        for name, f in futs.items():
            try:
                out[name] = f.result(timeout=PER_CALL_DEADLINE + 3)
            except Exception:  # noqa: BLE001
                out[name] = {"status": "timeout"}
    return out

# Cached capability probe (which datasets the current key unlocks). Tier-aware
# by *detection*, not a hardcoded tier table: a free key surfaces a subset,
# a premium key unlocks all four — we just ask the API which respond.
PROBE_TICKER = "LMT"  # Lockheed: has contracts, congress trades, insider, lobbying
_CAP: dict = {"data": None, "ts": 0.0}
_CAP_TTL = 3600.0


def _status_from_err(err: Optional[str]) -> str:
    if err is None:
        return "ok"
    low = err.lower()
    if "401" in err or "403" in err or "gated" in low or "upgrade" in low:
        return "gated"
    if "QUIVER_API_KEY" in err:
        return "no_key"
    return "error"


def has_key() -> bool:
    return bool((settings.QUIVER_API_KEY or "").strip())


def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _get(path: str) -> tuple[Optional[Any], Optional[str]]:
    key = (settings.QUIVER_API_KEY or "").strip()
    if not key:
        return None, "no QUIVER_API_KEY"
    url = f"{BASE}{path}"
    headers = {"Authorization": f"Bearer {key}", "Accept": "application/json", "User-Agent": _UA}
    try:
        # Stream + cap bytes/time so an unfiltered live feed can't stream
        # forever and wedge a worker thread.
        with httpx.stream("GET", url, timeout=_TIMEOUT, headers=headers) as r:
            if r.status_code in (401, 403):
                return None, f"{r.status_code} (key invalid or dataset not in your Quiver tier)"
            if r.status_code != 200:
                return None, f"http {r.status_code}: {bytes(r.read()[:160])!r}"
            start = time.monotonic()
            buf = bytearray()
            for chunk in r.iter_bytes():
                buf += chunk
                if len(buf) > MAX_BYTES:
                    return None, f"payload too large (>{MAX_BYTES // 1_000_000}MB) — unfiltered live feed"
                if time.monotonic() - start > PER_CALL_DEADLINE:
                    return None, "download exceeded deadline"
            text = buf.decode("utf-8", "replace")
    except Exception as e:  # noqa: BLE001
        return None, f"{type(e).__name__}: {e}"
    # Quiver returns a 200 with this string body for tier-gated datasets.
    if "Upgrade your subscription plan" in text:
        return None, "gated (upgrade your Quiver subscription)"
    try:
        return json.loads(text), None
    except ValueError:
        return None, "non-json"


def _fetch_all(sym: str) -> dict[str, tuple]:
    """Fetch all dataset endpoints for a ticker concurrently, with a hard
    per-call wall-clock deadline so one slow/large feed (the live insiders
    endpoint can stream a lot) can't hang the request → {ds: (data, err)}.
    A laggard is abandoned (non-blocking shutdown) and reported as a timeout.
    """
    ex = ThreadPoolExecutor(max_workers=len(_ENDPOINTS))
    futs = {ds: ex.submit(_get, tmpl.format(t=sym)) for ds, tmpl in _ENDPOINTS.items()}
    out: dict[str, tuple] = {}
    for ds, f in futs.items():
        try:
            out[ds] = f.result(timeout=PER_CALL_DEADLINE + 3)
        except Exception:  # noqa: BLE001 — TimeoutError or any worker failure
            out[ds] = (None, "timeout (dataset too slow)")
    ex.shutdown(wait=False, cancel_futures=True)
    return out


# ── tolerant parsing helpers ──────────────────────────────────────────────
def _f(row: dict, *names, default=None):
    low = {str(k).lower(): v for k, v in row.items()}
    for n in names:
        v = low.get(n.lower())
        if v not in (None, ""):
            return v
    return default


_num_re = re.compile(r"-?\d[\d,]*(?:\.\d+)?")


def _to_num(v) -> Optional[float]:
    if v is None:
        return None
    if isinstance(v, (int, float)):
        return float(v)
    nums = [float(x.replace(",", "")) for x in _num_re.findall(str(v))]
    if not nums:
        return None
    return (nums[0] + nums[-1]) / 2 if len(nums) >= 2 else nums[0]  # ranges → midpoint


def _to_date(v) -> Optional[date]:
    if not v:
        return None
    s = str(v)[:10]
    for fmt in ("%Y-%m-%d", "%m/%d/%Y", "%Y/%m/%d"):
        try:
            return datetime.strptime(s, fmt).date()
        except ValueError:
            continue
    return None


def _rows(data) -> list[dict]:
    if isinstance(data, list):
        return [r for r in data if isinstance(r, dict)]
    if isinstance(data, dict):
        for k in ("data", "results", "rows"):
            if isinstance(data.get(k), list):
                return [r for r in data[k] if isinstance(r, dict)]
    return []


def _trend(recent: float, prior: float) -> str:
    if recent == 0 and prior == 0:
        return "flat"
    if prior == 0:
        return "up" if recent > 0 else "flat"
    chg = (recent - prior) / prior
    return "up" if chg > 0.15 else "down" if chg < -0.15 else "flat"


# ── per-dataset aggregation (direction-focused) ───────────────────────────
def agg_govcontracts(rows: list[dict], today: date) -> dict:
    """Quiver gov-contracts are quarterly ({Year, Qtr, Amount}). Compare the
    latest quarter's obligated $ against the prior quarter."""
    by_q: dict[tuple, float] = {}
    for r in rows:
        amt = _to_num(_f(r, "Amount", "DollarsObligated", "Dollars"))
        if amt is None:
            continue
        yr = _to_num(_f(r, "Year"))
        qt = _to_num(_f(r, "Qtr", "Quarter"))
        if yr and qt:
            key = (int(yr), int(qt))
        else:
            d = _to_date(_f(r, "Date", "ReportDate", "ActionDate"))
            if not d:
                continue
            key = (d.year, (d.month - 1) // 3 + 1)
        by_q[key] = by_q.get(key, 0.0) + amt
    if not by_q:
        return {"recent_usd_90d": 0, "prior_usd_90d": 0, "trend": "flat", "count_90d": 0, "latest": None, "items": []}
    _qend = {1: (3, 31), 2: (6, 30), 3: (9, 30), 4: (12, 31)}

    def qend(k):
        y, qq = k
        m, d = _qend.get(qq, (12, 31))
        return date(y, m, d)

    keys = sorted(by_q)
    latest = keys[-1]
    # Only treat the latest quarter as "recent" if it's within ~2 quarters of
    # today — otherwise a years-old award shouldn't read as accelerating.
    is_recent = qend(latest) >= today - timedelta(days=180)
    recent = by_q[latest] if is_recent else 0.0
    prev = (by_q[keys[-2]] if len(keys) >= 2 else 0.0) if is_recent else 0.0
    ly, lq = latest
    items = [{"as_of": f"{y}-Q{q}", "amount": round(by_q[(y, q)])} for (y, q) in list(reversed(keys))[:8]]
    return {"recent_usd_90d": round(recent), "prior_usd_90d": round(prev), "trend": _trend(recent, prev),
            "count_90d": 1 if is_recent else 0,
            "latest": {"period": f"{ly}-Q{lq}", "amount": round(by_q[latest]), "stale": not is_recent},
            "items": items}


def agg_congress(rows: list[dict], today: date) -> dict:
    cutoff = today - timedelta(days=WINDOW_DAYS)
    buys = sells = 0.0
    buyers: set = set()
    items: list[dict] = []
    for r in rows:
        d = _to_date(_f(r, "TransactionDate", "Traded", "Date", "ReportDate"))
        # Range ("$1,001 - $15,000") → midpoint; Amount is just the low bound.
        amt = _to_num(_f(r, "Range", "Amount", "Trade_Size_USD")) or 0.0
        tx = str(_f(r, "Transaction", "Type") or "").lower()
        who = _f(r, "Representative", "Senator", "Name")
        items.append({"date": d.isoformat() if d else None, "who": who, "party": _f(r, "Party"),
                      "house": _f(r, "House"), "tx": tx, "amount": round(amt)})
        if d and d >= cutoff:
            if "purchase" in tx or "buy" in tx:
                buys += amt
                buyers.add(who)
            elif "sale" in tx or "sell" in tx:
                sells += amt
    items = [i for i in items if i["date"]]
    items.sort(key=lambda x: x["date"], reverse=True)
    return {"buys_usd_90d": round(buys), "sells_usd_90d": round(sells), "net_usd_90d": round(buys - sells),
            "buyers_90d": len(buyers), "items": items[:8]}


def agg_insider(rows: list[dict], today: date) -> dict:
    cutoff = today - timedelta(days=WINDOW_DAYS)
    net = 0.0
    buys = sells = 0
    items: list[dict] = []
    for r in rows:
        d = _to_date(_f(r, "Date", "TransactionDate", "FilingDate"))
        shares = _to_num(_f(r, "Shares", "Amount", "TransactionShares"))
        price = _to_num(_f(r, "PricePerShare", "Price"))
        code = str(_f(r, "AcquiredDisposedCode", "TransactionCode", "Transaction", "Code") or "")
        val = (shares or 0) * (price or 0)
        cu = code.upper()
        is_buy = cu.startswith("A") or "buy" in cu.lower() or "purchase" in cu.lower()
        is_sell = cu.startswith("D") or "sell" in cu.lower() or "sale" in cu.lower()
        items.append({"date": d.isoformat() if d else None, "who": _f(r, "Name", "Insider", "Reporter"),
                      "code": code, "value": round(val) if val else None})
        if d and d >= cutoff:
            if is_buy:
                net += val
                buys += 1
            elif is_sell:
                net -= val
                sells += 1
    items = [i for i in items if i["date"]]
    items.sort(key=lambda x: x["date"], reverse=True)
    return {"net_usd_90d": round(net), "buys_90d": buys, "sells_90d": sells, "items": items[:8]}


def agg_lobbying(rows: list[dict], today: date) -> dict:
    cutoff, prior = today - timedelta(days=180), today - timedelta(days=360)
    recent = prev = 0.0
    items: list[dict] = []
    for r in rows:
        d = _to_date(_f(r, "Date", "ReportDate"))
        amt = _to_num(_f(r, "Amount", "Dollars"))
        if d is None or amt is None:
            continue
        if d >= cutoff:
            recent += amt
        elif d >= prior:
            prev += amt
        items.append({"date": d.isoformat(), "amount": amt, "issue": _f(r, "Issue", "Issues", "Client")})
    items.sort(key=lambda x: x["date"], reverse=True)
    return {"recent_usd": round(recent), "prior_usd": round(prev), "trend": _trend(recent, prev), "items": items[:5]}


def agg_offexchange(rows: list[dict], today: date) -> dict:
    """Off-exchange/dark-pool: recent Dark Pool Index (DPI) + OTC short ratio,
    last ~30d vs the prior ~30d. Rising DPI = more off-exchange/institutional
    activity; short ratio = off-exchange short pressure. Direction is
    informational (DPI cuts both ways) — surfaced, not scored."""
    cutoff, prior = today - timedelta(days=30), today - timedelta(days=60)
    rec_dpi: list[float] = []
    prev_dpi: list[float] = []
    rec_short: list[float] = []
    for r in rows:
        d = _to_date(_f(r, "Date"))
        if d is None:
            continue
        dpi = _to_num(_f(r, "DPI"))
        short = _to_num(_f(r, "OTC_Short"))
        total = _to_num(_f(r, "OTC_Total"))
        if d >= cutoff:
            if dpi is not None:
                rec_dpi.append(dpi)
            if short is not None and total:
                rec_short.append(short / total * 100)
        elif d >= prior and dpi is not None:
            prev_dpi.append(dpi)
    if not rec_dpi:
        return {}
    recent_dpi = sum(rec_dpi) / len(rec_dpi)
    prior_dpi = sum(prev_dpi) / len(prev_dpi) if prev_dpi else 0.0
    return {
        "dpi_recent": round(recent_dpi, 3),
        "dpi_prior": round(prior_dpi, 3),
        "dpi_trend": _trend(recent_dpi, prior_dpi),
        "short_pct": round(sum(rec_short) / len(rec_short), 1) if rec_short else None,
    }


def composite_signal(gov: dict, congress: dict, insider: dict, lobbying: dict) -> dict:
    """Direction of public buying: a small interpretable score + drivers."""
    score = 0
    drivers: list[str] = []
    if gov.get("recent_usd_90d", 0) > 0:
        if gov["trend"] == "up":
            score += 2
            drivers.append("federal contracts accelerating")
        elif gov["trend"] == "down":
            score -= 1
            drivers.append("federal contracts slowing")
        else:
            score += 1
            drivers.append("ongoing federal contracts")
    if congress.get("net_usd_90d", 0) > 0:
        score += 1
        drivers.append(f"net congressional buying ({congress.get('buyers_90d', 0)} member(s))")
    elif congress.get("net_usd_90d", 0) < 0:
        score -= 1
        drivers.append("net congressional selling")
    if insider.get("net_usd_90d", 0) > 0:
        score += 1
        drivers.append("net insider buying")
    elif insider.get("net_usd_90d", 0) < 0:
        score -= 1
        drivers.append("net insider selling")
    if lobbying.get("trend") == "up":
        drivers.append("lobbying ramping")
    label = "Heating up" if score >= 2 else "Cooling" if score < 0 else "Steady"
    return {"label": label, "score": score, "drivers": drivers}


def capabilities(force: bool = False) -> dict:
    """Which datasets the configured key unlocks (probed once, cached ~1h).

    Tier-aware by detection: a free key surfaces a subset, a premium key
    unlocks all four — we just ask the API which datasets respond. Returns
    ``{configured, datasets:{ds:{label,status}}, accessible:[...], locked:[...]}``
    where status is ok | gated | error | no_key.
    """
    if not has_key():
        return {"configured": False,
                "datasets": {ds: {"label": lbl, "status": "no_key"} for ds, lbl in DATASET_LABELS.items()},
                "accessible": [], "locked": list(DATASET_LABELS)}
    now = time.time()
    if not force and _CAP["data"] is not None and now - _CAP["ts"] < _CAP_TTL:
        return _CAP["data"]
    datasets: dict[str, dict] = {}
    accessible: list[str] = []
    locked: list[str] = []
    for ds, (_data, err) in _fetch_all(PROBE_TICKER).items():
        st = _status_from_err(err)
        datasets[ds] = {"label": DATASET_LABELS[ds], "status": st}
        if st == "ok":
            accessible.append(ds)
        elif st == "gated":
            locked.append(ds)
    out = {"configured": True, "datasets": datasets, "accessible": accessible, "locked": locked}
    _CAP.update(data=out, ts=now)
    return out


def signals_for(ticker: str, today: Optional[date] = None) -> dict:
    """Full public-activity bundle for one ticker (all four datasets + signal)."""
    today = today or date.today()
    sym = (ticker or "").strip().upper()
    out: dict[str, Any] = {"ticker": sym, "source": "quiver", "fetched_at": _now_iso(), "available": False}
    if not has_key():
        out["reason"] = "no_key"
        return out
    errors: dict[str, str] = {}
    parsed: dict[str, Any] = {}
    aggs = {"govcontracts": agg_govcontracts, "congress": agg_congress,
            "insider": agg_insider, "lobbying": agg_lobbying, "offexchange": agg_offexchange}
    for ds, (data, err) in _fetch_all(sym).items():
        if err:
            errors[ds] = err
            continue
        parsed[ds] = aggs[ds](_rows(data), today)
    # Per-dataset status so the UI can show "unlocked" vs "upgrade to unlock".
    dataset_status = {}
    for ds in _ENDPOINTS:
        if ds in parsed:
            dataset_status[ds] = "ok"
        else:
            dataset_status[ds] = _status_from_err(errors.get(ds))
    out["dataset_status"] = dataset_status

    if not parsed:
        out["reason"] = "no_data"
        out["errors"] = errors
        return out
    gov = parsed.get("govcontracts", {})
    congress = parsed.get("congress", {})
    insider = parsed.get("insider", {})
    lobbying = parsed.get("lobbying", {})
    offexchange = parsed.get("offexchange", {})
    out.update(
        available=True,
        gov_contracts=gov or None,
        congress=congress or None,
        insider=insider or None,
        lobbying=lobbying or None,
        offexchange=offexchange or None,
        signal=composite_signal(gov, congress, insider, lobbying),
        errors=errors or None,
    )
    return out


def diagnose(ticker: str) -> dict:
    """Raw shape per dataset (row counts + sample keys) to finalise field maps."""
    sym = (ticker or "").strip().upper()
    if not has_key():
        return {"ticker": sym, "ok": False, "error": "no QUIVER_API_KEY set"}
    report: dict[str, Any] = {"ticker": sym, "ok": True, "datasets": {}}
    for ds, (data, err) in _fetch_all(sym).items():
        path = _ENDPOINTS[ds].format(t=sym)
        if err:
            report["datasets"][ds] = {"path": path, "error": err}
            continue
        rows = _rows(data)
        report["datasets"][ds] = {
            "path": path,
            "rows": len(rows),
            "sample_keys": sorted(rows[0].keys()) if rows else [],
            "sample_row": rows[0] if rows else None,
        }
    return report
