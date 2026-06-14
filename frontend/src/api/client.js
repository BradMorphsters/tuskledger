/** API client for Tusk Ledger backend. */
const BASE = '/api';

async function request(path, options = {}) {
  const res = await fetch(`${BASE}${path}`, {
    credentials: 'include', // send session cookie on every request
    headers: { 'Content-Type': 'application/json', ...options.headers },
    ...options,
  });
  if (!res.ok) {
    const error = await res.json().catch(() => ({ detail: res.statusText }));
    const err = new Error(error.detail || 'Request failed');
    err.status = res.status;
    throw err;
  }
  return res.json();
}

// Auth
export const getAuthStatus = () => request('/auth/status');
export const setupStart = (username, password) =>
  request('/auth/setup/start', { method: 'POST', body: JSON.stringify({ username, password }) });
export const setupVerify = (code) =>
  request('/auth/setup/verify', { method: 'POST', body: JSON.stringify({ code }) });
export const login = (username, password, code) =>
  request('/auth/login', { method: 'POST', body: JSON.stringify({ username, password, code }) });
export const logout = () => request('/auth/logout', { method: 'POST' });

// Plaid
export const getLinkToken = () => request('/plaid/link-token', { method: 'POST' });
export const exchangeToken = (data) =>
  request('/plaid/exchange-token', { method: 'POST', body: JSON.stringify(data) });
export const triggerSync = () => request('/plaid/sync', { method: 'POST' });
export const getPlaidItems = () => request('/plaid/items');
// One-off historical backfill via /transactions/get. itemId is optional —
// omit to backfill across every connected institution.
export const backfillTransactions = ({ start, end, itemId } = {}) => {
  const params = new URLSearchParams({ start, end });
  if (itemId !== undefined && itemId !== null && itemId !== '') {
    params.set('item_id', String(itemId));
  }
  return request(`/plaid/backfill?${params.toString()}`, { method: 'POST' });
};


// Accounts
export const getAccounts = () => request('/accounts/');
export const updateAccount = (id, data) =>
  request(`/accounts/${id}`, { method: 'PATCH', body: JSON.stringify(data) });
// Add after line 38 (after updateAccount)
export const getStaleAccounts = (days = 7) =>
  request(`/accounts/stale?days=${days}`);

// Liabilities (Plaid Liabilities product)
export const getMortgageDetail = (accountId) =>
  request(`/accounts/${accountId}/mortgage`);
export const getCreditCardDetail = (accountId) =>
  request(`/accounts/${accountId}/credit-card`);

// Manual assets (homes, vehicles, etc.)
export const getManualAssets = () => request('/manual-assets/');
export const createManualAsset = (data) =>
  request('/manual-assets/', { method: 'POST', body: JSON.stringify(data) });
export const updateManualAsset = (id, data) =>
  request(`/manual-assets/${id}`, { method: 'PATCH', body: JSON.stringify(data) });
export const deleteManualAsset = (id) =>
  request(`/manual-assets/${id}`, { method: 'DELETE' });

// Transactions
export const getTransactions = (params = {}) => {
  const qs = new URLSearchParams(params).toString();
  return request(`/transactions/?${qs}`);
};
// Aggregate income / spending / count for ALL rows matching the current
// filter — not just the visible page. Pass the same filter params as
// getTransactions (limit/offset are ignored server-side).
export const getTransactionsTotals = (params = {}) => {
  const { limit, offset, ...filterParams } = params;
  const qs = new URLSearchParams(filterParams).toString();
  return request(`/transactions/totals${qs ? `?${qs}` : ''}`);
};
export const updateTransaction = (id, data) =>
  request(`/transactions/${id}`, { method: 'PATCH', body: JSON.stringify(data) });
export const getTransactionSplits = (id) => request(`/transactions/${id}/splits`);
export const replaceTransactionSplits = (id, splits) =>
  request(`/transactions/${id}/splits`, { method: 'PUT', body: JSON.stringify({ splits }) });
export const clearTransactionSplits = (id) =>
  request(`/transactions/${id}/splits`, { method: 'DELETE' });
// businessFilter: 'all' (default, back-compat) | 'personal' | 'business'.
// 'personal' excludes business-tagged spend from categories so personal
// totals aren't inflated by business expenses. business_total +
// business_budget_limit are populated regardless of filter so the
// caller can render a Business rollup tile.
export const getSpendingSummary = (month, year, businessFilter) => {
  const qs = `month=${month}&year=${year}` +
    (businessFilter ? `&business_filter=${encodeURIComponent(businessFilter)}` : '');
  return request(`/transactions/spending-summary?${qs}`);
};
export const getMerchantDetails = (merchantName) =>
  request(`/transactions/by-merchant/${encodeURIComponent(merchantName)}`);

// Budgets
export const getBudgets = () => request('/budgets/');
export const getBudget = (month, year) => request(`/budgets/${month}/${year}`);
export const saveBudget = (data) =>
  request('/budgets/', { method: 'POST', body: JSON.stringify(data) });

// Net Worth
export const getNetWorthHistory = (days = 90) => request(`/net-worth/?days=${days}`);
export const getLatestNetWorth = () => request('/net-worth/latest');

// Analytics
export const getIncomeVsSpending = (months = 6) =>
  request(`/transactions/income-vs-spending?months=${months}`);
export const getCategoryBreakdown = (month, year) =>
  request(`/transactions/category-breakdown?month=${month}&year=${year}`);
export const getCategories = () => request('/transactions/categories');
// Custom-category CRUD. Reads come through getCategories() above (it
// merges customs + standards). Writes hit the dedicated routes below.
// Naming note: the routes live under /transactions/categories/custom
// rather than a top-level /categories namespace because the existing
// list endpoint is /transactions/categories — keeping both under the
// same prefix mirrors how the rest of the app groups category-related
// things with transactions.
export const createCustomCategory = ({ name, icon }) =>
  request('/transactions/categories/custom', {
    method: 'POST',
    body: JSON.stringify({ name, icon }),
  });
export const updateCustomCategory = (id, { name, icon }) =>
  request(`/transactions/categories/custom/${id}`, {
    method: 'PATCH',
    body: JSON.stringify({ name, icon }),
  });
export const deleteCustomCategory = (id) =>
  request(`/transactions/categories/custom/${id}`, { method: 'DELETE' });
export const getCustomCategoryUsage = (id) =>
  request(`/transactions/categories/custom/${id}/usage`);

// Analytics
export const getRules = () => request('/analytics/rules');
export const createRule = (data) =>
  request('/analytics/rules', { method: 'POST', body: JSON.stringify(data) });
export const deleteRule = (id) =>
  request(`/analytics/rules/${id}`, { method: 'DELETE' });
export const getRecurring = () => request('/analytics/recurring');
export const getMerchantInsights = (months = 6) =>
  request(`/analytics/merchants?months=${months}`);
export const getMonthlyReport = (month, year) =>
  request(`/analytics/monthly-report?month=${month}&year=${year}`);
export const getCategoryTrends = (month, year, monthsBack = 6) =>
  request(`/analytics/category-trends?month=${month}&year=${year}&months_back=${monthsBack}`);
export const getSpendingPatterns = (month, year) =>
  request(`/analytics/spending-patterns?month=${month}&year=${year}`);
export const getInsights = (limit = 5) =>
  request(`/analytics/insights?limit=${limit}`);
// AI-generated plain-English narrative of this month's spending.
// Backend returns one of three shapes (see analytics.py /narrative):
//   {narrative: "<text>",  source: "ollama" | "demo", model: "..." | null,
//    generated_at: "<iso>", from_cache: bool}
//   {narrative: null,      source: "disabled",        model: null,
//    generated_at: "<iso>", from_cache: false}
// On 503 (Ollama enabled but unreachable), `request` throws — caller
// should treat that the same as "disabled" but show a setup hint.
//
// Backend caches once per calendar day; pass refresh=true to force a
// regen (used by the refresh button on the card after a Plaid sync).
export const getInsightsNarrative = ({ refresh = false } = {}) =>
  request(`/analytics/narrative${refresh ? '?refresh=true' : ''}`);

// Streaming variant — same handler shape as streamChatAnswer. Used by
// AINarrative.jsx for the Refresh button (and on first load when
// nothing's cached) so the user watches the model write rather than
// staring at a spinner. Bypasses the daily cache server-side.
export const streamInsightsNarrative = (handlers) =>
  streamSSE(`${BASE}/analytics/narrative?stream=true`, {
    method: 'GET',
    credentials: 'include',
  }, handlers);

// ─── Server-Sent Events helper ───────────────────────────────────
//
// Why fetch+ReadableStream and not native EventSource: EventSource is
// GET-only, doesn't let us send credentials reliably across browsers,
// and can't carry a request body. POST /chat/answer needs a body, so
// we use fetch's response.body stream and parse SSE frames ourselves.
// Same code path handles GET (for /analytics/narrative).
//
// Frame format (per chat.py and analytics.py):
//   data: {"meta": {...}}
//   data: {"delta": "<chunk>"}
//   data: {"done": true}
//   data: {"error": "..."}
//
// Returns a cancel function. Call it to abort the fetch (e.g. when the
// user closes the panel mid-stream).
export function streamSSE(url, fetchInit, handlers) {
  const controller = new AbortController();
  const init = { ...fetchInit, signal: controller.signal };

  (async () => {
    let res;
    try {
      res = await fetch(url, init);
    } catch (err) {
      if (err.name !== 'AbortError') handlers.onError?.(String(err.message || err));
      return;
    }
    if (!res.ok) {
      // Try to parse a JSON error body (FastAPI 503 detail). Falls
      // back to status text if the body isn't JSON.
      let detail = res.statusText;
      try { detail = (await res.json()).detail || detail; } catch {}
      handlers.onError?.(detail);
      return;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        // SSE frames are delimited by \n\n. Split on it; the final
        // chunk may be incomplete (no trailing \n\n yet) — keep it
        // in the buffer for the next iteration.
        const frames = buffer.split('\n\n');
        buffer = frames.pop() ?? '';
        for (const frame of frames) {
          // Each frame is one or more `data: ...` lines. Concatenate
          // the data values per the SSE spec (we only emit one data
          // line per frame, but be liberal).
          const data = frame
            .split('\n')
            .filter(l => l.startsWith('data:'))
            .map(l => l.slice(5).trim())
            .join('');
          if (!data) continue;
          let payload;
          try { payload = JSON.parse(data); } catch { continue; }
          if (payload.meta) handlers.onMeta?.(payload.meta);
          if (payload.delta) handlers.onDelta?.(payload.delta);
          if (payload.error) { handlers.onError?.(payload.error); return; }
          if (payload.done) { handlers.onDone?.(); return; }
        }
      }
    } catch (err) {
      if (err.name !== 'AbortError') handlers.onError?.(String(err.message || err));
    }
  })();

  return () => controller.abort();
}
// In-app Ask panel — curated chat prompts answered by local Ollama
// with pre-computed numbers. Pair of endpoints:
//   GET  /chat/prompts   → catalog the panel renders as chips
//   POST /chat/answer    → run one prompt at one horizon
//                            stream=false (default): single JSON body
//                            stream=true: Server-Sent Events
// Backend returns one of:
//   {answer, source: "ollama"|"demo", model, generated_at, bundle}
//   {answer: null, source: "disabled", ..., bundle}      — LLM off
//   503 on Ollama unreachable (request() throws)
// View mode (read-only ↔ edit, per device). The backend middleware in
// main.py 403s mutating requests when this device's tuskledger_view
// cookie is "readonly". The frontend uses these to flip the cookie
// (typically: phone enters /?view=readonly once, gets cookied, banner
// renders, edit affordances hide).
export const getViewMode = () => request('/view/');
export const setViewMode = (mode) =>
  request(`/view/${mode === 'readonly' ? 'readonly' : 'edit'}`, { method: 'POST' });

export const getChatPrompts = () => request('/chat/prompts');
export const getChatAnswer = ({ promptId, horizon }) =>
  request('/chat/answer', {
    method: 'POST',
    body: JSON.stringify({ prompt_id: promptId, horizon }),
  });

// Streaming variant of getChatAnswer. Calls back as tokens arrive so
// the panel can render prose live. SSE protocol: each frame is one of
// {meta}, {delta}, {done}, {error}. The streamSSE helper below does
// the parsing; this function just wires the chat-specific request.
//
// Usage:
//   const cancel = streamChatAnswer(
//     { promptId: 'spending_total', horizon: '1mo' },
//     { onMeta, onDelta, onDone, onError }
//   )
//   // call cancel() to abort mid-stream (user closes the panel)
export const streamChatAnswer = ({ promptId, horizon }, handlers) =>
  streamSSE(`${BASE}/chat/answer?stream=true`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ prompt_id: promptId, horizon }),
  }, handlers);

// Top merchants by total spend over the lookback window.
export const getTopMerchants = (months = 6, limit = 20, businessId = null) => {
  const params = new URLSearchParams({ months: String(months), limit: String(limit) })
  if (businessId) params.set('business_id', businessId)
  return request(`/analytics/top-merchants?${params}`)
}
// 365-day spending heatmap.
export const getSpendingHeatmap = (days = 365) =>
  request(`/analytics/spending-heatmap?days=${days}`)
// Year-over-year net worth comparison.
export const getNetWorthYoy = () => request('/analytics/networth-yoy')
// Single composite "how's it going?" health score (0-100) + breakdown.
// Optional monthly_payroll_deferral lets the user add 401k payroll
// contributions (which Plaid never sees) for an accurate savings rate.
export const getFinancialPulse = (monthlyPayrollDeferral = 0) =>
  request(`/analytics/financial-pulse?monthly_payroll_deferral=${monthlyPayrollDeferral}`);
// HSA contribution status — IRS limits + list of detected HSA accounts.
// The frontend overlays per-account YTD contribution amounts (kept in
// localStorage) and computes the remaining headroom + tax savings.
export const getHsaStatus = (year) =>
  request(`/analytics/hsa-status${year ? `?year=${year}` : ''}`);
// Cross-cutting search — fans out across transactions + accounts.
export const globalSearch = (q, limit = 20) =>
  request(`/transactions/search?q=${encodeURIComponent(q)}&limit=${limit}`);
// Manual transaction creation — for cash purchases / quick-add UI.
export const createManualTransaction = (data) =>
  request('/transactions/manual', { method: 'POST', body: JSON.stringify(data) });
// Manual account creation — for non-Plaid accounts (HSA, 457, 403b,
// pension etc.). Body matches ManualAccountCreate schema.
export const createManualAccount = (data) =>
  request('/accounts/', { method: 'POST', body: JSON.stringify(data) });
// Multi-decade retirement projection. All inputs optional except current_age.
// Backend supplies sensible defaults and auto-detects current_assets +
// annual_contribution from existing data.
export const getRetirementProjection = (params = {}) => {
  const qs = new URLSearchParams(
    Object.entries(params).filter(([, v]) => v !== undefined && v !== '' && v !== null)
  ).toString();
  return request(`/analytics/retirement-projection?${qs}`);
};

// Loans — amortization + payoff timelines.
export const getLoans = () => request('/loans/');
export const getLoanAmortization = (accountId, params = {}) => {
  const qs = new URLSearchParams(
    Object.entries(params).filter(([, v]) => v !== undefined && v !== '' && v !== null)
  ).toString();
  return request(`/loans/${accountId}/amortization${qs ? '?' + qs : ''}`);
};
export const getLoanBiweekly = (loanId, params = {}) => {
  const qs = new URLSearchParams(
    Object.entries(params).filter(([, v]) => v !== undefined && v !== '' && v !== null)
  ).toString();
  return request(`/loans/${loanId}/biweekly${qs ? '?' + qs : ''}`);
};
export const getLoanRefinance = (loanId, params = {}) => {
  const qs = new URLSearchParams(
    Object.entries(params).filter(([, v]) => v !== undefined && v !== '' && v !== null)
  ).toString();
  return request(`/loans/${loanId}/refinance${qs ? '?' + qs : ''}`);
};
export const getLoanPmiDropoff = (loanId, params = {}) => {
  const qs = new URLSearchParams(
    Object.entries(params).filter(([, v]) => v !== undefined && v !== '' && v !== null)
  ).toString();
  return request(`/loans/${loanId}/pmi-dropoff${qs ? '?' + qs : ''}`);
};
export const getLoanHeloc = (loanId, params = {}) => {
  const qs = new URLSearchParams(
    Object.entries(params).filter(([, v]) => v !== undefined && v !== '' && v !== null)
  ).toString();
  return request(`/loans/${loanId}/heloc${qs ? '?' + qs : ''}`);
};
export const getExportUrl = (startDate, endDate, opts = {}) => {
  // opts: { account_id, category, business_id } — all optional. Returns
  // a download URL that the browser can open in a new tab to trigger
  // the CSV download. Backend respects all four filters.
  const p = new URLSearchParams()
  if (startDate) p.set('start_date', startDate)
  if (endDate) p.set('end_date', endDate)
  if (opts.account_id) p.set('account_id', opts.account_id)
  if (opts.category) p.set('category', opts.category)
  if (opts.business_id) p.set('business_id', opts.business_id)
  return `/api/analytics/export?${p.toString()}`
};

// Businesses
export const getBusinesses = () => request('/businesses/');
export const createBusiness = (data) =>
  request('/businesses/', { method: 'POST', body: JSON.stringify(data) });
export const updateBusiness = (id, data) =>
  request(`/businesses/${id}`, { method: 'PUT', body: JSON.stringify(data) });
export const deleteBusiness = (id) =>
  request(`/businesses/${id}`, { method: 'DELETE' });
export const tagTransactions = (businessId, transactionIds) =>
  request(`/businesses/${businessId}/tag`, { method: 'POST', body: JSON.stringify({ transaction_ids: transactionIds }) });
export const untagTransactions = (transactionIds) =>
  request('/businesses/untag', { method: 'POST', body: JSON.stringify({ transaction_ids: transactionIds }) });
export const getBusinessReport = (id, months = 12) =>
  request(`/businesses/${id}/report?months=${months}`);
// Per-business, per-tax-year roll-up for Schedule C preparation. Returns
// income totals + expense aggregation by Tusk Ledger category. Frontend
// overlays IRS-line mapping (localStorage) and Asset Register (also
// localStorage) to produce a TaxAct-ready summary.
export const getScheduleCSummary = (id, year) =>
  request(`/businesses/${id}/schedule-c-summary?year=${year}`);
export const getBusinessOverview = (months = 6) =>
  request(`/businesses/overview/summary?months=${months}`);
export const getBusinessExportUrl = (id, startDate, endDate) => {
  let url = `/api/businesses/${id}/export?`
  if (startDate) url += `start_date=${startDate}&`
  if (endDate) url += `end_date=${endDate}&`
  return url
};

// Bills
export const getUpcomingBills = (params = {}) => {
  const qs = new URLSearchParams(params).toString();
  return request(`/bills/upcoming${qs ? '?' + qs : ''}`);
};

// Investments
export const getHoldings = (accountId) => {
  const qs = accountId ? `?account_id=${accountId}` : '';
  return request(`/investments/holdings${qs}`);
};
export const getInvestmentTransactions = (params = {}) => {
  const qs = new URLSearchParams(params).toString();
  return request(`/investments/transactions${qs ? '?' + qs : ''}`);
};
export const getInvestmentsSummary = () => request('/investments/summary');
// Realized YTD P&L + wash-sale audit + open-position LT countdown.
// Pure read of investment_transactions; safe to call as often as needed.
export const getTradingTax = (params = {}) => {
  const qs = new URLSearchParams(
    Object.entries(params).filter(([, v]) => v !== undefined && v !== '' && v !== null)
  ).toString();
  return request(`/investments/trading-tax${qs ? '?' + qs : ''}`);
};
// Pre-flight a hypothetical sell — see services/trading_tax.py.
// Body: { plaid_security_id, quantity, price, year?, account_id?,
//         ordinary_marginal_rate?, ltcg_rate?, state_rate? }
export const preflightSell = (body) =>
  request('/investments/trading-tax/preflight', {
    method: 'POST',
    body: JSON.stringify(body),
  });
// Form 8949 CSV download URL. Returns a string the caller can drop
// into <a href="..."> or window.location.href to trigger the browser
// download — leverages the backend's Content-Disposition: attachment
// header so we don't need a fetch + blob dance.
export const tradingTaxForm8949Url = (params = {}) => {
  const qs = new URLSearchParams(
    Object.entries(params).filter(([, v]) => v !== undefined && v !== '' && v !== null)
  ).toString();
  return `/api/investments/trading-tax/form-8949${qs ? '?' + qs : ''}`;
};

// Research — long-term-hold research layer (PII-free scored universe joined
// onto live holdings at query time). See backend/app/routers/research.py.
export const getResearchDomains = () => request('/research/domains');
export const getResearchMeta = (domain) =>
  request(`/research/${encodeURIComponent(domain)}/meta`);
export const getResearchUniverse = (domain, { tier, minConviction, heldOnly } = {}) => {
  const p = new URLSearchParams();
  if (tier !== undefined && tier !== null && tier !== '') p.set('tier', String(tier));
  if (minConviction) p.set('min_conviction', String(minConviction));
  if (heldOnly) p.set('held_only', 'true');
  const qs = p.toString();
  return request(`/research/${encodeURIComponent(domain)}/universe${qs ? '?' + qs : ''}`);
};
// The headline view: held securities × research overlay (the cockpit).
export const getResearchPositions = (domain) =>
  request(`/research/${encodeURIComponent(domain)}/positions`);
export const getResearchAlerts = (domain) =>
  request(`/research/${encodeURIComponent(domain)}/alerts`);
export const getResearchEntity = (domain, id) =>
  request(`/research/${encodeURIComponent(domain)}/entity/${encodeURIComponent(id)}`);
export const getResearchForTicker = (ticker) =>
  request(`/research/ticker/${encodeURIComponent(ticker)}`);
export const getResearchHistory = (domain) =>
  request(`/research/${encodeURIComponent(domain)}/history`);
// Append a current-state snapshot for every entity (thesis-drift heartbeat).
export const recordResearchSnapshot = (domain) =>
  request(`/research/${encodeURIComponent(domain)}/snapshot`, { method: 'POST' });
// Real monthly close history + current price for one ticker (Stooq, on-demand).
export const getResearchPrices = (domain, ticker, { months, refresh } = {}) => {
  const p = new URLSearchParams();
  if (months) p.set('months', String(months));
  if (refresh) p.set('refresh', 'true');
  const qs = p.toString();
  return request(`/research/${encodeURIComponent(domain)}/prices/${encodeURIComponent(ticker)}${qs ? '?' + qs : ''}`);
};
// Bulk-warm the price cache for every ticker (used by the daily job).
export const refreshResearchPrices = (domain) =>
  request(`/research/${encodeURIComponent(domain)}/refresh-prices`, { method: 'POST' });

// Quiver public-purchase signals (gov contracts, congressional/insider, lobbying).
export const getSignalsStatus = () => request('/signals/status');
export const getSignalsFeed = (domain) => request(`/signals/${encodeURIComponent(domain)}/feed`);
export const getSignalsForTicker = (domain, ticker, { refresh } = {}) =>
  request(`/signals/${encodeURIComponent(domain)}/${encodeURIComponent(ticker)}${refresh ? '?refresh=true' : ''}`);
export const refreshSignals = (domain) =>
  request(`/signals/${encodeURIComponent(domain)}/refresh`, { method: 'POST' });

// Industry admin — switch the focused industry at runtime + scaffold new ones.
export const getActiveIndustry = () => request('/research/active');
export const setActiveIndustry = (domain) =>
  request('/research/active', { method: 'POST', body: JSON.stringify({ domain }) });
export const createIndustry = (data) =>
  request('/research/industries', { method: 'POST', body: JSON.stringify(data) });

// SEC EDGAR filing activity — free (no key): insider Form-4, 8-K events, raises.
export const getEdgarFeed = (domain) => request(`/edgar/${encodeURIComponent(domain)}/feed`);
export const getEdgarForTicker = (domain, ticker, { refresh } = {}) =>
  request(`/edgar/${encodeURIComponent(domain)}/${encodeURIComponent(ticker)}${refresh ? '?refresh=true' : ''}`);
export const refreshEdgar = (domain) =>
  request(`/edgar/${encodeURIComponent(domain)}/refresh`, { method: 'POST' });

// Integrations / API keys — bring-your-own-key status (booleans only).
export const getIntegrationsStatus = () => request('/integrations/status');

// Sector rotation watch (aggregate temperature + local-AI synthesis).
export const getRotation = (domain) => request(`/rotation/${encodeURIComponent(domain)}`);
export const getRotationNarrative = (domain) => request(`/rotation/${encodeURIComponent(domain)}/narrative`);
// Validated writes (blocked on read-only devices + the public demo by the
// backend's read_only_gate middleware).
export const upsertResearchEntity = (domain, entity) =>
  request(`/research/${encodeURIComponent(domain)}/entity`, {
    method: 'POST', body: JSON.stringify(entity),
  });
export const updateResearchField = (domain, id, path, value) =>
  request(`/research/${encodeURIComponent(domain)}/entity/${encodeURIComponent(id)}`, {
    method: 'PATCH', body: JSON.stringify({ path, value }),
  });

// Subscription rules — user-defined overrides for the recurrence
// detector. See models/subscription_rule.py for kind values.
export const getSubscriptionRules = () =>
  request('/subscription-rules/');
export const createSubscriptionRule = (body) =>
  request('/subscription-rules/', {
    method: 'POST',
    body: JSON.stringify(body),
  });
export const deleteSubscriptionRule = (ruleId) =>
  request(`/subscription-rules/${ruleId}`, { method: 'DELETE' });

// Goals
export const getGoals = () => request('/goals/');
export const createGoal = (data) =>
  request('/goals/', { method: 'POST', body: JSON.stringify(data) });
export const updateGoal = (id, data) =>
  request(`/goals/${id}`, { method: 'PATCH', body: JSON.stringify(data) });
export const deleteGoal = (id) =>
  request(`/goals/${id}`, { method: 'DELETE' });

// Cash flow forecast
export const getCashFlowForecast = (days = 30, baseline = 'median_3') =>
  request(`/analytics/cash-flow-forecast?days=${days}&baseline=${baseline}`);
export const getCashFlowHealth = () => request('/analytics/cash-flow-health');
export const getDebtPayoff = () => request('/analytics/debt-payoff');
export const getFirstTimeMerchants = (month, year) =>
  request(`/analytics/first-time-merchants?month=${month}&year=${year}`);

// Spending patterns (already imported elsewhere; re-exported here for clarity)
// — used by Insights for the income-sources panel.

// Analytics — new features
export const getYearOverYear = (month, year) =>
  request(`/analytics/year-over-year?month=${month}&year=${year}`);
export const getCashflowCalendar = (days = 30) =>
  request(`/analytics/cashflow-calendar?days=${days}`);
export const getNetWorthProjection = (months = 12) =>
  request(`/analytics/networth-projection?months=${months}`);

// Demo (mode toggle + dataset refresh)
export const setMode = (mode) =>
  request('/demo/mode', { method: 'POST', body: JSON.stringify({ mode }) });
export const refreshDemoData = () => request('/demo/refresh', { method: 'POST' });

// Health
export const healthCheck = () => request('/health');

// Business Rules
export const getBusinessRules = () => request('/business-rules/');
export const createBusinessRule = (data) =>
  request('/business-rules/', { method: 'POST', body: JSON.stringify(data) });
export const deleteBusinessRule = (id) =>
  request(`/business-rules/${id}`, { method: 'DELETE' });
export const applyBusinessRule = (id) =>
  request(`/business-rules/${id}/apply`, { method: 'POST' });

// Category Rules — retroactive application
export const applyCategoryRule = (id) =>
  request(`/analytics/rules/${id}/apply`, { method: 'POST' });

// CSV Import
export const importCsv = (accountId, file) => {
  const fd = new FormData();
  fd.append('file', file);
  return fetch(`${BASE}/csv-import?account_id=${accountId}`, {
    method: 'POST',
    credentials: 'include',
    body: fd,
  }).then(r => r.ok ? r.json() : r.json().catch(() => ({ detail: r.statusText })).then(e => Promise.reject(new Error(e.detail || r.statusText))));
};
