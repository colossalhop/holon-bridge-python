"""Named-projection tools."""

from __future__ import annotations

from ..session import _call, mcp


@mcp.tool()
async def list_named_projections(filter: str | None = None) -> dict:
    """List registered Named Projections.

    A Named Projection pairs a registered named query (the semantic call)
    with a stored prompt template applied to that query's result -- see
    ``register_named_projection``.
    """
    params = {"filter": filter} if filter else None
    return await _call("GET", "/named-projections", params=params)


@mcp.tool()
async def get_named_projection(projection_id: str) -> dict:
    """Full definition of one Named Projection, including its prompt text."""
    return await _call("GET", f"/named-projection/{projection_id}")


@mcp.tool()
async def run_named_projection(
    projection_id: str,
    params: dict | None = None,
    dry_run: bool = False,
    graph: str | None = None,
) -> dict:
    """Run a Named Projection: bind and run its wrapped named query, then
    return the projection's prompt with the result interpolated in.

    Only ``executionMode: "deferred"`` exists today -- no LLM call happens
    inside the bridge. The caller (an agent, human or LLM) applies the
    returned prompt itself; the response is marked ``"status": "deferred"``
    to make that explicit, the same convention Pipeline's own deferred
    stages already use. Set ``dry_run`` to see the bound query and the raw,
    uninterpolated prompt without executing anything.
    """
    return await _call(
        "POST",
        f"/named-projection/{projection_id}/run",
        json_body={"params": params or {}, "dry_run": dry_run, "graph": graph},
    )


@mcp.tool()
async def reload_named_projections() -> dict:
    """Re-read the named-projection registry, discarding the cached copy."""
    return await _call("POST", "/named-projections/reload")


@mcp.tool()
async def register_named_projection(
    id: str,
    named_query: str,
    prompt_text: str,
    label: str | None = None,
    description: str | None = None,
    output_format: str | None = None,
    execution_mode: str = "deferred",
) -> dict:
    """Register (or overwrite) a Named Projection.

    ``named_query`` is the id or IRI of an existing, reachable named query
    -- the semantic call. ``prompt_text`` is the deferred transform: a
    template that may contain one ``{{result}}`` placeholder, filled in at
    run time with the wrapped query's rendered result (Turtle for a
    CONSTRUCT/DESCRIBE query, JSON for a SELECT/ASK query). A template with
    no ``{{result}}`` placeholder gets the result appended rather than
    silently dropped.

    Registration requires write access to the named-projections registry,
    and additionally requires that you can currently reach the named query
    you are wrapping yourself -- a projection that reached a caller would
    otherwise let them invoke its wrapped query transitively, bypassing
    whatever Toolset restriction that query has. Wrapping an update-form
    named query is rejected: a projection renders a query's result, and an
    update has none.

    ``execution_mode`` only accepts ``"deferred"`` today -- a server-side,
    synchronously-executed LLM transform is a documented future extension,
    not yet implemented.
    """
    return await _call(
        "POST",
        "/named-projection",
        json_body={
            "id": id,
            "named_query": named_query,
            "prompt_text": prompt_text,
            "label": label,
            "description": description,
            "output_format": output_format,
            "execution_mode": execution_mode,
        },
    )


@mcp.tool()
async def delete_named_projection(projection_id: str) -> dict:
    """Remove a registered Named Projection by id.

    Requires replace-level access to the named-projections registry graph
    -- the same tier as deleting a named query, not an ordinary write.
    """
    return await _call("DELETE", f"/named-projection/{projection_id}")
