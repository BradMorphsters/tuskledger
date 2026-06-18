"""Join the research universe onto live holdings and derive alerts.

This is the headline of the research layer: the user's *long-term-hold
cockpit*. Position data is read from whichever DB the request is bound to
(real or demo) and is **never** written back into the research file — that
PII-free separation is the whole point (spec §9). Research contributes
``tier / conviction / upside / thesis / catalysts / invalidation_triggers /
risk_rating / review``; the holdings DB contributes ``quantity / market_value /
cost_basis / unrealized_gl / accounts / tax_bucket``.

The join is **tolerant** (spec §6.1): a holding with no research match simply
has no overlay; a research name the user doesn't hold simply isn't in the
cockpit. Nothing errors on a miss.
"""
from __future__ import annotations

import re
from datetime import date, timedelta
from typing import Any, Optional

from sqlalchemy.orm import Session, joinedload

from app.models import Holding
from app.services import research_store as store

# Weight (% of total portfolio market value) at/above which a holding is
# considered a "large position" worth flagging for thesis attention.
LARGE_POSITION_PCT = 5.0
# fundamentals.as_of older than this many days = stale (spec §7.5 default).
STALE_FUNDAMENTALS_DAYS = 90
# Held value concentrated in one category above this share triggers a
# concentration alert.
CONCENTRATION_PCT = 30.0
# Conviction at/above which a *non-held* watchlist name is scanned for public
# tripwire alerts (contracts/insider/dilution/etc.), not just held names.
HIGH_CONVICTION_FOR_SIGNALS = 85
# Insider Form-4 filings in 90d at/above which a "cluster" is worth flagging.
INSIDER_CLUSTER_90D = 8
# Finnhub: flag an upcoming earnings date within this many days (event risk); and an analyst
# net-rating revision of at least this magnitude (improving/deteriorating estimates).
EARNINGS_SOON_DAYS = 10
REVISION_ALERT = 0.10

_price_re = re.compile(r"-?\d+(?:\.\d+)?")


def _usd(n) -> str:
    """Compact USD label for alert messages ($4.4M, $550K)."""
    try:
        n = float(n)
    except (TypeError, ValueError):
        return "$0"
    a = abs(n)
    if a >= 1e9:
        return f"${n / 1e9:.1f}B"
    if a >= 1e6:
        return f"${n / 1e6:.1f}M"
    if a >= 1e3:
        return f"${n / 1e3:.0f}K"
    return f"${n:.0f}"


def parse_price(val) -> Optional[float]:
    """Best-effort parse of the approximate fundamentals.price string.

    The research file stores price as a human label ('~$28', '~$80 ADS',
    '~$1.9'); the viewer needs a number to place 'current' inside a target
    band. Returns None when there's no parseable figure.
    """
    if val is None:
        return None
    if isinstance(val, (int, float)):
        return float(val)
    m = _price_re.search(str(val).replace(",", ""))
    if not m:
        return None
    try:
        return float(m.group())
    except ValueError:
        return None


# ── Normalisation + matching ──────────────────────────────────────────────
def _norm(t: Optional[str]) -> Optional[str]:
    if not t:
        return None
    return t.strip().upper() or None


def _build_index(entities: list[dict]) -> dict[str, dict]:
    """Map normalised ticker / alias / plaid_security_id → entity."""
    by_ticker: dict[str, dict] = {}
    by_pid: dict[str, dict] = {}
    for e in entities:
        t = _norm(e.get("ticker"))
        if t and t not in by_ticker:
            by_ticker[t] = e
        for alias in e.get("aliases") or []:
            na = _norm(alias)
            if na and na not in by_ticker:
                by_ticker[na] = e
        pid = e.get("plaid_security_id")
        if pid:
            by_pid[str(pid)] = e
    return {"ticker": by_ticker, "pid": by_pid}


def _match(index: dict[str, dict], security) -> Optional[dict]:
    """Find the research entity for a holding's security, or None."""
    if security is None:
        return None
    pid = getattr(security, "plaid_security_id", None)
    if pid and str(pid) in index["pid"]:
        return index["pid"][str(pid)]
    t = _norm(getattr(security, "ticker_symbol", None))
    if t and t in index["ticker"]:
        return index["ticker"][t]
    return None


# ── Date parsing (catalysts use coarse periods) ───────────────────────────
_Q_END = {1: (3, 31), 2: (6, 30), 3: (9, 30), 4: (12, 31)}
_H_END = {1: (6, 30), 2: (12, 31)}


def period_end(s: Any) -> Optional[date]:
    """Coarse period or ISO date → the date by which it should have landed.

    Handles ``YYYY-MM-DD``, ``YYYY-Qn``, ``YYYY-Hn``, ``YYYY-MM`` and ``YYYY``.
    Returns None for anything unrecognised (so it never falsely flags overdue).
    """
    if not s:
        return None
    s = str(s).strip()
    m = re.fullmatch(r"(\d{4})-(\d{2})-(\d{2})", s)
    if m:
        try:
            return date(int(m[1]), int(m[2]), int(m[3]))
        except ValueError:
            return None
    m = re.fullmatch(r"(\d{4})-?Q([1-4])", s, re.I)
    if m:
        mo, dd = _Q_END[int(m[2])]
        return date(int(m[1]), mo, dd)
    m = re.fullmatch(r"(\d{4})-?H([12])", s, re.I)
    if m:
        mo, dd = _H_END[int(m[2])]
        return date(int(m[1]), mo, dd)
    m = re.fullmatch(r"(\d{4})-(\d{2})", s)
    if m:
        y, mo = int(m[1]), int(m[2])
        nxt = date(y + 1, 1, 1) if mo == 12 else date(y, mo + 1, 1)
        return nxt - timedelta(days=1)
    m = re.fullmatch(r"(\d{4})", s)
    if m:
        return date(int(m[1]), 12, 31)
    return None


# ── Entity loading ────────────────────────────────────────────────────────
def _entities(domain: Optional[str] = None) -> list[dict]:
    """Entities for one domain, or flattened across every domain file."""
    if domain:
        return store.load_domain(domain).get("entities", []) or []
    out: list[dict] = []
    for dom in store.list_domains():
        out.extend(store.load_domain(dom).get("entities", []) or [])
    return out


# ── Research overlay (the compact view the cockpit renders) ───────────────
_ACTIVE_CATALYST = {"upcoming", "in_progress", "ongoing"}


def _next_catalyst(ent: dict, today: date) -> Optional[dict]:
    """Soonest still-open catalyst, annotated with overdue + parsed due date."""
    candidates = []
    for c in ent.get("catalysts") or []:
        status = (c.get("status") or "upcoming").lower()
        if status in {"hit", "missed"}:
            continue
        due = period_end(c.get("due"))
        candidates.append((due, c, status))
    if not candidates:
        return None
    # Dated catalysts first (soonest), undated last.
    candidates.sort(key=lambda x: (x[0] is None, x[0] or date.max))
    due, c, status = candidates[0]
    out = dict(c)
    out["status"] = status
    out["due_date"] = due.isoformat() if due else None
    out["overdue"] = bool(due and due < today and status in _ACTIVE_CATALYST)
    return out


def _overdue_catalysts(ent: dict, today: date) -> list[dict]:
    out = []
    for c in ent.get("catalysts") or []:
        status = (c.get("status") or "upcoming").lower()
        if status not in _ACTIVE_CATALYST:
            continue
        due = period_end(c.get("due"))
        if due and due < today:
            out.append({**c, "due_date": due.isoformat()})
    return out


def _is_stale(ent: dict, today: date) -> bool:
    review = ent.get("review") or {}
    nd = period_end(review.get("next_due"))
    if nd and nd < today:
        return True
    fa = period_end((ent.get("fundamentals") or {}).get("as_of"))
    if fa and (today - fa).days > STALE_FUNDAMENTALS_DAYS:
        return True
    return False


def _sources_confidence(ent: dict) -> Optional[str]:
    """Lowest source confidence — the user needs to see verified vs inferred."""
    order = {"low": 0, "medium": 1, "high": 2}
    levels = [
        (s.get("confidence") or "").lower()
        for s in ent.get("sources") or []
        if s.get("confidence")
    ]
    levels = [l for l in levels if l in order]
    if not levels:
        return None
    return min(levels, key=lambda l: order[l])


def research_overlay(ent: dict, today: Optional[date] = None) -> dict[str, Any]:
    """The compact research projection joined onto a position (or shown solo)."""
    today = today or date.today()
    scores = ent.get("scores") or {}
    review = ent.get("review") or {}
    return {
        "id": ent.get("id"),
        "tier": ent.get("tier"),
        "category": ent.get("category"),
        "lifecycle_stage": ent.get("lifecycle_stage"),
        "conviction": scores.get("conviction"),
        "upside": scores.get("upside"),
        "risk_rating": ent.get("risk_rating"),
        "exposure": ent.get("exposure"),
        "govt_support": ent.get("govt_support"),
        "thesis_summary": (ent.get("thesis") or {}).get("summary"),
        "next_catalyst": _next_catalyst(ent, today),
        "invalidation_triggers": ent.get("invalidation_triggers") or [],
        "review": {
            "next_due": review.get("next_due"),
            "last_reviewed": review.get("last_reviewed"),
            "stale": _is_stale(ent, today),
        },
        "confidence": _sources_confidence(ent),
        "updated_at": ent.get("updated_at"),
        # Published analyst targets (equities only) + a parsed current price
        # from the research snapshot, so the viewer can show current-vs-range.
        # Held names also carry a live current_price on the position (below).
        "price_targets": ent.get("price_targets"),
        "current_price": parse_price((ent.get("fundamentals") or {}).get("price")),
        "price_as_of": (ent.get("fundamentals") or {}).get("as_of"),
    }


def _position_flags(
    ent: dict, market_value: float, gl: Optional[float], weight: Optional[float], today: date
) -> list[str]:
    flags: list[str] = []
    large = weight is not None and weight >= LARGE_POSITION_PCT
    if large:
        flags.append("large_position")
    if gl is not None and gl < 0:
        flags.append("below_cost")
    if _overdue_catalysts(ent, today):
        flags.append("overdue_catalyst")
    if _is_stale(ent, today):
        flags.append("stale_research")
    if large and (ent.get("invalidation_triggers") or []):
        flags.append("invalidation_watch")
    return flags


# ── The headline join ─────────────────────────────────────────────────────
def _holdings(db: Session) -> list[Holding]:
    return (
        db.query(Holding)
        .options(joinedload(Holding.security), joinedload(Holding.account))
        .all()
    )


def get_position_research(
    db: Session, domain: Optional[str] = None, today: Optional[date] = None
) -> dict[str, Any]:
    """Each held security that matches the research universe × its overlay.

    Returns ``{positions: [...], unmatched_holdings: int, total_market_value,
    matched_market_value}``. Positions aggregate a security held across several
    accounts into one row (spec §6.4).
    """
    today = today or date.today()
    entities = _entities(domain)
    index = _build_index(entities)
    holdings = _holdings(db)

    total_value = sum((h.institution_value or 0.0) for h in holdings)
    agg: dict[str, dict] = {}
    unmatched = 0

    for h in holdings:
        ent = _match(index, h.security)
        if ent is None:
            unmatched += 1
            continue
        slot = agg.setdefault(
            ent["id"],
            {
                "entity": ent,
                "quantity": 0.0,
                "market_value": 0.0,
                "cost_basis": 0.0,
                "cb_known": False,
                "accounts": [],
                "tax_buckets": set(),
            },
        )
        slot["quantity"] += h.quantity or 0.0
        slot["market_value"] += h.institution_value or 0.0
        if h.cost_basis is not None:
            slot["cost_basis"] += h.cost_basis
            slot["cb_known"] = True
        acct = h.account
        if acct is not None:
            nm = acct.custom_name or acct.name
            if nm and nm not in slot["accounts"]:
                slot["accounts"].append(nm)
            if getattr(acct, "tax_bucket", None):
                slot["tax_buckets"].add(acct.tax_bucket)

    positions: list[dict] = []
    matched_value = 0.0
    for slot in agg.values():
        ent = slot["entity"]
        mv = round(slot["market_value"], 2)
        matched_value += mv
        cb = round(slot["cost_basis"], 2) if slot["cb_known"] else None
        gl = round(mv - cb, 2) if cb is not None else None
        gl_pct = round(gl / cb * 100, 2) if (gl is not None and cb) else None
        weight = round(mv / total_value * 100, 2) if total_value else None
        positions.append(
            {
                "ticker": ent.get("ticker"),
                "name": ent.get("name"),
                "domain": ent.get("domain"),
                "security_type": ent.get("security_type"),
                "position": {
                    "quantity": round(slot["quantity"], 4),
                    "market_value": mv,
                    "cost_basis": cb,
                    "unrealized_gl": gl,
                    "unrealized_gl_pct": gl_pct,
                    "weight_pct": weight,
                    # Live per-share price from holdings — preferred over the
                    # research snapshot price for names the user actually holds.
                    "current_price": round(mv / slot["quantity"], 2) if slot["quantity"] else None,
                    "accounts": slot["accounts"],
                    "tax_buckets": sorted(slot["tax_buckets"]),
                },
                "research": research_overlay(ent, today),
                "flags": _position_flags(ent, mv, gl, weight, today),
            }
        )

    positions.sort(
        key=lambda r: (
            -(r["position"]["weight_pct"] or 0),
            -(r["research"]["conviction"] or 0),
        )
    )
    return {
        "as_of": today.isoformat(),
        "positions": positions,
        "matched_count": len(positions),
        "unmatched_holdings": unmatched,
        "total_market_value": round(total_value, 2),
        "matched_market_value": round(matched_value, 2),
    }


# ── Universe (full scored list, optionally filtered / held-marked) ────────
def get_universe(
    db: Optional[Session] = None,
    domain: Optional[str] = None,
    tier: Optional[int] = None,
    min_conviction: Optional[float] = None,
    held_only: bool = False,
    today: Optional[date] = None,
) -> list[dict]:
    """The scored universe. If ``db`` is given, each row is marked ``held``."""
    today = today or date.today()
    entities = _entities(domain)

    held_ids: set[str] = set()
    if db is not None:
        index = _build_index(entities)
        for h in _holdings(db):
            ent = _match(index, h.security)
            if ent is not None:
                held_ids.add(ent["id"])

    rows: list[dict] = []
    for ent in entities:
        scores = ent.get("scores") or {}
        conv = scores.get("conviction")
        if tier is not None and ent.get("tier") != tier:
            continue
        if min_conviction is not None and (conv is None or conv < min_conviction):
            continue
        is_held = ent["id"] in held_ids
        if held_only and not is_held:
            continue
        rows.append(
            {
                "id": ent.get("id"),
                "ticker": ent.get("ticker"),
                "name": ent.get("name"),
                "domain": ent.get("domain"),
                "category": ent.get("category"),
                "security_type": ent.get("security_type"),
                "tier": ent.get("tier"),
                "lifecycle_stage": ent.get("lifecycle_stage"),
                "conviction": conv,
                "upside": scores.get("upside"),
                "risk_rating": ent.get("risk_rating"),
                "govt_support": ent.get("govt_support"),
                "thesis_summary": (ent.get("thesis") or {}).get("summary"),
                "exposure": ent.get("exposure"),
                "held": is_held,
                "stale": _is_stale(ent, today),
                "confidence": _sources_confidence(ent),
                "price_targets": ent.get("price_targets"),
                "current_price": parse_price((ent.get("fundamentals") or {}).get("price")),
            }
        )

    rows.sort(key=lambda r: (-(r["conviction"] or 0), -(r["upside"] or 0)))
    return rows


# ── Alerts (derived flags across held + universe) ─────────────────────────
def get_alerts(
    db: Session, domain: Optional[str] = None, today: Optional[date] = None
) -> list[dict]:
    """Derived watch-list: stale, overdue catalyst, invalidation watch,
    large below-cost positions, and category concentration."""
    today = today or date.today()
    pr = get_position_research(db, domain=domain, today=today)
    positions = pr["positions"]
    held_by_id = {}
    entities = _entities(domain)
    ent_by_id = {e["id"]: e for e in entities}

    alerts: list[dict] = []

    def add(severity: str, kind: str, scope: str, ent_id: str, message: str, **extra):
        alerts.append(
            {
                "severity": severity,
                "type": kind,
                "scope": scope,
                "id": ent_id,
                "ticker": (ent_by_id.get(ent_id) or {}).get("ticker"),
                "name": (ent_by_id.get(ent_id) or {}).get("name"),
                "message": message,
                **extra,
            }
        )

    # Held-position alerts (the ones that matter most — money is on them).
    for p in positions:
        held_by_id[p["research"]["id"]] = p
        ent = ent_by_id.get(p["research"]["id"], {})
        flags = set(p["flags"])
        weight = p["position"]["weight_pct"]
        gl = p["position"]["unrealized_gl"]
        if "large_position" in flags and "below_cost" in flags:
            add(
                "high", "large_below_cost", "held", ent["id"],
                f"{p['ticker']} is a {weight:.1f}% position and below cost "
                f"(unrealized {gl:+,.0f}). Re-check the thesis.",
            )
        for c in _overdue_catalysts(ent, today):
            add(
                "high", "overdue_catalyst", "held", ent["id"],
                f"{p['ticker']}: catalyst past due ({c.get('due')}) — "
                f"{c.get('description')}",
            )
        if "invalidation_watch" in flags:
            add(
                "med", "invalidation_watch", "held", ent["id"],
                f"{p['ticker']} ({weight:.1f}%) — review invalidation triggers: "
                + "; ".join((ent.get("invalidation_triggers") or [])[:2]),
            )
        if "stale_research" in flags:
            add(
                "med", "stale", "held", ent["id"],
                f"{p['ticker']} research is stale "
                f"(review due {(ent.get('review') or {}).get('next_due')}).",
            )

    # Universe-wide stale / overdue (names you may be watching, not holding).
    for ent in entities:
        if ent["id"] in held_by_id:
            continue
        if _is_stale(ent, today):
            add(
                "low", "stale", "universe", ent["id"],
                f"{ent.get('ticker')} research is stale "
                f"(review due {(ent.get('review') or {}).get('next_due')}).",
            )
        for c in _overdue_catalysts(ent, today):
            add(
                "low", "overdue_catalyst", "universe", ent["id"],
                f"{ent.get('ticker')}: catalyst past due ({c.get('due')}).",
            )

    # ── Public-signal tripwires (cross-plane tie-back) ───────────────────
    # Turn the flow plane (Quiver) and the filing plane (SEC EDGAR) into
    # research alerts for held + high-conviction names. Each rule is
    # SINGLE-SOURCE and self-disabling: it reads only its own cache and emits
    # nothing when that cache is cold, so EDGAR and Quiver never depend on each
    # other. Cache-only — no network, demo-safe.
    signals_cache = store.load_signals(domain)
    edgar_cache = store.load_edgar(domain)
    from app.services import finnhub as _finnhub
    finnhub_cache = _finnhub.load_cache(domain)
    scan_ids = set(held_by_id)
    for ent in entities:
        conv = (ent.get("scores") or {}).get("conviction") or 0
        if ent["id"] in held_by_id or conv >= HIGH_CONVICTION_FOR_SIGNALS:
            scan_ids.add(ent["id"])

    for ent_id in scan_ids:
        ent = ent_by_id.get(ent_id) or {}
        tk = (ent.get("ticker") or "").upper()
        if not tk:
            continue
        held = ent_id in held_by_id
        scope = "held" if held else "universe"
        flags = set(held_by_id.get(ent_id, {}).get("flags", [])) if held else set()
        base = "med" if held else "low"

        # ----- Quiver flow (signals cache) -----
        sig = signals_cache.get(tk)
        if sig and sig.get("available"):
            gov = sig.get("gov_contracts") or {}
            if gov.get("recent_usd_90d") and gov.get("trend") == "up" \
                    and not (gov.get("latest") or {}).get("stale"):
                add(base, "flow_contract", scope, ent_id,
                    f"{tk}: federal contract activity accelerating "
                    f"({_usd(gov['recent_usd_90d'])} latest quarter).", source="quiver")
            con = sig.get("congress") or {}
            if (con.get("net_usd_90d") or 0) > 0 and (con.get("buyers_90d") or 0) >= 1:
                add(base, "flow_congress", scope, ent_id,
                    f"{tk}: net congressional buying "
                    f"({_usd(con['net_usd_90d'])}, {con['buyers_90d']} buyer(s), 90d).",
                    source="quiver")
            elif (con.get("net_usd_90d") or 0) < 0:
                add(base, "flow_congress_sell", scope, ent_id,
                    f"{tk}: net congressional selling ({_usd(-con['net_usd_90d'])}, 90d).",
                    source="quiver")
            lob = sig.get("lobbying") or {}
            if (lob.get("recent_usd") or 0) > 0 and lob.get("trend") == "up":
                add("low", "flow_lobbying", scope, ent_id,
                    f"{tk}: lobbying spend rising ({_usd(lob['recent_usd'])}, 6mo).",
                    source="quiver")
            oe = sig.get("offexchange") or {}
            if oe.get("dpi_trend") == "up" and oe.get("dpi_recent") is not None:
                add("low", "flow_darkpool", scope, ent_id,
                    f"{tk}: off-exchange/dark-pool activity rising (DPI {oe['dpi_recent']}).",
                    source="quiver")

        # ----- SEC EDGAR (edgar cache) -----
        ed = edgar_cache.get(tk)
        if ed and ed.get("available"):
            if (ed.get("capital_raises_90d") or 0) > 0:
                sev = "high" if (held and "below_cost" in flags) else ("med" if held else "low")
                forms = ", ".join(f.get("form") for f in (ed.get("recent_raises") or [])[:2]) or "S-1/424B"
                add(sev, "dilution_watch", scope, ent_id,
                    f"{tk}: new capital-raise filing(s) in 90d ({forms}) — potential dilution.",
                    source="edgar")
            ins = ed.get("insider_filings_90d") or 0
            if ins >= INSIDER_CLUSTER_90D and ed.get("insider_trend") == "up":
                add(base, "insider_cluster", scope, ent_id,
                    f"{tk}: insider Form-4 filings clustering ({ins} in 90d, up vs prior).",
                    source="edgar")

        # ----- Finnhub estimates / earnings (finnhub cache) -----
        fh = finnhub_cache.get(tk)
        if fh and fh.get("available"):
            ne = fh.get("next_earnings")
            if ne:
                try:
                    dd = (date.fromisoformat(str(ne)[:10]) - today).days
                except ValueError:
                    dd = None
                if dd is not None and 0 <= dd <= EARNINGS_SOON_DAYS:
                    add(base, "earnings_soon", scope, ent_id,
                        f"{tk}: earnings in {dd}d ({ne}) — event risk near.", source="finnhub")
            rev = fh.get("revision")
            if isinstance(rev, (int, float)):
                if rev >= REVISION_ALERT:
                    add("low", "revision_up", scope, ent_id,
                        f"{tk}: analyst estimates revising up (net +{rev:.2f}).", source="finnhub")
                elif rev <= -REVISION_ALERT:
                    add("med" if held else "low", "revision_down", scope, ent_id,
                        f"{tk}: analyst estimates revising down (net {rev:.2f}).", source="finnhub")

    # Category concentration across held research names.
    matched_value = pr["matched_market_value"] or 0.0
    if matched_value > 0:
        by_cat: dict[str, float] = {}
        for p in positions:
            ent = ent_by_id.get(p["research"]["id"], {})
            cat = ent.get("category") or "Uncategorised"
            by_cat[cat] = by_cat.get(cat, 0.0) + (p["position"]["market_value"] or 0.0)
        for cat, val in by_cat.items():
            share = val / matched_value * 100
            if share >= CONCENTRATION_PCT:
                alerts.append(
                    {
                        "severity": "med",
                        "type": "concentration",
                        "scope": "held",
                        "id": None,
                        "ticker": None,
                        "name": cat,
                        "message": (
                            f"{share:.0f}% of your research-tracked holdings are in "
                            f"{cat}. Consider single-theme concentration."
                        ),
                    }
                )

    sev_order = {"high": 0, "med": 1, "low": 2}
    alerts.sort(key=lambda a: (sev_order.get(a["severity"], 3), a["scope"] != "held"))
    return alerts


def get_political_flow(domain: Optional[str] = None, today: Optional[date] = None,
                       limit: int = 12) -> dict:
    """Universe-filtered 'political flow': congressional trades (buys AND sells, with the
    individual trades — member, party, chamber, amount) plus EDGAR insider Form-4 activity, for
    the names in the active industry. Every name relates to the industry by construction (it's in
    the universe). ``committee_relevant`` on each trade is a phase-2 scaffold — it stays False
    until a member→committee data source is wired (the industry's relevant committees are surfaced
    in ``relevant_committees`` so the UI can show what we'd match against). Cache-only; demo-safe."""
    today = today or date.today()
    entities = _entities(domain)
    signals = store.load_signals(domain)
    edgar = store.load_edgar(domain)
    try:
        meta = ((store.load_domain(domain) or {}).get("meta", {}) or {}).get("industry", {}) or {}
        committees = [str(c) for c in (meta.get("relevant_committees") or [])]
    except Exception:  # noqa: BLE001
        committees = []
    from app.services import congress_committees as cc
    cmap = cc.load_map()   # member→committee map (phase 2); {} until refreshed → flags stay False

    rows: list[dict] = []
    for e in entities:
        tk = (e.get("ticker") or "").upper()
        if not tk:
            continue
        sig = signals.get(tk) or {}
        con = (sig.get("congress") or {}) if sig.get("available") else {}
        ed = edgar.get(tk) or {}
        insider_filings = ed.get("insider_filings_90d") if ed.get("available") else None
        trades: list[dict] = []
        for it in (con.get("items") or [])[:8]:
            tx = str(it.get("tx") or "").lower()
            side = "buy" if ("purchase" in tx or "buy" in tx) else "sell" if ("sale" in tx or "sell" in tx) else "other"
            rel = cc.committees_for(it.get("who"), cmap, committees) if cmap else []
            trades.append({"date": it.get("date"), "who": it.get("who"), "party": it.get("party"),
                           "house": it.get("house"), "side": side, "amount": it.get("amount"),
                           "committee_relevant": bool(rel), "committees": rel})
        buys = con.get("buys_usd_90d") or 0
        sells = con.get("sells_usd_90d") or 0
        if not (trades or buys or sells or insider_filings):
            continue
        net = con.get("net_usd_90d") or 0
        direction = ("buying" if net > 0 else "selling" if net < 0
                     else "mixed" if (buys and sells) else "neutral")
        rows.append({
            "ticker": tk, "name": e.get("name"),
            "buys_usd_90d": buys, "sells_usd_90d": sells, "net_usd_90d": net,
            "buyers_90d": con.get("buyers_90d") or 0, "direction": direction, "trades": trades,
            "committee_relevant": any(t["committee_relevant"] for t in trades),
            "insider_filings_90d": insider_filings, "insider_trend": ed.get("insider_trend"),
        })
    rows.sort(key=lambda r: (-(abs(r["buys_usd_90d"]) + abs(r["sells_usd_90d"])),
                             -(r["insider_filings_90d"] or 0)))
    return {"domain": domain, "relevant_committees": committees, "rows": rows[:limit]}
