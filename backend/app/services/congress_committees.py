"""Member→committee map for the 'political flow' committee-relevance flag (phase 2).

Pulls the open ``unitedstates/congress-legislators`` data (committees-current +
committee-membership-current), builds a normalized ``{member_name: {name, committees}}`` map, and
caches it at ``research/congress_committees.json``. The per-cycle read is just a file load, so a
cold map is a graceful no-op (``committee_relevant`` stays False). Keyless, public data.

The full membership file is ~250KB — too big for the assistant's web_fetch (it truncates), so the
BACKEND fetches it via httpx (no egress limit) on demand, exactly like the price/Finnhub warms.
``committees_for`` filters the global map to whichever committees the active industry cares about
(``meta.industry.relevant_committees``), so one cached map serves every industry.
"""
from __future__ import annotations

import datetime
import json
import re
from typing import Callable, Optional

import httpx

COMMITTEES_URL = "https://unitedstates.github.io/congress-legislators/committees-current.json"
MEMBERSHIP_URL = "https://unitedstates.github.io/congress-legislators/committee-membership-current.json"
_TIMEOUT = 25.0
_UA = "TuskLedger/1.0 (+https://www.tuskledger.com)"

Fetcher = Callable[[str], object]


def _norm_name(name: str) -> str:
    return re.sub(r"\s+", " ", (name or "").strip().lower())


def build_map(committees: list, membership: dict, keywords: Optional[list[str]] = None) -> dict:
    """Pure transform: committees list + membership dict → ``{norm_name: {name, committees}}``.

    Top-level committees only (subcommittees ignored). ``keywords`` optionally restricts which
    committees are included; ``None``/empty = ALL committees (the recommended global map)."""
    kws = [k.lower() for k in (keywords or [])]
    relevant: dict[str, str] = {}                # thomas_id -> committee display name
    for c in committees or []:
        nm, tid = c.get("name") or "", c.get("thomas_id")
        if tid and nm and (not kws or any(k in nm.lower() for k in kws)):
            relevant[tid] = nm
    members: dict[str, dict] = {}
    for tid, name in relevant.items():
        for m in (membership.get(tid) or []):
            who = m.get("name")
            if not who:
                continue
            entry = members.setdefault(_norm_name(who), {"name": who, "committees": []})
            if name not in entry["committees"]:
                entry["committees"].append(name)
    return {
        "generated_at": datetime.date.today().isoformat(),
        "source": "unitedstates/congress-legislators committee-membership-current",
        "relevant_committees": sorted(set(relevant.values())),
        "members": members,
    }


def _http_json(url: str):
    try:
        r = httpx.get(url, headers={"User-Agent": _UA}, timeout=_TIMEOUT, follow_redirects=True)
        return r.json() if r.status_code == 200 else None
    except Exception:  # noqa: BLE001 — degrade to "no data", never raise
        return None


def _map_path():
    from app.services import research_store as store
    return store.research_dir() / "congress_committees.json"


def load_map() -> dict:
    try:
        p = _map_path()
        return json.loads(p.read_text()) if p.exists() else {}
    except Exception:  # noqa: BLE001
        return {}


def refresh(*, fetch: Optional[Fetcher] = None) -> dict:
    """Fetch the public datasets (backend httpx) and rebuild the cached GLOBAL map. Keeps the
    existing map on a failed pull. Returns ``{members: int, relevant_committees: int}``."""
    fetch = fetch or _http_json
    committees, membership = fetch(COMMITTEES_URL), fetch(MEMBERSHIP_URL)
    if not isinstance(committees, list) or not isinstance(membership, dict):
        cur = load_map()
        return {"ok": False, "members": len((cur.get("members") or {})),
                "relevant_committees": len(cur.get("relevant_committees") or [])}
    m = build_map(committees, membership, keywords=None)   # global map; filter per-domain at read
    try:
        p = _map_path()
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps(m, indent=2))
    except Exception:  # noqa: BLE001
        pass
    return {"ok": True, "members": len(m["members"]), "relevant_committees": len(m["relevant_committees"])}


def committees_for(member_name: str, cmap: dict, keywords: Optional[list[str]] = None) -> list[str]:
    """Relevant committees for a congressional member name. Exact normalized match first, then a
    last-name + first-initial fallback (Quiver's display names differ slightly from the official
    roster). ``keywords`` restricts to the industry's relevant committees."""
    members = (cmap or {}).get("members") or {}
    entry = members.get(_norm_name(member_name))
    if not entry:
        toks = _norm_name(member_name).split()
        if len(toks) >= 2:
            last, first0 = toks[-1], toks[0][:1]
            for k, e in members.items():
                kt = k.split()
                if kt and kt[-1] == last and kt[0][:1] == first0:
                    entry = e
                    break
    if not entry:
        return []
    comms = entry.get("committees") or []
    if keywords:
        kws = [k.lower() for k in keywords]
        comms = [c for c in comms if any(k in c.lower() for k in kws)]
    return comms
