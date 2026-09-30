"""Audit tools: read the audit log and set the dataset's audit level.

Thin wrappers over ``/audit`` on the REST bridge; all authorisation lives
there. Admin-only. Entries record who acted (and, under ``act_as``, who was
really behind it), what authorised a write, which graphs were touched, and
every refusal. Payloads are never stored, only a digest and a size.
"""

from __future__ import annotations

from ..session import mcp, _call


@mcp.tool()
async def list_audit(
    actor: str | None = None,
    outcome: str | None = None,
    since: str | None = None,
    limit: int = 100,
) -> dict:
    """List audit entries, newest first. Admin-only.

    ``actor`` is a Person slug or IRI. ``outcome`` is 'allowed', 'denied' or
    'error'. ``since`` is an ISO 8601 timestamp (e.g. '2026-09-30T00:00:00Z').
    ``limit`` defaults to 100, maximum 1000. An entry that touched several
    graphs is one item with a ``graphs`` list.

    Every mutation and every refusal is recorded; at the default 'standard'
    level so are security-relevant reads (under ``act_as``, ``on_behalf_of``,
    or of another person's private graph). Ordinary reads are not.
    """
    params: dict = {"limit": limit}
    for key, value in (("actor", actor), ("outcome", outcome), ("since", since)):
        if value:
            params[key] = value
    return await _call("GET", "/audit", params=params)


@mcp.tool()
async def get_audit_level() -> dict:
    """This dataset's audit level and the levels available. Admin-only.

    Levels, least to most verbose: 'off', 'denials' (refusals only),
    'mutations' (refusals and every write), 'standard' (adds security
    reads; the default).
    """
    return await _call("GET", "/audit/level")


@mcp.tool()
async def set_audit_level(level: str) -> dict:
    """Set this dataset's audit level: 'off', 'denials', 'mutations' or
    'standard'. Admin-only. The change itself is always recorded, whatever
    level it sets.
    """
    return await _call("POST", "/audit/level", json_body={"level": level})
