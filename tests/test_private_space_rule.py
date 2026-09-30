"""A persona-wide ``ReadGrant`` does not open another person's private space.

The grant is scoped to a persona, so before this rule it opened every
person's private area beneath that persona for any holder when the store was
queried directly -- a coarser rule than "private to you". Another person's
private space now opens only to an admin or to a holder of an active read
delegation naming that exact graph. A ReadGrant still opens the caller's own
private space and the persona's shared ``public`` space.

Tested at the ACL level, and over HTTP on the real ``/sparql/select`` and
``GET /graph`` routes, since those are where a read is actually decided.
"""

from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from rdflib import Dataset, URIRef

from holonbridge import delegation as dg
from holonbridge.acl import Animus, authorize_query, private_space_owner
from holonbridge.conn import Conn
from holonbridge.deps import get_client, require_animus, require_conn
from holonbridge.routes import graphs as graph_routes
from holonbridge.routes import sparql as sparql_routes

HOLON = "https://w3id.org/holon/"
HOLONS = "urn:example:holons"
ADMIN = "urn:example:person:root"
JANE = "urn:example:person:jane"
JANE2 = "urn:example:person:jane2"      # a name that starts with another's
JOHN = "urn:example:person:john"
PERSONA = "urn:example:persona:assistant"
OTHER_PERSONA = "urn:example:persona:advisor"

P = "urn:example:persona:assistant"
JANE_HOLONS = f"{P}:user:jane:holons"
JANE_SCENE = f"{P}:user:jane:scene"
JANE2_HOLONS = f"{P}:user:jane2:holons"
JOHN_HOLONS = f"{P}:user:john:holons"
PUBLIC_HOLONS = f"{P}:user:public:holons"
OTHER_PERSONA_JOHN = "urn:example:persona:advisor:user:john:holons"
GROUND = "urn:example:scene"

FIXTURE = f"""
@prefix holon: <{HOLON}> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
<urn:example:role:admin> a holon:Role .
<{ADMIN}> a holon:Person ; rdfs:label "Root" ; holon:hasRole <urn:example:role:admin> .
<{JANE}> a holon:Person ; rdfs:label "Jane" .
<{JANE2}> a holon:Person ; rdfs:label "Jane Two" .
<{JOHN}> a holon:Person ; rdfs:label "John" .
<{PERSONA}> a holon:Persona .
"""


class Store:
    def __init__(self) -> None:
        self.ds = Dataset()
        self.ds.get_context(URIRef(HOLONS)).parse(data=FIXTURE, format="turtle")
        for graph in (JANE_HOLONS, JANE_SCENE, JANE2_HOLONS, JOHN_HOLONS, PUBLIC_HOLONS, OTHER_PERSONA_JOHN, GROUND):
            self.ds.get_context(URIRef(graph)).parse(
                data=f'<{graph}#note> <http://www.w3.org/2000/01/rdf-schema#label> "secret in {graph}" .',
                format="turtle",
            )
        self.fetched: list[str] = []

    async def select(self, conn, query, *, default_graph=None):
        result = self.ds.query(query)
        if result.type == "ASK":
            return {"boolean": bool(result.askAnswer)}
        rows = []
        for row in result:
            binding = {}
            for var in result.vars:
                val = row[var]
                if val is None:
                    continue
                text = str(val)
                binding[str(var)] = {"type": "uri" if text.startswith(("http", "urn")) else "literal",
                                     "value": text}
            rows.append(binding)
        return {"results": {"bindings": rows}}

    async def get_graph(self, conn, graph_iri):
        self.fetched.append(graph_iri)
        return self.ds.get_context(URIRef(graph_iri)).serialize(format="turtle")


def give_read_grant(store, person, persona=PERSONA):
    store.ds.get_context(URIRef(HOLONS)).parse(
        data=f"""@prefix holon: <{HOLON}> .
<{person}> holon:hasRole <urn:example:role:reader> .
<urn:example:role:reader> holon:grants <urn:example:grant:r> .
<urn:example:grant:r> a holon:ReadGrant ; holon:scope <{persona}> .""",
        format="turtle",
    )


def lend(store, *, delegator, delegate, graph, perms=("read",), persona=PERSONA):
    now = datetime.now(timezone.utc)
    store.ds.get_context(URIRef(HOLONS)).parse(
        data=dg.build_delegation(
            delegation_iri=f"urn:example:delegation:{delegator[-4:]}-{delegate[-4:]}",
            delegator=delegator, delegate=delegate, persona=persona, graphs=[graph],
            permissions=list(perms), valid_from=now - timedelta(hours=1), valid_until=now + timedelta(days=1)),
        format="turtle",
    )


@pytest.fixture
def store() -> Store:
    return Store()


@pytest.fixture
def conn() -> Conn:
    return Conn(base_url="http://localhost:3030", dataset="example", overridden=False, bank_name="local")


def can_read(store, conn, person, graph) -> bool:
    text = f"SELECT * WHERE {{ GRAPH <{graph}> {{ ?s ?p ?o }} }}"
    return asyncio.run(
        authorize_query(lambda q: store.select(None, q), HOLONS, person=person, sparql_text=text,
                        persona_of_graph=conn.persona_for_graph)
    ).allowed


# --- the owner helper --------------------------------------------------------------------


@pytest.mark.parametrize(
    "graph, owner",
    [
        (JANE_HOLONS, "jane"),
        (JANE_SCENE, "jane"),
        (JANE2_HOLONS, "jane2"),
        (OTHER_PERSONA_JOHN, "john"),
        (PUBLIC_HOLONS, None),                                  # shared, belongs to nobody
        (GROUND, None),                                         # outside the persona scheme
        ("urn:example:holons", None),
        ("urn:example:persona:assistant", None),                # the persona itself
    ],
)
def test_private_space_owner(graph, owner):
    assert private_space_owner(graph) == owner


# --- the rule ---------------------------------------------------------------------------------


def test_a_readgrant_does_not_open_another_persons_private_space(store, conn):
    give_read_grant(store, JANE)
    assert not can_read(store, conn, JANE, JOHN_HOLONS)


def test_a_readgrant_opens_your_own_private_space_and_the_shared_one(store, conn):
    give_read_grant(store, JANE)
    assert can_read(store, conn, JANE, JANE_HOLONS)
    assert can_read(store, conn, JANE, JANE_SCENE)
    assert can_read(store, conn, JANE, PUBLIC_HOLONS)


def test_your_own_space_still_needs_the_grant(store, conn):
    # Unchanged from before: the owner has no special right; the persona-level
    # ReadGrant is still what opens it. This rule only closes the cross-person gap.
    assert not can_read(store, conn, JANE, JANE_HOLONS)
    give_read_grant(store, JANE)
    assert can_read(store, conn, JANE, JANE_HOLONS)


def test_a_name_that_starts_with_another_is_not_the_same_person(store, conn):
    give_read_grant(store, JANE)
    give_read_grant(store, JANE2)
    assert can_read(store, conn, JANE, JANE_HOLONS) and not can_read(store, conn, JANE, JANE2_HOLONS)
    assert can_read(store, conn, JANE2, JANE2_HOLONS) and not can_read(store, conn, JANE2, JANE_HOLONS)


def test_an_admin_can_read_anyones_private_space(store, conn):
    for graph in (JANE_HOLONS, JOHN_HOLONS, OTHER_PERSONA_JOHN):
        assert can_read(store, conn, ADMIN, graph)


def test_a_read_delegation_opens_exactly_the_named_graph(store, conn):
    lend(store, delegator=JOHN, delegate=JANE, graph=JOHN_HOLONS)
    assert can_read(store, conn, JANE, JOHN_HOLONS)
    # ...and nothing else of John's
    assert not can_read(store, conn, JANE, OTHER_PERSONA_JOHN)


def test_a_write_only_delegation_does_not_open_reading(store, conn):
    lend(store, delegator=JOHN, delegate=JANE, graph=JOHN_HOLONS, perms=("write",))
    assert not can_read(store, conn, JANE, JOHN_HOLONS)


def test_ground_truth_is_unaffected(store, conn):
    assert can_read(store, conn, JANE, GROUND)


def test_one_foreign_graph_refuses_the_whole_query(store, conn):
    give_read_grant(store, JANE)
    text = (f"SELECT * WHERE {{ GRAPH <{JANE_HOLONS}> {{ ?s ?p ?o }} "
            f"GRAPH <{JOHN_HOLONS}> {{ ?a ?b ?c }} }}")
    decision = asyncio.run(
        authorize_query(lambda q: store.select(None, q), HOLONS, person=JANE, sparql_text=text,
                        persona_of_graph=conn.persona_for_graph)
    )
    assert not decision.allowed and JOHN_HOLONS in decision.reason


def test_the_refusal_says_who_can_open_it(store, conn):
    give_read_grant(store, JANE)
    decision = asyncio.run(
        authorize_query(lambda q: store.select(None, q), HOLONS, person=JANE,
                        sparql_text=f"SELECT * WHERE {{ GRAPH <{JOHN_HOLONS}> {{ ?s ?p ?o }} }}",
                        persona_of_graph=conn.persona_for_graph)
    )
    assert "another person's private space" in decision.reason
    assert "administrator" in decision.reason and "lent" in decision.reason


# --- over HTTP ----------------------------------------------------------------------------------


@pytest.fixture
def api(store, conn):
    app = FastAPI()
    app.include_router(sparql_routes.router)
    app.include_router(graph_routes.router)
    who = {"person": JANE}

    async def _animus() -> Animus:
        return Animus("x", "GitHubIdentity", person=who["person"], real_person=who["person"])

    app.dependency_overrides[require_conn] = lambda: conn
    app.dependency_overrides[get_client] = lambda: store
    app.dependency_overrides[require_animus] = _animus
    client = TestClient(app, raise_server_exceptions=False)
    client.who = who  # type: ignore[attr-defined]
    return client


def select(api, graph):
    return api.post("/sparql/select", json={"query": f"SELECT * WHERE {{ GRAPH <{graph}> {{ ?s ?p ?o }} }}"})


def test_over_http_a_readgrant_opens_your_own_space_and_not_johns(api, store):
    give_read_grant(store, JANE)
    assert select(api, JANE_HOLONS).status_code == 200
    refused = select(api, JOHN_HOLONS)
    assert refused.status_code == 403 and "private space" in refused.json()["detail"]
    assert api.get("/graph", params={"iri": JANE_HOLONS}).status_code == 200
    other = api.get("/graph", params={"iri": JOHN_HOLONS})
    assert other.status_code == 403 and f"secret in {JOHN_HOLONS}" not in other.text
    assert JOHN_HOLONS not in store.fetched  # never fetched


def test_over_http_the_forms_that_used_to_slip_through_are_refused_too(api, store):
    give_read_grant(store, JANE)
    for text in (
        f"SELECT * FROM <{JOHN_HOLONS}> WHERE {{ ?s ?p ?o }}",
        f"CONSTRUCT {{ ?s ?p ?o }} WHERE {{ GRAPH <{JOHN_HOLONS}> {{ ?s ?p ?o }} }}",
        "SELECT * WHERE { GRAPH ?g { ?s ?p ?o } }",
    ):
        path = "/sparql/construct" if text.startswith("CONSTRUCT") else "/sparql/select"
        assert api.post(path, json={"query": text}).status_code == 403, text


def test_over_http_an_admin_and_a_delegate_can_read_it(api, store):
    lend(store, delegator=JOHN, delegate=JANE, graph=JOHN_HOLONS)
    assert select(api, JOHN_HOLONS).status_code == 200
    api.who["person"] = ADMIN
    assert select(api, JOHN_HOLONS).status_code == 200
    assert api.get("/graph", params={"iri": JOHN_HOLONS}).status_code == 200
