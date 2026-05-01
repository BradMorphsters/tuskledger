"""
Thin HTTP client wrapper around the Tusk Ledger backend.

Why a wrapper instead of raw httpx in the tool functions:
  - One place to set the base URL + timeouts + auth (when we add it)
  - One place to translate API errors into clean MCP-friendly messages
  - One place to mock in tests

Auth note: today this assumes DEV_BYPASS_AUTH=true on the user's
backend (the common single-machine pattern). When we add proper auth
support, the constructor will take an API token; everything else here
stays the same.
"""
from __future__ import annotations

import os
from typing import Any

import httpx


# Default to localhost:8000 (the Tusk Ledger backend's default port).
# Users can override with TUSKLEDGER_BASE_URL if they've moved the backend.
DEFAULT_BASE_URL = os.environ.get("TUSKLEDGER_BASE_URL", "http://127.0.0.1:8000")
DEFAULT_TIMEOUT = float(os.environ.get("TUSKLEDGER_TIMEOUT_SECONDS", "10"))


class TuskLedgerError(Exception):
    """
    Raised when the backend returns an error or is unreachable.
    The MCP tool dispatcher converts these into structured error
    responses for the assistant.
    """
    def __init__(self, message: str, status: int | None = None, body: Any = None):
        super().__init__(message)
        self.status = status
        self.body = body


class TuskLedgerClient:
    """
    Synchronous client. The MCP server uses async, but each tool call
    is a single HTTP round-trip and the backend is on localhost — sync
    keeps the tool implementations linear and readable. We wrap each
    call in a thread executor at the dispatch layer.
    """

    def __init__(self, base_url: str | None = None, timeout: float | None = None):
        self.base_url = (base_url or DEFAULT_BASE_URL).rstrip("/")
        self.timeout = timeout or DEFAULT_TIMEOUT

    # ── Low-level transport ──────────────────────────────────────

    def _request(
        self,
        method: str,
        path: str,
        params: dict | None = None,
        json: Any = None,
    ) -> Any:
        """
        Make an HTTP request and return the parsed JSON response.
        Raises TuskLedgerError for any non-2xx response or transport failure.
        """
        url = f"{self.base_url}{path}"
        try:
            with httpx.Client(timeout=self.timeout) as client:
                resp = client.request(method, url, params=params, json=json)
        except httpx.ConnectError as e:
            raise TuskLedgerError(
                f"Could not reach Tusk Ledger backend at {self.base_url}. "
                f"Is the app running? Try `./start.sh` from the repo root. "
                f"(transport error: {e})"
            ) from e
        except httpx.TimeoutException as e:
            raise TuskLedgerError(
                f"Tusk Ledger backend at {self.base_url} took longer than "
                f"{self.timeout}s to respond. The DB may be very large or the "
                f"endpoint may be misbehaving."
            ) from e

        if resp.status_code >= 400:
            try:
                body = resp.json()
            except Exception:  # pylint: disable=broad-except
                body = resp.text
            raise TuskLedgerError(
                f"Backend returned {resp.status_code} for {method} {path}.",
                status=resp.status_code,
                body=body,
            )

        if not resp.content:
            return None
        try:
            return resp.json()
        except ValueError:
            return resp.text

    # ── Convenience methods grouped by domain ────────────────────

    # accounts
    def list_accounts(self) -> list[dict]:
        return self._request("GET", "/api/accounts/")

    def get_account(self, account_id: int) -> dict:
        return self._request("GET", f"/api/accounts/{account_id}")

    def list_stale_accounts(self) -> dict:
        return self._request("GET", "/api/accounts/stale")

    # transactions
    def list_transactions(self, **filters) -> list[dict]:
        # Backend accepts standard query params: account_id, category,
        # start_date, end_date, limit, offset, etc. Pass through.
        return self._request("GET", "/api/transactions/", params=filters)

    def search_transactions(self, q: str, limit: int = 50) -> Any:
        return self._request(
            "GET",
            "/api/transactions/search",
            params={"q": q, "limit": limit},
        )

    def spending_summary(self, **filters) -> dict:
        return self._request("GET", "/api/transactions/spending-summary", params=filters)

    def category_breakdown(self, **filters) -> Any:
        return self._request("GET", "/api/transactions/category-breakdown", params=filters)

    def by_merchant(self, merchant_name: str) -> Any:
        return self._request("GET", f"/api/transactions/by-merchant/{merchant_name}")

    # analytics
    def top_merchants(self, **filters) -> Any:
        return self._request("GET", "/api/analytics/top-merchants", params=filters)

    def recurring_subscriptions(self) -> Any:
        return self._request("GET", "/api/analytics/recurring")

    def cash_flow_forecast(self, **params) -> Any:
        return self._request("GET", "/api/analytics/cash-flow-forecast", params=params)

    def cash_flow_health(self) -> Any:
        return self._request("GET", "/api/analytics/cash-flow-health")

    # bills
    def upcoming_bills(self, **params) -> list[dict]:
        return self._request("GET", "/api/bills/upcoming", params=params)

    # net worth
    def net_worth_latest(self) -> dict | None:
        return self._request("GET", "/api/net-worth/latest")

    def net_worth_history(self) -> list[dict]:
        return self._request("GET", "/api/net-worth/")

    # investments
    def holdings(self) -> list[dict]:
        return self._request("GET", "/api/investments/holdings")

    def investments_summary(self) -> dict:
        return self._request("GET", "/api/investments/summary")

    def trading_tax(self, **params) -> Any:
        return self._request("GET", "/api/investments/trading-tax", params=params)

    # retirement
    def retirement_projection(self, **params) -> Any:
        return self._request("GET", "/api/analytics/retirement-projection", params=params)

    # plaid
    def trigger_sync(self) -> Any:
        return self._request("POST", "/api/plaid/sync")
