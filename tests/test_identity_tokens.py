"""Identity-bound bearer tokens: the credential decides who the caller is.

Before this, ``require_animus`` took the caller's identity from the
``x-holon-animus-id`` header and the only credential was one shared bearer token,
so whoever held that token could send any identifier -- an admin's included --
and be that Person. These tests pin the replacement:

- an **identity token** IS one identity; a header naming anyone else is refused
  (403) and the other identity is never even looked up;
- a **proxy token** (the MCP remote, which has verified the caller itself) may
  still assert an identity via the header;
- the **legacy shared token** behaves exactly as before unless
  ``allow_legacy_bearer`` is switched off;
- misconfiguration (a token in two roles, a short or malformed token) stops the
  process at startup rather than silently authenticating the wrong thing.

The tests run the real app and a stub backend that records WHICH external id the
bridge looked up. That, not the status code alone, is the security property.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from holonbridge.config import Settings, parse_identity_tokens, parse_proxy_tokens
from holonbridge.deps import AnimusDep
from holonbridge.server import create_app

from ._identity import IdentityStub

SHARED = "shared-legacy-token-0123456789abcdef"
FRONTEND = "frontend-identity-token-0123456789ab"
ALICE = "alice-identity-token-0123456789abcdef"
PROXY = "mcp-proxy-token-0123456789abcdef0123"

FRONTEND_ID = "web-frontend-service"
ALICE_ID = "alice"
ADMIN_ID = "root-admin"


class RecordingStub(IdentityStub):
    """Answers identity/ACL queries and records every external id looked up."""

    def __init__(self) -> None:
        super().__init__()
        self.lookups: list[str] = []

    async def select(self, conn, query, *, default_graph=None):
        if "hasExternalIdentity" in query:
            self.lookups.append(query)
        infra = self.infra_select(query)
        return infra if infra is not None else {"results": {"bindings": []}}

    async def construct(self, conn, query, *, default_graph=None, timeout=None):
        return ""

    async def update(self, conn, update):
        return None

    async def post_graph(self, conn, graph_iri, turtle):
        return None

    async def put_graph(self, conn, graph_iri, turtle):
        return None

    async def ping(self, conn):
        return True

    async def aclose(self):
        return None

    def looked_up(self, external_id: str) -> bool:
        return any(f'"{external_id}"' in q for q in self.lookups)

    def looked_up_type(self, type_name: str) -> bool:
        return any(type_name in q for q in self.lookups)


def make_client(**settings_kwargs):
    settings = Settings(**settings_kwargs)
    app = create_app(settings)

    @app.get("/_whoami")
    async def whoami(animus: AnimusDep):
        return {"person": animus.person}

    stub = RecordingStub()
    test_client = TestClient(app)
    test_client.__enter__()
    app.state.fuseki = stub
    return test_client, stub


@pytest.fixture
def bound():
    """A deployment fully migrated: two identity tokens, one proxy, legacy off."""
    client, stub = make_client(
        identity_tokens={FRONTEND: FRONTEND_ID, ALICE: ALICE_ID},
        proxy_tokens=(PROXY,),
        allow_legacy_bearer=False,
    )
    yield client, stub
    client.__exit__(None, None, None)


@pytest.fixture
def legacy_off():
    """A legacy token IS configured but switched off -- the case the flag exists for."""
    client, stub = make_client(
        bearer_token=SHARED,
        identity_tokens={ALICE: ALICE_ID},
        allow_legacy_bearer=False,
    )
    yield client, stub
    client.__exit__(None, None, None)


@pytest.fixture
def mixed():
    """A deployment mid-migration: legacy token still accepted alongside the new ones."""
    client, stub = make_client(
        bearer_token=SHARED,
        identity_tokens={ALICE: ALICE_ID},
        proxy_tokens=(PROXY,),
    )
    yield client, stub
    client.__exit__(None, None, None)


def bearer(token: str, **extra: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}", **extra}


# --- an identity token IS one identity --------------------------------------------


def test_an_identity_token_needs_no_header_and_resolves_its_bound_identity(bound):
    client, stub = bound
    response = client.get("/_whoami", headers=bearer(ALICE))
    assert response.status_code == 200
    assert stub.looked_up(ALICE_ID)


def test_a_header_that_agrees_with_the_token_is_accepted(bound):
    client, stub = bound
    response = client.get("/_whoami", headers=bearer(ALICE, **{"x-holon-animus-id": ALICE_ID}))
    assert response.status_code == 200
    assert stub.looked_up(ALICE_ID)


def test_a_header_naming_someone_else_is_refused_and_never_looked_up(bound):
    """THE regression this change exists for: holding Alice's token must not let
    you be the admin by sending the admin's identifier."""
    client, stub = bound
    response = client.get("/_whoami", headers=bearer(ALICE, **{"x-holon-animus-id": ADMIN_ID}))
    assert response.status_code == 403
    assert not stub.looked_up(ADMIN_ID)
    assert not stub.looked_up(ALICE_ID)  # refused before any identity resolution at all


def test_an_identity_token_ignores_a_supplied_identity_type(bound):
    client, stub = bound
    response = client.get(
        "/_whoami", headers=bearer(ALICE, **{"x-holon-animus-type": "SomeOtherNamespace"})
    )
    assert response.status_code == 200
    assert stub.looked_up(ALICE_ID)
    assert not stub.looked_up_type("SomeOtherNamespace")
    assert stub.looked_up_type("GitHubIdentity")


def test_two_identity_tokens_resolve_to_two_different_identities(bound):
    client, stub = bound
    assert client.get("/_whoami", headers=bearer(FRONTEND)).status_code == 200
    assert stub.looked_up(FRONTEND_ID) and not stub.looked_up(ALICE_ID)
    assert client.get("/_whoami", headers=bearer(ALICE)).status_code == 200
    assert stub.looked_up(ALICE_ID)


def test_an_identity_token_for_an_unknown_person_is_a_401_not_a_pass_through(bound):
    client, stub = bound

    async def no_person(conn, query, *, default_graph=None):
        if "hasExternalIdentity" in query:
            return {"results": {"bindings": []}}
        return stub.infra_select(query) or {"results": {"bindings": []}}

    stub.select = no_person  # type: ignore[method-assign]
    assert client.get("/_whoami", headers=bearer(ALICE)).status_code == 401


# --- a proxy token may assert an identity ----------------------------------------


def test_a_proxy_token_may_assert_the_identity_it_verified(bound):
    client, stub = bound
    response = client.get("/_whoami", headers=bearer(PROXY, **{"x-holon-animus-id": ALICE_ID}))
    assert response.status_code == 200
    assert stub.looked_up(ALICE_ID)


def test_a_proxy_token_without_a_header_is_a_401(bound):
    client, _ = bound
    assert client.get("/_whoami", headers=bearer(PROXY)).status_code == 401


# --- the legacy shared token --------------------------------------------------------


def test_the_legacy_token_still_asserts_any_identity_when_allowed(mixed):
    """Back-compat: unchanged behaviour for deployments that have not migrated."""
    client, stub = mixed
    response = client.get("/_whoami", headers=bearer(SHARED, **{"x-holon-animus-id": ADMIN_ID}))
    assert response.status_code == 200
    assert stub.looked_up(ADMIN_ID)


def test_the_legacy_token_is_refused_once_switched_off(legacy_off):
    client, stub = legacy_off
    response = client.get("/_whoami", headers=bearer(SHARED, **{"x-holon-animus-id": ADMIN_ID}))
    assert response.status_code == 401
    assert response.json()["detail"] == "invalid bearer token"
    assert not stub.looked_up(ADMIN_ID)


def test_a_switched_off_legacy_token_is_indistinguishable_from_an_unknown_one(legacy_off):
    client, _ = legacy_off
    legacy = client.get("/_whoami", headers=bearer(SHARED))
    unknown = client.get("/_whoami", headers=bearer("x" * 40))
    assert legacy.status_code == unknown.status_code == 401
    assert legacy.json() == unknown.json()


def test_identity_tokens_keep_working_when_the_legacy_one_is_switched_off(legacy_off):
    client, stub = legacy_off
    assert client.get("/_whoami", headers=bearer(ALICE)).status_code == 200
    assert stub.looked_up(ALICE_ID)


# --- general ------------------------------------------------------------------------


@pytest.mark.parametrize("headers", [{}, {"Authorization": "Basic abc"}, {"Authorization": "Bearer "}])
def test_missing_or_malformed_credentials_are_a_401(bound, headers):
    client, _ = bound
    assert client.get("/_whoami", headers=headers).status_code == 401


def test_with_no_tokens_configured_the_loopback_dev_mode_is_unchanged():
    client, stub = make_client()
    try:
        # Still needs an identity: the header is trusted, as in development today.
        assert client.get("/_whoami").status_code == 401
        response = client.get("/_whoami", headers={"x-holon-animus-id": ALICE_ID})
        assert response.status_code == 200
        assert stub.looked_up(ALICE_ID)
    finally:
        client.__exit__(None, None, None)


def test_a_public_bind_with_no_tokens_still_refuses_to_serve():
    client, _ = make_client(host="0.0.0.0")
    try:
        assert client.get("/_whoami", headers={"x-holon-animus-id": ALICE_ID}).status_code == 500
    finally:
        client.__exit__(None, None, None)


# --- configuration fails closed at startup -------------------------------------------


def test_the_same_token_in_two_roles_is_refused():
    with pytest.raises(ValueError, match="both"):
        Settings(bearer_token=ALICE, identity_tokens={ALICE: ALICE_ID})
    with pytest.raises(ValueError, match="both"):
        Settings(identity_tokens={ALICE: ALICE_ID}, proxy_tokens=(ALICE,))


@pytest.mark.parametrize(
    "raw",
    ["notoken", "=" + "a" * 30, "a" * 30 + "=", "short=alice", ("a" * 30 + "=alice,") * 2],
)
def test_malformed_identity_tokens_are_refused(raw):
    with pytest.raises(ValueError):
        parse_identity_tokens(raw)


def test_proxy_tokens_must_be_long_and_unique():
    with pytest.raises(ValueError):
        parse_proxy_tokens("short")
    with pytest.raises(ValueError):
        parse_proxy_tokens(f"{PROXY},{PROXY}")
    assert parse_proxy_tokens(f" {PROXY} , ") == (PROXY,)


def test_settings_read_the_new_variables_from_the_environment(monkeypatch):
    monkeypatch.setenv("IDENTITY_TOKENS", f"{ALICE}={ALICE_ID}, {FRONTEND}={FRONTEND_ID}")
    monkeypatch.setenv("PROXY_TOKENS", PROXY)
    monkeypatch.setenv("ALLOW_LEGACY_BEARER", "false")
    monkeypatch.delenv("BEARER_TOKEN", raising=False)
    settings = Settings.from_env()
    assert settings.identity_tokens == {ALICE: ALICE_ID, FRONTEND: FRONTEND_ID}
    assert settings.proxy_tokens == (PROXY,)
    assert settings.allow_legacy_bearer is False


def test_legacy_stays_allowed_by_default(monkeypatch):
    monkeypatch.delenv("ALLOW_LEGACY_BEARER", raising=False)
    assert Settings.from_env().allow_legacy_bearer is True
