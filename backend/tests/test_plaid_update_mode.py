"""Tests for Plaid update-mode (reconnect) link-token creation.

Update mode is how we re-authenticate an existing item that's fallen into
ITEM_LOGIN_REQUIRED without creating a duplicate item. The contract that
matters — and what these tests pin down — is:

  * the request carries the existing item's ``access_token`` (that's the
    single field that flips Link into update mode), and
  * NO product fields are set (Plaid rejects ``products`` /
    ``optional_products`` in update mode).

We assert against a captured LinkTokenCreateRequest rather than hitting
Plaid, so the test needs no credentials and no network.
"""
from app.services.plaid_service import create_link_token, create_update_link_token


class _FakeClient:
    """Stand-in for plaid_api.PlaidApi that records the request instead of
    calling Plaid. Returns a fixed token so the caller has something to
    return."""

    def __init__(self, token="link-update-sandbox-xyz"):
        self.token = token
        self.last_request = None

    def link_token_create(self, request):
        self.last_request = request
        return {"link_token": self.token}


def test_update_link_token_sets_access_token():
    client = _FakeClient()
    token = create_update_link_token(client, "access-sandbox-abc123")

    assert token == "link-update-sandbox-xyz"
    # The access_token is what makes this update mode rather than a fresh link.
    assert client.last_request.access_token == "access-sandbox-abc123"


def test_update_link_token_omits_product_fields():
    client = _FakeClient()
    create_update_link_token(client, "access-sandbox-abc123")

    # Plaid 400s if products are present in update mode. plaid-python's
    # models only serialize fields that were actually set, so a clean
    # to_dict() is the reliable check that we didn't set them.
    body = client.last_request.to_dict()
    assert "products" not in body
    assert "optional_products" not in body
    assert "required_if_supported_products" not in body
    # Sanity: the fields update mode DOES require are present.
    assert "access_token" in body
    assert "user" in body


def test_new_link_token_differs_from_update():
    """The fresh-link path must still request products; without that, normal
    (non-update) linking would break. Guards against someone 'simplifying'
    the two functions into one."""
    client = _FakeClient(token="link-new-sandbox-1")
    create_link_token(client)

    body = client.last_request.to_dict()
    assert "products" in body
    assert "access_token" not in body
