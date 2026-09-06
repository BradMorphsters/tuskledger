/**
 * On-device intent parser — the offline half of Ask Tusk on the phone.
 *
 * The real assistant lives on the laptop (services/assistant_retrieval:
 * 38 retrievers, a local model to narrate). Away from home Wi-Fi the phone
 * can't reach it, but the questions people actually ask standing in a
 * store are a short list, and the SQLite mirror can answer them exactly.
 * This module maps a question to one of those intents with plain pattern
 * matching — no model, no network, deterministic, unit-tested in Node
 * (scripts/test-ask-intent.mjs).
 *
 * Intents (all read-only, all answerable from the mirror):
 *   spend_total        "how much have I spent this month / last month / this week"
 *   spend_category     "how much on groceries this month"
 *   spend_merchant     "how much at costco", "what did I spend at costco last time"
 *   income_total       "how much did I make this month"
 *   balance            "what's my checking balance", "how much is in savings"
 *   net_worth          "what's my net worth"
 *   upcoming_bills     "what bills are due", "when is the mortgage due"
 *   budget_status      "how am I doing on my budget", "am I over on dining"
 *   biggest_expenses   "biggest purchases this month"
 *
 * Anything else → null, and the screen tells the user that question needs
 * the laptop.
 *
 * Period resolution is local-calendar based and returns explicit
 * [start, endExclusive) ISO dates so the SQL layer never re-derives it.
 */

export type Period = {
  label: string;
  start: string; // YYYY-MM-DD inclusive
  end: string;   // YYYY-MM-DD exclusive
};

export type LocalIntent =
  | { kind: 'spend_total'; period: Period }
  | { kind: 'spend_category'; category: string; period: Period }
  | { kind: 'spend_merchant'; merchant: string; period: Period | null; lastOnly: boolean }
  | { kind: 'income_total'; period: Period }
  | { kind: 'balance'; account: string | null }
  | { kind: 'net_worth' }
  | { kind: 'upcoming_bills'; name: string | null }
  | { kind: 'budget_status'; category: string | null }
  | { kind: 'biggest_expenses'; period: Period; limit: number };

function iso(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july',
  'august', 'september', 'october', 'november', 'december'];

/** Resolve a time phrase to a period. Defaults to "this month". */
export function resolvePeriod(q: string, now: Date): Period {
  const y = now.getFullYear();
  const m = now.getMonth();
  const today = new Date(y, m, now.getDate());

  if (/\b(today)\b/.test(q)) {
    const t = new Date(today); t.setDate(t.getDate() + 1);
    return { label: 'today', start: iso(today), end: iso(t) };
  }
  if (/\byesterday\b/.test(q)) {
    const s = new Date(today); s.setDate(s.getDate() - 1);
    return { label: 'yesterday', start: iso(s), end: iso(today) };
  }
  if (/\b(this|past|last)\s+(7\s+days|week)\b/.test(q) || /\bthis week\b/.test(q)) {
    const lastWeek = /\blast week\b/.test(q);
    if (lastWeek) {
      // Previous Sunday..Saturday block.
      const dow = today.getDay();
      const thisSunday = new Date(today); thisSunday.setDate(today.getDate() - dow);
      const prevSunday = new Date(thisSunday); prevSunday.setDate(thisSunday.getDate() - 7);
      return { label: 'last week', start: iso(prevSunday), end: iso(thisSunday) };
    }
    const s = new Date(today); s.setDate(s.getDate() - 6);
    const e = new Date(today); e.setDate(e.getDate() + 1);
    return { label: 'the last 7 days', start: iso(s), end: iso(e) };
  }
  if (/\blast\s+(30\s+days|month)\b/.test(q) && /\b30\s+days\b/.test(q)) {
    const s = new Date(today); s.setDate(s.getDate() - 29);
    const e = new Date(today); e.setDate(e.getDate() + 1);
    return { label: 'the last 30 days', start: iso(s), end: iso(e) };
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
  for (let i = 0; i < 12; i++) {
    const name = MONTHS[i];
    if (new RegExp(`\\b(in\\s+)?${name}\\b`).test(q) || new RegExp(`\\b${name.slice(0, 3)}\\b`).test(q)) {
      // A named month in the future refers to last year's instance.
      const year = i > m ? y - 1 : y;
      return {
        label: name[0].toUpperCase() + name.slice(1),
        start: iso(new Date(year, i, 1)),
        end: iso(new Date(year, i + 1, 1)),
      };
    }
  }
  return { label: 'this month', start: iso(new Date(y, m, 1)), end: iso(new Date(y, m + 1, 1)) };
}

/** Strip a leading "how much did I spend" style stem and time words to leave the object. */
function stripNoise(s: string): string {
  return s
    .replace(/\b(this|last|previous|past)\s+(month|week|year|7\s+days|30\s+days)\b/g, ' ')
    .replace(/\b(today|yesterday|ytd|year to date|so far|in total|total|altogether)\b/g, ' ')
    .replace(new RegExp(`\\b(in\\s+)?(${MONTHS.join('|')})\\b`, 'g'), ' ')
    .replace(/[?.!,]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const SPEND_STEM = /\b(spent|spend|spending|paid|pay|cost|blow|blew|dropped|drop)\b/;
const HOW_MUCH = /\b(how much|what did|what have|what've|whats|what's|total)\b/;

export function parseLocalIntent(question: string, now: Date = new Date()): LocalIntent | null {
  const q = question.toLowerCase().replace(/[’']/g, "'").trim();
  if (!q) return null;
  const period = resolvePeriod(q, now);

  // ── net worth ────────────────────────────────────────────────
  if (/\bnet\s*worth\b/.test(q)) return { kind: 'net_worth' };

  // ── bills ────────────────────────────────────────────────────
  if (/\b(bills?|due|payment due|mortgage due|card due|owe)\b/.test(q) && !/\bspent\b/.test(q)) {
    const m = /\b(?:when is|when's|is)\s+(?:the|my)?\s*([a-z][a-z0-9 &'-]{1,40}?)\s+(?:due|payment)/.exec(q);
    const name = m ? m[1].replace(/\b(bill|payment|next)\b/g, '').trim() : null;
    return { kind: 'upcoming_bills', name: name || null };
  }

  // ── budget ───────────────────────────────────────────────────
  if (/\bbudget/.test(q) || /\b(over|under)\s+(on|in)\b/.test(q) || /\bhow am i doing\b/.test(q)) {
    const m = /\b(?:on|in|for)\s+(?:my\s+)?([a-z][a-z &'-]{1,30}?)(?:\s+budget)?\s*$/.exec(stripNoise(q).replace(/\bbudget\b/g, 'budget'));
    let cat = m ? m[1].trim() : null;
    if (cat && /^(my|the|budget|this|it)$/.test(cat)) cat = null;
    return { kind: 'budget_status', category: cat };
  }

  // ── balances ─────────────────────────────────────────────────
  if (/\b(balances?|how much (is|do i have) in|how much money (is|do i have)|what'?s in my|how much cash)\b/.test(q)) {
    const m = /\b(?:in|on)\s+(?:my\s+)?([a-z][a-z0-9 &'-]{1,40}?)(?:\s+account)?\s*(?:balance)?\s*$/.exec(stripNoise(q))
      || /\b(?:my|the)\s+([a-z][a-z0-9 &'-]{1,40}?)\s+(?:account\s+)?balance\b/.exec(q);
    let acct = m ? m[1].trim() : null;
    if (acct && /^(my|the|bank|account|accounts|total|cash|money)$/.test(acct)) acct = null;
    return { kind: 'balance', account: acct };
  }

  // ── income ───────────────────────────────────────────────────
  if (/\b(income|earn|earned|make|made|paid me|deposits?|paycheck)\b/.test(q) && !/\b(spent|spend)\b/.test(q)) {
    return { kind: 'income_total', period };
  }

  // ── biggest expenses ─────────────────────────────────────────
  if (/\b(biggest|largest|top|most expensive)\b/.test(q) && /\b(purchases?|expenses?|charges?|transactions?|spend)\b/.test(q)) {
    const n = /\btop\s+(\d{1,2})\b/.exec(q);
    return { kind: 'biggest_expenses', period, limit: n ? Math.min(parseInt(n[1], 10), 10) : 5 };
  }

  // ── spending: merchant / category / total ────────────────────
  if (SPEND_STEM.test(q) || HOW_MUCH.test(q)) {
    const lastOnly = /\b(last time|most recent|latest)\b/.test(q);
    const atM = /\b(?:at|to|with|from)\s+([a-z0-9][a-z0-9 &'.-]{1,40}?)(?:\s+(?:last time|most recently|recently|so far))?\s*$/.exec(stripNoise(q));
    if (atM) {
      const merchant = atM[1].trim();
      if (merchant && !/^(all|everything|home|work|the store)$/.test(merchant)) {
        return { kind: 'spend_merchant', merchant, period: lastOnly ? null : period, lastOnly };
      }
    }
    const onM = /\b(?:on|for)\s+([a-z][a-z &'-]{1,30}?)\s*$/.exec(stripNoise(q));
    if (onM) {
      const cat = onM[1].trim();
      if (cat && !/^(everything|all|stuff|things|total|it)$/.test(cat)) {
        return { kind: 'spend_category', category: cat, period };
      }
    }
    return { kind: 'spend_total', period };
  }

  return null;
}
