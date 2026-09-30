"""Audit routes: read the audit log, and get/set the dataset's audit level.

Admin-only, and the only supported way to read the audit graph over HTTP:
``GET /graph?iri=<audit graph>`` refuses it (see ``routes/graphs.py``) and
raw SPARQL against it is admin-only (see ``acl.authorize_query``). The
audit graph cannot be written through the API by anyone -- entries are
written by :class:`holonbridge.audit.AuditMiddleware` alone.

The admin check is against ``animus.real_person``, like ``identity_admin``,
so an admin who is currently ``act_as`` someone else can still read it.
"""

from __future__ import annotations

from datetime import datetime

from fastapi import APIRouter, HTTPException, Query, status
from pydantic import BaseModel

from .. import audit
from .. import delegation as dg
from ..acl import is_admin
from ..deps import AnimusDep, ClientDep, ConnDep
from ..fuseki import FusekiError

router = APIRouter(prefix="/audit", tags=["audit"])

_OUTCOMES = ("allowed", "denied", "error")


async def _require_admin(conn, client, animus) -> None:
    async def query_fn(q: str) -> dict:
        return await client.select(conn, q)

    if animus.real_person is None or not await is_admin(
        query_fn, conn.holons_graph, person=animus.real_person
    ):
        raise HTTPException(status.HTTP_403_FORBIDDEN, detail="admin role required on this dataset")


@router.get("")
async def list_entries(
    conn: ConnDep,
    client: ClientDep,
    animus: AnimusDep,
    actor: str | None = Query(default=None, description="Person slug or IRI."),
    outcome: str | None = Query(default=None, description="allowed, denied or error."),
    since: datetime | None = Query(default=None, description="Only entries at or after this time."),
    limit: int = Query(default=100, ge=1, le=1000),
) -> dict:
    """Newest first. An entry that touched several graphs is one item with a
    ``graphs`` list."""
    await _require_admin(conn, client, animus)

    filters = []
    try:
        if actor:
            iri = actor if ":" in actor else conn.person_iri(actor)
            filters.append(f"FILTER(?actor = <{dg.safe_iri(iri)}>)")
    except (dg.DelegationError, ValueError) as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    if outcome:
        if outcome not in _OUTCOMES:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST, detail=f"outcome must be one of {list(_OUTCOMES)}"
            )
        filters.append(f'FILTER(?outcome = "{outcome}")')
    if since:
        filters.append(f'FILTER(?at >= "{dg._iso(since)}"^^<{audit.XSD}dateTime>)')

    query = f"""PREFIX hb: <{audit.HB}>
SELECT ?e ?at ?actor ?realActor ?outcome ?operation ?status ?graph ?by ?reason ?security ?hash
WHERE {{ GRAPH <{audit.audit_graph(conn.holons_graph)}> {{
  ?e a hb:AuditEntry ; hb:at ?at ; hb:outcome ?outcome ; hb:operation ?operation ; hb:status ?status .
  OPTIONAL {{ ?e hb:actor ?actor }}
  OPTIONAL {{ ?e hb:realActor ?realActor }}
  OPTIONAL {{ ?e hb:targetGraph ?graph }}
  OPTIONAL {{ ?e hb:authorisedBy ?by }}
  OPTIONAL {{ ?e hb:authorisedReason ?reason }}
  OPTIONAL {{ ?e hb:securityRead ?security }}
  OPTIONAL {{ ?e hb:payloadHash ?hash }}
  {' '.join(filters)}
}} }} ORDER BY DESC(?at) LIMIT {limit * 10}"""

    try:
        rows = (await client.select(conn, query)).get("results", {}).get("bindings", [])
    except FusekiError as exc:
        raise HTTPException(exc.status or 502, detail=exc.as_dict()) from exc

    entries: dict[str, dict] = {}
    for row in rows:
        iri = row["e"]["value"]
        item = entries.get(iri)
        if item is None:
            if len(entries) >= limit:
                continue
            item = entries[iri] = {
                "entry": iri,
                "at": row["at"]["value"],
                "outcome": row["outcome"]["value"],
                "operation": row["operation"]["value"],
                "status": int(row["status"]["value"]),
                "actor": row.get("actor", {}).get("value"),
                "real_actor": row.get("realActor", {}).get("value"),
                "authorised_by": row.get("by", {}).get("value"),
                "authorised_reason": row.get("reason", {}).get("value"),
                "security_read": "security" in row,
                "payload_hash": row.get("hash", {}).get("value"),
                "graphs": [],
            }
        graph = row.get("graph", {}).get("value")
        if graph and graph not in item["graphs"]:
            item["graphs"].append(graph)

    listing = list(entries.values())
    return {"dataset": conn.dataset, "count": len(listing), "entries": listing}


@router.get("/level")
async def get_level(conn: ConnDep, client: ClientDep, animus: AnimusDep) -> dict:
    await _require_admin(conn, client, animus)
    audit.forget_level(conn)
    return {"dataset": conn.dataset, "level": await audit.level_for(client, conn),
            "levels": list(audit.LEVELS), "default": audit.default_level()}


class SetLevelRequest(BaseModel):
    level: str


@router.post("/level")
async def set_level(
    body: SetLevelRequest, conn: ConnDep, client: ClientDep, animus: AnimusDep
) -> dict:
    await _require_admin(conn, client, animus)
    previous = await audit.level_for(client, conn)
    audit.annotate(reason=f"audit level {previous} -> {body.level}")
    try:
        await audit.set_level(client, conn, body.level)
    except ValueError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    except FusekiError as exc:
        raise HTTPException(exc.status or 502, detail=exc.as_dict()) from exc
    return {"ok": True, "dataset": conn.dataset, "level": body.level}
