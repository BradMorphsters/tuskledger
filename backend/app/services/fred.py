"""FRED (Federal Reserve Economic Data) — free macro / commodity series for the theme signal.

The sector-tailwind today rides only proxy-ETF momentum (themes.py). For a thematic miner book
the *actual* commodity/macro trend — copper, metals PPI, real rates, the dollar — is the real
driver, and FRED publishes it for free. This pulls a series' recent trend and feeds it into the
theme blend so "don't fight the sector" keys off the underlying, not just an ETF's price.

Keyless by design: the public CSV download (``fredgraph.csv``) needs no API key, matching the
rest of the data layer (cache-backed, key-independent). A ``FRED_API_KEY`` is optional and only
raises rate limits — not required for this path.

Pure parse/aggregate (``parse_fred_csv``, ``series_change``, ``theme_from_series``) + a thin
fetch (``fetch_series``) that's injectable for tests.
"""
from __future__ import annotations

import csv
import datetime
import io
from typing import Callable, Optional

import httpx

FRED_CSV = "https://fred.stlouisfed.org/graph/fredgraph.csv?id={series}"
_TIMEOUT = 10.0
_UA = "TuskLedger/1.0 (+https://www.tuskledger.com)"

# (series_id) -> (csv_text | None, error | None)
Fetcher = Callable[[str], "tuple[Optional[str], Optional[str]]"]


def _http_get(url: str) -> "tuple[Optional[str], Optional[str]]":
    try:
        r = httpx.get(url, headers={"User-Agent": _UA}, timeout=_TIMEOUT, follow_redirects=True)
        if r.status_code != 200:
            return None, f"HTTP {r.status_code}"
        return r.text, None
    except Exception as e:  # noqa: BLE001 — a fetch failure must degrade to "no data", never raise
        return None, str(e)


def parse_fred_csv(text: str) -> list[tuple[str, float]]:
    """FRED graph CSV → ``[(date_iso, value)]``, oldest→newest, skipping FRED's '.' (missing)
    markers. The value column is the last column (header is DATE,<SERIES> or observation_date,…)."""
    out: list[tuple[str, float]] = []
    if not text:
        return out
    rows = list(csv.reader(io.StringIO(text)))
    for row in rows[1:]:                       # skip the header
        if len(row) < 2:
            continue
        d, v = (row[0] or "").strip(), (row[-1] or "").strip()
        if not d or v in ("", "."):
            continue
        try:
            out.append((d, float(v)))
        except ValueError:
            continue
    return out


def series_change(observations: list[tuple[str, float]], *, lookback_days: int = 90) -> Optional[float]:
    """Fractional change of the series over ~``lookback_days`` (default ≈3 months). Uses the
    nearest observation at or before the target date as the base. ``None`` if not enough data."""
    if not observations or len(observations) < 2:
        return None
    obs = sorted(observations, key=lambda x: x[0])
    try:
        last_date = datetime.date.fromisoformat(obs[-1][0][:10])
    except (TypeError, ValueError):
        return None
    last_val = obs[-1][1]
    target = last_date - datetime.timedelta(days=lookback_days)
    base: Optional[float] = None
    for d, v in obs:
        try:
            od = datetime.date.fromisoformat(d[:10])
        except (TypeError, ValueError):
            continue
        if od <= target:
            base = v
        else:
            break
    if base is None:
        base = obs[0][1]
    if base == 0:
        return None
    return round((last_val - base) / abs(base), 4)


def fetch_series(series: str, *, get: Fetcher = _http_get) -> list[tuple[str, float]]:
    """Fetch + parse one FRED series (keyless CSV). Returns [] on any error."""
    text, err = get(FRED_CSV.format(series=series))
    if err or not text:
        return []
    return parse_fred_csv(text)


def theme_from_series(changes: dict[str, Optional[float]]) -> dict:
    """Aggregate per-series 3-mo changes into ``{momentum, trend_up, n, series}``. ``momentum``
    is the average fractional change; ``trend_up`` means the commodities/macro are net rising."""
    vals = [c for c in changes.values() if isinstance(c, (int, float))]
    if not vals:
        return {"momentum": 0.0, "trend_up": False, "n": 0, "series": list(changes)}
    avg = sum(vals) / len(vals)
    return {"momentum": round(avg, 4), "trend_up": avg >= 0.0, "n": len(vals), "series": list(changes)}
