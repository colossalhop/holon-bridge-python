"""Route tests for /delegation (create, revoke, list) and the read-side
resolution helper /holon uses for ``on_behalf_of``.

Builds a small FastAPI app around just the delegation router and overrides
the three dependencies (connection, client, caller identity). That keeps
these tests independent of OAuth, bank config and the persona store, while
still running every SPARQL statement the routes generate against a real
in-memory rdflib Dataset -- so a delegation created by one request is
genuinely visible to the next, and to the real acl.check_write.
"""

from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from rdflib import Dataset, URIRef

from holonbridge import delegation as dg
from holonbridge.acl import Animus, check_replace, check_write
from holonbridge.conn import Conn
from holonbridge.deps import get_client, require_animus, require_conn
from holonbridge.routes import delegation as routes

HOLON = "https://w3id.org/holon/"
HOLONS = "urn:example:holons"
KURT = "urn:example:person:kurt"
JANE = "urn:example:person:jane"
ADMIN = "urn:example:person:root"
KURT_HOLONS = "urn:example:persona:phoebe:user:kurt:holons"
KURT_SCENE = "urn:example:persona:phoebe:user:kurt:scene"

FIXTURE = f"""
@prefix holon: <{HOLON}> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .

<urn:example:role:admin> a holon:Role .
<{ADMIN}> a holon:Person ; rdfs:label "Root" ; holon:hasRole <urn:example:role:admin> .
<{KURT}> a holon:Person ; rdfs:label "Kurt" .
<{JANE}> a holon:Person ; rdfs:label "Jane" .
<urn:example:persona:phoebe> a holon:Persona .
"""

# Kurt holds a Home under phoebe and may write his own private holons graph.
KURT_GRAPH_FIXTURE = f"""
@prefix holon: <{HOLON}> .
<{KURT_HOLONS}#home> a holon:Home ; holon:representsPerson <{KURT}> .
"""
KURT_WRITE_GRANT = f"""
@prefix holon: <{HOLON}> .
<{KURT_HOLONS}> holon:grantsWrite <{KURT}> .
<{KURT_SCENE}> holon:grantsWrite <{KURT}> .
"""


class GraphStoreStub:
    """FusekiClient stand-in backed by a real in-memory rdflib Dataset."""

    def __init__(self) -> None:
        self.ds = Dataset()

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
        self.ds.update(update)

    async def post_graph(self, conn, graph_iri, turtle):
        self.ds.get_context(URIRef(graph_iri)).parse(data=turtle, format="turtle")


@pytest.fixture
def stub() -> GraphStoreStub:
    store = GraphStoreStub()
    store.ds.get_context(URIRef(HOLONS)).parse(data=FIXTURE, format="turtle")
    store.ds.get_context(URIRef(KURT_HOLONS)).parse(data=KURT_GRAPH_FIXTURE, format="turtle")
    store.ds.get_context(URIRef(HOLONS)).parse(data=KURT_WRITE_GRANT, format="turtle")
    return store


@pytest.fixture
def actor():
    """Mutable current caller, so one test can act as several people."""
    return {"person": KURT}


@pytest.fixture
def client(stub, actor):
    app = FastAPI()
    app.include_router(routes.router)
    conn = Conn(base_url="http://localhost:3030", dataset="example", overridden=False,
                bank_name="local")

    async def _animus() -> Animus:
        person = actor["person"]
        return Animus("x", "GitHubIdentity", person=person, real_person=person)

    app.dependency_overrides[require_conn] = lambda: conn
    app.dependency_overrides[get_client] = lambda: stub
    app.dependency_overrides[require_animus] = _animus
    return TestClient(app)


def body(**kw):
    base = {"delegate": "jane", "persona": "phoebe"}
    base.update(kw)
    return base


def query_fn_for(stub):
    async def q(sparql: str) -> dict:
        return await stub.select(None, sparql)
    return q


def can_write(stub, person, target):
    return asyncio.run(
        check_write(query_fn_for(stub), HOLONS, person=person, target=target)
    ).allowed


# --- create ------------------------------------------------------------------


def test_create_derives_graphs_from_the_delegator_and_grants_write(client, stub):
    response = client.post("/delegation", json=body())
    assert response.status_code == 200, response.text
    out = response.json()
    assert out["graphs"] == [KURT_HOLONS]
    assert out["permissions"] == ["read", "write"]
    assert out["delegator"] == KURT and out["delegate"] == JANE
    assert out["delegation"].startswith("urn:example:delegation:")

    assert can_write(stub, JANE, KURT_HOLONS)
    assert not can_write(stub, JANE, KURT_SCENE)  # only holons was delegated


def test_create_can_cover_scene_too(client, stub):
    out = client.post("/delegation", json=body(roles=["holons", "scene"])).json()
    assert sorted(out["graphs"]) == sorted([KURT_HOLONS, KURT_SCENE])
    assert can_write(stub, JANE, KURT_SCENE)


def test_create_never_confers_replace(client, stub):
    client.post("/delegation", json=body())
    assert not asyncio.run(
        check_replace(query_fn_for(stub), HOLONS, person=JANE, target=KURT_HOLONS)
    ).allowed


def test_a_read_only_delegation_is_created_and_does_not_permit_writes(client, stub):
    out = client.post("/delegation", json=body(permissions=["read"])).json()
    assert out["permissions"] == ["read"]
    assert not can_write(stub, JANE, KURT_HOLONS)


@pytest.mark.parametrize(
    "extra, code, fragment",
    [
        ({"permissions": ["replace"]}, 400, "replace"),
        ({"permissions": []}, 400, "permission"),
        ({"roles": ["events"]}, 400, "cannot be delegated"),
        ({"delegate": "kurt"}, 400, "themselves"),
        ({"lifetime_days": 365}, 400, "maximum"),
        ({"delegate": "nobody"}, 404, "no active"),
        ({"persona": "ghost"}, 404, "Persona"),
    ],
)
def test_create_rejects_bad_requests(client, extra, code, fragment):
    response = client.post("/delegation", json=body(**extra))
    assert response.status_code == code, response.text
    assert fragment.lower() in response.text.lower()


def test_create_requires_a_home_under_the_persona(client, actor):
    actor["person"] = JANE  # Jane has no Home under phoebe
    response = client.post("/delegation", json=body(delegate="kurt"))
    assert response.status_code == 403
    assert "Home" in response.text


def test_cannot_delegate_write_the_delegator_does_not_hold(client, stub):
    stub.ds.update(
        f"DELETE DATA {{ GRAPH <{HOLONS}> {{ <{KURT_HOLONS}> <{HOLON}grantsWrite> <{KURT}> }} }}"
    )
    response = client.post("/delegation", json=body())
    assert response.status_code == 403
    assert "does not hold" in response.text
    # ...but sharing read access needs no write grant at all.
    assert client.post("/delegation", json=body(permissions=["read"])).status_code == 200


def test_delegating_to_a_deactivated_person_is_refused(client, stub):
    stub.ds.get_context(URIRef(HOLONS)).parse(
        data=f'@prefix holon: <{HOLON}> . <{JANE}> holon:status "inactive" .', format="turtle"
    )
    assert client.post("/delegation", json=body()).status_code == 404


def test_only_an_admin_may_delegate_on_someone_elses_behalf(client, actor, stub):
    actor["person"] = JANE
    denied = client.post("/delegation", json=body(delegate="root", delegator="kurt"))
    assert denied.status_code == 403

    actor["person"] = ADMIN
    ok = client.post("/delegation", json=body(delegate="jane", delegator="kurt"))
    assert ok.status_code == 200, ok.text
    assert ok.json()["delegator"] == KURT
    assert can_write(stub, JANE, KURT_HOLONS)


# --- list --------------------------------------------------------------------


def test_list_reports_given_and_received(client, actor):
    client.post("/delegation", json=body())
    given = client.get("/delegation?direction=given").json()
    assert given["count"] == 1 and given["delegations"][0]["status"] == "active"

    actor["person"] = JANE
    assert client.get("/delegation?direction=given").json()["count"] == 0
    received = client.get("/delegation?direction=received").json()
    assert received["count"] == 1
    assert received["delegations"][0]["delegator"] == KURT


def test_list_all_is_admin_only(client, actor):
    client.post("/delegation", json=body())
    actor["person"] = JANE
    assert client.get("/delegation?all=true").status_code == 403
    actor["person"] = ADMIN
    assert client.get("/delegation?all=true").json()["count"] == 1


# --- revoke ------------------------------------------------------------------


def test_delegator_can_revoke_and_access_ends(client, stub):
    iri = client.post("/delegation", json=body()).json()["delegation"]
    assert can_write(stub, JANE, KURT_HOLONS)
    out = client.post("/delegation/revoke", json={"delegation": iri}).json()
    assert out["ok"] is True and out["revoked"] is True
    assert not can_write(stub, JANE, KURT_HOLONS)
    listing = client.get("/delegation?direction=given").json()
    assert listing["delegations"][0]["status"] == "revoked"  # retained, not deleted


def test_delegate_can_resign(client, actor, stub):
    iri = client.post("/delegation", json=body()).json()["delegation"]
    actor["person"] = JANE
    assert client.post("/delegation/revoke", json={"delegation": iri}).json()["ok"] is True
    assert not can_write(stub, JANE, KURT_HOLONS)


def test_a_third_party_cannot_revoke(client, actor):
    iri = client.post("/delegation", json=body()).json()["delegation"]
    actor["person"] = "urn:example:person:stranger"
    assert client.post("/delegation/revoke", json={"delegation": iri}).status_code == 403


def test_an_admin_can_revoke(client, actor, stub):
    iri = client.post("/delegation", json=body()).json()["delegation"]
    actor["person"] = ADMIN
    assert client.post("/delegation/revoke", json={"delegation": iri}).json()["ok"] is True
    assert not can_write(stub, JANE, KURT_HOLONS)


def test_revoke_is_idempotent_and_unknown_is_ok_false(client):
    iri = client.post("/delegation", json=body()).json()["delegation"]
    client.post("/delegation/revoke", json={"delegation": iri})
    again = client.post("/delegation/revoke", json={"delegation": iri}).json()
    assert again["ok"] is True and "already" in again["note"]
    missing = client.post("/delegation/revoke", json={"delegation": "urn:example:delegation:zzz"}).json()
    assert missing["ok"] is False and "not_found" in missing["note"]


# --- read resolution used by /holon?on_behalf_of ---------------------------


def test_resolve_read_delegation_returns_only_the_covered_graphs(client, stub):
    client.post("/delegation", json=body(permissions=["read"]))  # holons only
    resolved = asyncio.run(
        dg.resolve_read_delegation(
            query_fn_for(stub), HOLONS, delegate=JANE, delegator=KURT,
            current_persona=None,
            persona_iri_of=lambda name: f"urn:example:persona:{name}",
        )
    )
    assert resolved.persona == "phoebe"
    assert resolved.graphs == frozenset({KURT_HOLONS})  # scene was NOT delegated


def test_resolve_read_delegation_refuses_without_a_read_delegation(client, stub):
    client.post("/delegation", json=body(permissions=["write"]))
    with pytest.raises(dg.DelegationRefused):
        asyncio.run(
            dg.resolve_read_delegation(
                query_fn_for(stub), HOLONS, delegate=JANE, delegator=KURT,
                current_persona=None,
                persona_iri_of=lambda name: f"urn:example:persona:{name}",
            )
        )


def test_resolve_read_delegation_is_ambiguous_across_personas(stub):
    now = datetime.now(timezone.utc)
    for name in ("phoebe", "chloe"):
        stub.ds.get_context(URIRef(HOLONS)).parse(
            data=dg.build_delegation(
                delegation_iri=f"urn:example:delegation:{name}", delegator=KURT, delegate=JANE,
                persona=f"urn:example:persona:{name}",
                graphs=[f"urn:example:persona:{name}:user:kurt:holons"], permissions=["read"],
                valid_from=now - timedelta(hours=1), valid_until=now + timedelta(days=1),
            ),
            format="turtle",
        )
    kwargs = dict(
        delegate=JANE, delegator=KURT,
        persona_iri_of=lambda name: f"urn:example:persona:{name}",
    )
    with pytest.raises(dg.DelegationAmbiguous):
        asyncio.run(dg.resolve_read_delegation(
            query_fn_for(stub), HOLONS, current_persona=None, **kwargs))
    picked = asyncio.run(dg.resolve_read_delegation(
        query_fn_for(stub), HOLONS, current_persona="chloe", **kwargs))
    assert picked.persona == "chloe"
    assert picked.graphs == frozenset({"urn:example:persona:chloe:user:kurt:holons"})


def test_delegation_iri_follows_the_holons_graph_convention():
    assert dg.delegation_iri("urn:example:holons", "abc") == "urn:example:delegation:abc"
    assert dg.delegation_iri("urn:bank:ds:holons", "abc") == "urn:bank:ds:delegation:abc"
    with pytest.raises(ValueError):
        dg.delegation_iri("urn:example:other", "abc")
    with pytest.raises(ValueError):
        dg.delegation_iri("urn:example:holons", "a:b")


# --- injection: request-supplied IRIs must not change statement structure ---


@pytest.mark.parametrize(
    "hostile",
    [
        "urn:example:person:jane> ; <https://w3id.org/holon/hasRole> <urn:example:role:admin",
        "urn:example:person:jane>\n<urn:example:person:kurt> a <https://w3id.org/holon/Person",
        "urn:example:person:jane ",
        "urn:example:person:jane\"",
    ],
)
def test_a_hostile_delegate_is_refused_and_nothing_is_written(client, stub, hostile):
    before = len(stub.ds.get_context(URIRef(HOLONS)))
    response = client.post("/delegation", json=body(delegate=hostile))
    assert response.status_code == 400, response.text
    assert len(stub.ds.get_context(URIRef(HOLONS))) == before  # no triples appended
    assert not can_write(stub, JANE, KURT_HOLONS)


def test_a_hostile_delegator_from_an_admin_is_refused(client, actor, stub):
    actor["person"] = ADMIN
    before = len(stub.ds.get_context(URIRef(HOLONS)))
    response = client.post(
        "/delegation",
        json=body(delegator="urn:example:person:kurt> ; a <urn:example:role:admin"),
    )
    assert response.status_code == 400, response.text
    assert len(stub.ds.get_context(URIRef(HOLONS))) == before


def test_a_note_with_newlines_and_quotes_round_trips_safely(client, stub):
    note = 'line one\nline "two"\ttabbed \\ backslash'
    response = client.post("/delegation", json=body(note=note))
    assert response.status_code == 200, response.text
    comments = [
        str(o) for o in stub.ds.get_context(URIRef(HOLONS)).objects(
            URIRef(response.json()["delegation"]),
            URIRef("http://www.w3.org/2000/01/rdf-schema#comment"),
        )
    ]
    assert comments == [note]


def test_an_overlong_note_is_refused(client):
    assert client.post("/delegation", json=body(note="x" * 501)).status_code == 400


def test_lookup_functions_refuse_hostile_iris(stub):
    hostile = "urn:example:person:kurt> || true || ?delegator = <urn:x"
    q = query_fn_for(stub)
    with pytest.raises(dg.DelegationError):
        asyncio.run(dg.find_delegation(q, HOLONS, delegate=JANE, permission="read",
                                       delegator=hostile))
    with pytest.raises(dg.DelegationError):
        asyncio.run(dg.find_delegation(q, HOLONS, delegate=JANE, permission="read",
                                       target=hostile))
    with pytest.raises(dg.DelegationError):
        asyncio.run(dg.resolve_read_delegation(
            q, HOLONS, delegate=JANE, delegator=hostile, current_persona=None,
            persona_iri_of=lambda n: f"urn:example:persona:{n}"))
    with pytest.raises(dg.DelegationError):
        dg.revoke_update(HOLONS, hostile, datetime.now(timezone.utc))
