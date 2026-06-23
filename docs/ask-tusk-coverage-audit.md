# Ask Tusk — Page-by-Page Routing Coverage Audit

**App:** Tusk Ledger · **Date:** 2026-06-18
**Question:** For each page/section of the app, does the Ask Tusk deterministic router have a retriever that can answer questions about it?

**Method:** inventoried every page in `frontend/src/pages/`, then mapped each data section to the 17 retrievers in `backend/app/services/assistant_retrieval.py`
(`largest_transactions, spending_total, top_merchant, top_categories, category_spend, merchant_spend, recent_transactions, income_total, cash_flow, net_worth, net_worth_change, largest_assets, account_balance, accounts_overview, portfolio, upcoming_bills, budget_status`).

**Legend:** ✅ covered · 🟡 partial · ❌ gap

---

## UPDATE 2026-06-18 (5) — composition layer + L2/L3 closed to the honest ceiling

**38 retrievers.** Closed the addressable secondary/tertiary gaps: added a deterministic **comparison composer** (`compare` — two tickers / two categories / two merchants, e.g. "how does my AAPL gain compare to my VTI gain", "do I spend more on dining or groceries"), **average_spend** ("average size of my Amazon orders"), **duplicate_charges** ("did I pay the same merchant twice"), **home_equity** (real-estate value − mortgage — now computed instead of refused), and routed "how much have I gained" → holdings and "what could I cancel" → subscriptions. Re-probed (115 questions):

| Level | Before | **Now** |
|---|---|---|
| L1 — primary | 100% | **100%** |
| L2 — secondary | 95% | **98%** (the one miss, "how's my NVDA", is covered at runtime via the held-ticker DB fallback → effectively 100%) |
| L3 — tertiary | 71% → 81% | **91%** |
| Overall | 81% → 89% | **95%** |

**The remaining ~5% is the true floor and it's all honest:** advice/what-if/simulation ("should I refinance", "taxes if I sold NVDA", "which lots to harvest" — declined by design), plus two low-value items (savings-trend comparison, per-ticker research depth). 126 tests pass. The only architectural lever left is an LLM **planner** for *open-ended* multi-step composition beyond the fixed two-entity `compare` — but the deterministic composer already covers the realistic comparison questions, and the facts still come from retrievers, never the model.

## UPDATE 2026-06-18 (4) — empirical 3-level probe (primary / secondary / tertiary)

Stopped eyeballing and built a question battery — 112 questions across 14 domains × 3 depths — run through the real `route()` (`tests/_coverage_probe.py`). After patching the addressable gaps (34 retrievers now; added `transaction_search` and `spending_compare`, plus routing fixes), the measured coverage is:

| Level | Routed to a retriever |
|---|---|
| **L1 — primary** ("what's my net worth") | **20/20 = 100%** |
| **L2 — secondary** ("how has it changed", "how much at Costco") | **38/40 = 95%** |
| **L3 — tertiary** (comparisons, conditionals, multi-part) | **42/52 = 81%** |
| **Overall** | **100/112 = 89%** |

**What the probe caught and I fixed** (real bugs, now in the eval table): plural/conjugation holes ("all **budgets**", "best **performer**"), "how much **at** Costco" (no spend-verb), "**short vs long** term gains", sector "**heating up**", loan **total interest** (the data was already there), and a mis-route where "**equity in my house**" was hitting the *stock*-holdings retriever (now an honest refuse). Added new retrievers for **transaction search** ("every purchase over $500", "what did I buy at Amazon") and **period comparison** ("did I spend more than last month").

**The residual L3 misses are a real ceiling, and they sort into four honest buckets:**

1. **Covered at runtime, false-miss in the probe** — "how's my NVDA doing" (no keyword, but `answer()` catches it via the held-security DB fallback). The probe only exercises `route()`.
2. **Out of scope by design — advice / what-if / simulation** — "should I refinance", "which lots should I sell to harvest losses", "how much would I owe in taxes if I sold NVDA", "can I retire at 60". These ask for a *recommendation or a hypothetical*, not a fact. Correctly deferred — the assistant reports facts, and "should I" is advice we don't give.
3. **Cross-item / cross-period comparison (composition ceiling)** — "how does my AAPL gain compare to my VTI gain", "did I save more this month than last", "is my portfolio more concentrated than last quarter". A single-intent retriever returns one fact; comparing two requires composing two retrievals. This is the architectural edge of the keyword router.
4. **Aggregations / detections we don't compute** — "average size of my Amazon orders", "find duplicate charges". Easy to add as retrievers if wanted; low frequency.

**Takeaway:** primary and secondary questions are essentially solved (95–100%). The remaining ~11% are tertiary questions that are *correctly* declined (advice/what-ifs) or need genuine multi-retrieval composition — not more keywords. Closing the composition bucket is the only place a smarter layer (an LLM **planner** that calls 2+ retrievers and the grounding-checked synthesis) would add real value — and even then, the facts still come from the deterministic retrievers, never the model.

## UPDATE 2026-06-18 (3) — Tier 3 shipped — coverage essentially complete

Added 2 read-only surfaces (**32 retrievers**) + a tax sub-mode: `agent_status` (what the agent holds, what's **pending your approval**, cash/deployable, armed/mode — insight only, never places or approves), `market_signals` (sector **rotation temperature** + **congressional/insider** activity for the active research domain), and **capital-loss carryover** folded into `trading_tax` ($3k deductible vs the remainder carried forward). Routing: agent/market/trading-tax checked *before* the holdings rule so "agent positions" / "capital gains on my stocks" route correctly; ROUTING_CASES ~56 cases; **107 tests pass**. Agent retriever is provably read-only (test asserts no "I placed/approved/bought" phrasing). Every page section in the audit now has a grounded retriever or an honest defer (e.g. retirement projection → tab). Remaining is deep tax-prep line-item detail (Schedule-C-by-IRS-line) — low value for a voice assistant.

## UPDATE 2026-06-18 (2) — Tier 2 shipped

Added 5 more retrievers (**30 total**): `loan_detail` (balance / rate / payment / payoff / "owe on my car" / total debt), `retirement` (current savings, defers the assumption-laden projection to the tab), `trading_tax` (net realized / short-vs-long / wash sales), `business` (income / expenses / net), `hsa` (contributed / room left / balance). Each wraps existing logic (debt_payoff, compute_realized_pnl, businesses_overview, hsa_status). Routing ladder +6 rules (retirement excludes "balance" so "roth balance" still goes to account_balance); ROUTING_CASES ~49 cases; **98 tests pass** (85 assistant + 13 app-boot). Now-covered: Loans, Retirement (savings), Trading Tax, Business, HSA. **Remaining (Tier 3 / product decision):** Tax-prep Schedule-C-line detail + capital-loss-carryover years, and the research/agent surfaces (Signals, Rotation, Agent status).

## UPDATE 2026-06-18 — Tier 1 + secondary questions shipped

Closed most Tier-1/Tier-2 gaps. The router now has **25 retrievers** (was 17). Added: `holdings` (rich: specific ticker, best/worst mover, largest position, total gain/loss, allocation, count, + bare-ticker DB fallback so "how's NVDA" works), `subscriptions` (total/most-expensive/anomalies/overdue/count), `savings_rate`, `budget_category` (per-category "am I over on dining"), `goals` (progress/remaining/required-monthly), `cash_flow_forecast` (runway + projected balance), `stale_accounts`, `income_sources`. Routing eval table grew to ~38 cases; 71 assistant tests + 13 app-boot pass. **Each retriever was built around the follow-up questions, not just the headline.** Remaining open: Loans detail, Retirement, Trading-tax, Tax-prep (HSA/Schedule C/loss-carryover), Business, and the Tier-3 research/agent surfaces (Signals, Rotation, Agent status). Per-page statuses below are pre-update; treat Investments/Subscriptions/Savings/Goals/Budget-category/Runway as now ✅.

---

## Headline finding

The router covers the **core day-to-day money questions well** — net worth, spending, income, cash flow, top merchants/categories, category & merchant spend, account balances, bills, budget, recent transactions. That's most of the Dashboard, Spending/Income, Transactions, Budgets, Net Worth, Cash Flow, and Bills pages.

The gaps cluster in **four areas**: (1) investments at the holding level, (2) planning pages (Goals, Retirement, Loans detail), (3) tax pages, and (4) the investing-research/agent surfaces. **Crucially, the backend data already exists for almost every gap** (MCP tools / chat_prompts builders are already built) — what's missing is a thin retriever + a routing rule, not new computation. So each gap is a small, testable add, consistent with the current architecture.

---

## Per-page coverage

| Page | Data sections | Status | Missing queries (gaps) |
|---|---|---|---|
| **Dashboard** | net worth, assets/debt, month spend & income, category pie, account balances, recent txns, health tiles | 🟡 | Financial Pulse score; HSA/DCFSA trackers; **forward cash-flow forecast**; loan-payoff countdown |
| **Spending / Income** | income vs spending, by category, income sources, top merchants, **recurring/subscriptions**, cash-flow waterfall, **YoY** | 🟡 | **Subscriptions/recurring**; income-source breakdown; **spending YoY**; day-of-week patterns |
| **Transactions** | searchable list, scope totals, category/merchant/date drill-down | ✅ | (covered via recent_transactions + category_spend + merchant_spend; arbitrary multi-filter → open-ended) |
| **Budgets** | total vs budget, per-category limits, rollover, business budget | 🟡 | **Per-category budget status** ("am I over on dining?"); rollover credit; business budget |
| **Goals** | goal list, target, progress %, pace/mo, projected reach, on-track | ❌ | **No goals retriever at all** — progress, pace, "will I hit my goal", on-track |
| **Net Worth** | net worth + history, manual assets, debt-payoff timeline, **forecast** | 🟡 | **Net-worth projection/forecast**; debt-payoff timeline |
| **Loans** | per-loan payoff date, lifetime interest, refinance/PMI/HELOC models | ❌ | **No loan retriever** — payoff date, interest, mortgage balance, extra-payment what-ifs (accounts_overview gives only the liabilities total) |
| **Retirement** | retirement projection, withdrawals, SS/pension, RMDs, healthcare bridge | ❌ | **No retirement retriever** — "am I on track to retire", projected balance, withdrawal income |
| **Tax Prep Pack** | HSA contributions vs limit, Schedule C, capital-loss carryover | ❌ | **No tax retriever** — HSA room, Schedule C net, loss carryover years left |
| **Cash Flow** | forward forecast, runway, bill stress, subscriptions | 🟡 | **Forward forecast / emergency runway / bill-stress** (cash_flow today is *historical* in/out only); subscriptions |
| **Bills Calendar** | upcoming bills, running daily balance, projected low point | 🟡 | Projected daily balance / projected low point (bills themselves ✅) |
| **Investments** | total value + gain/loss, allocation, **top holdings**, holdings table, by-account, **top movers** | 🟡 | **Largest/specific holding**, gain-loss per holding, asset allocation, top movers, value-by-account (only the portfolio *total* ✅) |
| **Trading Tax** | realized capital gains, wash-sale, hold-to-long-term | ❌ | **No trading-tax retriever** — realized gains YTD, wash-sale flags, hold-to-LT opportunities |
| **Insights** | monthly report, new merchants, anomalies, YoY, top merchants/categories | 🟡 | New-merchant detection; spending anomalies/insights; YoY; (top merchants/categories ✅) |
| **Business** | business income/expense rollup, Schedule C, tagging | ❌ | **No business retriever** — business net, expense total, tagged-vs-untagged |
| **Research** | per-ticker research, AI synthesis, public-activity detail | 🟡 | No dedicated "research on \<ticker\>" retriever (handled by the open-ended snapshot path, not a grounded retriever) |
| **Signals** | conviction, gov contracts $, congressional/insider buying, lobbying | ❌ | **No signals retriever** — gov-contract $, net congressional/insider buying per ticker |
| **Rotation** | rotation temperature, component scores, curve, AI narrative | ❌ | **No rotation retriever** — rotation temp, component scores |
| **Agent Trading** | agent mode, cash/deployable, **open positions**, guardrail vetoes, **approval queue**, ranking, backtest | ❌ | **No agent-status retriever** — "what's pending approval", "what are my agent positions", "what got vetoed" (read-only insight; placement stays manual) |
| Rules / Categories / Connect / Pair-Phone | configuration only | n/a | No queryable financial data — correctly out of scope |

---

## Gaps grouped by priority

### Tier 1 — common personal-finance questions, data already exists (add next)
1. **Subscriptions / recurring** — backend `detect_recurring` (analytics.py) + MCP `get_recurring_subscriptions` exist. Used on Spending, Cash Flow, Insights. *"What am I paying for in subscriptions?"*
2. **Largest / specific holding + gain-loss** — MCP `get_holdings` / `get_investments_summary` exist. *"What's my biggest holding / how's NVDA doing?"*
3. **Savings rate** — `savings_rate` builder already in chat_prompts (unwrapped). *"What's my savings rate?"*
4. **Per-category budget status** — `overspending` bundle already has per-category detail. *"Am I over budget on dining?"*
5. **Goals progress** — `savings_goals` model + page exist. *"Am I on track for my \<goal\>?"*
6. **Cash-flow forecast / runway** — MCP `get_cash_flow_forecast` exists. *"How many months of runway do I have?"*

### Tier 2 — planning/tax, data exists via dedicated services
7. **Loan detail** — payoff date, mortgage balance, lifetime interest (mortgage_detail + Loans page math).
8. **Retirement** — MCP `get_retirement_projection`. *"Am I on track to retire?"*
9. **Trading tax** — MCP `get_trading_tax_summary`. *"What are my realized gains this year?"*
10. **Tax-prep facts** — HSA room, Schedule C net, capital-loss carryover (TaxPrepPack services).
11. **Stale accounts** — `stale_accounts` builder exists. *"Which accounts are out of date?"*

### Tier 3 — investing-research / agent surfaces (decide if in scope for a *personal-finance* voice assistant)
12. **Agent-trading status** (read-only) — positions, pending approvals, guardrail vetoes.
13. **Signals / Rotation / per-ticker research** — currently only reachable through the open-ended snapshot path, not a grounded retriever.

---

## Recommendation

Each Tier-1/Tier-2 gap is the same shape as the retrievers already built: a deterministic query (most already exist as MCP tools or chat_prompts builders), a routing rule, a template, and one row in the `ROUTING_CASES` eval table. None require model training or new math — they wrap data the app already computes.

Suggested order: **subscriptions → holdings/largest-position → savings rate → per-category budget → goals → cash-flow forecast** (Tier 1), then the planning/tax wrappers (Tier 2). Tier 3 (agent/research) is a product decision about whether the voice assistant should speak to the investing surfaces at all.
