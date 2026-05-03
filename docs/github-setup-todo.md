# GitHub setup TODO (manual steps)

These are the two Tier-1 items from the audit prioritization that need
your hand on the GitHub UI — they can't be done from a script. Both are
~5–10 minutes apiece. Drafts of the content are below; copy/paste into
GitHub when ready.

---

## 1. Enable GitHub Discussions

**Where:** https://github.com/BradMorphsters/tuskledger/settings → Features → check **Discussions**.

**Why:** Gives the repo a Q&A surface that isn't issue tracker. Signals
"community-shaped" rather than "single maintainer's hobby." Costs
nothing.

**Welcome post to seed it with** (paste as the first Discussion in the
Announcements category):

> ### Welcome
>
> This is the place for questions, ideas, and "is anyone else doing X"
> threads about Tusk Ledger.
>
> **What goes here, vs. issues:**
>
> - **Discussions** — questions, ideas, sharing your setup, feature
>   wishlists, "how do I…", show & tell.
> - **Issues** — bug reports with steps to reproduce, or accepted
>   feature work with a clear scope.
>
> If you're not sure which, post here first; I'll move it to issues
> if it's the right shape.
>
> A few starter threads worth opening:
>
> - **Show & tell** — what you've customized, what tiles you added,
>   what you wish were different.
> - **Plaid quirks** — institution-specific issues you've hit and how
>   you worked around them.
> - **Tax-modeling questions** — "is the Roth ladder math doing what I
>   think it's doing?" with citations welcome.
>
> See [CONTRIBUTING.md](../blob/main/CONTRIBUTING.md) for the scope of
> the project (what's a "yes," what's a "no") before filing larger
> ideas as issues.

---

## 2. Pin a Roadmap issue

**Where:** https://github.com/BradMorphsters/tuskledger/issues/new → paste the title and body below → after creating, click the issue → right sidebar → **Pin issue**.

**Why:** Public visibility into what's coming. Replaces the
"contributing wishlist" in the README with something that can change
without a commit.

**Title:**

```
Roadmap — what's queued, what's later, what's unlikely
```

**Body:**

```markdown
A living list of what's planned for Tusk Ledger. This is intentionally
loose — dates are aspirational, scope can change, and things below the
"someday" line may never ship. If something here matters to you, leave
a 👍 reaction or comment with your use case.

For the scope of the project (what's a "yes," what's a "no"), see
[CONTRIBUTING.md](../blob/main/CONTRIBUTING.md).

---

## 🟢 Active (next 1–2 weeks)

- [ ] **Self-test the Cowork plugin** at github.com/BradMorphsters/tuskledger-marketplace — install in a clean Cowork environment end-to-end, fix what breaks.
- [ ] **First technical write-up** — the no-hallucination invariant (see ARCHITECTURE.md). Becomes the seed for the build-in-public cadence.
- [ ] **Multi-account filter + 'selected accounts' wash-sale scope** (carry-over from the trading-tax build).

## 🟡 Queued (next month)

- [ ] **Snapshot replication for offline phone access (v2)** — encrypted SQLite snapshot pushed to user-controlled storage (S3 / Cloudflare R2), hydrated in the browser via sql.js. Phone works when laptop is asleep at the cost of being a point-in-time copy.
- [ ] **Monthly recurring digest** — scheduled task on the same pattern as the weekly security sweep, summarizing what changed in the codebase + dataset over the month.
- [ ] **More mutating MCP tools** — `set_budget_category`, `mark_bill_paid`, `add_manual_transaction`, `set_account_tax_bucket`, `add_manual_asset`. Currently the MCP server is read-mostly by design; a small set of safe mutations would unlock more agent workflows.
- [ ] **Live demo at demo.tuskledger.com** — read-only seeded instance hosted somewhere, so visitors can poke the UI without installing anything.
- [ ] **60-second Ask-panel screencast** in the README hero slot.

## 🔵 Eventually (someday)

- [ ] Plaid update-mode flow for re-linking with additional product scopes.
- [ ] Windows-native start script (currently bash-only).
- [ ] More institution support in the manual-asset flow.
- [ ] Light theme.
- [ ] Auth-aware MCP server (currently assumes `DEV_BYPASS_AUTH=true`).

## 🔴 Unlikely (probably not)

These come up; the answer is usually no. CONTRIBUTING.md explains why.

- Multi-user / shared budgets.
- A second bank-sync provider in addition to Plaid.
- Cloud-hosted SaaS variant.
- Native mobile app rewrite (PWA + read-only is the v1; snapshot replication is v2).
- Internationalization beyond cosmetic changes.
- Envelope-budgeting paradigm grafted on top of category budgets.
- Telemetry or analytics, even opt-in.

---

*Last updated: 2026-05-02. Edited as priorities shift.*
```

---

## After both are done

You can delete this file (`docs/github-setup-todo.md`) — it's only
useful until the GitHub side is set up. Or leave it; future-you might
want the welcome / roadmap text as a starting point for a refresh.
