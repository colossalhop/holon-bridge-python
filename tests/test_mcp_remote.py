"""Tests for holonbridge_mcp.remote — the composed, gated ASGI app.

The one regression this guards hardest against is the exact bug hit on the
Node side: an OAuth well-known/register/authorize/token path landing behind
the auth gate, because the metadata endpoint that is supposed to bootstrap
the whole flow would then itself require a credential nobody has yet.

Transport coverage: ``sse`` (``/sse``), ``http`` (``/mcp``) and ``both``. These
tests use ``FakeMcp``, which stands in for FastMCP; the real SDK, including
how identity survives Streamable HTTP, is exercised in
``test_mcp_streamable_identity.py``.
"""

from __future__ import annotations

import pytest
from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import PlainTextResponse
from starlette.routing import Route
from starlette.testclient import TestClient

from holonbridge_mcp import github_oauth as oauth
from holonbridge_mcp import remote, session


class FakeMcp:
    """Stands in for FastMCP: each transport is a tiny Starlette app.

    The two answer with different bodies so a test can tell which transport
    actually served a request. Like the real SSE and Streamable HTTP apps they
    own different paths (``/sse`` and ``/mcp``).
    """

    def __init__(self) -> None:
        async def handle_sse(request: Request) -> PlainTextResponse:
            return PlainTextResponse("mcp-transport-reached")

        async def handle_http(request: Request) -> PlainTextResponse:
            return PlainTextResponse("mcp-http-transport-reached")

        self._sse = Starlette(routes=[Route("/sse", handle_sse, methods=["GET"])])
        self._http = Starlette(routes=[Route("/mcp", handle_http, methods=["GET", "POST"])])

    def sse_app(self):
        return self._sse

    def streamable_http_app(self):
        return self._http


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch):
    for key in (
        "MCP_INBOUND_TOKEN",
        "GITHUB_OAUTH_CLIENT_ID",
        "GITHUB_OAUTH_CLIENT_SECRET",
        "MCP_PUBLIC_URL",
        "MCP_JWT_SECRET",
        "MCP_ALLOWED_GITHUB_LOGINS",
    ):
        monkeypatch.delenv(key, raising=False)


def auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


# --- refusal to start -----------------------------------------------------------


def test_refuses_to_start_with_no_credential_configured():
    with pytest.raises(SystemExit, match="No inbound credential"):
        remote.build_app(FakeMcp(), "sse")


def test_refuses_to_start_with_no_credential_on_every_transport():
    for transport in ("http", "streamable-http", "both"):
        with pytest.raises(SystemExit, match="No inbound credential"):
            remote.build_app(FakeMcp(), transport)


def test_refuses_a_short_static_token(monkeypatch):
    monkeypatch.setenv("MCP_INBOUND_TOKEN", "too-short")
    with pytest.raises(SystemExit, match="too short"):
        remote.build_app(FakeMcp(), "sse")


def test_bad_transport_name_is_rejected(monkeypatch):
    monkeypatch.setenv("MCP_INBOUND_TOKEN", "x" * 32)
    with pytest.raises(ValueError, match="not a remote transport"):
        remote.build_app(FakeMcp(), "carrier-pigeon")


# --- static-token-only mode (no regression) --------------------------------------


def test_static_token_alone_still_works_exactly_as_before(monkeypatch):
    monkeypatch.setenv("MCP_INBOUND_TOKEN", "x" * 32)
    app = remote.build_app(FakeMcp(), "sse")
    client = TestClient(app)

    assert client.get("/healthz").status_code == 200
    assert client.get("/sse").status_code == 401
    response = client.get("/sse", headers=auth("x" * 32))
    assert response.status_code == 200
    assert response.text == "mcp-transport-reached"


def test_static_token_mode_still_exempts_oauth_discovery_paths(monkeypatch):
    """Regression: a real claude.ai connector hit this exact case.

    Its trace showed 401 on every well-known/register path even with a valid
    MCP_INBOUND_TOKEN configured and no GitHub OAuth involved at all — because
    the client probes OAuth discovery *before* it ever tries the static token
    it already has, and this gate used to only exempt those paths when
    GitHub OAuth was configured. Unconfigured, there is genuinely no route
    behind them, so the correct response once they're exempted from the gate
    is a plain 404 (the FakeMcp transport doesn't know these paths either) —
    not 401, which reads as "you must authenticate to find out how to
    authenticate" and stalls a client that only needed the token it already
    sent.
    """
    monkeypatch.setenv("MCP_INBOUND_TOKEN", "x" * 32)
    app = remote.build_app(FakeMcp(), "sse")
    client = TestClient(app)

    for path in (
        "/.well-known/oauth-authorization-server",
        "/.well-known/oauth-protected-resource",
        "/.well-known/oauth-protected-resource/sse",
        "/.well-known/oauth-protected-resource/mcp",
        "/register",
        "/authorize",
    ):
        response = client.get(path) if path != "/register" else client.post(path, json={})
        assert response.status_code == 404, f"{path} should 404, not gate with 401"

    # The actual transport path is unaffected — still gated as before.
    assert client.get("/sse").status_code == 401


# --- Streamable HTTP (/mcp) and both transports together ---------------------------


@pytest.mark.parametrize("transport", ["http", "streamable-http"])
def test_http_transport_serves_mcp_behind_the_same_gate(monkeypatch, transport):
    monkeypatch.setenv("MCP_INBOUND_TOKEN", "x" * 32)
    client = TestClient(remote.build_app(FakeMcp(), transport))

    assert client.get("/healthz").status_code == 200
    assert client.get("/mcp").status_code == 401
    response = client.get("/mcp", headers=auth("x" * 32))
    assert response.status_code == 200
    assert response.text == "mcp-http-transport-reached"
    # the legacy endpoint is not served when only Streamable HTTP was asked for
    assert client.get("/sse", headers=auth("x" * 32)).status_code == 404


def test_both_transports_serve_both_paths_behind_one_gate(monkeypatch):
    monkeypatch.setenv("MCP_INBOUND_TOKEN", "x" * 32)
    client = TestClient(remote.build_app(FakeMcp(), "both"))

    assert client.get("/healthz").status_code == 200

    # neither endpoint answers without a credential
    assert client.get("/sse").status_code == 401
    assert client.get("/mcp").status_code == 401
    assert client.get("/mcp", headers=auth("wrong" * 8)).status_code == 401

    # each is served by its own transport once authenticated
    sse = client.get("/sse", headers=auth("x" * 32))
    assert (sse.status_code, sse.text) == (200, "mcp-transport-reached")
    http = client.get("/mcp", headers=auth("x" * 32))
    assert (http.status_code, http.text) == (200, "mcp-http-transport-reached")


def test_both_transports_share_the_oauth_layer(monkeypatch):
    """One OAuth authorization server fronts both endpoints: the same issued
    token works on /sse and /mcp, and discovery is open for either path."""
    _enable_oauth(monkeypatch)
    client = TestClient(remote.build_app(FakeMcp(), "both"), follow_redirects=False)

    for path in (
        "/.well-known/oauth-authorization-server",
        "/.well-known/oauth-protected-resource",
        "/.well-known/oauth-protected-resource/sse",
        "/.well-known/oauth-protected-resource/mcp",
    ):
        assert client.get(path).status_code == 200, f"{path} must not require auth"

    config = oauth.config_from_env()
    token, _ = oauth.issue_session_token(config, "kurtcagle")
    assert client.get("/sse", headers=auth(token)).status_code == 200
    assert client.get("/mcp", headers=auth(token)).status_code == 200
    assert client.get("/mcp").status_code == 401


class _SettingsDouble:
    stateless_http = False


def test_streamable_http_is_made_stateless(monkeypatch):
    """Identity is per task, and only stateless mode starts that task from the
    request being served -- see remote._require_stateless."""
    monkeypatch.setenv("MCP_INBOUND_TOKEN", "x" * 32)
    for transport in ("http", "streamable-http", "both"):
        fake = FakeMcp()
        fake.settings = _SettingsDouble()
        remote.build_app(fake, transport)
        assert fake.settings.stateless_http is True, transport


def test_sse_alone_leaves_the_stateless_setting_alone(monkeypatch):
    monkeypatch.setenv("MCP_INBOUND_TOKEN", "x" * 32)
    fake = FakeMcp()
    fake.settings = _SettingsDouble()
    remote.build_app(fake, "sse")
    assert fake.settings.stateless_http is False


# --- GitHub OAuth mode ------------------------------------------------------------


def _enable_oauth(monkeypatch) -> None:
    monkeypatch.setenv("GITHUB_OAUTH_CLIENT_ID", "gh-id")
    monkeypatch.setenv("GITHUB_OAUTH_CLIENT_SECRET", "gh-secret")
    monkeypatch.setenv("MCP_PUBLIC_URL", "https://bridge.example.ngrok.io")
    monkeypatch.setenv("MCP_JWT_SECRET", "a-signing-secret-well-over-32-bytes-long")
    monkeypatch.setenv("MCP_ALLOWED_GITHUB_LOGINS", "kurtcagle")


def test_oauth_metadata_is_reachable_with_no_credential_at_all(monkeypatch):
    """The exact regression: well-known routes must never sit behind the gate."""
    _enable_oauth(monkeypatch)
    app = remote.build_app(FakeMcp(), "sse")
    client = TestClient(app, follow_redirects=False)

    for path in (
        "/.well-known/oauth-authorization-server",
        "/.well-known/oauth-protected-resource",
    ):
        response = client.get(path)
        assert response.status_code == 200, f"{path} must not require auth"


def test_register_and_authorize_are_reachable_with_no_credential(monkeypatch):
    _enable_oauth(monkeypatch)
    app = remote.build_app(FakeMcp(), "sse")
    client = TestClient(app, follow_redirects=False)

    registered = client.post("/register", json={"redirect_uris": ["https://claude.ai/cb"]})
    assert registered.status_code == 201  # not 401

    authorize = client.get(
        "/authorize",
        params={
            "response_type": "code",
            "client_id": "unknown-but-still-reachable",
            "redirect_uri": "https://claude.ai/cb",
            "state": "s",
            "code_challenge": "x",
            "code_challenge_method": "S256",
        },
    )
    # 400 (bad client) is fine and expected — 401 (auth gate) would mean the
    # regression is back.
    assert authorize.status_code == 400


def test_token_endpoint_is_reachable_with_no_credential(monkeypatch):
    _enable_oauth(monkeypatch)
    app = remote.build_app(FakeMcp(), "sse")
    client = TestClient(app, follow_redirects=False)
    response = client.post("/token", data={"grant_type": "client_credentials"})
    assert response.status_code == 400  # rejected on its merits, not 401


def test_the_mcp_transport_path_still_requires_a_credential_under_oauth_mode(monkeypatch):
    _enable_oauth(monkeypatch)
    app = remote.build_app(FakeMcp(), "sse")
    client = TestClient(app)
    assert client.get("/sse").status_code == 401


def test_a_github_issued_session_token_reaches_the_transport(monkeypatch):
    _enable_oauth(monkeypatch)
    app = remote.build_app(FakeMcp(), "sse")
    client = TestClient(app)

    config = oauth.config_from_env()
    token, _ = oauth.issue_session_token(config, "kurtcagle")

    response = client.get("/sse", headers=auth(token))
    assert response.status_code == 200
    assert response.text == "mcp-transport-reached"


def test_the_gate_verifies_signature_and_expiry_only_not_allowlist_membership(monkeypatch):
    """The allowlist is enforced once, at /callback/github — not on every request.

    A validly signed token for a login the allowlist never named still passes
    the gate. This can't happen through the real flow (the callback checks
    the allowlist before any token is minted), so it isn't a hole an outside
    caller can reach — but it does mean revoking a login from
    MCP_ALLOWED_GITHUB_LOGINS doesn't invalidate a token already issued to
    it; that token remains valid until its own expiry. Stateless verification
    trades immediate revocation for not needing a lookup on every request.
    The name matters here: an earlier version of this test was misleadingly
    named "is_refused" while asserting the opposite — exactly the kind of
    test that teaches a wrong mental model to whoever reads it next.
    """
    _enable_oauth(monkeypatch)
    app = remote.build_app(FakeMcp(), "sse")
    client = TestClient(app)

    config = oauth.config_from_env()
    token, _ = oauth.issue_session_token(config, "someone-else")
    response = client.get("/sse", headers=auth(token))
    assert response.status_code == 200


def test_both_credential_kinds_work_when_both_are_configured(monkeypatch):
    _enable_oauth(monkeypatch)
    monkeypatch.setenv("MCP_INBOUND_TOKEN", "y" * 32)
    app = remote.build_app(FakeMcp(), "sse")
    client = TestClient(app)

    assert client.get("/sse", headers=auth("y" * 32)).status_code == 200

    config = oauth.config_from_env()
    token, _ = oauth.issue_session_token(config, "kurtcagle")
    assert client.get("/sse", headers=auth(token)).status_code == 200

    assert client.get("/sse", headers=auth("neither of the above")).status_code == 401


def test_a_static_token_does_not_verify_as_a_jwt_and_vice_versa(monkeypatch):
    _enable_oauth(monkeypatch)
    monkeypatch.setenv("MCP_INBOUND_TOKEN", "y" * 32)
    remote.build_app(FakeMcp(), "sse")
    config = oauth.config_from_env()
    assert oauth.verify_session_token(config, "y" * 32) is None


# --- transport security (DNS-rebinding) -------------------------------------
#
# ``_transport_security`` moved from server.py to session.py on 2026-08-28. It
# is a pure function of the environment, so these call it directly. They used
# to ``importlib.reload`` the server module to rebuild the global FastMCP
# instance, which after the move re-read nothing (the instance is built in
# session.py) and, done properly, would orphan every tool registered on the
# old instance for the rest of the suite.


def test_the_tunnel_hostname_is_allowed_past_dns_rebinding_protection(monkeypatch):
    """Regression: a real connector got 421 here after OAuth had fully succeeded.

    The MCP SDK enables DNS-rebinding protection by default with an empty
    allowed_hosts, i.e. localhost only. Behind ngrok the Host header carries
    the public hostname, so every /sse request failed with 421 and a
    ValueError raised from inside the SSE handler — after /register,
    /authorize, the GitHub round trip, and /token had all returned success.
    That ordering is what made it read as an auth bug when it wasn't one.

    MCP_PUBLIC_URL already names the public host (the OAuth layer requires
    it), so the allowlist is derived from it rather than configured twice.
    """
    monkeypatch.setenv("MCP_PUBLIC_URL", "https://bridge.example.ngrok.io")

    settings = session._transport_security()

    assert "bridge.example.ngrok.io" in settings.allowed_hosts
    # localhost must survive too — the same process is still reachable directly
    assert "127.0.0.1" in settings.allowed_hosts
    # and protection stays on; this widens the allowlist, it doesn't disable it
    assert settings.enable_dns_rebinding_protection is True


def test_extra_allowed_hosts_can_be_declared_explicitly(monkeypatch):
    monkeypatch.setenv("MCP_PUBLIC_URL", "https://bridge.example.ngrok.io")
    monkeypatch.setenv("MCP_ALLOWED_HOSTS", "proxy.internal, other.example.com")

    hosts = session._transport_security().allowed_hosts

    assert "proxy.internal" in hosts
    assert "other.example.com" in hosts
    assert "bridge.example.ngrok.io" in hosts


def test_with_no_public_url_only_localhost_is_allowed(monkeypatch):
    monkeypatch.delenv("MCP_PUBLIC_URL", raising=False)
    monkeypatch.delenv("MCP_ALLOWED_HOSTS", raising=False)

    hosts = session._transport_security().allowed_hosts

    assert "127.0.0.1" in hosts
    assert not any("ngrok" in h for h in hosts)
