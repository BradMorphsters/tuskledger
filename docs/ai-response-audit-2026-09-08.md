# Ask Tusk / AI-response audit — 2026-09-08

Full audit of every surface in Tusk Ledger that produces an AI-generated or AI-routed
response: the laptop retrieval brain, the LLM narration layer, the proactive briefing,
the chat + dashboard narrative endpoints, research/rotation synthesis, and the phone's
offline parser.

**Evidence standard.** Every finding below was reproduced by running code — either as a
pytest against the seeded fictional household, as a Node probe against the phone parser,
or as a live call to the running backend. Two plausible-looking findings were
**discarded** during verification (see *Rejected*). No finding here rests on reading
alone.

All figures in this document are from the fictional test household or are structural.
Real balances are deliberately excluded (public repo).

---

## Summary

| | |
|---|---|
| Backend tests | **1,014 pass** (1,018 collected; 4 are `tests/_disabled/`) |
| Ask Tusk suites | **307 pass** — assistant, retrieval, corpus, eval, feedback, narrative |
| Golden routing report | **85/85 (100%)** |
| Coverage probe | L1 100% · L2 98% · L3 93% · **overall 96%** |
| Phone intent suite | **ALL PASS** |
| Live backend | up; voice enabled (Parakeet STT + Kokoro TTS both available) |

**The regression net is green and it is not catching these.** Every defect below passes
CI today. That is the headline: the test suites verify *routing* (does the question reach
the right retriever) and pin *known-good* phrasings. They do not verify that an answer is
**responsive to the question actually asked**, and they never exercise the LLM layer at
all (`LLM_ENABLED=False` in every test).

Two structural themes account for almost everything found:

1. **Negation and qualifiers are invisible to both brains.** "Besides", "excluding",
   "other than" are silently dropped, so the app answers about the very thing you asked
   to exclude — with a confident number.
2. **`grounding_ok` is the single load-bearing safety claim in the codebase, and it is
   porous.** Five of the seven LLM surfaces don't call it at all; on the two that do, it
   passes fabricated figures.

---

## Findings

### 1 · CRITICAL — `grounding_ok` passes fabricated figures

`backend/app/services/assistant_retrieval.py:2398-2418`

This is the only numeric gate in the app and the guarantee every docstring rests on. I
extracted it and ran it. **All of the following return `(True, None)` — accepted:**

| Bypass | Retrieved truth | Model output | Result |
|---|---|---|---|
| Sign inversion | `-12,400` (net worth **down**) | "net worth is **up $12,400**" | accepted |
| Any figure under $100 | anything | "**$87** at Starbucks and **$42** on parking" | accepted |
| Any percentage under 100 | anything | "savings rate is **63%**, spending down **41%**" | accepted |
| 1% drift | `1,234,567` | "**$1,240,000**" (off by $5,433) | accepted |
| Calendar-year band | anything | "you owe **$1,999** on that card" | accepted |
| `K`/`M` suffix | `47.0` | "spending hit **$47K**" | accepted |
| No digits at all | anything | "you are **massively overdrawn**" | accepted |
| Omission | `{3142, 30}` | "$3,142" — drops "over 30 days" | accepted |

Root causes, all confirmed by execution:

- **`abs()` is applied to both sides** (`:2392` and `:2405`). The check *structurally
  cannot* tell a gain from a loss, income from expense, or under- from over-budget.
- **Blanket exemption at `:2415`** — `n <= 99 or 1900 <= n <= 2100`. I enumerated it:
  **every integer 0–99 and 1,900–2,100 is unconditionally exempt.** The inline comment
  claims "a dollar amount like 1737 is NOT exempt" — but 2,050 is.
- **Tolerance `max(1.0, a * 0.01)`** (`:2409`) — a $1 floor plus a 1% band.
- Percentages are compared against the dollar allowlist; `K`/`M` suffixes aren't normalized.

**Fix:** drop both `abs()` calls and match signed; delete the `<= 99` exemption and
instead let retrievers publish counts/days explicitly; tighten tolerance to exact match at
displayed precision; give percentages their own allowlist; normalize magnitude suffixes.

---

### 2 · CRITICAL — Five of seven LLM surfaces have no grounding check at all

Confirmed by grep: `grounding_ok` / `_numbers_in` are **not imported** by any of these.

| Surface | File | Grounded? | If Ollama is down |
|---|---|---|---|
| Ask panel chat | `routers/chat.py:239, :252` | **no** | **HTTP 503** |
| Dashboard AI card | `routers/analytics.py:2861, :2881` | **no** | **HTTP 503** |
| Proactive briefing | `services/assistant.py:162` | **no** | template ✓ |
| Research synthesis | `services/research_synthesis.py:362` | **no** | template ✓ |
| Rotation narrative | `services/rotation.py:558` | **no** | template ✓ |
| Ask Tusk open-ended | `assistant_retrieval.py:2462` | weak (#1) | refuses ✓ |
| Ask Tusk rephrase | `assistant_retrieval.py:2562` | weak (#1) | deterministic ✓ |

The briefing is the sharpest edge: `assistant.py:150-165` computes `base` (deterministic
ground truth), hands it to the model, then returns `text or base` **without comparing
them** — and that text is what the Ask panel greets with, what `/api/mobile/briefing`
serves, and what **Kokoro speaks aloud**. A spoken number leaves no receipt to check.
Grounding it is a two-line change; `_maybe_rephrase` already does exactly this.

I called the live endpoint: it returned `source: "ollama"` and the numbers **matched
ground truth exactly**. So it behaves today — it is simply unguarded by construction.

**Also confirmed:** `chat.py` and `analytics.py` stream **raw model tokens**
(`for chunk in client.complete_stream(...): yield`), so a check bolted on afterwards would
be too late — the figure is already rendered. `analytics.py:2869-2874` then **caches the
ungrounded text for the rest of the calendar day**.

`routers/assistant.py:43-49` already solves this correctly — it generates, approves, then
re-chunks the *approved string*. That's the pattern to copy into the other two.

---

### 3 · HIGH — "Did I pay the electric bill?" answers Yes, citing a different bill

`assistant_retrieval.py:2267-2293` · **reproduced on live data**

The `else` branch at `:2280-2281` handles any bill it doesn't specifically recognise with
`pat = payment|autopay|loan|mortgage`, takes the **first match in the window**, and
answers `"Yes — $X to <that merchant>"`. **The question's subject is never compared to the
match.**

Fictional household:

```
"did I pay the electric bill"   -> Yes — $1,800 to Home Lender on Sep 1.
"did I pay the water bill"      -> Yes — $1,800 to Home Lender on Sep 1.
"did I pay my internet bill"    -> Yes — $1,800 to Home Lender on Sep 1.
```

On the live backend all three returned an emphatic **"Yes"** citing an unrelated
credit-card payment. This is the highest-consequence shape of wrong answer in the app: a
direct yes/no question about money, answered "yes" about something else. A user could
skip a real payment on the strength of it.

The routing guard at `:191` requires a payable word, so "did I pay the babysitter"
correctly refuses — but "bill" is in the allowlist, so every named bill routes straight
into the fallthrough.

**Fix:** in the `else` branch, extract the subject from the question and require the match
to contain it; otherwise return `found=False`. Never emit "Yes" for a hit whose
name/category doesn't contain what was asked about.

---

### 4 · HIGH — Negation inverts the answer (both brains)

**Reproduced on the laptop, on the phone, and on live data.** Neither router has a
negation guard; the category extractor grabs the excluded word and answers about it.

Laptop, fictional household:

```
"how much did I spend besides groceries this month"  -> $170 on Groceries this month
"how much did I spend other than gas"                -> $192 on Transportation
"what did I spend apart from dining this month"      -> $54 on Dining
"how much did I spend not counting groceries"        -> $340 on Groceries
"spending excluding shopping this month"             -> $829.98 on Shopping
```

Phone parser (`mobile/src/ask/intent.ts:305-308`) — identical, all five return
`spend_category` for the excluded category.

**Live:** "what did I spend excluding rent last month" returned a confident four-figure
total for the utilities category. The number is real; it is the answer to a question that
was not asked, and nothing signals that.

`NON_RECURRING` (`intent.ts:164`) is the only negation either brain knows, and only
`biggest_expenses`/`subscriptions` consult it.

**Fix:** guard both routers — on `/\b(excluding|except|besides|other than|not counting|
apart from|aside from|minus|without)\b/`, return "I can't do exclusions yet" unless the
phrase is one a retriever actually implements. Refusing is strictly better than inverting.

---

### 5 · HIGH — Phone silently collapses unparsed time windows to "this month"

`mobile/src/ask/intent.ts:83-150` — verified against fixed `now` = Tue 15 Sep 2026:

| Question | Phone window | Laptop window |
|---|---|---|
| "in the last 3 months" | **this month** | last 90 days |
| "in the past year" | **this month** | last 12 months |
| "last quarter" | **this month** | last 90 days |
| "over the past month" | **this month** | last 30 days |
| "in the last 6 months" | **this month** | last 30 days |

`hasTimePhrase()` returns `true` for all of these, so the dropped phrase is never noticed.
"How much did I spend on groceries in the last 3 months?" returns **one month's** number,
labelled "this month" — a ~3× understatement the user has no way to spot.

The laptop handles all five correctly (verified), so the answer also **changes depending
on whether the laptop was reachable**.

**Fix:** `resolvePeriod` should return `null` when a time phrase is present but unmatched,
and `parseLocalIntent` should refuse; then add the missing branches mirroring
`parse_window`.

---

### 6 · HIGH — Phone answers a merchant question with the whole-month total

`mobile/src/ask/intent.ts:299-310`

When the merchant extractor can't parse the store (leading non-alphanumeric, >40 chars, or
a stop word), the question falls through to `spend_total`:

```
"how much did I spend at A&W"    -> spend_total   (grand total, every merchant)
"how much did I spend at Home"   -> spend_total   ('home' hits OBJECT_STOP)
"how much did I spend at Total Wine" -> merchant "wine"  (stripNoise mangles it)
```

A large, confident, unrelated number with no hint the store was dropped. The laptop
correctly refuses ("I don't see any charges from A&W").

Related, same file: `"how many purchases did I make at Costco this month"` →
**`income_total`** — a spending question answered with a deposits figure, because `make`
is in the income regex at `:255` and fires before the purchase-count rule at `:297`.

**Fix:** if `at|from` is present but extraction failed, return `null`. Require money-in
context for the bare verbs `make|made`.

---

### 7 · MEDIUM — Ungrounded fallback is dead code; it can never produce an answer

`services/assistant.py:74-93` · **proven end-to-end**

`_template()` reads `net_worth`, `current`, `change`, `delta`, `total`, `spending`. The
bundles publish `latest_net_worth_dollars`, `change_dollars`, `total_spent_dollars`. **No
key overlaps**, so both `if` blocks are permanently false.

Run against the seeded household:

```
_template()      -> "I don't have that in the current snapshot — try the Dashboard
                     or Research tab. (Local model is off …)"
_briefing_text() -> "Net worth is about $73,250, up $500 today. You've spent about
                     $3,190 over the past 30 days."
```

Same snapshot. The data was right there. This is the path users hit when
`assistant_retrieval` raises — the moment a useful fallback matters most.

**Fix:** delete `_template` and call `_briefing_text(snap)`, which already uses the right keys.

---

### 8 · MEDIUM — Briefing's reliability guard reads a key that doesn't exist

`services/assistant.py:129`

```python
if chg is not None and not nw.get("change_unreliable"):
```

`change_unreliable` appears **exactly once in the backend — here, on the read side.**
Nothing writes it. The bundle signals this with **`baseline_truncated`**
(`chat_prompts.py:432`), confirmed present on a live snapshot. The guard therefore never
fires.

Impact: with only a few days of snapshots, the briefing still states a confident delta —
then the model rephrases it and it is **spoken aloud**. Grounding can't catch this class:
the number really is in the snapshot. Only the deterministic layer can.

**Fix:** `not nw.get("baseline_truncated")`.

---

### 9 · MEDIUM — Multi-entity questions silently answer about one entity

Laptop, verified:

```
"how much did I spend at Grocer Mart and Mega Mart"  -> $340 at Grocer Mart …
"how much did I spend on groceries and dining"       -> $340 on Groceries …
```

The second entity is dropped with no disclosure. (`compare` handles "X vs Y" but not
"X and Y".) On his live category set the food case happens to merge correctly into
"Food & Dining" — the merchant case does not.

**Fix:** detect a second entity and either sum both with both named, or refuse.

---

### 10 · MEDIUM — Questions answered with a different question's answer

Verified on both brains and live:

- `"has my spending gone up"` → `unusual_charges` → returns first-time merchants and an
  outlier charge. Never answers up-or-down. (`"why is my spending up"` correctly reaches
  `spending_compare`.) `\bgone up\b` sits in the `unusual` trigger, which is evaluated
  first.
- `"how much did I spend a week ago"` → `monthly_average` → "you usually spend about
  $711.86 a week, averaged over the last 6 months." A point-in-time question answered with
  a long-run average. Cause: the bare `a` in `/(per|a|each|every) (week|month)/`.

**Fix:** exclude `spend|spending|budget` from the `unusual` trigger; treat
`a (week|month) ago` as a time phrase, not an averaging unit.

---

### 11 · MEDIUM — Six retrievers bypass the injectable clock, blinding the regression net

`assistant_retrieval.py:1091, 1375, 1431, 1462, 1589, 1670, 2093`

The module defines `_now()` (`:40-41`) with the explicit comment *"so tests and the eval
harness can pin the clock."* Seven sites call `date.today()` directly instead —
`budget_category`, `goals`, `trading_tax`, `hsa`, and three others.

**This is not a wrong number in production** (there `_TODAY == date.today()`). It is worse
in one specific way: any test that pins the clock gets **silently wrong results** from
these retrievers. I hit this directly — `budget_category` reported half the true MTD
grocery spend under the fixture's pinned date, while `category_spend` reported it
correctly. These retrievers are effectively **untestable**, which is why the budget path
has no meaningful date regression coverage.

**Fix:** replace all seven with `_now()`.

---

### 12 · MEDIUM — Ollama down ⇒ hard 503 on the two highest-traffic surfaces

`chat.py:253-254`, `analytics.py:2882-2883`

The assistant, research and rotation paths all degrade to a deterministic template. The
Ask panel and Dashboard card instead raise 503 — even though both already hold the
computed `bundle` and both have a rendering path for it. Ollama being down is a *normal*
state for an optional local daemon (laptop asleep, `ollama serve` not running).

**Fix:** return `{answer: None, bundle, source: "degraded"}` and render the template.

---

### 13 · MEDIUM — Phone reports "$0" / "no debt" on an unsynced mirror

`mobile/src/ask/local.ts:399-416`

`netWorth()` is a bare `SUM()` with no row-count check. On a fresh install, mid-first-sync,
or after the schema-bump `DROP TABLE` path, "What's my net worth?" answers **"Your net
worth is $0.00 — $0.00 in assets against $0.00 owed."** `debtTotal` similarly answers "No
balances owed on file." The laptop refuses in this situation (`:553-559`).

Most other phone answers are honest about empty state — these three are the outliers.

**Fix:** guard on `SELECT COUNT(*)`; surface `lastSyncedAt` in `basis`.

---

### 14 · Lower severity — confirmed, batched

- **Injection surface.** Merchant names, account names and research `thesis`/`message`
  free-text flow unsanitised into prompts (`insights_narrative.py:222, :356`,
  `chat_prompts.py:864`, `research_synthesis.py:127-140`). The research path is the widest:
  no grounding check downstream, so a crafted note has a clean path to model output. *No
  XSS* — I checked; zero `dangerouslySetInnerHTML` in the frontend, and SSE frames are
  `json.dumps`-encoded.
- **`has_model()` missing on 5 of 7 paths.** `llm_ollama.py:84-92` documents why it matters
  (Ollama silently starts a multi-GB pull). Change `LLM_MODEL` without pulling and every
  Ask Tusk question stalls the full 60 s `COMPLETION_TIMEOUT_S`, then quietly returns the
  deterministic answer.
- **Two HTTP round trips per answer.** `_maybe_rephrase` (`:2541`, called on *every*
  successful retrieval) does `health()` then `complete()` for a cosmetic rewrite that is
  discarded if the check fails.
- **No wall-clock deadline on streams.** `llm_ollama.py:191-196` — httpx `timeout` is
  per-socket-read, not total.
- **`except (LLMUnavailable, Exception)`** (`assistant.py:163`, `research_synthesis.py:363`,
  `assistant_retrieval.py:2463`) reports genuine `KeyError`/`AttributeError` bugs to the
  user as "local model unavailable", and logs nothing.
- **Client-forgeable history.** `assistant.py:99-103` renders any turn whose `who` != `"you"`
  as `Tusk:`, and neither `AskIn.history` nor `AskRequest.history` caps length.
- **Phone/laptop window divergence** — "last week": phone = previous Sun–Sat, laptop =
  rolling 7 days. "last 30 days": 30 vs 31 days inclusive. Same question, two answers,
  depending on connectivity.
- **Phone refund divergence** — phone's `SPEND` is `(amount > 0 OR is_refund = 1)`; the
  laptop's `_spend_q` is `amount > 0` only. After a large return the two brains disagree.
- **Phone `top_categories` percentages** are shares of the top 6, not of all spending
  (`local.ts:210-225`), so they overstate and sum to 100%.
- **Phone overrides the laptop's refusal** (`AskScreen.tsx:149-151`) — whenever the laptop
  honestly declines, the phone's looser matching answers instead, marked only "Answered on
  this phone."
- **No advice guard on the phone** — "should I cancel my subscriptions" is answered with
  data; the laptop refuses.

---

## Rejected during verification

Two findings looked real and did not survive checking. Recording them so they aren't
re-raised:

- **"`largest_transactions` hides the mortgage."** Ground truth showed a $1,800 mortgage
  outranking the $640 answer. It is **deliberate and documented** (`:471-472`): loan
  payments are obligations, not purchases, "and otherwise they win every month." Correct
  as designed.
- **"10 transaction-search tests fail."** They fail only because `DEV_BYPASS_AUTH` isn't
  set in the audit container. With it set: **10/10 pass.** Environmental, not a defect.

---

## Not covered

- **Voice loop end-to-end.** Backend reports STT+TTS available and enabled; mic capture,
  VAD thresholds and TTS playback need a human at the Mac.
- **Prompt injection was not executed live** — I did not write a crafted merchant into the
  real ledger. The finding rests on tracing the data path, not a live exploit.
- **The LLM router (`_llm_route`) long-tail path** is exercised only when the keyword
  router misses; live spot-checks all hit the keyword path.
- **`local.ts` has no Node test** (needs an `expo-sqlite` stub), so phone *retrieval* — as
  opposed to routing — is unverified by any automated test.

---

## Suggested order

1. **#3 and #4** — the two that produce confidently wrong answers to real questions today.
   Both are small, local guards. Highest value per line changed.
2. **#1** — fix `grounding_ok`; everything else in the LLM layer depends on it being real.
3. **#2** — wire the fixed check into the five ungrounded surfaces; convert chat/analytics
   to the generate-then-approve-then-chunk pattern `routers/assistant.py` already uses.
4. **#7, #8, #11** — deterministic-layer bugs. Grounding cannot save a wrong ground truth.
5. **#5, #6, #13** — the phone's wrong-answer paths, all violations of the existing
   "null over wrong" rule.
6. **#12, #14** — resilience and hygiene.

**Test-suite gap worth closing first:** the corpus tests pin *routing*, never *refusal*.
Adding a `MUST_REFUSE` corpus — negations, unparsable windows, unnamed payables, unparsed
merchants — would have caught #3, #4, #5 and #6 before they shipped, and is cheap.
