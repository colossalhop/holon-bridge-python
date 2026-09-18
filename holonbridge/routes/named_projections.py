"""Named-projection routes.

A Named Projection pairs a registered named query (the semantic call) with
a stored prompt template (the deferred transform) -- see
``holonbridge/named_projections.py``'s module docstring for the concept.
This file is deliberately a close mirror of ``routes/named_queries.py``;
where it diverges, the divergence is called out below rather than left
implicit.

Same identity/Toolset-reachability shape as named queries throughout:
every route requires a resolved identity (``AnimusDep``), and list/get/run
are gated by Toolset reachability with the same "unreachable looks
identical to unknown" 404 shape ``named_queries.py`` established --
applied here to the *projection's own* registry entry, independently of
whatever reachability its wrapped query has.

**Registration ACL, one addition beyond register_named_query's own
pattern.** A projection that reaches a caller lets that caller invoke its
wrapped named query transitively, without necessarily being able to reach
that query directly -- Toolset reachability is evaluated per tool, not
transitively through a wrapper. ``register_named_query``'s own docstring
already names this exact risk for update-form query bodies ("a looser
check here would let anyone who can add a label to the registry install
something that later runs with more reach than they personally have");
the same risk applies here for *any* wrapped query, so registration
additionally requires the registrant to currently be able to reach the
named query they are wrapping -- checked once, here, not on every later
run (a definer's-rights shape, same as the update-body graph-reference
check).

**Only update-form named queries are refused as wrap targets.** A
projection renders a query's *result* (Turtle from a CONSTRUCT/DESCRIBE,
or SELECT/ASK bindings as JSON) into a prompt; a query whose body is a
SPARQL UPDATE has no result to render, so registering a projection over
one is rejected at registration time, not discovered as a confusing
failure at run time.

**Execution mode.** Only ``hb:executionMode "deferred"`` is accepted for
now -- the route runs the wrapped query and returns the prompt template
with the result interpolated in, unexecuted by any LLM. A server-executed
mode (calling an LLM synchronously, the way ``nl_query`` already can) is
an intentionally deferred extension -- see the architecture note this PR
references -- not implemented here.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone

from fastapi import APIRouter, HTTPException, Query, status
from pydantic import BaseModel, Field

from ..acl import check_replace, check_write
from ..deps import AnimusDep, ClientDep, ConnDep, PersonasDep, RegistryDep
from ..fuseki import FusekiError
from ..named_projections import (
    HB_NAMESPACE as HB,
)
from ..named_projections import (
    load_named_projections,
    render_prompt,
)
from ..named_queries import apply_query_params, load_named_queries
from ..params import ParameterError
from ..sparql_kind import classify, form
from ..toolset import bind_persona_param, resolve_reachable
from ..turtle import literal

router = APIRouter(tags=["named-projections"])
KIND = "named-projections"
QUERY_KIND = "named-queries"


def _projection_node(projection_id: str) -> str:
    return f"{HB}projection/{projection_id}"


class RunRequest(BaseModel):
    params: dict[str, object] = Field(default_factory=dict)
    dry_run: bool = Field(
        default=False, description="return the bound query and raw prompt without executing"
    )
    graph: str | None = None


class RegisterNamedProjectionRequest(BaseModel):
    id: str = Field(..., min_length=1, max_length=128, pattern=r"^[A-Za-z0-9._-]+$")
    named_query: str = Field(
        ..., min_length=1, description="id or IRI of an existing, reachable named query"
    )
    prompt_text: str = Field(..., min_length=1)
    label: str | None = None
    description: str | None = None
    output_format: str | None = None
    execution_mode: str = Field(
        default="deferred",
        pattern="^deferred$",
        description="only 'deferred' is implemented; see this module's docstring",
    )


def _not_found(projection_id: str, available_ids: list[str]) -> HTTPException:
    """Same indistinguishable-404 shape as named_queries.py's _not_found,
    for the same reason: a restricted projection must not differentially
    confirm its own existence to a caller who can't reach it."""
    return HTTPException(
        status.HTTP_404_NOT_FOUND,
        detail={
            "error": "unknown_named_projection",
            "id": projection_id,
            "available": available_ids,
        },
    )


async def _reachable_ids(iris_by_id: dict[str, str], conn, client, persona: str | None) -> set[str]:
    async def query_fn(q: str) -> dict:
        return await client.select(conn, q)

    id_by_iri = {iri: id_ for id_, iri in iris_by_id.items()}
    reachable_iris = await resolve_reachable(
        query_fn, conn, persona=persona, candidate_iris=list(id_by_iri)
    )
    return {id_by_iri[iri] for iri in reachable_iris}


async def _load_and_authorise(projection_id: str, conn, client, animus, personas, cache):
    result = await cache.get(client, conn, kind=KIND, loader=load_named_projections)
    projection = result.by_id(projection_id)
    available_ids = [p.id for p in result.projections]
    if projection is None:
        raise _not_found(projection_id, available_ids)

    persona, _source = personas.get(person_id=animus.person, dataset=conn.dataset)
    iris_by_id = {p.id: p.iri for p in result.projections}
    reachable_ids = await _reachable_ids(iris_by_id, conn, client, persona)

    if projection.id not in reachable_ids:
        raise _not_found(projection_id, sorted(reachable_ids))

    return projection, persona


@router.get("/named-projections")
async def list_named_projections(
    conn: ConnDep,
    client: ClientDep,
    animus: AnimusDep,
    personas: PersonasDep,
    cache: RegistryDep,
    filter: str | None = Query(default=None, description="substring match on id or label"),
    refresh: bool = Query(default=False),
) -> dict:
    result = await cache.get(
        client, conn, kind=KIND, loader=load_named_projections, refresh=refresh
    )

    persona, _source = personas.get(person_id=animus.person, dataset=conn.dataset)
    iris_by_id = {p.id: p.iri for p in result.projections}
    reachable_ids = await _reachable_ids(iris_by_id, conn, client, persona)

    projections = [p for p in result.projections if p.id in reachable_ids]
    if filter:
        needle = filter.lower()
        projections = [
            p for p in projections if needle in p.id.lower() or needle in p.label.lower()
        ]

    return {
        "dataset": conn.dataset,
        "graph": conn.graph("named-projections"),
        "count": len(projections),
        "projections": [p.summary() for p in projections],
        "warnings": result.warnings,
    }


@router.get("/named-projection/{projection_id}")
async def get_named_projection(
    projection_id: str,
    conn: ConnDep,
    client: ClientDep,
    animus: AnimusDep,
    personas: PersonasDep,
    cache: RegistryDep,
) -> dict:
    projection, _persona = await _load_and_authorise(
        projection_id, conn, client, animus, personas, cache
    )
    return projection.detail()


@router.post("/named-projection/{projection_id}/run")
async def run_named_projection(
    projection_id: str,
    body: RunRequest,
    conn: ConnDep,
    client: ClientDep,
    animus: AnimusDep,
    personas: PersonasDep,
    cache: RegistryDep,
) -> dict:
    projection, persona = await _load_and_authorise(
        projection_id, conn, client, animus, personas, cache
    )

    # Definer's-rights shape (see named_queries.py's own registration
    # docstring): the wrapped query's own Toolset reachability was already
    # checked once, at registration time. It is not re-checked here --
    # reaching the projection is what run authorises, same as reaching a
    # stored procedure authorises whatever it does internally.
    query_result = await cache.get(client, conn, kind=QUERY_KIND, loader=load_named_queries)
    wrapped = query_result.by_id(projection.named_query) or next(
        (q for q in query_result.queries if q.iri == projection.named_query), None
    )
    if wrapped is None:
        raise HTTPException(
            status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=(
                f"projection {projection_id!r} names named query "
                f"{projection.named_query!r}, which no longer resolves"
            ),
        )

    persona_iri = conn.persona_graph(persona) if persona else None
    params = bind_persona_param(
        body.params,
        persona_iri=persona_iri,
        declares_persona="persona" in wrapped.declared,
    )

    try:
        bound = apply_query_params(wrapped, params)
    except ParameterError as exc:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            detail={"error": "parameter_error", "id": projection_id, "message": str(exc)},
        ) from exc

    if bound.missing:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            detail={
                "error": "missing_parameters",
                "id": projection_id,
                "missing": bound.missing,
                "strategy": bound.strategy,
            },
        )

    envelope = {
        "id": projection.id,
        "namedQuery": wrapped.id,
        "strategy": bound.strategy,
        "bound": bound.bound,
        "sparql": bound.sparql,
        "executionMode": projection.execution_mode,
    }

    if body.dry_run:
        return {**envelope, "executed": False, "prompt": projection.prompt_text}

    graph = body.graph or wrapped.target_graph

    try:
        if form(bound.sparql) in {"CONSTRUCT", "DESCRIBE"}:
            turtle_result = await client.construct(conn, bound.sparql, default_graph=graph)
            result_text = turtle_result
        else:
            results = await client.select(conn, bound.sparql, default_graph=graph)
            result_text = json.dumps(results, indent=2)
    except FusekiError as exc:
        raise HTTPException(exc.status or 502, detail=exc.as_dict()) from exc

    return {
        **envelope,
        "executed": True,
        "result": result_text,
        "prompt": render_prompt(projection.prompt_text, result_text),
        "status": "deferred",
    }


@router.post("/named-projections/reload")
async def reload_named_projections(
    conn: ConnDep, client: ClientDep, cache: RegistryDep
) -> dict:
    """Registry cache maintenance, ungated -- identical reasoning to
    reload_named_queries."""
    cache.invalidate(conn, KIND)
    result = await cache.get(
        client, conn, kind=KIND, loader=load_named_projections, refresh=True
    )
    return {
        "ok": True,
        "dataset": conn.dataset,
        "count": len(result.projections),
        "warnings": result.warnings,
    }


# --- registration ---------------------------------------------------------


def _render_registration_turtle(
    body: RegisterNamedProjectionRequest, wrapped_iri: str, registered_at: str
) -> str:
    node = f"<{_projection_node(body.id)}>"

    lines = [
        f"{node} a <{HB}NamedProjection> ;",
        f"  <{HB}id> {literal(body.id)} ;",
        f"  <{HB}namedQuery> <{wrapped_iri}> ;",
        f"  <{HB}promptText> {literal(body.prompt_text)} ;",
        f"  <{HB}executionMode> {literal(body.execution_mode)} ;",
    ]
    if body.label:
        lines.append(f"  <{HB}label> {literal(body.label)} ;")
    if body.description:
        lines.append(f"  <{HB}description> {literal(body.description)} ;")
    if body.output_format:
        lines.append(f"  <{HB}outputFormat> {literal(body.output_format)} ;")
    lines.append(
        "  <" + HB + "registeredAt> "
        + literal(registered_at, datatype="<http://www.w3.org/2001/XMLSchema#dateTime>")
        + " ."
    )
    return "\n".join(lines)


@router.post("/named-projection")
async def register_named_projection(
    body: RegisterNamedProjectionRequest,
    conn: ConnDep,
    client: ClientDep,
    animus: AnimusDep,
    personas: PersonasDep,
    cache: RegistryDep,
) -> dict:
    """Register (or overwrite) a Named Projection.

    See this module's docstring for the full ACL reasoning: check_write on
    the named-projections graph always; additionally, the wrapped named
    query must exist, must not be update-form, and must currently be
    reachable by the registering caller.
    """
    if animus.person is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail="unresolved identity")

    registry = conn.graph("named-projections")

    async def query_fn(q: str) -> dict:
        return await client.select(conn, q)

    decision = await check_write(
        query_fn, conn.holons_graph, person=animus.person, target=registry
    )
    if not decision.allowed:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN, detail=f"{decision.reason} (graph: {registry})"
        )

    query_result = await cache.get(client, conn, kind=QUERY_KIND, loader=load_named_queries)
    wrapped = query_result.by_id(body.named_query) or next(
        (q for q in query_result.queries if q.iri == body.named_query), None
    )
    if wrapped is None:
        raise HTTPException(
            status.HTTP_404_NOT_FOUND,
            detail={"error": "unknown_named_query", "id": body.named_query},
        )

    if classify(wrapped.sparql) == "update":
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            detail=(
                f"named query {wrapped.id!r} is update-form; a projection "
                "renders a query result and cannot wrap a query with no result"
            ),
        )

    persona, _source = personas.get(person_id=animus.person, dataset=conn.dataset)
    reachable = await _reachable_ids({wrapped.id: wrapped.iri}, conn, client, persona)
    if wrapped.id not in reachable:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            detail=(
                f"cannot register a projection over named query {wrapped.id!r}: "
                "you cannot currently reach it yourself"
            ),
        )

    registered_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
    insert_body = _render_registration_turtle(body, wrapped.iri, registered_at)
    node = f"<{_projection_node(body.id)}>"

    update = f"""DELETE WHERE {{ GRAPH <{registry}> {{ {node} ?p ?o }} }} ;
INSERT DATA {{ GRAPH <{registry}> {{
{insert_body}
}} }}"""

    try:
        await client.update(conn, update)
    except FusekiError as exc:
        raise HTTPException(exc.status or 502, detail=exc.as_dict()) from exc

    cache.invalidate(conn, KIND)
    return {
        "ok": True,
        "id": body.id,
        "iri": _projection_node(body.id),
        "graph": registry,
        "namedQuery": wrapped.id,
    }


@router.delete("/named-projection/{projection_id}")
async def delete_named_projection(
    projection_id: str,
    conn: ConnDep,
    client: ClientDep,
    animus: AnimusDep,
    cache: RegistryDep,
) -> dict:
    """Remove a registered projection. check_replace, same tier as
    delete_named_query -- destructive, not an ordinary append."""
    if animus.person is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail="unresolved identity")

    registry = conn.graph("named-projections")

    async def query_fn(q: str) -> dict:
        return await client.select(conn, q)

    decision = await check_replace(
        query_fn, conn.holons_graph, person=animus.person, target=registry
    )
    if not decision.allowed:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN, detail=f"{decision.reason} (graph: {registry})"
        )

    result = await cache.get(client, conn, kind=KIND, loader=load_named_projections)
    projection = result.by_id(projection_id)
    if projection is None:
        raise HTTPException(
            status.HTTP_404_NOT_FOUND,
            detail={"error": "unknown_named_projection", "id": projection_id},
        )

    node = f"<{projection.iri}>"
    update = f"DELETE WHERE {{ GRAPH <{registry}> {{ {node} ?p ?o }} }}"

    try:
        await client.update(conn, update)
    except FusekiError as exc:
        raise HTTPException(exc.status or 502, detail=exc.as_dict()) from exc

    cache.invalidate(conn, KIND)
    return {"ok": True, "id": projection_id, "graph": registry}
