# Tusk Ledger — Audit Loop Prompt

Paste this into a Claude session (or reference it: "run AUDIT_LOOP.md") to run one full
audit→propose→approve→fix cycle. Re-run it any time; each pass builds on the last via AUDIT_LOG.md.

---

## Prompt

Run one iteration of the Tusk Ledger audit loop:

1. **Recon** — Read `AUDIT_LOG.md` (repo root) if it exists to see what previous passes found
   and fixed. Skip anything already fixed or explicitly deferred by Eduardo.

2. **Audit (read-only)** — Fan out parallel subagents over these areas, top-down
   (architecture → module → function). Look for: security issues, correctness bugs, data-integrity
   risks, N+1 / performance problems, error-handling gaps, dead code, and duplication.
   - `backend/app` (routers, services, models, agent_trading)
   - `frontend/src` (components, pages, hooks, api)
   - `mobile/` (src, App.tsx — see constraints below)
   - `tuskledger-mcp/`, `tuskledger-site/`, `research/`, shell scripts

3. **Propose** — Compile findings into a numbered, prioritized list (P0 security/data-loss →
   P1 correctness → P2 performance → P3 cleanup). For each: file:line, what's wrong, proposed fix,
   and blast radius. **Make NO changes yet.** Present the list and wait for Eduardo's approval.

4. **Fix** — Apply only the approved items. Run existing tests (`backend/tests`, frontend
   `*.test.jsx`) after changes. Commit from the sandbox is OK but never push, and remind Eduardo
   to `rm .git/index.lock` afterward.

5. **Log** — Append to `AUDIT_LOG.md`: date, findings proposed, approved/rejected/deferred,
   fixes applied, test results. This is the loop's memory.

## Standing constraints (do NOT flag these)

- `DEV_BYPASS_AUTH=true` in production is accepted by Eduardo — don't re-pitch auth/MFA.
- Mobile phone path is read-only by design ("Switch to edit mode" is the only opt-in).
- Load-bearing mobile quirks: `enableScreens(false)`, daemon-thread Bonjour, `get_real_db`
  token auth, manual_assets/investment fold-in. Don't "fix" these.
- FAB/Ask bottom-right proximity fade + pointer-events behavior is intentional.
- Claude never places trades; approval-queue model is locked.
- Demo deploy uses `DEMO_LOCKED`; don't weaken it.
- Prefer help text/inline annotation over refactors for ambiguous-but-working UI.
