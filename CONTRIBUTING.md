# Contributing

Thanks for considering a contribution. A few things that will save us
both time.

## What this project is, and isn't

Tusk Ledger is a **single-user, US-tax-resident, local-first** personal
finance app, run on the maintainer's own machine and shared with the
world. The scope is intentionally narrow:

- **One person, one machine.** No multi-user, no shared budgets, no
  collaborative editing. The phone is a thin read-only client.
- **US tax math.** Schedule C, Roth, RMDs, IRMAA, Form 8949 — these
  are first-class. Internationalization is not.
- **Plaid for bank sync.** BYO API keys; no plan to layer additional
  aggregators.
- **No cloud, no telemetry, no SaaS.** If a feature needs a hosted
  backend to work, it doesn't fit here.

If a contribution moves the project away from these constraints, it
will likely be declined — not because it's bad, but because the focus
matters more than the feature. **Please open an issue to discuss
anything large before writing the code.**

## Things that are warmly welcome

- Bug fixes, especially with a regression test
- Documentation improvements (typos, missing context, broken links)
- New tests for under-covered modules
- Plaid edge-case handling (institution-specific quirks, error codes)
- Tax modeling refinements with a citation (IRS pub, court ruling,
  bracket update)
- Performance improvements with before/after numbers
- Accessibility fixes
- New manual-account types or import format support
- Demo-data improvements that surface a feature that's currently hidden

## Things that are unlikely to be merged

- Multi-user / shared budgets / collaboration features
- A second bank-sync provider in addition to Plaid
- A cloud-hosted SaaS variant
- A native mobile app rewrite (PWA + read-only is the v1 phone path;
  snapshot replication is the v2 plan, tracked in the roadmap)
- Internationalization beyond cosmetic changes
- Envelope-budgeting paradigm grafted on top of category budgets
- Telemetry or analytics, even opt-in
- Removing the no-hallucination invariant (see [ARCHITECTURE.md](ARCHITECTURE.md))
- Vendoring fonts / icons / scripts that currently load from CDN, or
  vice versa, without a clear reason

If your idea is on this list, please open an issue first to talk it
through. Sometimes there's a sub-feature inside a "no" that's a "yes."

## Opening an issue

Bugs:
- What did you do, what did you expect, what happened?
- Output of `./tuskledger doctor` (it sanitizes secrets)
- Browser + OS version
- Backend log lines around the failure
- Whether you can reproduce in demo mode (rules out your data being
  the cause)

Features:
- What problem are you solving for yourself?
- What does the simplest possible version look like?
- Have you read the "what this project isn't" section above?

## Sending a PR

1. Fork, branch from `main`, name the branch something descriptive
   (`fix-wash-sale-cross-account-bug`, not `patch-1`).
2. Run the test suite: `cd backend && python -m pytest tests/ -q` and
   `cd frontend && npm test -- --run`. Both should be green.
3. If you changed behavior, add a test that fails before your change
   and passes after.
4. Keep the PR scoped to one concern. A typo fix bundled with a
   refactor will get split.
5. Write the PR description in the same style as the recent commit log:
   what, why, what trade-offs, what's *not* changed.
6. Don't bump dependency versions in the same PR as a feature change —
   Dependabot handles deps on its own cadence.

## Code style

- **Python** — `from __future__ import annotations`, type hints on new
  functions, `ruff` for lint. SQLAlchemy 2.x style (`select()`, not
  `Query`). Pydantic v2.
- **JavaScript** — React 18, function components only, hooks not
  classes. Single-quote strings, no semicolons (matches existing code).
  Lucide for icons, Recharts for charts; please don't add another chart
  lib.
- **CSS** — variables in `frontend/src/index.css` are the design
  tokens; reference them rather than hard-coding colors.
- **Comments** — comment the *why*, not the *what*. Existing files have
  a high bar for explaining non-obvious decisions; please match it.
- **Test naming** — `test_<module>_<scenario>_<expectation>` style.

## Commit messages

Imperative mood, capitalize the first word, no trailing period. The
first line ≤72 characters. If the diff isn't trivially obvious, add a
body explaining why. Example:

```
Fix wash-sale cross-account FIFO when a transfer lacks a Plaid event

When shares move between brokerages without a tagged transfer, the
calculator was inventing phantom open positions to satisfy the
oversell on the destination side. Now we look at sibling accounts'
FIFO lots before falling back to error.
```

## Security

Found a security issue? Please email rather than opening a public
issue. The README's "Security notes" section has more detail.

## Code of conduct

Be civil. Don't be a jerk. The maintainer reserves the right to lock
threads or block users for behavior that doesn't meet that bar.

## License

By contributing you agree your contributions will be MIT-licensed under
the same license as the project.
