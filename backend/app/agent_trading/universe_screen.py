"""Universe discovery / maintenance — keep the candidate LIST itself fresh.

The Analyst only ranks *within* a fixed universe (your research list). This layer feeds
that universe so new players get *considered* and stale ones get flagged to drop. It never
mutates your research list — it produces an add/drop REVIEW queue you approve, preserving
the manual-conviction model (discovery surfaces the name; you still author the thesis).

Two discovery tiers:

* **Tier 1 — sector-ETF holdings (high-signal).** When a name is added to URA / LIT / COPX,
  an index committee already judged it "investable enough". Global X publishes a daily
  full-holdings CSV at a predictable URL; we diff its US-listed names against your universe.
  Reliable, keyless, httpx-friendly. (Rare-earth REMX is VanEck, a JS page a server can't
  cleanly fetch — that one is covered by the weekly agent task's web read, not here.)
* **Tier 2 — EDGAR SIC screen (broad, noisier).** Currently-listed companies filing under the
  theme's mining SIC codes that aren't on your radar yet — catches a US filer before any ETF
  holds it. Free, government data; expect review noise.

Pure parse/diff (:func:`parse_globalx_csv`, :func:`parse_sic_ciks`, :func:`screen_universe`)
+ thin fetch adapters (injectable for tests), mirroring ``themes.py`` / ``sec_edgar.py``. The
holdings data carries issuer "no redistribution" terms, so the live adapter caches nothing to
disk and we never commit it — it's a transient personal screen.
"""
from __future__ import annotations

import csv
import io
import re
from typing import Callable, Optional, Sequence

import httpx

# Sector-proxy ETFs we can diff deterministically (Global X publishes a clean daily CSV).
# REMX (rare earth, VanEck) is intentionally absent — it's a JS page; the weekly agent task
# reads it instead. Keyed by research domain.
GLOBALX_PROXIES: dict[str, list[str]] = {
    "critical-minerals": ["URA", "LIT", "COPX"],
}

# EDGAR Standard Industrial Classification codes for the theme's mining/materials filers.
# Broad on purpose (gold 1040 brings noise) — the review queue is human-approved.
SIC_CODES: dict[str, list[str]] = {
    "critical-minerals": ["1000", "1090", "1040", "2810"],  # metal / misc-metal / gold / inorg-chem
}

_GLOBALX_PAGE = "https://www.globalxetfs.com/funds/{etf_lower}/"
_GLOBALX_CSV_RE = re.compile(r"https://assets\.globalxetfs\.com/funds/holdings/[\w\-]+\.csv")
_SIC_FEED = ("https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&SIC={sic}"
             "&type=10-K&dateb=&owner=include&count=100&output=atom")
_CIK_RE = re.compile(r"<cik>\s*(\d+)\s*</cik>", re.IGNORECASE)
_TIMEOUT = 14.0
_UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
       "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36")

Fetcher = Callable[[str, dict], tuple[Optional[str], Optional[str]]]


def _industry_meta(domain: Optional[str]) -> dict:
    """Per-domain industry knobs from the research file (``meta.industry``) — the single place a
    new industry declares its own ETFs / SIC codes, so discovery retargets with no code change."""
    if not domain:
        return {}
    try:
        from app.services import research_store as store
        return ((store.load_domain(domain) or {}).get("meta", {}) or {}).get("industry", {}) or {}
    except Exception:
        return {}


def proxies_for(domain: Optional[str]) -> list[str]:
    """Global-X-diffable sector ETFs: the curated built-in list, else the domain's own
    ``meta.industry.sector_etfs`` so a new industry's Tier-1 discovery works out of the box."""
    hit = GLOBALX_PROXIES.get((domain or "").strip().lower())
    if hit:
        return hit
    return [str(e).upper() for e in (_industry_meta(domain).get("sector_etfs") or [])]


def sic_for(domain: Optional[str]) -> list[str]:
    """EDGAR SIC codes: the curated built-in list, else the domain's own
    ``meta.industry.sic_codes`` (Tier-2 discovery retargets per industry)."""
    hit = SIC_CODES.get((domain or "").strip().lower())
    if hit:
        return hit
    return [str(s) for s in (_industry_meta(domain).get("sic_codes") or [])]


# --------------------------------------------------------------------------- pure parsing

def globalx_us_listed(raw_ticker: str) -> Optional[str]:
    """Global X tags foreign lines with an exchange suffix ('TECK/B CN', 'BHP AU', '2899 HK',
    'ANTO LN') and lists US names bare ('SCCO', 'FCX', 'TGB', 'IE'). Return the clean US
    ticker, or ``None`` for cash/foreign rows (not Robinhood-tradable)."""
    t = (raw_ticker or "").strip().upper()
    if not t or " " in t or "/" in t:           # foreign suffix or class-share slash → skip
        return None
    if not re.fullmatch(r"[A-Z][A-Z.]{0,5}", t):  # bare alpha (allow a dot class share) only
        return None
    return t.replace(".", "-")                    # BRK.B → BRK-B (Robinhood form)


def parse_globalx_csv(text: str) -> list[dict]:
    """Parse a Global X full-holdings CSV → ``[{raw, ticker, name, weight, us_listed}]``.

    The file has two preamble lines (fund name, 'as of' date) then a header row beginning
    ``% of Net Assets,Ticker,Name,...`` and quoted, comma-bearing numeric fields."""
    rows: list[dict] = []
    reader = csv.reader(io.StringIO(text))
    header_seen = False
    for cells in reader:
        if not cells:
            continue
        first = (cells[0] or "").strip()
        if not header_seen:
            if first.lower().startswith("% of net assets"):
                header_seen = True
            continue
        if len(cells) < 3:
            continue
        raw_ticker = (cells[1] or "").strip()
        name = (cells[2] or "").strip()
        if not raw_ticker or name.upper() in ("CASH", "OTHER PAYABLE & RECEIVABLES"):
            continue
        try:
            weight = float((cells[0] or "0").strip())
        except ValueError:
            weight = 0.0
        us = globalx_us_listed(raw_ticker)
        rows.append({"raw": raw_ticker, "ticker": us or raw_ticker, "name": name,
                     "weight": weight, "us_listed": us is not None})
    return rows


def parse_sic_ciks(atom_xml: str) -> list[str]:
    """EDGAR browse-edgar atom feed → ordered, de-duplicated 10-digit CIK strings. (The feed's
    company *names* render as a Perl array-ref bug, so we resolve names/tickers via the CIK
    map instead.)"""
    out: list[str] = []
    seen: set[str] = set()
    for m in _CIK_RE.findall(atom_xml or ""):
        cik = m.zfill(10)
        if cik not in seen:
            seen.add(cik)
            out.append(cik)
    return out


# --------------------------------------------------------------------------- pure diff

def screen_universe(
    universe: Sequence[str],
    etf_lists: dict[str, list[dict]],
    scored: Sequence[dict],
    edgar_candidates: Sequence[dict],
    *,
    research_floor: float = 0.50,
    max_edgar: int = 25,
) -> dict:
    """Diff discovery sources against the current universe → add/drop review queues. Pure.

    * ``universe`` — current research tickers.
    * ``etf_lists`` — ``{etf: [{ticker, name, weight, us_listed}]}`` from Tier 1.
    * ``scored`` — ``[{ticker, research_score, stale}]`` for current names (drop logic).
    * ``edgar_candidates`` — ``[{ticker, cik, sic}]`` from Tier 2.

    Adds are never auto-applied; drops are only *flagged* (a name out of every ETF AND weak or
    stale), never removed. You approve everything."""
    have = {(t or "").upper() for t in universe}

    # ── Tier 1: ETF names not on the list ────────────────────────────────
    in_any_etf: set[str] = set()
    add_etf: dict[str, dict] = {}
    for etf, holdings in (etf_lists or {}).items():
        for h in holdings or []:
            if not h.get("us_listed"):
                continue
            tk = (h.get("ticker") or "").upper()
            if not tk:
                continue
            in_any_etf.add(tk)
            if tk in have:
                continue
            row = add_etf.setdefault(tk, {"ticker": tk, "name": h.get("name"),
                                          "sources": [], "weight": 0.0})
            row["sources"].append(f"ETF {etf} ({h.get('weight', 0.0):.1f}%)")
            row["weight"] = max(row["weight"], float(h.get("weight") or 0.0))
    add_tier1 = sorted(add_etf.values(), key=lambda r: r["weight"], reverse=True)

    # ── Tier 2: EDGAR filers not on the list and not already surfaced by an ETF ──
    add_tier2: list[dict] = []
    t1_set = {r["ticker"] for r in add_tier1}
    seen2: set[str] = set()
    for c in edgar_candidates or []:
        tk = (c.get("ticker") or "").upper()
        if not tk or tk in have or tk in t1_set or tk in seen2:
            continue
        seen2.add(tk)
        add_tier2.append({"ticker": tk, "name": c.get("name"), "cik": c.get("cik"),
                          "sources": [f"EDGAR SIC {c.get('sic')}"]})
        if len(add_tier2) >= max_edgar:
            break

    # ── Drop: held/listed names out of every ETF AND weak or stale ───────
    drops: list[dict] = []
    for s in scored or []:
        tk = (s.get("ticker") or "").upper()
        if not tk or tk in in_any_etf:
            continue  # still in a sector fund → leave it
        weak = (s.get("research_score") or 0.0) < research_floor
        stale = bool(s.get("stale"))
        if not (weak or stale):
            continue
        reasons = []
        if weak:
            reasons.append(f"conviction {(s.get('research_score') or 0.0):.2f} < floor {research_floor:.2f}")
        if stale:
            reasons.append("past its research review date")
        reasons.append("no longer in any theme ETF")
        drops.append({"ticker": tk, "reasons": reasons})

    return {
        "add": add_tier1,
        "add_edgar": add_tier2,
        "drop": drops,
        "in_etf_count": len(in_any_etf),
        "universe_count": len(have),
    }


# --------------------------------------------------------------------------- live fetch adapters

def _http_get(url: str, headers: dict) -> tuple[Optional[str], Optional[str]]:
    """Bounded GET → (text, None) | (None, error). Never raises into the request path."""
    try:
        r = httpx.get(url, headers=headers, timeout=_TIMEOUT, follow_redirects=True)
    except Exception as e:  # noqa: BLE001
        return None, f"{type(e).__name__}: {e}"
    if r.status_code != 200:
        return None, f"http {r.status_code}"
    return r.text, None


def fetch_globalx_holdings(etf: str, *, get: Fetcher = _http_get) -> tuple[list[dict], Optional[str]]:
    """Resolve the fund's current full-holdings CSV from its page, then fetch + parse it."""
    page, err = get(_GLOBALX_PAGE.format(etf_lower=etf.lower()), {"User-Agent": _UA})
    if err or not page:
        return [], err or "no page"
    m = _GLOBALX_CSV_RE.search(page)
    if not m:
        return [], "no holdings CSV link on fund page"
    csv_text, err = get(m.group(0), {"User-Agent": _UA, "Accept": "text/csv,*/*"})
    if err or not csv_text:
        return [], err or "no csv"
    return parse_globalx_csv(csv_text), None


def fetch_sic_ciks(sic: str, *, get: Fetcher = _http_get, sec_user_agent: str = "") -> tuple[list[str], Optional[str]]:
    ua = sec_user_agent or _UA
    xml, err = get(_SIC_FEED.format(sic=sic), {"User-Agent": ua, "Host": "www.sec.gov"})
    if err or not xml:
        return [], err
    return parse_sic_ciks(xml), None


def run_universe_review(
    domain: str,
    *,
    get: Fetcher = _http_get,
    store=None,
    cik_to_ticker: Optional[dict[str, dict]] = None,
    today: Optional[str] = None,
) -> dict:
    """Live orchestrator (impure): pull Tier-1 ETF holdings + Tier-2 EDGAR filers for ``domain``,
    score the current universe for drop logic, and return the review queue. Caches nothing."""
    import datetime as _dt

    from .candidates import _clamp01, _is_stale
    if store is None:
        from app.services import research_store as store  # lazy

    today = today or _dt.date.today().isoformat()
    entities = (store.load_domain(domain).get("entities") if domain else []) or []
    universe = [(e.get("ticker") or "").upper() for e in entities if e.get("ticker")]

    # Tier 1
    etf_lists: dict[str, list[dict]] = {}
    fetch_errors: dict[str, str] = {}
    for etf in proxies_for(domain):
        holdings, err = fetch_globalx_holdings(etf, get=get)
        if holdings:
            etf_lists[etf] = holdings
        if err:
            fetch_errors[etf] = err

    # Tier 2 — resolve listed CIKs to tickers via the SEC ticker map
    if cik_to_ticker is None:
        try:
            from app.services import sec_edgar
            from app.config import settings
            t2c = sec_edgar._ticker_cik_map()  # {TICKER: cik}
            cik_to_ticker = {cik: {"ticker": tk} for tk, cik in t2c.items()}
            sec_ua = settings.SEC_USER_AGENT
        except Exception:
            cik_to_ticker, sec_ua = {}, ""
    else:
        sec_ua = ""
    edgar_candidates: list[dict] = []
    seen_cik: set[str] = set()
    for sic in sic_for(domain):
        ciks, err = fetch_sic_ciks(sic, get=get, sec_user_agent=sec_ua)
        if err:
            fetch_errors[f"SIC {sic}"] = err
        for cik in ciks:
            if cik in seen_cik:
                continue
            seen_cik.add(cik)
            hit = (cik_to_ticker or {}).get(cik)
            if hit:  # only currently-listed filers (have a ticker)
                edgar_candidates.append({"ticker": hit.get("ticker"), "name": hit.get("name"),
                                         "cik": cik, "sic": sic})

    # drop-logic scoring (raw conviction + staleness)
    scored: list[dict] = []
    for e in entities:
        tk = (e.get("ticker") or "").upper()
        if not tk:
            continue
        conv = (e.get("scores") or {}).get("conviction")
        rs = _clamp01(conv / 100.0) if isinstance(conv, (int, float)) else 0.0
        scored.append({"ticker": tk, "research_score": round(rs, 4), "stale": _is_stale(e, today)})

    result = screen_universe(universe, etf_lists, scored, edgar_candidates)
    result.update({"domain": domain, "as_of": today, "proxies": proxies_for(domain),
                   "sic_codes": sic_for(domain), "errors": fetch_errors})
    return result
