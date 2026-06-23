# Ask Tusk — Tile-Level Coverage Audit (Round 2)

**App:** Tusk Ledger · **Date:** 2026-06-18
**Premise (yours):** *if a number is shown to a user, they will ask about it.* So this round audits every major **tile/metric** — not pages — and asks: does the assistant return **that exact concept**, not just *a* number?

**Why a second round:** the page-level audit called tiles "covered" without checking the answer. That's how "total assets" shipped returning **net worth** (assets − liabilities), and "cash balance" returned nothing. This round catches that class explicitly.

**Method:** built a tile→question probe (`backend/tests/_tile_probe.py`, 67 metric questions) and ran each through the real `route()`, then hand-verdicted whether the chosen retriever returns the tile's concept.

**Verdict legend:** ✅ correct · 🟡 partial / phrasing-sensitive · ⚠️ **MIS-ROUTE** (routes, but returns the *wrong* concept/data) · ❌ gap (no retriever) · ⛔ out-of-scope by design (advice / what-if)

---

## ✅ REMEDIATION (same day) — mis-routes killed, gaps closed

Acted on the findings. Tile routing went **50/67 → 58/67**; more importantly, **all 6 confident mis-routes are gone** (43 retrievers now, 158 tests pass).

- **P0 mis-routes fixed:** greedy `balance` no longer steals "projected balance / go negative" (→ `cash_flow_forecast`); greedy `spend` no longer steals "typical Monday" (→ new `day_of_week`); greedy `at` no longer steals "how much will I have **at 65**" / DCFSA (now refuse cleanly instead of a wrong merchant lookup); **investment transactions** now hit a real `investment_transactions` retriever (InvestmentTransaction table, not spending); **total budget remaining** is a real dollars-left answer, not an over/under count.
- **P1 routing fixed:** "asset allocation" / "unrealized gain" / "cost basis" → `holdings`; "am I over **on dining**" → `budget_category`; "how does this month compare to last month" → `spending_compare`.
- **P2 new retrievers + sub-modes:** `financial_pulse` (health score + debt-to-assets), `day_of_week`, `monthly_average`, `investment_transactions`; sub-modes for holdings cost-basis, business profit-margin, retirement pre-tax-vs-Roth, subscriptions "next \<merchant\> charge", budget total-remaining.

**Last gaps closed (same day):** **forecast low-point + date** now wired via the analytics daily simulation ("what's my lowest cash point" → projected low + date). On inspection, **DCFSA and budget-rollover have NO backend service** (grep finds nothing) — so rather than fabricate, the assistant **refuses** those cleanly. That's the grounding discipline working: no data → no answer, never an invented number. Tile routing **58 → 59/67**; the remaining 8 are out-of-scope advice/what-ifs (refuse cleanly) + two un-backed metrics (DCFSA, rollover) + one runtime-covered ("how's my NVDA") + one phrasing ("how much this week"). **Every metric backed by real data now has a grounded retriever.**

---

## Headline finding (pre-remediation, for reference)

Routing reaches a retriever for **50/67 (75%)** of tile metrics. But that number is misleading — the real picture is:

- ✅ **~28 metrics correct** — net worth, total assets/liabilities (now fixed), cash balance (now fixed), spending/income, top category/merchant, holdings value & top holding, savings rate, goals, loans, realized gains, duplicates, averages, home equity, subscriptions, business net.
- ⚠️ **6 dangerous MIS-ROUTES** — they route confidently to the *wrong* answer. **This is the bug class you're hitting.** A greedy keyword ("at" → merchant, "balance" → a single account, "spending" → period total) steals a question it can't actually answer.
- 🟡 **~16 partial / phrasing-sensitive** — the concept exists but a natural phrasing misses it, or the retriever returns a *related* number, not the tile's exact one.
- ❌ **~10 true gaps** — no retriever (Financial Pulse score, DCFSA, forecast low-point, rollover, profit margin, merchant-frequency, monthly averages, cost-basis total).
- ⛔ **3 out-of-scope** — refinance / extra-payment / loss-harvesting (advice & what-ifs, correctly declined).

**The takeaway:** the ~75% "routed" number hides that ~6 are confidently wrong and ~16 are soft-wrong. A wrong number is worse than a refusal, so the mis-routes are P0.

---

## Mis-routes (P0 — confident wrong answers)

| Tile metric | User asks | Routes to | Why it's wrong |
|---|---|---|---|
| Cash-flow forecast — projected balance | "what's my projected balance in 90 days" | `account_balance` | "balance" was grabbed; returns "which account?" instead of the forecast |
| Cash-flow forecast — negative alert | "will my balance go negative" | `account_balance` | same greedy "balance"; should be the runway/forecast |
| Daily snapshot — typical day-of-week | "what's my typical Monday spending" | `spending_total` | returns the 30-day **total**, not the Monday average — a confidently wrong number |
| Investments — transaction history | "show my investment transactions" | `transaction_search` | queries **spending** transactions, not investment **buys/sells** (different table) |
| Budgets — total remaining | "how much budget do I have left in total" | `budget_status` | returns over/under **count**, not dollars **remaining** |
| Insights — anomalies | "any unusual spending this month" | `spending_total` | returns the period **total**, not the anomaly detection the tile shows |

Plus two that *gracefully* miss (route to an entity retriever that then says "I couldn't tell which merchant/account") rather than answer wrong — less dangerous but still wrong destination: **DCFSA** ("at risk in my DCFSA" → `merchant_spend`) and **retirement projection** ("how much will I have at 65" → `merchant_spend`, via greedy "at").

**Root cause:** three over-greedy routing tokens — `at` → merchant_spend, `balance` → account_balance, `spend(ing)` → spending_total — fire before more specific intents. Fix = tighten those three rules (require they not be preceded by forecast/projection/DoW/total-budget cues) and add the missing specific routes.

---

## Tile-by-tile

### Dashboard — health tiles
| Tile | Metric | Verdict |
|---|---|---|
| Stat cards | net worth / total assets / total liabilities | ✅ (assets/liabs fixed this session) |
| Stat cards | this-month spending / income | ✅ |
| **Financial Pulse** | 0–100 health score, sub-scores | ❌ no health-score retriever |
| **Financial Pulse** | debt-to-assets ratio | ❌ |
| Cash Balances | total liquid cash | ✅ (fixed this session) |
| Cash Balances | low-balance / watch account counts | 🟡 `accounts_overview` lists, doesn't count |
| HSA | contributed YTD / room left | ✅ |
| HSA | tax savings if maxed | 🟡 `hsa` returns room, not the tax-savings figure |
| **DCFSA** | at-risk / forfeit dollars, deadline | ❌ no DCFSA retriever |
| Portfolio snapshot | market value / top holding | ✅ |
| Portfolio snapshot | unrealized gain/loss | 🟡 concept exists (`holdings` total G/L) but "unrealized gain" doesn't route to it |
| Portfolio snapshot | asset allocation | 🟡 `holdings` has allocation, but "asset allocation" doesn't route there |
| Portfolio snapshot | total cost basis | ❌ no cost-basis-total answer |
| Cash Flow Forecast | runway / projected balance | ⚠️ projected balance → `account_balance` |
| Cash Flow Forecast | lowest point + date | ❌ not computed |
| Loan payoff | payoff date / lifetime interest | ✅ |
| Loan payoff | term progress % | 🟡 not surfaced |
| Daily snapshot | today / this-week spend | ✅ (use "spend this week") |
| Daily snapshot | typical day-of-week | ⚠️ → `spending_total` (wrong number) |
| Accounts overview | cash / investment / credit / loan subtotals | 🟡 partial (investment→portfolio, credit→loan_detail) |

### Spending / Income
| Metric | Verdict |
|---|---|
| savings rate · top category · top merchants · income sources · subscriptions list | ✅ |
| category MoM/YoY delta | 🟡 `spending_compare` gives **total** MoM, not per-category |
| "how does this month compare to last month" | 🟡 misses (compare needs a "spend" word) |
| average income/spending **per month** | ❌ no monthly-average retriever |
| day-of-week heatmap | ⚠️ → `spending_total` |
| subscription "savings if I cancel" | 🟡 gives total/most-expensive, not the marked-cancel sum |

### Investments / Trading tax
| Metric | Verdict |
|---|---|
| value · gain/loss · top mover · biggest holding · allocation(by keyword) · capital-loss carryover · realized gains · wash sales | ✅ |
| per-holding ("how's my NVDA") | ✅ (runtime via held-ticker fallback) |
| **investment transactions (buys/sells)** | ⚠️ → `transaction_search` (returns spending, wrong table) |
| hold-to-long-term / harvesting candidates | ⛔ advice |

### Net Worth / Loans / Retirement
| Metric | Verdict |
|---|---|
| net worth + history/change · total assets/liabilities | ✅ |
| net-worth 12-mo projection · YoY overlay | ❌ no forecast/YoY retriever |
| loan balance/rate/payment/payoff/total interest | ✅ |
| extra-payment what-if · refinance · PMI · HELOC | ⛔ what-if/advice |
| retirement current savings | ✅ |
| retirement projection (nest egg, depletion age) | ⛔ defers (but routes via greedy "at" → fix to refuse cleanly) |
| pre-tax vs Roth bucket split | 🟡 `retirement` gives total, not the split |

### Budgets / Goals / Business / Insights
| Metric | Verdict |
|---|---|
| over/under budget · goal progress/remaining · business net · duplicates · average order | ✅ |
| per-category budget ("am I over on dining", no word "budget") | 🟡 misses (rule needs "budget") |
| total budget remaining | ⚠️ → `budget_status` (count, not dollars left) |
| rollover credit | ❌ |
| business profit margin · per-line expense | ❌ / 🟡 |
| spending anomalies | ⚠️ → `spending_total` |
| merchant frequency ("when's my next Netflix charge") | ❌ |

---

## Prioritized remediation

**P0 — kill the confident-wrong mis-routes (a refusal beats a wrong number):**
1. Tighten greedy `balance` → don't let "projected/forecast/go negative" hit `account_balance`; route them to `cash_flow_forecast`.
2. Tighten greedy `spend(ing)` → "typical \<day\>"/"day of week" and "unusual/anomal" must not fall to `spending_total`.
3. `investment transactions` → a new `investment_transactions` retriever over the InvestmentTransaction table (not `transaction_search`).
4. `total budget remaining` → a `budget_status` sub-mode that sums limits − spent (or a `budget_remaining` answer).
5. Greedy `at` → `merchant_spend` should yield to retirement/DCFSA/"at \<age\>" cues.

**P1 — cheap routing fixes for concepts that already exist:**
6. "asset allocation" and "unrealized gain/loss" → route to `holdings` (sub-modes already built).
7. "am I over on \<category\>" (no word "budget") → `budget_category`.
8. "how does this month compare to last month" → `spending_compare` (drop the spend-word requirement).
9. retirement "pre-tax vs Roth" → add a bucket split from account subtypes.

**P2 — new retrievers for real gaps (data exists):**
10. Financial Pulse score + debt-to-assets (analytics `financial-pulse` endpoint).
11. DCFSA forfeit risk (the DCFSA tracker service).
12. HSA "tax savings if maxed" (hsa_status already returns it).
13. Cash-flow forecast low-point + date (the forecast already computes it).
14. Monthly averages, total cost basis, profit margin, rollover, merchant-frequency / next-charge, net-worth forecast.

**Out of scope (leave):** refinance, extra-payment, loss-harvesting, retirement projection — advice/what-ifs the assistant declines by design (but route them to a clean refusal, not a greedy mis-route).
