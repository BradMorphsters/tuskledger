"""Thumbs-up / thumbs-down feedback loop for Ask Tusk — capture, diagnose, correct (on approval).

A down-thumb captures the question + the answer + the retrieval metadata, then DIAGNOSES why the
answer may be wrong:

  * mis_route       — the question maps better to a different retriever (the model judges this, or
                      the user picks the right one); we re-run that retriever to produce a grounded
                      corrected answer.
  * coverage_gap    — nothing in the catalog fits; logged as a coverage request (no auto-fix).
  * grounded_review — the answer came straight from a retriever and is grounded; if a figure looks
                      wrong it's a data/sync issue, not a routing one.

The proposed correction is queued; the user APPROVES it. An approved correction writes a learned
routing override (normalized question → intent) that ``answer()`` consults first, so questions like
it route correctly from then on.

Safe by construction: a correction only changes WHICH retriever answers — every number still comes
from the deterministic retriever, never the model. Nothing here ever takes an action.
"""
from __future__ import annotations

import json
import os
import re
import tempfile
import threading
import time
import uuid
from pathlib import Path
from typing import Optional

from app.config import settings

_OV_CACHE: Optional[dict] = None

# One lock for every read-modify-write on the JSON stores below. Without it,
# concurrent requests (a 👎 landing while an approval is in flight) clobber
# each other's writes; and a plain write_text() torn by a crash leaves a
# half-written file that _load_*() silently turns into {} — losing every
# pending feedback record / learned override.
_STORE_LOCK = threading.RLock()


def _atomic_write_json(path: Path, data: dict) -> None:
    """Same-directory tmp file + os.replace, so readers never see a torn file
    (mirrors research_store._atomic_write)."""
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), prefix=".tmp-", suffix=".json")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


# ── storage ──────────────────────────────────────────────────────────────
def _dir() -> Path:
    configured = (getattr(settings, "ASSISTANT_FEEDBACK_DIR", "") or "").strip()
    base = (Path(os.path.expanduser(configured)).resolve() if configured
            else Path(__file__).resolve().parents[2] / "var" / "assistant_feedback")
    base.mkdir(parents=True, exist_ok=True)
    return base


def _events_path() -> Path:
    return _dir() / "events.jsonl"


def _open_path() -> Path:
    return _dir() / "open.json"


def _overrides_path() -> Path:
    return _dir() / "overrides.json"


def _normalize(q: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"[^a-z0-9 ]+", " ", (q or "").lower())).strip()


def _append_event(ev: dict) -> None:
    with _STORE_LOCK, _events_path().open("a") as f:
        f.write(json.dumps(ev) + "\n")


def _load_open() -> dict:
    p = _open_path()
    if p.exists():
        try:
            return json.loads(p.read_text())
        except Exception:  # noqa: BLE001
            return {}
    return {}


def _write_open(d: dict) -> None:
    _atomic_write_json(_open_path(), d)


def _save_open(fid: str, rec: dict) -> None:
    with _STORE_LOCK:
        d = _load_open()
        d[fid] = rec
        _write_open(d)


def _load_overrides() -> dict:
    p = _overrides_path()
    if p.exists():
        try:
            return json.loads(p.read_text())
        except Exception:  # noqa: BLE001
            return {}
    return {}


def _save_overrides(ov: dict) -> None:
    global _OV_CACHE
    with _STORE_LOCK:
        _atomic_write_json(_overrides_path(), ov)
        _OV_CACHE = ov


def reset_cache() -> None:
    """Tests / hot-reload: force the override cache to reload from disk next lookup."""
    global _OV_CACHE
    _OV_CACHE = None


def learned_override(question: str) -> Optional[str]:
    """The approved intent for a question like this, or None. Consulted by ``answer()`` first."""
    global _OV_CACHE
    if _OV_CACHE is None:
        _OV_CACHE = _load_overrides()
    return _OV_CACHE.get(_normalize(question))


# ── intent catalog (for the correction picker) ──────────────────────────
def intents() -> list[dict]:
    from app.services import assistant_retrieval as R
    out = []
    for name, fn in R.RETRIEVERS.items():
        doc = (fn.__doc__ or "").strip().split("\n")[0].strip()
        out.append({"intent": name, "description": (doc or name.replace("_", " "))[:120]})
    return sorted(out, key=lambda x: x["intent"])


# ── run one retriever to produce a grounded (corrected) answer ──────────
def _run_intent(db, intent: str, question: str, today=None) -> Optional[dict]:
    from app.services import assistant_retrieval as R
    fn = R.RETRIEVERS.get(intent)
    if not fn:
        return None
    start, end, label = R.parse_window(question, today)
    try:
        r = fn(db, start, end, label, question)
    except Exception:  # noqa: BLE001
        return None
    r["intent"] = intent
    r["source"] = "retrieval"
    if r.get("found"):
        r["answer"] = R._maybe_rephrase(question, r["answer"], r.get("facts") or [])
    return r


_JUDGE_SYSTEM = """You triage feedback for a read-only finance assistant. You are given a user
QUESTION, the ANSWER that was given, and a CATALOG of intents (each is one thing the assistant can
answer). Decide ONE of:
- reply "OK" if the answer reasonably addresses the question;
- reply with the single best catalog intent NAME if the question should have used a different one;
- reply "GAP" if nothing in the catalog fits.
Reply with exactly one token and nothing else."""


def _llm_suggest_intent(question: str, answer_text: str) -> Optional[str]:
    if not settings.LLM_ENABLED:
        return None
    try:
        from app.services.llm_ollama import OllamaClient
        client = OllamaClient(base_url=settings.LLM_URL, model=settings.LLM_MODEL)
        if not client.health():
            return None
        catalog = "\n".join(f"- {d['intent']}: {d['description']}" for d in intents())
        user = f"QUESTION: {question}\nANSWER: {answer_text}\n\nCATALOG:\n{catalog}"
        tok = (client.complete(_JUDGE_SYSTEM, user) or "").strip().split()
        return tok[0].strip(".,:'\"") if tok else None
    except Exception:  # noqa: BLE001
        return None


def analyze(db, question: str, answer_text: str, intent: Optional[str]) -> dict:
    """Diagnose a down-thumb. Returns ``{type, used_intent, natural_route, suggested_intent?,
    suggested_answer?, suggested_rows?, note?}``. Never raises."""
    from app.services import assistant_retrieval as R
    diag = {"used_intent": intent, "natural_route": R.route(question)}
    refusal = (intent is None) or (intent not in R.RETRIEVERS)

    suggested = _llm_suggest_intent(question, answer_text)
    if suggested in R.RETRIEVERS and suggested != intent:
        corr = _run_intent(db, suggested, question)
        if corr and corr.get("found"):
            diag.update(type="mis_route", suggested_intent=suggested,
                        suggested_answer=corr["answer"], suggested_rows=corr.get("rows"))
            return diag

    if suggested == "GAP" or refusal:
        diag.update(type="coverage_gap",
                    note="No retriever fits this yet — logged as a coverage request.")
        return diag

    diag.update(type="grounded_review",
                note=(f"This came straight from your data via the '{intent}' read, so the figures are "
                      "real. If one looks off it's likely a stale/unsynced account. If I picked the "
                      "wrong read, tell me which one below and I'll learn it."))
    return diag


# ── public API ───────────────────────────────────────────────────────────
def record(db, question: str, answer_text: str, rating: str,
           intent: Optional[str] = None, rows=None, comment: Optional[str] = None) -> dict:
    """Log a thumbs up/down. For a down-thumb, diagnose + (if possible) propose a grounded correction
    and open it for approval. Returns ``{feedback_id, rating, diagnosis?}``."""
    fid = uuid.uuid4().hex[:12]
    ev = {"id": fid, "ts": time.time(), "event": "feedback", "rating": rating,
          "question": question, "answer": answer_text, "intent": intent, "comment": comment}
    _append_event(ev)
    out = {"feedback_id": fid, "rating": rating}
    if rating == "down":
        diag = analyze(db, question, answer_text, intent)
        rec = {"id": fid, "ts": ev["ts"], "status": "open", "question": question,
               "answer": answer_text, "intent": intent, "comment": comment, **diag}
        _save_open(fid, rec)
        out["diagnosis"] = diag
    return out


def correct(db, fid: str, hint: str) -> Optional[dict]:
    """User says, in plain language, what they meant ("my biggest debt") OR names an intent. We route
    the hint to a retriever (keyword router → LLM router) and re-answer the ORIGINAL question with it,
    grounded. Returns a preview; approving learns the override on the original question."""
    from app.services import assistant_retrieval as R
    d = _load_open()
    rec = d.get(fid)
    if not rec:
        return None
    intent = hint if hint in R.RETRIEVERS else (R.route(hint) or R._llm_route(hint))
    if not intent or intent not in R.RETRIEVERS:
        return {"error": "I couldn't map that to something I can read — try naming a metric, e.g. 'my biggest debt' or 'checking balance'."}
    corr = _run_intent(db, intent, rec["question"])
    rec["suggested_intent"] = intent
    rec["suggested_answer"] = corr.get("answer") if corr else None
    rec["suggested_rows"] = corr.get("rows") if corr else None
    rec["type"] = "mis_route"
    _save_open(fid, rec)
    return {"intent": intent, "preview": rec["suggested_answer"], "rows": rec.get("suggested_rows")}


def approve(fid: str) -> Optional[dict]:
    """Approve a correction → write the learned routing override + resolve the item."""
    with _STORE_LOCK:  # RLock — whole approve is one atomic RMW across both stores
        d = _load_open()
        rec = d.get(fid)
        if not rec:
            return None
        applied = None
        si = rec.get("suggested_intent")
        if si:
            ov = _load_overrides()
            ov[_normalize(rec["question"])] = si
            _save_overrides(ov)
            applied = si
        _append_event({"id": fid, "ts": time.time(), "event": "approved", "applied_intent": applied})
        del d[fid]
        _write_open(d)
    return {"applied_intent": applied}


def reject(fid: str) -> Optional[dict]:
    with _STORE_LOCK:
        d = _load_open()
        if fid not in d:
            return None
        _append_event({"id": fid, "ts": time.time(), "event": "rejected"})
        del d[fid]
        _write_open(d)
    return {"ok": True}


def pending() -> list[dict]:
    return sorted(_load_open().values(), key=lambda r: -r.get("ts", 0))
