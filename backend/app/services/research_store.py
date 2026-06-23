"""Long-term-hold research layer — file store, schema validation, atomic writes.

The research layer is a **PII-free**, file-based data store that lives beside
the app (default: ``<repo>/research/``). Each ``<domain>.research.json`` holds
a scored universe of securities; ``research.schema.json`` is the contract every
write validates against. No balances or account data ever live here — positions
are joined onto this data at query time (see ``research_join.py``), so the whole
directory is safe to commit to git.

Design notes
------------
* **Validated writes.** Every write is checked against the JSON Schema before
  it touches disk; a bad update can't corrupt the file the viewer reads.
* **Atomic writes.** Writes go to a temp file in the same directory and are
  swapped in with ``os.replace`` — readers never see a half-written file.
* **Version guard.** ``meta.schema_version`` is SemVer; a writer that doesn't
  recognise the major version refuses to write (per the spec's update protocol).
* **History.** Each scoring write appends a row to a sibling
  ``<domain>.history.jsonl`` so trend / thesis-drift charts can accumulate from
  day one, even before the UI plots them.
"""
from __future__ import annotations

import json
import os
import re
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

from jsonschema.validators import Draft202012Validator

from app.config import settings

SCHEMA_FILENAME = "research.schema.json"

# Major schema version this server knows how to write. A writer that doesn't
# recognise the major version must refuse to write (spec §7.2).
SUPPORTED_SCHEMA_MAJOR = 1


# ── Errors ────────────────────────────────────────────────────────────────
class ResearchError(Exception):
    """Base class for research-layer failures."""


class ResearchNotFound(ResearchError):
    """A requested domain file (or the research dir / schema) doesn't exist."""


class ResearchValidationError(ResearchError):
    """A write failed schema validation. Carries a flat list of messages."""

    def __init__(self, message: str, errors: Optional[list[str]] = None):
        super().__init__(message)
        self.errors = errors or []


# ── Paths ─────────────────────────────────────────────────────────────────
def research_dir() -> Path:
    """Resolve the research directory.

    ``settings.RESEARCH_DIR`` wins if set ("~" expanded). Otherwise default to
    the repo-level ``./research`` directory, resolved relative to this file so
    it works regardless of the cwd uvicorn was launched from.
    """
    configured = (settings.RESEARCH_DIR or "").strip()
    if configured:
        return Path(os.path.expanduser(configured)).resolve()
    # services/research_store.py → parents: [0]=services [1]=app [2]=backend [3]=repo root
    return Path(__file__).resolve().parents[3] / "research"


def schema_path() -> Path:
    return research_dir() / SCHEMA_FILENAME


_slug_re = re.compile(r"[^a-z0-9._-]+")


def _slug(domain: str) -> str:
    """Filesystem-safe domain key. 'Critical Minerals' → 'critical-minerals'."""
    s = _slug_re.sub("-", (domain or "").strip().lower()).strip("-.")
    return s or "domain"


def domain_path(domain: str) -> Path:
    return research_dir() / f"{_slug(domain)}.research.json"


def history_path(domain: str) -> Path:
    return research_dir() / f"{_slug(domain)}.history.jsonl"


# ── Schema + validation ───────────────────────────────────────────────────
def load_schema() -> dict[str, Any]:
    p = schema_path()
    if not p.exists():
        raise ResearchNotFound(f"Research schema not found at {p}")
    with open(p, encoding="utf-8") as f:
        return json.load(f)


def _validator() -> Draft202012Validator:
    return Draft202012Validator(load_schema())


def validate(data: dict[str, Any]) -> None:
    """Validate a full research document. Raises ResearchValidationError."""
    errs = sorted(_validator().iter_errors(data), key=lambda e: list(e.path))
    if errs:
        msgs = [
            f"{'/'.join(str(x) for x in e.path) or '<root>'}: {e.message}"
            for e in errs
        ]
        raise ResearchValidationError(f"{len(msgs)} schema violation(s)", msgs)


def _schema_major(version: Any) -> int:
    try:
        return int(str(version).split(".")[0])
    except (ValueError, IndexError):
        return -1


# ── Reads ─────────────────────────────────────────────────────────────────
def list_domains() -> list[str]:
    """Every domain that has a ``*.research.json`` file, by ``meta.domain``."""
    d = research_dir()
    if not d.exists():
        return []
    domains: list[str] = []
    for p in sorted(d.glob("*.research.json")):
        try:
            with open(p, encoding="utf-8") as f:
                data = json.load(f)
        except (OSError, json.JSONDecodeError):
            continue
        dom = (data.get("meta") or {}).get("domain")
        if dom and dom not in domains:
            domains.append(dom)
    return domains


def load_domain(domain: str) -> dict[str, Any]:
    p = domain_path(domain)
    if not p.exists():
        raise ResearchNotFound(f"No research file for domain {domain!r} at {p}")
    with open(p, encoding="utf-8") as f:
        return json.load(f)


# ── Active industry (runtime-switchable focus) ─────────────────────────────
def active_domain_path() -> Path:
    return research_dir() / ".active-domain.json"


def get_active_domain() -> Optional[str]:
    """The currently-focused industry. Runtime file wins (set via the admin
    switcher); falls back to ``settings.ACTIVE_RESEARCH_DOMAIN``; else None.
    Only honored if the named domain actually has a research file."""
    domains = list_domains()
    p = active_domain_path()
    if p.exists():
        try:
            with open(p, encoding="utf-8") as f:
                dom = (json.load(f) or {}).get("domain")
            if dom in domains:
                return dom
        except (OSError, json.JSONDecodeError):
            pass
    env = (settings.ACTIVE_RESEARCH_DOMAIN or "").strip()
    return env if env in domains else None


def set_active_domain(domain: str) -> str:
    """Persist the focused industry (runtime). Raises if it doesn't exist."""
    if domain not in list_domains():
        raise ResearchNotFound(f"No research file for domain {domain!r}")
    _atomic_write(active_domain_path(), {"domain": domain})
    return domain


def get_entity(domain: str, entity_id: str) -> dict[str, Any]:
    data = load_domain(domain)
    for e in data.get("entities", []):
        if e.get("id") == entity_id:
            return e
    raise ResearchNotFound(f"No entity {entity_id!r} in domain {domain!r}")


# ── Atomic write ──────────────────────────────────────────────────────────
def _atomic_write(path: Path, data: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    # Temp file in the *same* directory so os.replace is a same-filesystem
    # atomic rename — readers never observe a torn file.
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), prefix=".tmp-", suffix=".json")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
            f.write("\n")
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _today() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")


def save_domain(
    domain: str,
    data: dict[str, Any],
    updated_by: str = "tuskledger",
) -> dict[str, Any]:
    """Version-check, stamp ``meta``, validate, then atomically write a doc."""
    meta = data.setdefault("meta", {})
    version = meta.get("schema_version", "")
    if _schema_major(version) != SUPPORTED_SCHEMA_MAJOR:
        raise ResearchError(
            f"Refusing to write: schema_version {version!r} major version != "
            f"{SUPPORTED_SCHEMA_MAJOR} (this server only writes "
            f"v{SUPPORTED_SCHEMA_MAJOR}.x files)."
        )
    meta["last_updated"] = _now_iso()
    meta["updated_by"] = updated_by
    validate(data)  # raises before anything touches disk
    _atomic_write(domain_path(domain), data)
    return data


# ── History (append-only snapshots) ───────────────────────────────────────
def append_history(domain: str, entity: dict[str, Any]) -> None:
    """Append a ``{id, as_of, conviction, upside, price, tier}`` snapshot row.

    Never overwrites — pure append, so trend / thesis-drift series accumulate.
    """
    scores = entity.get("scores") or {}
    fundamentals = entity.get("fundamentals") or {}
    row = {
        "id": entity.get("id"),
        "as_of": scores.get("as_of") or _today(),
        "conviction": scores.get("conviction"),
        "upside": scores.get("upside"),
        "price": fundamentals.get("price"),
        "tier": entity.get("tier"),
        "recorded_at": _now_iso(),
    }
    p = history_path(domain)
    p.parent.mkdir(parents=True, exist_ok=True)
    with open(p, "a", encoding="utf-8") as f:
        f.write(json.dumps(row, ensure_ascii=False) + "\n")


def read_history(domain: str) -> list[dict[str, Any]]:
    """All snapshot rows for a domain (sibling JSONL + any in-file snapshots)."""
    rows: list[dict[str, Any]] = []
    p = history_path(domain)
    if p.exists():
        with open(p, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    rows.append(json.loads(line))
                except json.JSONDecodeError:
                    continue
    # Fold in any snapshots embedded in the doc itself (spec allows both).
    try:
        for s in load_domain(domain).get("snapshots", []) or []:
            rows.append(s)
    except ResearchNotFound:
        pass
    return rows


def prices_path(domain: str) -> Path:
    return research_dir() / f"{_slug(domain)}.prices.json"


def load_prices(domain: str) -> dict[str, Any]:
    """Market-price cache: ``{ticker: {history, current, fetched_at, ...}}``.

    Not schema-validated — it's a derived market-data cache, not the research
    truth. Missing/corrupt file → empty dict.
    """
    p = prices_path(domain)
    if not p.exists():
        return {}
    try:
        with open(p, encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


def save_prices(domain: str, data: dict[str, Any]) -> None:
    _atomic_write(prices_path(domain), data)


def signals_path(domain: str) -> Path:
    return research_dir() / f"{_slug(domain)}.signals.json"


def load_signals(domain: str) -> dict[str, Any]:
    """Quiver public-activity cache: ``{ticker: {<signals bundle>}}``.

    Derived alt-data cache, not research truth — not schema-validated.
    """
    p = signals_path(domain)
    if not p.exists():
        return {}
    try:
        with open(p, encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


def save_signals(domain: str, data: dict[str, Any]) -> None:
    _atomic_write(signals_path(domain), data)


def edgar_path(domain: str) -> Path:
    return research_dir() / f"{_slug(domain)}.edgar.json"


def load_edgar(domain: str) -> dict[str, Any]:
    """SEC EDGAR filing-activity cache: ``{ticker: {<edgar bundle>}}``.

    Derived public-filing cache, not research truth — not schema-validated.
    """
    p = edgar_path(domain)
    if not p.exists():
        return {}
    try:
        with open(p, encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


def save_edgar(domain: str, data: dict[str, Any]) -> None:
    _atomic_write(edgar_path(domain), data)


def rotation_path(domain: str) -> Path:
    return research_dir() / f"{_slug(domain)}.rotation.jsonl"


def append_rotation(domain: str, row: dict[str, Any]) -> None:
    """Append one sector-rotation snapshot (append-only time series)."""
    p = rotation_path(domain)
    p.parent.mkdir(parents=True, exist_ok=True)
    with open(p, "a", encoding="utf-8") as f:
        f.write(json.dumps(row, ensure_ascii=False) + "\n")


def read_rotation(domain: str) -> list[dict[str, Any]]:
    p = rotation_path(domain)
    if not p.exists():
        return []
    rows: list[dict[str, Any]] = []
    with open(p, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    return rows


def record_snapshots(domain: str) -> int:
    """Append a current-state snapshot row for every entity in a domain.

    Gives the thesis-drift chart a steady heartbeat: called once per day by
    the scheduled job, the conviction/upside trend accumulates even when no
    score changed (unlike append_history, which only fires on score writes).
    Returns the number of rows appended.
    """
    data = load_domain(domain)
    n = 0
    for e in data.get("entities", []):
        append_history(domain, e)
        n += 1
    return n


# ── Writes: upsert + targeted field update ────────────────────────────────
def upsert_entity(
    domain: str,
    entity: dict[str, Any],
    updated_by: str = "tuskledger",
) -> dict[str, Any]:
    """Insert or shallow-merge one entity, validate the whole doc, then write.

    Match is by ``id`` (falling back to ``ticker`` when ``id`` is absent on the
    incoming partial). A snapshot row is appended so scoring history accrues.
    """
    if not isinstance(entity, dict):
        raise ResearchValidationError("entity must be an object", ["entity not an object"])
    eid = entity.get("id") or entity.get("ticker")
    if not eid:
        raise ResearchValidationError(
            "entity needs an 'id' or 'ticker'", ["entity.id / entity.ticker missing"]
        )

    data = load_domain(domain)
    meta_domain = (data.get("meta") or {}).get("domain", domain)

    incoming = dict(entity)
    incoming.setdefault("id", eid)
    incoming.setdefault("ticker", eid)
    incoming.setdefault("domain", meta_domain)
    incoming["updated_by"] = updated_by
    incoming["updated_at"] = _today()

    entities = data.setdefault("entities", [])
    merged = incoming
    for i, e in enumerate(entities):
        if e.get("id") == incoming["id"]:
            merged = {**e, **incoming}  # shallow merge: incoming keys win
            entities[i] = merged
            break
    else:
        entities.append(merged)

    save_domain(domain, data, updated_by=updated_by)
    append_history(domain, merged)
    return merged


def remove_entity(
    domain: str,
    entity_id: str,
    updated_by: str = "tuskledger",
) -> dict[str, Any]:
    """Drop one entity from a domain (matched by ``id``, falling back to ``ticker``), then
    re-validate + atomically write. Returns ``{removed, id, ticker, remaining}``.

    The inverse of :func:`upsert_entity`, for the universe-review "approve a drop" path —
    a name that's fallen out of every theme ETF and is weak/stale. No history row is
    appended (the entity is gone); the snapshot heartbeat simply stops covering it.
    """
    data = load_domain(domain)
    entities = data.get("entities", []) or []
    key = (entity_id or "").strip()
    if not key:
        raise ResearchValidationError("entity id/ticker required", ["empty id"])
    idx = next(
        (i for i, e in enumerate(entities)
         if e.get("id") == key or (e.get("ticker") or "").upper() == key.upper()),
        None,
    )
    if idx is None:
        raise ResearchNotFound(f"No entity {entity_id!r} in domain {domain!r}")
    removed = entities.pop(idx)
    save_domain(domain, data, updated_by=updated_by)
    return {
        "removed": True,
        "id": removed.get("id"),
        "ticker": removed.get("ticker"),
        "remaining": len(entities),
    }


def upsert_entities(
    domain: str,
    entities: list[dict[str, Any]],
    updated_by: str = "tuskledger",
) -> dict[str, Any]:
    """Insert/merge MANY entities in a single load → validate → atomic write (vs. one file
    rewrite per name in a loop of :func:`upsert_entity`). Used by the universe-review "approve
    all" path. Match is by ``id`` (falling back to ``ticker``); incoming keys win on merge.
    Returns ``{written: [ids], count, total}``. A history row is appended per entity."""
    if not entities:
        return {"written": [], "count": 0, "total": len(load_domain(domain).get("entities", []) or [])}
    data = load_domain(domain)
    meta_domain = (data.get("meta") or {}).get("domain", domain)
    rows = data.setdefault("entities", [])
    by_id = {e.get("id"): i for i, e in enumerate(rows) if e.get("id")}
    written: list[dict[str, Any]] = []
    for entity in entities:
        if not isinstance(entity, dict):
            raise ResearchValidationError("entity must be an object", ["entity not an object"])
        eid = entity.get("id") or entity.get("ticker")
        if not eid:
            raise ResearchValidationError("entity needs an 'id' or 'ticker'",
                                          ["entity.id / entity.ticker missing"])
        incoming = dict(entity)
        incoming.setdefault("id", eid)
        incoming.setdefault("ticker", eid)
        incoming.setdefault("domain", meta_domain)
        incoming["updated_by"] = updated_by
        incoming["updated_at"] = _today()
        if incoming["id"] in by_id:
            i = by_id[incoming["id"]]
            merged = {**rows[i], **incoming}
            rows[i] = merged
        else:
            by_id[incoming["id"]] = len(rows)
            rows.append(incoming)
            merged = incoming
        written.append(merged)
    save_domain(domain, data, updated_by=updated_by)  # one validate + one atomic write
    for m in written:
        append_history(domain, m)
    return {"written": [m.get("id") for m in written], "count": len(written), "total": len(rows)}


def remove_entities(
    domain: str,
    ids: list[str],
    updated_by: str = "tuskledger",
) -> dict[str, Any]:
    """Drop MANY entities in a single load → validate → atomic write (matched by ``id`` or
    ``ticker``). Returns ``{removed: [ids], count, remaining}``. Unknown ids are skipped."""
    data = load_domain(domain)
    rows = data.get("entities", []) or []
    want = {(x or "").strip().upper() for x in (ids or []) if (x or "").strip()}
    if not want:
        return {"removed": [], "count": 0, "remaining": len(rows)}
    kept: list[dict[str, Any]] = []
    removed: list[str] = []
    for e in rows:
        if (e.get("id") or "").upper() in want or (e.get("ticker") or "").upper() in want:
            removed.append(e.get("id"))
        else:
            kept.append(e)
    if removed:
        data["entities"] = kept
        save_domain(domain, data, updated_by=updated_by)
    return {"removed": removed, "count": len(removed), "remaining": len(kept)}


# ── Universe-review decisions (reject persistence) ─────────────────────────
def universe_decisions_path(domain: str) -> Path:
    return research_dir() / f"{_slug(domain)}.universe-decisions.json"


def load_universe_decisions(domain: str) -> dict[str, Any]:
    """Persisted user decisions on the universe-review queue so a *rejected* candidate
    doesn't keep reappearing each week. Two maps keyed by TICKER:

    * ``ignored`` — add-candidates the user dismissed (filtered out of future ``add``/
      ``add_edgar``); ``kept`` — drop-candidates the user chose to keep (filtered out of
      future ``drop``). Each value is ``{reason, at}``. Not schema-validated — a small
      sidecar control file, like the signals/edgar caches. Missing/corrupt → empty maps.
    """
    p = universe_decisions_path(domain)
    base = {"ignored": {}, "kept": {}}
    if not p.exists():
        return base
    try:
        with open(p, encoding="utf-8") as f:
            data = json.load(f)
        if not isinstance(data, dict):
            return base
        return {"ignored": dict(data.get("ignored") or {}), "kept": dict(data.get("kept") or {})}
    except (OSError, json.JSONDecodeError):
        return base


def save_universe_decisions(domain: str, data: dict[str, Any]) -> None:
    _atomic_write(universe_decisions_path(domain),
                  {"ignored": dict(data.get("ignored") or {}), "kept": dict(data.get("kept") or {})})


def record_universe_decision(
    domain: str, ticker: str, bucket: str, *, reason: str = "", restore: bool = False,
) -> dict[str, Any]:
    """Add (or, with ``restore``, remove) a TICKER in the ``ignored`` or ``kept`` map.
    Returns the updated decisions document."""
    if bucket not in ("ignored", "kept"):
        raise ResearchValidationError(f"bad bucket {bucket!r}", ["bucket must be ignored|kept"])
    tk = (ticker or "").strip().upper()
    if not tk:
        raise ResearchValidationError("ticker required", ["empty ticker"])
    dec = load_universe_decisions(domain)
    if restore:
        dec[bucket].pop(tk, None)
    else:
        dec[bucket][tk] = {"reason": reason or "", "at": _now_iso()}
    save_universe_decisions(domain, dec)
    return dec


_index_re = re.compile(r"^(.*?)\[(\d+)\]$")


def _set_path(obj: dict[str, Any], path: str, value: Any) -> None:
    """Set a dotted path, e.g. ``scores.conviction`` or ``catalysts[0].status``.

    Intermediate objects are created as needed; list indices must already
    exist (we don't grow lists implicitly — that should go through upsert).
    """
    parts = [p for p in path.split(".") if p != ""]
    if not parts:
        raise ResearchValidationError("empty path", ["path is empty"])
    cur: Any = obj
    for part in parts[:-1]:
        m = _index_re.match(part)
        if m:
            key, idx = m.group(1), int(m.group(2))
            cur = cur.setdefault(key, []) if key else cur
            if not isinstance(cur, list) or idx >= len(cur):
                raise ResearchValidationError(
                    f"list index out of range at {part!r}", [f"bad index {part}"]
                )
            cur = cur[idx]
        else:
            nxt = cur.get(part)
            if not isinstance(nxt, dict):
                nxt = {}
                cur[part] = nxt
            cur = nxt
    last = parts[-1]
    m = _index_re.match(last)
    if m:
        key, idx = m.group(1), int(m.group(2))
        target = cur.get(key) if key else cur
        if not isinstance(target, list) or idx >= len(target):
            raise ResearchValidationError(
                f"list index out of range at {last!r}", [f"bad index {last}"]
            )
        target[idx] = value
    else:
        cur[last] = value


def update_field(
    domain: str,
    entity_id: str,
    path: str,
    value: Any,
    updated_by: str = "tuskledger",
) -> dict[str, Any]:
    """Set a single field on one entity, validate the doc, then write."""
    data = load_domain(domain)
    ent = next((e for e in data.get("entities", []) if e.get("id") == entity_id), None)
    if ent is None:
        raise ResearchNotFound(f"No entity {entity_id!r} in domain {domain!r}")
    _set_path(ent, path, value)
    ent["updated_by"] = updated_by
    ent["updated_at"] = _today()
    save_domain(domain, data, updated_by=updated_by)
    if path.startswith("scores"):
        append_history(domain, ent)
    return ent
