/**
 * On-device intent parser — the offline half of Ask Tusk on the phone.
 *
 * The real assistant lives on the laptop (services/assistant_retrieval:
 * ~45 grounded retrievers, a local model to narrate). Away from home Wi-Fi
 * the phone can't reach it, but the questions people actually ask in a
 * store are a short list, and the SQLite mirror (plus the cached
 * safe-to-spend / weekly-digest insights) can answer them exactly. This
 * module maps a question to one of those intents with ordered pattern
 * rules — no model, no network, deterministic, unit-tested in Node
 * (scripts/test-ask-intent.mjs).
 *
 * Design rules, learned from the first version:
 *   - Specific before general. "did I pay the mortgage this month" must
 *     never fall through to spend_total just because it says "month".
 *   - Prefer null over a confident wrong answer. spend_total needs a real
 *     spend verb or "how much"; a question we don't understand returns
 *     null and the screen says it needs the laptop.
 *   - Periods are explicit [start, endExclusive) local-calendar dates so
 *     the SQL layer never re-derives them.
 *
 * Intents (all read-only):
 *   help, briefing, spend_total, spend_category, spend_merchant (incl.
 *   lastOnly / visits), spend_compare, top_categories, biggest_expenses,
 *   average_spend, recent_transactions, income_total, cash_flow, balance,
 *   debt_total, net_worth, upcoming_bills (incl. biggest / withinDays),
 *   payment_made, budget_status, affordability, next_paycheck, unusual.
 */

export type Period = {
  label: string;
  start: string; // YYYY-MM-DD inclusive
  end: string;   // YYYY-MM-DD exclusive
};

export type LocalIntent =
  | { kind: 'help' }
  | { kind: 'briefing' }
  | { kind: 'spend_total'; period: Period }
  | { kind: 'spend_category'; category: string; period: Period }
  | { kind: 'spend_merchant'; merchant: string; period: Period | null; lastOnly: boolean; visits: boolean }
  | { kind: 'spend_compare' }
  | { kind: 'top_categories'; period: Period }
  | { kind: 'biggest_expenses'; period: Period; limit: number }
  | { kind: 'average_spend'; target: string | null; unit: 'purchase' | 'week' | 'month' }
  | { kind: 'recent_transactions'; merchant: string | null; period: Period | null }
  | { kind: 'income_total'; period: Period }
  | { kind: 'cash_flow'; period: Period }
  | { kind: 'balance'; account: string | null }
  | { kind: 'debt_total' }
  | { kind: 'net_worth' }
  | { kind: 'upcoming_bills'; name: string | null; biggest: boolean; withinDays: number | null }
  | { kind: 'payment_made'; what: 'mortgage' | 'card' | 'rent' | 'payment'; period: Period }
  | { kind: 'budget_status'; category: string | null }
  | { kind: 'affordability'; amount: number | null }
  | { kind: 'next_paycheck' }
  | { kind: 'unusual' };

function iso(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july',
  'august', 'september', 'october', 'november', 'december'];
const MONTH_RE = '(january|february|march|april|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept|sep|oct|nov|dec)';

function monthIndex(word: string): number {
  const w = word.slice(0, 3);
  return MONTHS.findIndex((m) => m.startsWith(w));
}

/** Did the question say WHEN? (Used to decide whether a default period is an assumption.) */
export function hasTimePhrase(q: string): boolean {
  return /\b(today|yesterday|this|last|past|previous|since|ytd|year to date|\d+\s+days|weekend|week|month|year)\b/.test(q)
    || new RegExp(`\\b${MONTH_RE}\\b`).test(q);
}

/** Resolve a time phrase to a period. Defaults to "this month". */
export function resolvePeriod(q: string, now: Date): Period {
  const y = now.getFullYear();
  const m = now.getMonth();
  const today = new Date(y, m, now.getDate());
  const tomorrow = new Date(today); tomorrow.setDate(today.getDate() + 1);

  if (/\btoday\b/.test(q)) return { label: 'today', start: iso(today), end: iso(tomorrow) };
  if (/\byesterday\b/.test(q)) {
    const s = new Date(today); s.setDate(s.getDate() - 1);
    return { label: 'yesterday', start: iso(s), end: iso(today) };
  }
  // "since July" / "since the start of the year"
  const since = new RegExp(`\\bsince\\s+${MONTH_RE}\\b`).exec(q);
  if (since) {
    const mi = monthIndex(since[1]);
    const yr = mi <= m ? y : y - 1;
    return { label: `since ${MONTHS[mi][0].toUpperCase()}${MONTHS[mi].slice(1)}`, start: iso(new Date(yr, mi, 1)), end: iso(tomorrow) };
  }
  if (/\bsince (the )?(start|beginning) of (the|this) year\b/.test(q)) {
    return { label: 'this year', start: iso(new Date(y, 0, 1)), end: iso(tomorrow) };
  }
  // weekends
  if (/\b(this|last|past|the) weekend\b/.test(q)) {
    const back = (today.getDay() + 1) % 7;           // days since the most recent Saturday
    const sat = new Date(today); sat.setDate(today.getDate() - back);
    if (/\blast weekend\b/.test(q) && back < 2) sat.setDate(sat.getDate() - 7);
    const end = new Date(sat); end.setDate(sat.getDate() + 2);
    return { label: /\blast weekend\b/.test(q) ? 'last weekend' : 'this weekend', start: iso(sat), end: iso(end) };
  }
  // "last N days" / "past N days"
  const nd = /\b(?:last|past|previous)\s+(\d{1,3})\s+days\b/.exec(q);
  if (nd) {
    const n = parseInt(nd[1], 10);
    const s = new Date(today); s.setDate(s.getDate() - (n - 1));
    return { label: `the last ${n} days`, start: iso(s), end: iso(tomorrow) };
  }
  if (/\blast week\b/.test(q)) {
    const dow = today.getDay();
    const thisSunday = new Date(today); thisSunday.setDate(today.getDate() - dow);
    const prevSunday = new Date(thisSunday); prevSunday.setDate(thisSunday.getDate() - 7);
    return { label: 'last week', start: iso(prevSunday), end: iso(thisSunday) };
  }
  if (/\b(this|past|the)\s+week\b|\b7\s+days\b/.test(q)) {
    const s = new Date(today); s.setDate(s.getDate() - 6);
    return { label: 'the last 7 days', start: iso(s), end: iso(tomorrow) };
  }
  if (/\b(last|past)\s+30\s+days\b/.test(q)) {
    const s = new Date(today); s.setDate(s.getDate() - 29);
    return { label: 'the last 30 days', start: iso(s), end: iso(tomorrow) };
  }
  if (/\b(last|previous)\s+month\b/.test(q)) {
    return { label: 'last month', start: iso(new Date(y, m - 1, 1)), end: iso(new Date(y, m, 1)) };
  }
  if (/\b(this\s+year|ytd|year\s+to\s+date)\b/.test(q)) {
    return { label: 'this year', start: iso(new Date(y, 0, 1)), end: iso(new Date(y + 1, 0, 1)) };
  }
  if (/\blast\s+year\b/.test(q)) {
    return { label: 'last year', start: iso(new Date(y - 1, 0, 1)), end: iso(new Date(y, 0, 1)) };
  }
  const named = new RegExp(`\\b${MONTH_RE}\\b`).exec(q);
  if (named) {
    const mi = monthIndex(named[1]);
    const yr = mi <= m ? y : y - 1;   // a future-named month means last year's
    const name = MONTHS[mi];
    return { label: name[0].toUpperCase() + name.slice(1), start: iso(new Date(yr, mi, 1)), end: iso(new Date(yr, mi + 1, 1)) };
  }
  return { label: 'this month', start: iso(new Date(y, m, 1)), end: iso(new Date(y, m + 1, 1)) };
}

/** Remove time words and punctuation so the object of the question is what's left. */
function stripNoise(s: string): string {
  return s
    .replace(/\b(this|last|previous|past|the)\s+(month|week|weekend|year|\d+\s+days)\b/g, ' ')
    .replace(new RegExp(`\\bsince\\s+${MONTH_RE}\\b`, 'g'), ' ')
    .replace(new RegExp(`\\b(in|for|during|back in)?\\s*${MONTH_RE}\\b`, 'g'), ' ')
    .replace(/\b(today|yesterday|ytd|year to date|so far|in total|total|altogether|usually|typically|on average|per|each|a|every)\b/g, ' ')
    .replace(/[?.!,]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const SPEND_VERB = /\b(spent|spend|spending|paid|pay|paying|cost|blow|blew|dropped|drop|bought|buy|purchases?|expenses?|charges?)\b/;
const HOW_MUCH = /\b(how much|what did|what have|what've|what'?s|total)\b/;
const OBJECT_STOP = /^(all|everything|home|work|the store|it|that|things|stuff|money|cash)$/;

function tail(q: string, prep: string): string | null {
  const m = new RegExp(`\\b(?:${prep})\\s+(?:my\\s+)?([a-z0-9][a-z0-9 &'.-]{1,40}?)\\s*$`).exec(stripNoise(q));
  if (!m) return null;
  const v = m[1].trim().replace(/\s+(account|store|shop)$/, '');
  return v && !OBJECT_STOP.test(v) ? v : null;
}

function parseAmount(q: string): number | null {
  const m = /\$\s*([\d,]+(?:\.\d+)?)\s*(k)?|\b([\d,]+(?:\.\d+)?)\s*(k|dollars|bucks)\b/.exec(q);
  if (!m) return null;
  const raw = (m[1] || m[3] || '').replace(/,/g, '');
  const n = parseFloat(raw) * ((m[2] || m[4]) === 'k' ? 1000 : 1);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function parseLocalIntent(question: string, now: Date = new Date()): LocalIntent | null {
  const q = question.toLowerCase().replace(/[’']/g, "'").replace(/\s+/g, ' ').trim();
  if (!q) return null;
  const period = resolvePeriod(q, now);

  // ── 0. greetings / help ──────────────────────────────────────
  if (/^(hi|hello|hey|yo|howdy|good (morning|afternoon|evening)|thanks|thank you|help)( tusk)?[!. ]*$/.test(q)
      || /\b(what can (you|i) (do|ask)|how do (you|i) (work|use this)|what do you know)\b/.test(q)) {
    return { kind: 'help' };
  }
  // ── 0a. "how am I doing / what's new / summary" → briefing ──
  if (/^(how am i doing|how'?s it (going|looking)|how are things( looking)?|what'?s new|what'?s (up|going on)|anything new)[?!. ]*$/.test(q)
      || /\b(summary|summarize|rundown|overview|recap|briefing|catch me up|big picture)\b/.test(q)) {
    return { kind: 'briefing' };
  }
  // ── 0b. affordability (cached safe-to-spend) ─────────────────
  if (/\b(afford|can i (buy|spend|swing)|safe to spend|okay to spend|ok to spend|room to spend|after (my |the )?bills|until payday)\b/.test(q)) {
    return { kind: 'affordability', amount: parseAmount(q) };
  }
  // ── 0c. next paycheck ────────────────────────────────────────
  if (/\b(next (paycheck|pay ?day)|when('?s| is| do i) .*\b(paid|payday|paycheck)|\bpay ?day\b)/.test(q)) {
    return { kind: 'next_paycheck' };
  }
  // ── 0d. unusual / price changes (cached digest) ──────────────
  if (/\b(unusual|weird|strange|odd|suspicious|anomal\w*|out of the ordinary|red flags?|price (hike|increase)s?|went up|charging me more|(get|got|gotten|become) more expensive|gone up)\b/.test(q)
      && !/\bnet\s*worth\b/.test(q)) {
    return { kind: 'unusual' };
  }
  // ── 1. net worth ─────────────────────────────────────────────
  if (/\bnet\s*worth\b/.test(q)) return { kind: 'net_worth' };
  // ── 1a. total debt ───────────────────────────────────────────
  if (/\b(total debt|how much (do i owe|debt)|my liabilities|owe in total|what do i owe)\b/.test(q) && !/\b(card|mortgage|loan|on the|on my)\b/.test(q)) {
    return { kind: 'debt_total' };
  }
  // ── 2. payments made ("did I pay the mortgage") ──────────────
  if (/\b(did i pay|have i paid|was .* paid|is .* (payment )?(made|posted|paid|through)|did (the|my) .* (payment|autopay) (go|post|clear))\b/.test(q)) {
    const what = /\bmortgage|home loan|house payment\b/.test(q) ? 'mortgage' : /\bcard\b/.test(q) ? 'card' : /\brent\b/.test(q) ? 'rent' : 'payment';
    return { kind: 'payment_made', what, period: hasTimePhrase(q) ? period : resolvePeriod('this month', now) };
  }
  // ── 3. bills ─────────────────────────────────────────────────
  if (/\b(bills?|due|payment due|mortgage payment|car payment|owe soon)\b/.test(q) && !SPEND_VERB.test(q.replace(/\bpayment\b/g, ''))
      && !/\b(average|avg|typical|usual|usually)\b/.test(q)) {
    const m = /\b(?:when is|when's|is|for)\s+(?:the|my)?\s*([a-z][a-z0-9 &'-]{1,40}?)\s+(?:due|payment)/.exec(q);
    let name = m ? m[1].replace(/\b(bill|payment|next)\b/g, '').trim() : null;
    if (!name && /\bmortgage|home loan\b/.test(q)) name = 'mortgage';
    if (!name && /\bcard\b/.test(q)) name = 'card';
    const withinDays = /\b(this|next) week\b|\bnext (7|seven) days\b/.test(q) ? 7 : /\bthis month\b/.test(q) ? 31 : null;
    return { kind: 'upcoming_bills', name: name || null, biggest: /\b(biggest|largest|most expensive)\b/.test(q), withinDays };
  }
  // ── 4. budget ────────────────────────────────────────────────
  if (/\bbudget/.test(q) || /\b(over|under)\s+(on|in)\b/.test(q) || /\bon track\b/.test(q) || /\b(left|remaining) (this month|for the month|to spend)\b/.test(q)) {
    const m = /\b(?:on|in|for)\s+(?:my\s+)?([a-z][a-z &'-]{1,30}?)(?:\s+budget)?\s*$/.exec(stripNoise(q));
    let cat = m ? m[1].trim() : null;
    if (cat && /^(my|the|budget|this|it|track)$/.test(cat)) cat = null;
    return { kind: 'budget_status', category: cat };
  }
  // ── 5. balances ──────────────────────────────────────────────
  if (/\b(balances?|how much (is|do i have) in|how much money (is|do i have)|what'?s in my|how much cash|how much money do i have|what do i owe on)\b/.test(q)) {
    const m = /\b(?:in|on)\s+(?:my\s+|the\s+)?([a-z][a-z0-9 &'-]{1,40}?)(?:\s+account)?\s*(?:balance)?\s*$/.exec(stripNoise(q))
      || /\b(?:my|the)\s+([a-z][a-z0-9 &'-]{1,40}?)\s+(?:account\s+)?balance\b/.exec(q);
    let acct = m ? m[1].trim() : null;
    if (acct && /^(my|the|bank|account|accounts|total|cash|money|there)$/.test(acct)) acct = null;
    if (acct && /\band\b/.test(acct)) acct = null;   // "checking and savings" → all cash accounts
    return { kind: 'balance', account: acct };
  }
  // ── 6. saving / cash flow ────────────────────────────────────
  if (/\b(am i saving|saving (any )?money|did i save|save any(thing)?|how much (did|have) i saved?|income (vs\.?|versus|and|compared to|against) (my )?spend\w*|cash ?flow|in (and|vs) out)\b/.test(q)
      && !/\bsavings? (rate|account|balance)\b/.test(q)) {
    return { kind: 'cash_flow', period };
  }
  // ── 7. income ────────────────────────────────────────────────
  if (/\b(income|earn|earned|make|made|paid me|deposits?|paycheck|get paid|got paid|take[- ]?home)\b/.test(q) && !/\b(spent|spend)\b/.test(q)) {
    return { kind: 'income_total', period };
  }
  // ── 8. comparisons ───────────────────────────────────────────
  if ((/\b(compare|compared|vs\.?|versus|more than|less than|than last)\b/.test(q) && /\b(spend|spent|spending|month)\b/.test(q))
      || /\b(why|what('?s| is) driving)\b.*\b(spend|spending|spent|expenses?)\b/.test(q)) {
    return { kind: 'spend_compare' };
  }
  // ── 9. where does the money go / top categories ──────────────
  if (/\bwhere (does|is|did|do) (most of )?(my|the) money (go|going|went)\b|\bwhat (am i|do i|did i) spend(ing)? (the )?most on\b|\btop categor|\bbiggest categor|\bbreak ?down\b/.test(q)) {
    return { kind: 'top_categories', period };
  }
  // ── 10. biggest / top N purchases ────────────────────────────
  if (/\b(biggest|largest|top|most expensive)\b/.test(q) && /\b(purchases?|expenses?|charges?|transactions?|spend|buys?)\b/.test(q)) {
    const n = /\btop\s+(\d{1,2})\b/.exec(q);
    return { kind: 'biggest_expenses', period, limit: n ? Math.min(parseInt(n[1], 10), 10) : /\btop\b/.test(q) ? 3 : 5 };
  }
  // ── 11. averages ─────────────────────────────────────────────
  if (/\b(average|avg|typical|usually|typically|on average)\b/.test(q) || /\b(per|a|each|every) (week|month)\b/.test(q)) {
    const unit: 'purchase' | 'week' | 'month' = /\b(per|a|each|every) week\b|\bweekly\b/.test(q) ? 'week'
      : /\b(per|a|each|every) month\b|\bmonthly\b/.test(q) ? 'month' : 'purchase';
    const t = tail(q.replace(/\b(per|a|each|every) (week|month)\b|\b(weekly|monthly)\b/g, ''), 'on|for|at|from')
      || (/\b(grocery|groceries)\b/.test(q) ? 'groceries' : null);
    const target = t ? t.replace(/\b(bill|run|trip|order|purchase|spending|spend|week|month)\b/g, '').trim() || null : null;
    return { kind: 'average_spend', target, unit };
  }
  // ── 12. recent / list ────────────────────────────────────────
  if (/\b(recent|latest|last few|most recent|show me|list)\b.*\b(transactions?|purchases?|charges?|buys?|spending)\b/.test(q)
      || /\bwhat did i (buy|purchase|get)\b/.test(q)) {
    const merchant = tail(q, 'at|from');
    return { kind: 'recent_transactions', merchant, period: hasTimePhrase(q) ? period : null };
  }
  // ── 13. how often at a store ─────────────────────────────────
  if (/\b(how often|how many times|how frequently)\b/.test(q)) {
    const merchant = tail(q, 'go to|shop at|visit|eat at|stop at|at|buy from|order from|to');
    if (merchant) return { kind: 'spend_merchant', merchant, period, lastOnly: false, visits: true };
  }
  // ── 14. counts ───────────────────────────────────────────────
  if (/\bhow many (transactions?|purchases?|charges?)\b/.test(q)) return { kind: 'spend_total', period };
  // ── 15. spending: merchant / category / total ────────────────
  if (SPEND_VERB.test(q) || HOW_MUCH.test(q)) {
    const lastOnly = /\b(last time|most recent|latest|last visit|last trip)\b/.test(q);
    const atM = tail(q.replace(/\b(last time|most recently|recently|so far)\b/g, ''), 'at|from|with');
    if (atM) return { kind: 'spend_merchant', merchant: atM, period: lastOnly ? null : period, lastOnly, visits: false };
    const onM = tail(q, 'on|for');
    if (onM) return { kind: 'spend_category', category: onM, period };
    if (/\b(eating out|dining out|restaurants?|takeout|groceries|gas|fuel|coffee|entertainment|utilities|shopping|travel)\b/.test(q)) {
      const word = /\b(eating out|dining out|restaurants?|takeout|groceries|gas|fuel|coffee|entertainment|utilities|shopping|travel)\b/.exec(q)![1];
      return { kind: 'spend_category', category: word, period };
    }
    if (/\b(spent|spend|spending|how much did i pay|expenses?|purchases?)\b/.test(q)) return { kind: 'spend_total', period };
  }

  return null;
}
