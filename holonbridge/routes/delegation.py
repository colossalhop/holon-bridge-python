"""Delegation routes: create, revoke, list.

Unlike everything in ``identity_admin.py`` these are NOT admin-only. A
delegation is self-service by design -- a Person shares their own graphs
with someone they choose -- and the rules that keep that safe live here,
not in a role check:

- The covered graphs are derived from the delegator's own identity and the
  named persona (``conn.persona_user_graph``), never accepted from the
  request, so nobody can delegate a graph that is not theirs.
- A ``write`` delegation is refused unless the delegator can themselves
  write every covered graph (``check_write``): you cannot delegate
  authority you do not hold.
- The delegator must hold a Home under the persona, the same membership
  test ``switch_persona`` applies.
- Only ``read`` and ``write`` exist. There is no way to ask for replace,
  admin, or a Role.
- The lifetime is required to be bounded (default 7 days, max 90).

An admin may create or revoke on someone's behalf (``delegator`` field /
revoking any delegation); the checks above still apply to the delegator.

Writes go straight to ``holons_graph`` through ``client.post_graph``, the
same bridge-internal path ``create_person`` and ``grant_write`` use, after
the checks above -- not through ``write_turtle_to_graph``, which would ask
the caller for a ``grantsWrite`` on the holons graph that ordinary people
(rightly) do not hold.

Registered in server.py alongside the other routers:
``app.include_router(delegation.router)``.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, HTTPException, Query, status
from pydantic import BaseModel, Field

from .. import delegation as dg
from ..acl import check_write, is_admin
from ..deps import AnimusDep, ClientDep, ConnDep
from ..fuseki import FusekiError
from ..persona import has_home, persona_exists

router = APIRouter(prefix="/delegation", tags=["delegation"])

HOLON = "https://w3id.org/holon/"


def _person(conn, value: str) -> str:
    """Slug or full IRI -> Person IRI. Same rule as identity_admin's
    ``_resolve_person``; restated so this module does not import a
    private helper from a sibling route module."""
    return value if value.startswith("http") or ":" in value else conn.person_iri(value)


async def _active_person_exists(query_fn, conn, person: str) -> bool:
    result = await query_fn(
        f"""PREFIX holon: <{HOLON}>
ASK {{ GRAPH <{conn.holons_graph}> {{
  <{person}> a holon:Person .
  FILTER NOT EXISTS {{ <{person}> holon:status "inactive" }}
}} }}"""
    )
    return bool(result.get("boolean"))


class CreateDelegationRequest(BaseModel):
    delegate: str = Field(..., min_length=1, description="Person to share with: slug or full IRI.")
    persona: str = Field(..., min_length=1, description="Local persona name, e.g. 'phoebe'.")
    permissions: list[str] = Field(
        default_factory=lambda: ["read", "write"],
        description="Any of 'read', 'write'. There is no 'replace'.",
    )
    roles: list[str] = Field(
        default_factory=lambda: ["holons"],
        description="Which of the delegator's graphs in that persona: 'holons' and/or 'scene'.",
    )
    lifetime_days: float | None = Field(
        default=None, gt=0, description="Defaults to 7; maximum 90."
    )
    note: str | None = Field(default=None, description="Optional rdfs:comment for the record.")
    delegator: str | None = Field(
        default=None,
        description="Admin only: create on behalf of this Person. Omit to delegate your own graphs.",
    )


@router.post("")
async def create_delegation(
    body: CreateDelegationRequest, conn: ConnDep, client: ClientDep, animus: AnimusDep
) -> dict:
    if animus.person is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail="unresolved identity")

    async def query_fn(q: str) -> dict:
        return await client.select(conn, q)

    delegator = animus.person
    if body.delegator is not None:
        requested = _person(conn, body.delegator)
        if requested != animus.person:
            if not await is_admin(query_fn, conn.holons_graph, person=animus.real_person):
                raise HTTPException(
                    status.HTTP_403_FORBIDDEN,
                    detail="only an admin may delegate on someone else's behalf",
                )
            delegator = requested

    delegate = _person(conn, body.delegate)
    lifetime = timedelta(days=body.lifetime_days) if body.lifetime_days else dg.DEFAULT_LIFETIME

    try:
        # Both come from the request (the delegate always; the delegator for
        # an admin) and end up inside generated Turtle and SPARQL: refuse
        # anything that could change the statement's structure.
        delegator = dg.safe_iri(delegator)
        delegate = dg.safe_iri(delegate)
        dg.validate_request(
            delegator=delegator, delegate=delegate, permissions=body.permissions,
            roles=body.roles, lifetime=lifetime,
        )
        graphs = [
            conn.persona_user_graph(body.persona, role, conn.person_slug(delegator))
            for role in body.roles
        ]
        persona_iri = conn.persona_graph(body.persona)
    except (dg.DelegationError, ValueError) as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc

    try:
        if not await _active_person_exists(query_fn, conn, delegate):
            raise HTTPException(
                status.HTTP_404_NOT_FOUND, detail=f"no active holon:Person found: {delegate}"
            )
        if not await persona_exists(query_fn, conn, persona=body.persona):
            raise HTTPException(
                status.HTTP_404_NOT_FOUND, detail=f"no holon:Persona named {body.persona!r}"
            )
        if not await has_home(query_fn, conn, persona=body.persona, person_id=delegator):
            raise HTTPException(
                status.HTTP_403_FORBIDDEN,
                detail=f"the delegator holds no Home under persona {body.persona!r}",
            )
        if "write" in body.permissions:
            for graph in graphs:
                held = await check_write(
                    query_fn, conn.holons_graph, person=delegator, target=graph
                )
                if not held.allowed:
                    raise HTTPException(
                        status.HTTP_403_FORBIDDEN,
                        detail=f"cannot delegate write access the delegator does not hold ({graph})",
                    )

        start, end = dg.default_window(lifetime)
        iri = dg.delegation_iri(conn.holons_graph, dg.new_delegation_slug())
        turtle = dg.build_delegation(
            delegation_iri=iri, delegator=delegator, delegate=delegate,
            persona=persona_iri, graphs=graphs, permissions=body.permissions,
            valid_from=start, valid_until=end, note=body.note,
        )
        await client.post_graph(conn, conn.holons_graph, turtle)
    except dg.DelegationError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    except FusekiError as exc:
        raise HTTPException(exc.status or 502, detail=exc.as_dict()) from exc

    return {
        "ok": True, "delegation": iri, "delegator": delegator, "delegate": delegate,
        "persona": persona_iri, "graphs": graphs, "permissions": sorted(set(body.permissions)),
        "valid_from": dg._iso(start), "valid_until": dg._iso(end),
    }


class RevokeDelegationRequest(BaseModel):
    delegation: str = Field(..., min_length=1, description="Delegation IRI.")


@router.post("/revoke")
async def revoke_delegation(
    body: RevokeDelegationRequest, conn: ConnDep, client: ClientDep, animus: AnimusDep
) -> dict:
    """The delegator, the delegate (declining or resigning) or an admin may
    revoke. Retains the record with ``holon:revokedAt``; never deletes."""
    if animus.person is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail="unresolved identity")

    async def query_fn(q: str) -> dict:
        return await client.select(conn, q)

    try:
        rows = [
            r for r in await dg.list_delegations(query_fn, conn.holons_graph)
            if r["delegation"] == body.delegation
        ]
        if not rows:
            return {"ok": False, "delegation": body.delegation,
                    "note": "not_found: no such delegation"}
        row = rows[0]
        if animus.person not in (row["delegator"], row["delegate"]) and not await is_admin(
            query_fn, conn.holons_graph, person=animus.real_person
        ):
            raise HTTPException(
                status.HTTP_403_FORBIDDEN,
                detail="only the delegator, the delegate, or an admin may revoke a delegation",
            )
        if row["status"] == "revoked":
            return {"ok": True, "delegation": body.delegation, "revoked": True,
                    "note": "already revoked"}
        await client.update(
            conn, dg.revoke_update(conn.holons_graph, body.delegation, datetime.now(timezone.utc))
        )
    except FusekiError as exc:
        raise HTTPException(exc.status or 502, detail=exc.as_dict()) from exc

    return {"ok": True, "delegation": body.delegation, "revoked": True}


@router.get("")
async def list_my_delegations(
    conn: ConnDep,
    client: ClientDep,
    animus: AnimusDep,
    direction: str = Query(default="both", pattern="^(given|received|both)$"),
    all: bool = Query(default=False, description="Admin only: every delegation in the dataset."),
) -> dict:
    if animus.person is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail="unresolved identity")

    async def query_fn(q: str) -> dict:
        return await client.select(conn, q)

    person: str | None = animus.person
    if all:
        if not await is_admin(query_fn, conn.holons_graph, person=animus.real_person):
            raise HTTPException(status.HTTP_403_FORBIDDEN, detail="admin role required for all=true")
        person = None
    try:
        rows = await dg.list_delegations(
            query_fn, conn.holons_graph, person=person, direction=direction
        )
    except FusekiError as exc:
        raise HTTPException(exc.status or 502, detail=exc.as_dict()) from exc
    return {"dataset": conn.dataset, "count": len(rows), "delegations": rows}
