"""``GET /graph?iri=`` applies the same read rules as ``POST /sparql/select``.

Before this it had no identity check at all: anyone holding the shared
bearer token could read any graph in full. These tests run the REAL
``routes/graphs.py`` router (with dependency overrides for connection,
client and identity, and the audit middleware in front) against a real
in-memory rdflib store, so what is asserted is the actual route, the actual
``acl.authorize_query`` and the actual audit trail.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest
from fastapi import FastAPI, Request
from fastapi.testclient import TestClient
from rdflib import Dataset, Namespace, URIRef

from holonbridge import audit
from holonbridge import delegation as dg
from holonbridge.acl import Animus
from holonbridge.conn import Conn
from holonbridge.deps import get_client, require_animus, require_conn
from holonbridge.routes import graphs

HOLON = "https://w3id.org/holon/"
HB = Namespace(audit.HB)
HOLONS = "urn:example:holons"
AUDIT = "urn:example:audit"
ADMIN = "urn:example:person:root"
KURT = "urn:example:person:kurt"
JANE = "urn:example:person:jane"
PERSONA = "urn:example:persona:phoebe"
KURT_HOLONS = "urn:example:persona:phoebe:user:kurt:holons"
JANE_HOLONS = "urn:example:persona:phoebe:user:jane:holons"
GROUND = "urn:example:scene"

FIXTURE = f"""
@prefix holon: <{HOLON}> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
<urn:example:role:admin> a holon:Role .
<{ADMIN}> a holon:Person ; rdfs:label "Root" ; holon:hasRole <urn:example:role:admin> .
<{KURT}> a holon:Person ; rdfs:label "Kurt" .
<{JANE}> a holon:Person ; rdfs:label "Jane" .
<{PERSONA}> a holon:Persona .
"""
SECRET = '<urn:example:kurt-diary> <http://www.w3.org/2000/01/rdf-schema#label> "kurt-private-secret" .'
PUBLIC = '<urn:example:sun> <http://www.w3.org/2000/01/rdf-schema#label> "public-fact" .'


class GraphStoreStub:
    def __init__(self) -> None:
        self.ds = Dataset()
        self.fetched: list[str] = []

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
                text = str(val)
                binding[str(var)] = {
                    "type": "uri" if text.startswith(("http", "urn")) else "literal",
                    "value": text,
                }
            bindings.append(binding)
        return {"results": {"bindings": bindings}}

    async def get_graph(self, conn, graph_iri):
        self.fetched.append(graph_iri)
        return self.ds.get_context(URIRef(graph_iri)).serialize(format="turtle")

    async def post_graph(self, conn, graph_iri, turtle):
        self.ds.get_context(URIRef(graph_iri)).parse(data=turtle, format="turtle")


def audit_entries(stub):
    g = stub.ds.get_context(URIRef(AUDIT))
    return [
        {
            "outcome": str(next(iter(g.objects(e, HB.outcome)))),
            "operation": str(next(iter(g.objects(e, HB.operation)))),
            "security": bool(next(iter(g.objects(e, HB.securityRead)), None)),
            "reason": str(next(iter(g.objects(e, HB.reason)), "")),
        }
        for e in g.subjects(URIRef("http://www.w3.org/1999/02/22-rdf-syntax-ns#type"), HB.AuditEntry)
    ]


@pytest.fixture(autouse=True)
def _fresh_level_cache(monkeypatch):
    audit._level_cache.clear()
    monkeypatch.delenv("HOLONBRIDGE_AUDIT_LEVEL", raising=False)


@pytest.fixture
def stub() -> GraphStoreStub:
    store = GraphStoreStub()
    ds = store.ds
    ds.get_context(URIRef(HOLONS)).parse(data=FIXTURE, format="turtle")
    ds.get_context(URIRef(KURT_HOLONS)).parse(data=SECRET, format="turtle")
    ds.get_context(URIRef(GROUND)).parse(data=PUBLIC, format="turtle")
    ds.get_context(URIRef(AUDIT)).parse(data=PUBLIC.replace("sun", "marker"), format="turtle")
    return store


@pytest.fixture
def conn() -> Conn:
    return Conn(base_url="http://localhost:3030", dataset="example", overridden=False,
                bank_name="local")


@pytest.fixture
def actor():
    return {"person": JANE, "real": JANE, "acting_as": False}


@pytest.fixture
def client(stub, conn, actor):
    app = FastAPI()
    app.state.fuseki = stub
    app.add_middleware(audit.AuditMiddleware)
    app.include_router(graphs.router)

    def _conn(request: Request) -> Conn:
        request.state.conn = conn
        return conn

    async def _animus(request: Request) -> Animus:
        animus = Animus("x", "GitHubIdentity", person=actor["person"], real_person=actor["real"],
                        acting_as=actor["acting_as"])
        request.state.animus = animus
        return animus

    app.dependency_overrides[require_conn] = _conn
    app.dependency_overrides[get_client] = lambda: stub
    app.dependency_overrides[require_animus] = _animus
    return TestClient(app, raise_server_exceptions=False)


def read(client, iri):
    return client.get("/graph", params={"iri": iri})


def grant_read(stub, person=JANE):
    stub.ds.get_context(URIRef(HOLONS)).parse(
        data=f"""@prefix holon: <{HOLON}> .
<{person}> holon:hasRole <urn:example:role:reader> .
<urn:example:role:reader> holon:grants <urn:example:grant:r> .
<urn:example:grant:r> a holon:ReadGrant ; holon:scope <{PERSONA}> .""",
        format="turtle",
    )


# --- the hole, closed --------------------------------------------------------


def test_someone_elses_private_graph_is_refused_and_never_fetched(stub, client):
    response = read(client, KURT_HOLONS)
    assert response.status_code == 403
    assert "no ReadGrant" in response.json()["detail"]
    assert "kurt-private-secret" not in response.text
    assert stub.fetched == []  # refused BEFORE anything was fetched


def test_a_persona_readgrant_opens_the_graph(stub, client):
    grant_read(stub)
    response = read(client, KURT_HOLONS)
    assert response.status_code == 200 and "kurt-private-secret" in response.text


def test_an_admin_can_read_it(stub, client, actor):
    actor.update(person=ADMIN, real=ADMIN)
    assert "kurt-private-secret" in read(client, KURT_HOLONS).text


def test_a_read_delegation_opens_exactly_that_graph(stub, client):
    now = datetime.now(timezone.utc)
    stub.ds.get_context(URIRef(HOLONS)).parse(
        data=dg.build_delegation(
            delegation_iri="urn:example:delegation:d", delegator=KURT, delegate=JANE,
            persona=PERSONA, graphs=[KURT_HOLONS], permissions=["read"],
            valid_from=now - timedelta(hours=1), valid_until=now + timedelta(days=1)),
        format="turtle",
    )
    assert read(client, KURT_HOLONS).status_code == 200
    assert read(client, "urn:example:persona:phoebe:user:kurt:scene").status_code == 403


def test_ground_truth_is_readable_by_any_identified_caller(stub, client):
    # Parity with /sparql/select, where graphs outside the persona scheme are
    # not role-gated.
    assert "public-fact" in read(client, GROUND).text


def test_the_audit_graph_is_admin_only(stub, client, actor):
    assert read(client, AUDIT).status_code == 403
    actor.update(person=ADMIN, real=ADMIN)
    assert read(client, AUDIT).status_code == 200


# --- crafted IRIs --------------------------------------------------------------
#
# ``iri`` is interpolated into a probe query so ``authorize_query`` can vet
# it. ``safe_iri`` refuses anything that could change that query's shape;
# the route additionally requires the probe to parse to exactly one graph
# reference equal to the IRI. The second guard is redundant while the first
# holds (safe_iri excludes exactly the characters a SPARQL IRIREF cannot
# contain), so it is not separately observable here -- it is there so that a
# future change to either side fails closed instead of silently.


@pytest.mark.parametrize(
    "hostile",
    [
        # would parse as a probe for BOTH graphs, hiding the private one behind a public one
        f"{GROUND}> {{ ?s ?p ?o }} GRAPH <{KURT_HOLONS}",
        f"{GROUND}> {{ ?s ?p ?o }} }} UNION {{ GRAPH <{KURT_HOLONS}",
        f"{KURT_HOLONS} ",
        f"{KURT_HOLONS}\n",
        f'{KURT_HOLONS}"',
    ],
)
def test_a_crafted_iri_cannot_smuggle_a_different_graph_past_the_check(stub, client, hostile):
    response = read(client, hostile)
    # Refused outright as "not a plain IRI" (delegation.safe_iri), before any
    # probe is built or anything is fetched.
    assert response.status_code == 400
    assert "kurt-private-secret" not in response.text
    assert stub.fetched == []


# --- audit --------------------------------------------------------------------


def test_a_refused_read_is_recorded_with_its_reason(stub, client):
    read(client, KURT_HOLONS)
    (entry,) = audit_entries(stub)
    assert entry["outcome"] == "denied" and entry["operation"] == "GET /graph"
    assert entry["reason"].startswith("no ReadGrant")


def test_reading_someone_elses_private_graph_is_a_security_read(stub, client, actor):
    actor.update(person=ADMIN, real=ADMIN)
    read(client, KURT_HOLONS)
    (entry,) = audit_entries(stub)
    assert entry["security"] is True and entry["outcome"] == "allowed"


def test_an_ordinary_read_is_not_recorded(stub, client):
    read(client, GROUND)
    assert audit_entries(stub) == []


def test_reading_your_own_private_graph_is_not_a_security_read(stub, client, actor):
    actor.update(person=KURT, real=KURT)
    grant_read(stub, person=KURT)
    assert read(client, KURT_HOLONS).status_code == 200
    assert audit_entries(stub) == []
