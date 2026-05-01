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
//   {narrative: "<text>",  source: "ollama" | "demo", model: "..." | null}
//   {narrative: null,      source: "disabled",        model: null}
// On 503 (Ollama enabled but unreachable), `request` throws — caller
// should treat that the same as "disabled" but show a setup hint.
export const getInsightsNarrative = () => request('/analytics/narrative');
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
  return fetch(`${API_BASE}/csv-import?account_id=${accountId}`, {
    method: 'POST',
    credentials: 'include',
    body: fd,
  }).then(r => r.ok ? r.json() : Promise.reject(new Error(r.statusText)));
};
