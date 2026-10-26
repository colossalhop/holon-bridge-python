"""Which credential the MCP process presents to the REST bridge.

The MCP takes its own token from ``HOLONBRIDGE_MCP_TOKEN`` and falls back to
``BEARER_TOKEN``, so existing setups keep working while a deployment that has
moved the REST process onto ``PROXY_TOKENS`` can give the MCP a token that is not
also the legacy one (one token, one role).

``session.BEARER`` is fixed at import, so the resolution is tested through
``resolve_mcp_token`` with an explicit environment, and the header through
``session._headers`` with ``BEARER`` patched.
"""

from __future__ import annotations

import pytest

from holonbridge_mcp import session
from holonbridge_mcp.session import resolve_mcp_token

MCP = "mcp-own-token-0123456789abcdef0123"
LEGACY = "legacy-shared-token-0123456789abcd"


def test_the_mcp_token_wins_over_bearer_token():
    env = {"HOLONBRIDGE_MCP_TOKEN": MCP, "BEARER_TOKEN": LEGACY}

    assert resolve_mcp_token(env) == (MCP, "HOLONBRIDGE_MCP_TOKEN")


def test_bearer_token_is_the_fallback_so_existing_setups_keep_working():
    assert resolve_mcp_token({"BEARER_TOKEN": LEGACY}) == (LEGACY, "BEARER_TOKEN")


@pytest.mark.parametrize("blank", ["", "   "])
def test_a_blank_mcp_token_falls_through_instead_of_masking_the_fallback(blank):
    env = {"HOLONBRIDGE_MCP_TOKEN": blank, "BEARER_TOKEN": LEGACY}

    assert resolve_mcp_token(env) == (LEGACY, "BEARER_TOKEN")


def test_a_blank_bearer_token_does_not_hide_the_mcp_token():
    """The shared .env carries ``BEARER_TOKEN=`` blank for the REST process."""
    env = {"HOLONBRIDGE_MCP_TOKEN": MCP, "BEARER_TOKEN": ""}

    assert resolve_mcp_token(env) == (MCP, "HOLONBRIDGE_MCP_TOKEN")


def test_no_token_anywhere_is_an_empty_token_with_no_source():
    assert resolve_mcp_token({}) == ("", None)
    assert resolve_mcp_token({"HOLONBRIDGE_MCP_TOKEN": " ", "BEARER_TOKEN": ""}) == ("", None)


def test_surrounding_whitespace_is_not_part_of_the_token():
    assert resolve_mcp_token({"HOLONBRIDGE_MCP_TOKEN": f"  {MCP}\n"}) == (MCP, "HOLONBRIDGE_MCP_TOKEN")


def test_the_resolved_token_is_what_goes_on_the_wire(monkeypatch):
    monkeypatch.setattr(session, "BEARER", MCP)

    assert session._headers()["Authorization"] == f"Bearer {MCP}"


def test_without_a_token_no_authorization_header_is_sent(monkeypatch):
    monkeypatch.setattr(session, "BEARER", "")

    assert "Authorization" not in session._headers()
