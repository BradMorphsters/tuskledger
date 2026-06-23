"""'Ask Tusk' — a read-only, data-grounded insight assistant (the brain behind the voice UI).

Free-form questions about the owner's finances, answered by the local LLM over a snapshot that
the PYTHON side computes (net worth, spending, portfolio, top merchants, and the research read on
tracked securities). Read-only and insight-only by construction: it is wired ONLY to read
builders, never takes an action, and never invents a figure — every number comes from a Python
handler (same no-hallucination contract as the Ask panel + the research synthesis). Degrades to a
deterministic summary when the local model is off/unreachable.
"""
from __future__ import annotations

import json
from datetime import date
from typing import Optional

from app.config import settings
from app.services.llm_ollama import LLMUnavailable, OllamaClient

from app.services import assistant_persona as persona

_SYSTEM = persona.system("""You are handed a JSON `snapshot` of PRE-COMPUTED facts (net worth,
spending, portfolio, top merchants, and a research read on the user's tracked securities, including
any alerts and congressional/insider activity). Answer the user's question using ONLY numbers,
tickers, and names present in the snapshot. If the snapshot lacks what's needed, say so plainly and
suggest which tab to open. If data_freshness shows stale prices, briefly note the figures may lag.""")

# Read-only builders this assistant may call — by construction there is NO write path here.
_INTENTS = ("net_worth_change", "spending_total", "portfolio_status", "top_merchants")


def gather_snapshot(db, *, today: Optional[date] = None) -> dict:
    """Assemble the read-only grounding snapshot from existing Python builders. Each piece is
    best-effort — a failing builder is skipped, never fatal."""
    snap: dict = {}
    from app.services import chat_prompts as cp

    def _bundle(pid: str):
        hs = cp.known_horizon_ids(pid)
        hz = sorted(hs)[0] if hs else None
        return cp.build_bundle(db, pid, hz) if hz else None

    for pid in _INTENTS:
        try:
            b = _bundle(pid)
            if b is not None:
                snap[pid] = b
        except Exception:  # noqa: BLE001
            pass

    try:  # research read on tracked securities (active domain) — reuses the synthesis bundle
        from app.services import research_store as rs, research_synthesis as rsyn
        dom = rs.get_active_domain() or (rs.list_domains() or [None])[0]
        if dom:
            b = rsyn.build_synthesis_bundle(db, dom)
            snap["research"] = {
                "domain": dom, "portfolio": b.get("portfolio"), "alerts": b.get("alerts"),
                "sector": b.get("sector"), "names_to_watch": b.get("names_to_watch"),
                "political_flow": b.get("political_flow"), "data_freshness": b.get("data_freshness"),
            }
    except Exception:  # noqa: BLE001
        pass
    return snap


def _num(b, *path, default=None):
    cur = b
    for k in path:
        if not isinstance(cur, dict):
            return default
        cur = cur.get(k)
    return cur if cur is not None else default


def _template(question: str, snap: dict) -> str:
    """Deterministic, non-AI answer when the local model is off — a plain read of the snapshot."""
    bits: list[str] = []
    nw = snap.get("net_worth_change") or {}
    if nw.get("net_worth") is not None or nw.get("current") is not None:
        val = nw.get("net_worth", nw.get("current"))
        chg = nw.get("change") or nw.get("delta")
        bits.append(f"Net worth is about ${float(val):,.0f}" + (f" ({'+' if (chg or 0) >= 0 else ''}{float(chg):,.0f} over the window)" if chg is not None else "") + ".")
    sp = snap.get("spending_total") or {}
    if sp.get("total") is not None or sp.get("spending") is not None:
        bits.append(f"Spending in the window is about ${float(sp.get('total', sp.get('spending'))):,.0f}.")
    res = snap.get("research") or {}
    al = (res.get("alerts") or [])
    highs = [a for a in al if a.get("severity") == "high"]
    if highs:
        bits.append(f"Top research flag: {highs[0].get('message')}")
    if not bits:
        bits.append("I don't have that in the current snapshot — try the Dashboard or Research tab.")
    bits.append("(Local model is off — this is a plain read of your numbers.)")
    return " ".join(bits)


def _user_prompt(question: str, snap: dict, history: Optional[list] = None) -> str:
    """The grounded user message: recent turns (for multi-turn follow-ups) + question + snapshot."""
    parts: list[str] = []
    if history:
        convo = "\n".join(f"{'You' if (t or {}).get('who') == 'you' else 'Tusk'}: {(t or {}).get('text', '')}"
                          for t in history[-6:] if (t or {}).get('text'))
        if convo.strip():
            parts.append("recent conversation (for context on follow-ups):\n" + convo)
    parts.append(f"Question: {question}")
    parts.append("snapshot:\n" + json.dumps(snap, indent=2, default=str))
    return "\n\n".join(parts)


def prepare(db, question: str, history: Optional[list] = None) -> tuple:
    """For the streaming endpoint: (system, user_prompt, snapshot). Snapshot built once in Python."""
    snap = gather_snapshot(db)
    return _SYSTEM, _user_prompt(question, snap, history), snap


_BRIEF_SYSTEM = persona.system("""You're greeting the owner with a short proactive read of their
finances. You're handed an already-computed plain-text read plus the JSON snapshot it came from.
Rephrase it as ONE warm, natural spoken greeting of 1–3 short sentences. Keep every number and name
EXACTLY as given; invent nothing.""")


def _briefing_text(snap: dict) -> str:
    """Deterministic proactive read from the snapshot — the source of truth the LLM only rephrases."""
    bits: list[str] = []
    nw = snap.get("net_worth_change") or {}
    val = nw.get("latest_net_worth_dollars")
    if val is not None and not nw.get("no_data"):
        s = f"Net worth is about ${float(val):,.0f}"
        chg = nw.get("change_dollars")
        if chg is not None and not nw.get("change_unreliable"):
            s += f", {'up' if float(chg) >= 0 else 'down'} ${abs(float(chg)):,.0f} {nw.get('horizon_label', 'recently')}"
        bits.append(s + ".")
    sp = snap.get("spending_total") or {}
    spv = sp.get("total_spent_dollars")
    if spv is not None and not sp.get("no_data"):
        bits.append(f"You've spent about ${float(spv):,.0f} {sp.get('horizon_label', 'lately')}.")
    res = snap.get("research") or {}
    highs = [a for a in (res.get("alerts") or []) if a.get("severity") == "high"]
    if highs:
        bits.append(f"Heads up: {highs[0].get('message')}")
    fr = res.get("data_freshness") or {}
    if fr.get("stale") or fr.get("any_stale"):
        bits.append("A few prices look stale, so some figures may lag.")
    if not bits:
        bits.append("I don't have much in your snapshot yet — connect accounts or open the Dashboard to get started.")
    return " ".join(bits)


def briefing(db) -> dict:
    """A short, proactive 'morning read' (read-only). Returns ``{source, briefing, snapshot}``.
    Deterministic text is the ground truth; the local model only rephrases it. Never raises."""
    snap = gather_snapshot(db)
    base = _briefing_text(snap)
    if not settings.LLM_ENABLED:
        return {"source": "template", "briefing": base, "snapshot": snap}
    try:
        client = OllamaClient(base_url=settings.LLM_URL, model=settings.LLM_MODEL)
        if not client.health():
            return {"source": "template", "briefing": base, "snapshot": snap}
        user = ("Today's read (already computed — rephrase as a warm 1–3 sentence spoken greeting, "
                "keep every number EXACTLY, add no new figures):\n" + base
                + "\n\nsnapshot:\n" + json.dumps(snap, indent=2, default=str))
        text = client.complete(_BRIEF_SYSTEM, user)
    except (LLMUnavailable, Exception):  # noqa: BLE001
        return {"source": "template", "briefing": base, "snapshot": snap}
    return {"source": "ollama", "briefing": text or base, "snapshot": snap}


def answer(db, question: str, history: Optional[list] = None) -> dict:
    """Answer a free-form question via the retrieve-then-narrate brain (assistant_retrieval): route
    the question to a deterministic query, answer from the retrieved rows, and only let the model
    narrate when every figure it states is grounded (else refuse). Returns
    ``{source, answer, intent, window, rows, found, grounded}``. Never raises on a data/LLM gap."""
    from app.services import assistant_retrieval as ret
    try:
        return ret.answer(db, question, history)
    except Exception:  # noqa: BLE001 — last-resort: a data gap must never 500
        snap = gather_snapshot(db)
        return {"source": "template", "answer": _template(question, snap), "snapshot": snap,
                "rows": [], "found": False, "grounded": True}
