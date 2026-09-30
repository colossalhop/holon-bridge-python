"""Two follow-ups to holon:Delegation (PR #27):

1. ``POST /admin/person/deactivate`` revokes every still-live delegation the
   Person gave or received, in the same single atomic SPARQL Update as the
   rest of the deactivation, and reports them as ``delegations_revoked``.
2. ``write_turtle_to_graph`` reports what authorised a write
   (``authorisedBy`` / ``authorisedReason``), so a delegated write is
   distinguishable from the delegator's own in the response.

Same harness as test_delegation_routes.py: an rdflib-backed store stub, and
FastAPI ``dependency_overrides`` on the three identity/connection
dependencies, so the real routes run against real SPARQL.
"""

from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from rdflib import Dataset, URIRef

from holonbridge import delegation as dg
from holonbridge.acl import Animus
from holonbridge.conn import Conn
from holonbridge.deps import get_acting_as, get_client, require_animus, require_conn
from holonbridge.ingest import write_turtle_to_graph
from holonbridge.routes import identity_admin

HOLON = "https://w3id.org/holon/"
HOLONS = "urn:example:holons"
ADMIN = "urn:example:person:root"
KURT = "urn:example:person:kurt"
JANE = "urn:example:person:jane"
BOB = "urn:example:person:bob"
PERSONA = "urn:example:persona:phoebe"
KURT_HOLONS = "urn:example:persona:phoebe:user:kurt:holons"
BOB_HOLONS = "urn:example:persona:phoebe:user:bob:holons"

FIXTURE = f"""
@prefix holon: <{HOLON}> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .

<urn:example:role:admin> a holon:Role .
<{ADMIN}> a holon:Person ; rdfs:label "Root" ; holon:hasRole <urn:example:role:admin> .
<{KURT}> a holon:Person ; rdfs:label "Kurt" .
<{JANE}> a holon:Person ; rdfs:label "Jane" .
<{BOB}>  a holon:Person ; rdfs:label "Bob" .
<{PERSONA}> a holon:Persona .
"""


class GraphStoreStub:
    """FusekiClient stand-in backed by a real in-memory rdflib Dataset."""

    def __init__(self) -> None:
        self.ds = Dataset()
        self.updates: list[str] = []
        self.posted: list[tuple[str, str]] = []

    async def select(self, conn, query, *, default_graph=None):
        result = self.ds.query(query)
        if result.type == "ASK":
            return {"boolean": bool(result.askAnswer)}
        bindings = []
        for row in result:
            binding = {}
            for var in result.vars:
                val = row[var]
                if val is None:
                    continue
                binding[str(var)] = {
                    "type": "uri" if str(val).startswith(("http", "urn")) else "literal",
                    "value": str(val),
                }
            bindings.append(binding)
        return {"results": {"bindings": bindings}}

    async def update(self, conn, update):
        self.updates.append(update)
        self.ds.update(update)

    async def post_graph(self, conn, graph_iri, turtle):
        self.posted.append((graph_iri, turtle))
        self.ds.get_context(URIRef(graph_iri)).parse(data=turtle, format="turtle")

    async def put_graph(self, conn, graph_iri, turtle):
        self.posted.append((graph_iri, turtle))


class ActingAsStub:
    def get(self, *, real_person):
        return None

    def clear(self, *, real_person):
        return None

    def set(self, *, real_person, target_person):
        return None


@pytest.fixture
def stub() -> GraphStoreStub:
    store = GraphStoreStub()
    store.ds.get_context(URIRef(HOLONS)).parse(data=FIXTURE, format="turtle")
    return store


@pytest.fixture
def conn() -> Conn:
    return Conn(base_url="http://localhost:3030", dataset="example", overridden=False,
                bank_name="local")


@pytest.fixture
def client(stub, conn):
    app = FastAPI()
    app.include_router(identity_admin.router)

    async def _animus() -> Animus:
        return Animus("x", "GitHubIdentity", person=ADMIN, real_person=ADMIN)

    app.dependency_overrides[require_conn] = lambda: conn
    app.dependency_overrides[get_client] = lambda: stub
    app.dependency_overrides[require_animus] = _animus
    app.dependency_overrides[get_acting_as] = lambda: ActingAsStub()
    return TestClient(app)


def query_fn_for(stub):
    async def q(sparql: str) -> dict:
        return await stub.select(None, sparql)
    return q


def delegate(stub, iri, *, by, to, graph, perms=("read", "write"), start=None, days=7):
    now = datetime.now(timezone.utc)
    start = start or now - timedelta(hours=1)
    stub.ds.get_context(URIRef(HOLONS)).parse(
        data=dg.build_delegation(
            delegation_iri=iri, delegator=by, delegate=to, persona=PERSONA, graphs=[graph],
            permissions=perms, valid_from=start, valid_until=start + timedelta(days=days),
        ),
        format="turtle",
    )
    return iri


def statuses(stub):
    rows = asyncio.run(dg.list_delegations(query_fn_for(stub), HOLONS))
    return {r["delegation"]: r["status"] for r in rows}


# --- 1. deactivate_person revokes delegations --------------------------------


def test_deactivating_a_delegate_revokes_the_delegation(client, stub):
    iri = delegate(stub, "urn:example:delegation:a", by=KURT, to=JANE, graph=KURT_HOLONS)
    assert statuses(stub)[iri] == "active"

    response = client.post("/admin/person/deactivate", json={"person": "urn:example:person:jane"})
    assert response.status_code == 200, response.text
    assert response.json()["delegations_revoked"] == [iri]
    assert statuses(stub)[iri] == "revoked"  # retained, not deleted


def test_deactivating_a_delegator_revokes_the_delegation(client, stub):
    iri = delegate(stub, "urn:example:delegation:a", by=KURT, to=JANE, graph=KURT_HOLONS)
    response = client.post("/admin/person/deactivate", json={"person": "urn:example:person:kurt"})
    assert response.json()["delegations_revoked"] == [iri]
    assert statuses(stub)[iri] == "revoked"


def test_unrelated_delegations_are_left_alone(client, stub):
    mine = delegate(stub, "urn:example:delegation:a", by=KURT, to=JANE, graph=KURT_HOLONS)
    other = delegate(stub, "urn:example:delegation:b", by=BOB, to=KURT, graph=BOB_HOLONS)
    body = client.post(
        "/admin/person/deactivate", json={"person": "urn:example:person:jane"}
    ).json()
    assert body["delegations_revoked"] == [mine]
    assert statuses(stub)[other] == "active"


def test_only_live_delegations_are_reported(client, stub):
    live = delegate(stub, "urn:example:delegation:live", by=KURT, to=JANE, graph=KURT_HOLONS)
    delegate(stub, "urn:example:delegation:old", by=KURT, to=JANE, graph=KURT_HOLONS,
             start=datetime.now(timezone.utc) - timedelta(days=30), days=7)  # expired
    already = delegate(stub, "urn:example:delegation:gone", by=KURT, to=JANE, graph=KURT_HOLONS)
    stub.ds.update(dg.revoke_update(HOLONS, already, datetime.now(timezone.utc)))

    body = client.post(
        "/admin/person/deactivate", json={"person": "urn:example:person:jane"}
    ).json()
    assert body["delegations_revoked"] == [live]


def test_a_person_with_no_delegations_reports_an_empty_list(client):
    body = client.post(
        "/admin/person/deactivate", json={"person": "urn:example:person:bob"}
    ).json()
    assert body["ok"] is True and body["delegations_revoked"] == []


def test_it_is_one_atomic_request(client, stub):
    delegate(stub, "urn:example:delegation:a", by=KURT, to=JANE, graph=KURT_HOLONS)
    client.post("/admin/person/deactivate", json={"person": "urn:example:person:jane"})
    assert len(stub.updates) == 1  # roles, grants, delegations and status together
    assert "holon:revokedAt" in stub.updates[0] and 'holon:status "inactive"' in stub.updates[0]


def test_reactivation_does_not_revive_a_revoked_delegation(client, stub):
    iri = delegate(stub, "urn:example:delegation:a", by=KURT, to=JANE, graph=KURT_HOLONS)
    client.post("/admin/person/deactivate", json={"person": "urn:example:person:jane"})
    client.post("/admin/person/reactivate", json={"person": "urn:example:person:jane"})

    assert statuses(stub)[iri] == "revoked"
    found = asyncio.run(
        dg.find_delegation(query_fn_for(stub), HOLONS, delegate=JANE, permission="write",
                           target=KURT_HOLONS)
    )
    assert found == []


# --- 2. authorisedBy on write_turtle_to_graph --------------------------------


def write(stub, conn, person, graph, *, mode="merge", admin=False):
    animus = Animus("x", "GitHubIdentity", person=person, real_person=person)
    return asyncio.run(
        write_turtle_to_graph(
            turtle="<urn:example:a> <urn:example:b> <urn:example:c> .",
            graph_iri=graph, mode=mode, shapes_graph=None, reduction_rule_id=None,
            conn=conn, client=stub, shacl_required=False, shacl_delta=False, animus=animus,
        )
    )


def test_a_delegated_write_reports_the_delegation(stub, conn):
    iri = delegate(stub, "urn:example:delegation:a", by=KURT, to=JANE, graph=KURT_HOLONS)
    result = write(stub, conn, JANE, KURT_HOLONS)
    assert result["ok"] is True
    assert result["authorisedBy"] == iri
    assert "delegated write" in result["authorisedReason"] and KURT in result["authorisedReason"]


def test_an_explicit_grant_reports_its_target(stub, conn):
    stub.ds.get_context(URIRef(HOLONS)).parse(
        data=f"@prefix holon: <{HOLON}> . <{BOB_HOLONS}> holon:grantsWrite <{JANE}> .",
        format="turtle",
    )
    result = write(stub, conn, JANE, BOB_HOLONS)
    assert result["authorisedBy"] == BOB_HOLONS
    assert result["authorisedReason"] == "explicit grantsWrite"


def test_the_admin_bypass_reports_no_grant(stub, conn):
    result = write(stub, conn, ADMIN, KURT_HOLONS)
    assert result["authorisedBy"] is None
    assert result["authorisedReason"] == "admin role bypass"


def test_a_write_delegation_still_cannot_replace(stub, conn):
    delegate(stub, "urn:example:delegation:a", by=KURT, to=JANE, graph=KURT_HOLONS)
    with pytest.raises(HTTPException) as denied:
        write(stub, conn, JANE, KURT_HOLONS, mode="replace")
    assert denied.value.status_code == 403
    assert stub.posted == []  # nothing was written


def test_an_undelegated_write_is_still_refused_and_writes_nothing(stub, conn):
    with pytest.raises(HTTPException) as denied:
        write(stub, conn, JANE, KURT_HOLONS)
    assert denied.value.status_code == 403
    assert stub.posted == []
