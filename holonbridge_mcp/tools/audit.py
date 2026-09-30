"""Audit tools: read the audit log and control the dataset's audit level.

Thin wrappers over ``/audit`` on the REST bridge; all authorisation lives
there. Admin-only. Entries record who acted (and, under ``act_as``, who was
really behind it), what authorised a write, which graphs were touched, and
every refusal. Payloads are never stored, only a digest and a size.

Turning audit down: ``set_audit_level`` has a floor of 'mutations'. A quieter
setting is a time-boxed ``suspend_audit`` (reason required, reverts by
itself, start and end both recorded); a permanent 'denials' or 'off' is an
operator decision made in the bridge's environment, not through this API.
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
    graphs is one item with a ``graphs`` list; ``note`` carries the reason for
    a refusal or a change to the audit setting.

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
    """This dataset's audit setting. Admin-only.

    Reports the effective level and where it comes from: an active
    suspension (level, expiry, reason, who), the level set through the API,
    and the operator's level from the bridge's environment. Levels, least to
    most verbose: 'off', 'denials' (refusals only), 'mutations' (refusals and
    every write), 'standard' (adds security reads; the default).
    """
    return await _call("GET", "/audit/level")


@mcp.tool()
async def set_audit_level(level: str) -> dict:
    """Set this dataset's audit level: 'mutations' or 'standard', or
    'default' to clear the override and fall back to the operator's level.
    Admin-only. The change itself is always recorded.

    'off' and 'denials' are refused here on purpose: use ``suspend_audit``
    for a time-boxed one, or ask whoever runs the bridge to set
    HOLONBRIDGE_AUDIT_LEVEL / HOLONBRIDGE_AUDIT_LEVELS for a permanent one.
    """
    return await _call("POST", "/audit/level", json_body={"level": level})


@mcp.tool()
async def suspend_audit(level: str, minutes: int, reason: str) -> dict:
    """Temporarily lower auditing to 'denials' or 'off'. Admin-only.

    A reason is mandatory and is recorded. ``minutes`` is 1 to the maximum
    reported by ``get_audit_level`` (currently 240). It reverts by itself,
    and its start and end are both recorded. Meant for things like a bulk
    load; a new suspension replaces one already running.
    """
    return await _call(
        "POST", "/audit/suspend",
        json_body={"level": level, "minutes": minutes, "reason": reason},
    )


@mcp.tool()
async def resume_audit() -> dict:
    """End a running audit suspension early. Admin-only. Recorded, and
    harmless if none is running."""
    return await _call("POST", "/audit/resume")
