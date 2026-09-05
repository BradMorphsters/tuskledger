# Tusk Ledger — Improvement Loop Prompt ("best in class")

Paste this into a Claude session, or just say **"run IMPROVE_LOOP.md"** / "run the improve loop",
to execute one pass. Each pass moves the app measurably toward best-in-class on ONE dimension,
ships it, and records the score so the next pass starts from evidence instead of opinion.

This loop is the sibling of `AUDIT_LOOP.md`. That one hunts defects (security, correctness,
perf bugs). This one raises the ceiling: trust, insight, speed, polish, completeness. If a pass
turns up a real bug, fix it if it's in the path — otherwise hand it to the audit loop's log.

---

## Prompt

Run one iteration of the Tusk Ledger improvement loop.

### 0. Recon (read-only, ~5 min)

- Read `IMPROVE_LOG.md` (repo root). It holds the **scorecard** from the last pass, what
  shipped, what Eduardo deferred or rejected, and the seed backlog. Never re-propose a
  rejected item; treat "deferred" as available only if its blocker is gone.
- Skim `AUDIT_LOG.md` (last pass only) and `git log --oneline -20` so you don't rebuild
  something that landed last week.
- Re-read the four **design pillars** in `AGENTS.md` ("What this project is"). Every proposal
  must survive them: local-first, single-user, single maintainer, tax math is load-bearing.
- Load the standing constraints (bottom of this file). Anything there is settled — don't
  spend a proposal on it.

### 1. Ground truth — use the app, don't just read it

Best-in-class is judged by what a person sees, so look at what the person sees:

- **Real data, read-only.** Open `backend/tuskledger.db` with
  `sqlite3.connect('file:backend/tuskledger.db?immutable=1', uri=True)` (never write; the
  mount refuses SQLite writes anyway). Pull the numbers each page would show for the current
  month, last 30/90 days, YTD. Ask of every headline figure: *would Eduardo trust this number
  without checking it against the bank?* Wrong-but-plausible numbers are the #1 thing that
  kills a finance app.
  **Privacy rule:** this repo is public on GitHub. Real balances, income amounts, employer
  names, account names/masks and raw bank descriptors from the DB may appear in the chat with
  Eduardo, but NEVER in `IMPROVE_LOG.md`, code comments, tests, or commit messages. In the
  log, refer to transaction/account **ids**, relative deltas (%, row counts) and generic
  descriptions ("a payroll deposit", "a CC autopay credit"). Personal ground-truth that the
  next pass needs goes to project memory, not the repo.
- **Walk the pages** — Dashboard, Transactions, Spending & Income, Cash Flow, Net Worth,
  Budgets, Investments, Loans, Goals, Insights, and the mobile app. If the frontend is
  reachable (Chrome tools or the built-in browser against `localhost:3000`), screenshot each
  page at desktop and mobile widths. If not, read the JSX and reconstruct the render honestly.
  For each page write one line: *the question this page answers, and whether it answers it in
  under five seconds.*
- **Measure, don't vibe.** Time the slowest API calls (`/analytics/*`, `/transactions/totals`)
  against the real DB. Count rows a page fetches vs. rows it displays. Note any chart whose
  data occupies < 25% of its plot area, any table with > 50 rows and no summary line, any
  action that takes > 2 clicks when peers do it in 1.

### 2. Score the rubric

Score each dimension 1–5 against the best product in its class, not against last pass.
Anchors: **1** = missing or misleading · **3** = works, a power user copes · **5** = the
reference implementation; a Monarch/Copilot/YNAB user would not miss anything. Reference
set for "best in class": Monarch Money, Copilot Money, YNAB (workflow), Lunch Money and
Actual Budget (local-first, open-source peers), Firefly III (self-hosted feature breadth),
Empower (net worth + investments). Cite the specific peer behaviour you're scoring against.

| # | Dimension | What 5 looks like |
|---|---|---|
| D1 | **Data trust** | Transfers, refunds, CC payments, duplicates and pending never leak into income/spend. Every headline number is reconcilable to a drill-down that adds up to it. Categorization is right ≥ 95% without manual fixes. |
| D2 | **Insight density** | Each page answers its question at a glance: change is visible (axis fitted, deltas vs. prior period, pace vs. budget), outliers are called out, and nothing needs a second click to be understood. |
| D3 | **Speed** | Every page paints usable content < 500 ms on the real DB; no request > 300 ms; no refetch storms; skeletons not spinners. |
| D4 | **Polish & consistency** | One visual grammar across pages (spacing, type scale, empty/loading/error states, number formatting, color semantics). Mobile widths work. No dead ends. |
| D5 | **Workflow completeness** | The recurring jobs a person actually does — review new transactions, fix a category, set/adjust a budget, mark a transfer, split, add a manual asset, export — each ≤ 2 clicks with keyboard support, bulk ops, and undo. Rules learn from fixes. |
| D6 | **Reliability & recovery** | Sync failures are visible and explain themselves; backups are automatic, verified, and restorable in one command; data survives a bad migration. |
| D7 | **First-run & OSS on-ramp** | A stranger goes from `git clone` to a populated dashboard (demo or Plaid) in < 10 minutes; README, `doctor`, and error messages carry them there. |
| D8 | **Financial correctness** | Tax, retirement, loan and net-worth math match IRS/actuarial references and have tests that pin them. Sign conventions are documented and enforced in one place. |
| D9 | **Accessibility** | Keyboard reaches everything; focus is visible; contrast passes AA; charts have text equivalents; screen-reader labels on controls and amounts. |
| D10 | **Assistant quality** | Ask Tusk answers grounded, cites the retriever, says "I don't have that" instead of inventing, and the 👎 loop measurably reduces repeat misses. |

Write the score, the one-sentence reason, and the single highest-leverage gap for each.
A dimension you didn't actually examine this pass keeps its previous score, marked *(carried)*.

### 3. Pick ONE theme

Choose the dimension where **(5 − score) × how often Eduardo hits it in daily use** is
largest. Daily-use weight beats novelty: a D1 or D2 gap on the Dashboard outranks a D9 gap
on the Retirement page. State the choice and the reasoning in two sentences.

Then draft **3–6 concrete improvements** inside that theme, each with:
- **User-visible outcome** in one sentence ("the 30-day net worth chart shows this month's
  movement instead of a flat line"). If you can't phrase the outcome, cut the item.
- `file:line` anchors and the shape of the change.
- **Before/after measure** you will report (ms, % plot area, clicks, rows, test count,
  score delta). No measure → not a proposal; it's a hunch.
- Blast radius and the tests you'll add or extend.
- Peer reference: which best-in-class product does this and how.

**Verify before proposing.** Fan out Explore subagents for recon if useful, but personally
re-derive every claim against the code or the DB before it goes in the list — historically
~40% of unverified subagent findings here were wrong or re-flagged settled decisions.

### 4. Approve

Present the theme and the numbered list with **AskUserQuestion**. Make NO changes before
approval. Eduardo may approve a subset, swap the theme, or add an item — record whatever he
says verbatim in the log's "Decisions" section so the next pass honours it.

### 5. Build

- **Patch the file that is actually on disk.** When working through the file bridge, compare
  a staged copy's mtime/size with `device_list_dir` before editing it; a stale cached copy once
  silently reverted two earlier passes. If they differ, re-stage, wait, re-check.
- Ship only approved items. Small, complete, tested. Prefer a pure helper in `frontend/src/lib`
  or `backend/app/services` with a unit test over logic inline in a page or router.
- Keep the app's conventions (see `AGENTS.md` "Style conventions"): Plaid sign convention
  (positive = outflow), `is_transfer` filtered in every aggregation, `expand_splits` for
  category math, `useLatestRequest` on fetch-racing pages, `table-layout: fixed` on the
  transactions table.
- Disclose what you change visually: a fitted axis gets a "not zero-based" caption; an
  excluded row gets a "N excluded" footnote. Best-in-class is never "looks better because it
  hides something."
- Measure the after-state with the same method as the before-state.

### 6. Verify

- Backend: `pytest backend/tests` on Eduardo's Mac. In the sandbox the FastAPI suite can't
  boot (macOS venv) — run the pure-module tests and `py_compile`, and say so.
- Frontend: `npx vitest` on the Mac. In the sandbox `node_modules` binaries are darwin
  ("Exec format error") — verify pure-JS libs with `node --input-type=module` importing the
  module directly, and syntax-check JSX with `@babel/parser`, which is pure JS and works.
- Re-run the ground-truth queries from step 1 against the real DB and confirm the headline
  numbers did not change unless the change was the point — and if they did, show old → new
  and why new is right.
- Re-score the theme's dimension honestly. A pass that shipped but didn't move the score
  is still logged; it just says so.

### 7. Log and commit

Append to `IMPROVE_LOG.md` (public-safe — see the privacy rule in step 1), newest pass at
the top of the passes section:
date · theme · updated scorecard row(s) · shipped items with before → after measures ·
decisions (approved / rejected / deferred, in Eduardo's words) · verification results ·
**Next-pass candidates** (the top two gaps you saw but didn't take, so the next pass starts
warm). Keep the "Seed backlog" section pruned: delete items as they ship.

Commit from the sandbox is fine (git works despite the `.git` perms warnings; clear a stale
`index.lock` by `mv`-ing it into `.git/_to_delete/` — `rm` is blocked). **Never push.**
Remind Eduardo to restart the frontend/backend if the change needs it.

---

## Standing constraints (settled — do NOT spend a proposal on these)

Everything in `AUDIT_LOOP.md`'s constraints list, plus:

- **Pillars are not up for debate.** No cloud sync, no telemetry, no hosted tier, no
  multi-user, no heavy dependencies (a new npm/pip dependency needs a one-line justification
  in the proposal).
- **Net worth chart is fitted, not zero-based** (`lib/chartScale.js`); keep its disclosure
  caption. Spending/income *bars* stay zero-based — bar length is the encoding there.
- **Transfer rows stay visible in drill-down drawers** (badged, excluded from summaries) so
  they can be re-categorized. Don't hide them.
- **Accounts that share a display name** are real, distinct accounts (one is being wound
  down). Don't propose merging or unlinking. Proposing a way to *distinguish* them in the UI
  is fair game.
- **X/Twitter posting is draft-only**; don't re-pitch automation.
- **Ask Tusk is read-only, insight-only**; never propose write actions through it.
- **Prefer clarify over refactor** for ambiguous-but-working UI: help text and inline
  annotation first, redesign only when Eduardo asks.
- **One theme per pass.** A pass that touches five dimensions shallowly is a failed pass.
