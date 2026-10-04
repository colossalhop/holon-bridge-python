"""Identity over Streamable HTTP, end to end through the real MCP SDK.

``test_mcp_remote.py`` uses a stand-in for FastMCP, which is right for routing
and gating but cannot say whether the caller's identity actually reaches a tool
handler. That depends on which request's context the SDK starts the handler's
task from, so it has to be checked against the SDK itself.

The property pinned here: with Streamable HTTP served stateless (which
``remote.build_app`` arranges), each request runs as the login on *its own*
bearer token. In the SDK's default stateful mode a session's task is started
from the request that created it, so a later request on the same session would
run as the first caller. A tool that just reports ``current_github_login`` makes
that visible.

Each test builds its own FastMCP: a Streamable HTTP session manager can only be
run once per instance, and the module-level one in ``session.py`` carries all
of the bridge's tools.
"""

from __future__ import annotations

import json

from mcp.server.fastmcp import FastMCP
from mcp.server.transport_security import TransportSecuritySettings
from starlette.testclient import TestClient

from holonbridge_mcp import github_oauth as oauth
from holonbridge_mcp import remote
from holonbridge_mcp.identity import current_github_login


def _enable_oauth(monkeypatch) -> None:
    monkeypatch.setenv("GITHUB_OAUTH_CLIENT_ID", "gh-id")
    monkeypatch.setenv("GITHUB_OAUTH_CLIENT_SECRET", "gh-secret")
    monkeypatch.setenv("MCP_PUBLIC_URL", "https://bridge.example.ngrok.io")
    monkeypatch.setenv("MCP_JWT_SECRET", "a-signing-secret-well-over-32-bytes-long")
    monkeypatch.setenv("MCP_ALLOWED_GITHUB_LOGINS", "alice,bob")


def _probe_mcp() -> FastMCP:
    # DNS-rebinding protection off: the TestClient's Host is "testserver", and
    # that check is session.py's concern, covered in test_mcp_remote.py.
    mcp = FastMCP(
        "identity-probe",
        transport_security=TransportSecuritySettings(enable_dns_rebinding_protection=False),
    )

    @mcp.tool()
    def whoami() -> str:
        """The login the bridge would present downstream for this call."""
        return current_github_login.get() or "anonymous"

    return mcp


def _call_whoami(client: TestClient, token: str, request_id: int) -> str:
    response = client.post(
        "/mcp",
        json={
            "jsonrpc": "2.0",
            "id": request_id,
            "method": "tools/call",
            "params": {"name": "whoami", "arguments": {}},
        },
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/json, text/event-stream",
            "Content-Type": "application/json",
        },
    )
    assert response.status_code == 200, response.text
    if response.headers.get("content-type", "").startswith("application/json"):
        message = response.json()
    else:  # the SDK frames a POST response as an SSE event by default
        data = [line[5:].strip() for line in response.text.splitlines() if line.startswith("data:")]
        assert data, response.text
        message = json.loads(data[-1])
    assert "error" not in message, message
    return message["result"]["content"][0]["text"]


def test_each_request_runs_as_the_identity_on_its_own_token(monkeypatch):
    _enable_oauth(monkeypatch)
    config = oauth.config_from_env()
    alice, _ = oauth.issue_session_token(config, "alice")
    bob, _ = oauth.issue_session_token(config, "bob")

    app = remote.build_app(_probe_mcp(), "both")
    with TestClient(app) as client:
        # Interleaved on purpose: a session-bound identity would answer
        # "alice" to all three.
        assert _call_whoami(client, alice, 1) == "alice"
        assert _call_whoami(client, bob, 2) == "bob"
        assert _call_whoami(client, alice, 3) == "alice"


def test_a_static_token_call_is_anonymous_not_a_leftover_identity(monkeypatch):
    _enable_oauth(monkeypatch)
    monkeypatch.setenv("MCP_INBOUND_TOKEN", "s" * 32)
    config = oauth.config_from_env()
    alice, _ = oauth.issue_session_token(config, "alice")

    app = remote.build_app(_probe_mcp(), "http")
    with TestClient(app) as client:
        assert _call_whoami(client, alice, 1) == "alice"
        # The static token carries no per-user identity, and must not inherit
        # the previous caller's.
        assert _call_whoami(client, "s" * 32, 2) == "anonymous"


def test_both_endpoints_are_mounted_and_gated_on_the_real_sdk(monkeypatch):
    _enable_oauth(monkeypatch)
    app = remote.build_app(_probe_mcp(), "both")
    with TestClient(app) as client:
        assert client.get("/healthz").status_code == 200
        assert client.get("/sse").status_code == 401
        assert client.post("/mcp", json={}).status_code == 401
