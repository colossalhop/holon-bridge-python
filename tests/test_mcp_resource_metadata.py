"""Discovery documents for the Streamable HTTP endpoint (/mcp).

Two things a client reads before it ever sends a credential:

- the RFC 9728 protected-resource metadata, whose ``resource`` must name the
  resource the well-known URL was derived from (§3.3), and
- the ``WWW-Authenticate`` challenge on a 401, which points at that metadata.

A connector registered against ``/sse`` works with the bare-origin ``resource``
and the plain ``Bearer`` challenge, so those stay exactly as they were; only
the ``/mcp`` variants change. These tests pin both halves of that.
"""

from __future__ import annotations

import pytest
from starlette.testclient import TestClient

from holonbridge_mcp import remote

from .test_mcp_remote import FakeMcp, _enable_oauth, _clean_env  # noqa: F401 - fixture

PUBLIC = "https://bridge.example.ngrok.io"


@pytest.fixture
def client(monkeypatch) -> TestClient:
    _enable_oauth(monkeypatch)
    return TestClient(remote.build_app(FakeMcp(), "both"), follow_redirects=False)


# --- protected-resource metadata ---------------------------------------------


def test_mcp_suffix_names_the_mcp_url_as_its_resource(client):
    body = client.get("/.well-known/oauth-protected-resource/mcp").json()
    assert body["resource"] == f"{PUBLIC}/mcp"
    assert body["authorization_servers"] == [PUBLIC]


def test_bare_and_sse_variants_are_unchanged(client):
    for path in (
        "/.well-known/oauth-protected-resource",
        "/.well-known/oauth-protected-resource/sse",
    ):
        body = client.get(path).json()
        assert body["resource"] == PUBLIC, path
        assert body["authorization_servers"] == [PUBLIC], path


# --- 401 challenge ----------------------------------------------------------------


def test_a_401_on_mcp_points_at_its_resource_metadata(client):
    response = client.get("/mcp")
    assert response.status_code == 401
    challenge = response.headers["www-authenticate"]
    assert challenge.startswith("Bearer ")
    assert f'resource_metadata="{PUBLIC}/.well-known/oauth-protected-resource/mcp"' in challenge


def test_a_401_on_sse_keeps_the_plain_challenge(client):
    response = client.get("/sse")
    assert response.status_code == 401
    assert response.headers["www-authenticate"] == "Bearer"


def test_a_bad_token_on_mcp_gets_the_same_challenge(client):
    response = client.post("/mcp", headers={"Authorization": "Bearer not-a-real-token"})
    assert response.status_code == 401
    assert "resource_metadata=" in response.headers["www-authenticate"]


def test_without_oauth_the_challenge_stays_plain_on_mcp(monkeypatch):
    """Static-token-only deployments have no metadata document to point at."""
    monkeypatch.setenv("MCP_INBOUND_TOKEN", "x" * 32)
    plain = TestClient(remote.build_app(FakeMcp(), "both"))
    response = plain.get("/mcp")
    assert response.status_code == 401
    assert response.headers["www-authenticate"] == "Bearer"
