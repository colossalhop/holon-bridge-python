"""Delegation tools: let another Person read and/or write inside your own
persona-user graphs, for a bounded time, without impersonation.

Thin wrappers over ``/delegation`` on the REST bridge -- all authorisation
and validation lives there. To read as someone who has delegated to you,
pass ``on_behalf_of`` to ``get_holon``; writes need nothing extra, because
the target graph already names whose graph it is.
"""

from __future__ import annotations

from ..session import mcp, _call


@mcp.tool()
async def create_delegation(
    delegate: str,
    persona: str,
    permissions: list[str] | None = None,
    roles: list[str] | None = None,
    lifetime_days: float | None = None,
    note: str | None = None,
    delegator: str | None = None,
) -> dict:
    """Share your own graphs under one persona with another Person.

    ``delegate`` is a short Person slug (e.g. 'jane-doe') or a full Person
    IRI. ``persona`` is the local persona name (e.g. 'phoebe'); you must
    hold a Home under it. ``permissions`` is any of 'read' and 'write'
    (default both) -- there is deliberately no 'replace', no admin and no
    Role, and a 'write' delegation is refused unless you can write those
    graphs yourself. ``roles`` picks which of your graphs in that persona:
    'holons' (default) and/or 'scene'; 'events' is never delegable.
    ``lifetime_days`` defaults to 7 and is capped at 90. ``note`` is an
    optional comment kept on the record.

    The delegate keeps their own identity throughout: nothing is
    impersonated, and their writes are theirs. ``delegator`` is admin-only,
    to create one on someone else's behalf.

    Which graphs are covered is derived by the bridge from your identity
    and the persona -- it is never taken from this call, so you cannot
    delegate a graph that is not yours.
    """
    body: dict = {"delegate": delegate, "persona": persona}
    for key, value in (
        ("permissions", permissions),
        ("roles", roles),
        ("lifetime_days", lifetime_days),
        ("note", note),
        ("delegator", delegator),
    ):
        if value is not None:
            body[key] = value
    return await _call("POST", "/delegation", json_body=body)


@mcp.tool()
async def revoke_delegation(delegation: str) -> dict:
    """Revoke a delegation (its full IRI, from ``list_delegations``).

    The delegator, the delegate (declining or resigning) or an admin may
    revoke. Access ends immediately. The record is kept, stamped
    ``holon:revokedAt``, not deleted. Safe to repeat.
    """
    return await _call("POST", "/delegation/revoke", json_body={"delegation": delegation})


@mcp.tool()
async def list_delegations(direction: str = "both", all: bool = False) -> dict:
    """Delegations you have given and/or received, each with a derived
    status: active, expired, revoked or not_yet_valid.

    ``direction`` is 'given', 'received' or 'both'. ``all=True`` lists every
    delegation in the dataset and is admin-only.
    """
    params: dict = {"direction": direction}
    if all:
        params["all"] = "true"
    return await _call("GET", "/delegation", params=params)
