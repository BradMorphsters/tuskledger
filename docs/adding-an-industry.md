# Adding an industry (retargeting the Research / Signals / Rotation tools)

Tusk Ledger's research layer is **industry-agnostic**. "Critical minerals" is just
the default — the whole Research / Signals / Rotation / alerts stack is driven by a
single **research file per industry**, joined onto your holdings by ticker. You can
point it at retail, defense, semiconductors, energy, or anything else by dropping in
one file. The app focuses on **one industry at a time**.

## What's generic vs. industry-specific

Already generic (no code changes needed for a new industry):

- **Research** — the join, cockpit, universe, drawer, and alerts read whatever
  `*.research.json` you provide.
- **Signals (Quiver)** and **SEC EDGAR** — per-ticker; they work for any equity
  universe (government contracts, congressional/insider trades, lobbying,
  dark-pool, Form-4 filings, 8-Ks, capital raises).
- **Price chart, momentum** — any ticker via your market-data key.

Industry-specific, declared in the file's `meta.industry` block:

- `label` — used in the UI and AI narrative ("retail", "defense", …).
- `benchmark` — broad-market ticker for relative strength (default `SPY`).
- `sector_etfs` — the theme's proxy ETFs, measured against the benchmark to gauge
  whether capital is rotating **into** the sector. Omit it and the Rotation
  "relative strength" view simply doesn't compute — everything else still works.
- `proxy_keywords` — `category-substring → ETF`, used for per-name backdrop.
- `rotation_weights` — how the rotation temperature weights its four components
  (`flow`, `rerating`, `momentum`, `cadence`); auto-normalized. Omit for the
  default 0.35 / 0.30 / 0.20 / 0.15.
- `flow_signals` — which public-money-flow sub-signals apply to this industry
  (`gov_contracts`, `congress`, `lobbying`, `edgar`). Omit = all. Retail, for
  example, has no federal contracts or lobbying, so you'd set `["edgar"]` and
  the rotation read stops crediting signals that don't apply.

## Steps

1. **Copy the template.** `docs/industry-template.research.json` →
   `research/<your-industry>.research.json`.
2. **Fill it in:**
   - `meta.domain` — a slug like `retail` (this becomes the URL/key).
   - `meta.industry` — your `label`, `benchmark`, `sector_etfs`, `proxy_keywords`.
     For retail you might use `sector_etfs: ["XRT","RTH"]`.
   - `dimensions.factors` / `tiers` — the scoring vocabulary for this industry.
   - `entities` — your universe (equities + ETFs) with `scores.conviction`,
     `scores.upside`, optional `price_targets`, `catalysts`, `thesis`, etc. The
     schema (`research/research.schema.json`) is the contract; writes are validated.
3. **Make it active.** Set `ACTIVE_RESEARCH_DOMAIN=<your-industry>` in
   `backend/.env` so the UI defaults to it, then restart the backend.
4. **Warm the data.** Open the app (or run the daily job): the price refresh warms
   your `benchmark` + `sector_etfs` automatically; click **Refresh signals** /
   **Refresh filings** on the Signals tab to warm Quiver + EDGAR for the new names.

That's it — Research, Signals, Rotation, the alert tripwires, and the AI narrative
all retarget to the new industry with no code changes.

## Notes

- **One at a time:** multiple research files can coexist; `ACTIVE_RESEARCH_DOMAIN`
  picks the focused one. The tabs operate on the active domain.
- **Bring-your-own-keys** are shared across industries: the same Twelve Data /
  Quiver keys work for any universe; SEC EDGAR is free and needs no key.
- **No `sector_etfs`?** Fine — you lose only the sector relative-strength read.
  Momentum, valuation re-rating, flow, filings, and catalyst cadence still drive
  the rotation temperature.
- Keep the file PII-free (no balances) — positions join in at query time. It's
  safe to commit to git, which is how you get version history of your thesis.
