"""Audit log: policy, entry building, the middleware end to end, and the
protections around the audit graph itself.

Same harness as test_delegation_lifecycle.py: an rdflib-backed store stub and
FastAPI ``dependency_overrides``. The overrides for ``require_conn`` /
``require_animus`` also set ``request.state`` -- exactly what the real
dependencies in ``deps.py`` do for the middleware -- so what is exercised
here is the real middleware, the real ``write_turtle_to_graph`` and the
real ``acl`` functions.
"""

from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone

import pytest
from fastapi import FastAPI, Request
from fastapi.testclient import TestClient
from rdflib import Dataset, Namespace, URIRef

from holonbridge import audit
from holonbridge import delegation as dg
from holonbridge.acl import Animus, authorize_query, check_replace, check_write
from holonbridge.conn import Conn
from holonbridge.deps import AnimusDep, ClientDep, ConnDep, get_client, require_animus, require_conn
from holonbridge.ingest import write_turtle_to_graph
from holonbridge.routes import audit as audit_routes

HOLON = "https://w3id.org/holon/"
HB = Namespace(audit.HB)
HOLONS = "urn:example:holons"
AUDIT = "urn:example:audit"
CONFIG = "urn:example:audit:config"
META = "urn:example:meta"
ADMIN = "urn:example:person:root"
KURT = "urn:example:person:kurt"
JANE = "urn:example:person:jane"
PERSONA = "urn:example:persona:phoebe"
KURT_HOLONS = "urn:example:persona:phoebe:user:kurt:holons"

FIXTURE = f"""
@prefix holon: <{HOLON}> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
<urn:example:role:admin> a holon:Role .
<{ADMIN}> a holon:Person ; rdfs:label "Root" ; holon:hasRole <urn:example:role:admin> .
<{KURT}> a holon:Person ; rdfs:label "Kurt" .
<{JANE}> a holon:Person ; rdfs:label "Jane" .
<{PERSONA}> a holon:Persona .
"""

TURTLE = "<urn:example:secret-subject> <urn:example:secret-predicate> <urn:example:secret-object> ."


class GraphStoreStub:
    def __init__(self) -> None:
        self.ds = Dataset()
        self.fail_audit = False

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

    async def update(self, conn, update):
        self.ds.update(update)

    async def post_graph(self, conn, graph_iri, turtle):
        if self.fail_audit and graph_iri == AUDIT:
            raise RuntimeError("audit store down")
        self.ds.get_context(URIRef(graph_iri)).parse(data=turtle, format="turtle")

    async def put_graph(self, conn, graph_iri, turtle):
        self.ds.get_context(URIRef(graph_iri)).parse(data=turtle, format="turtle")


def entries(stub):
    g = stub.ds.get_context(URIRef(AUDIT))
    out = []
    for e in g.subjects(URIRef("http://www.w3.org/1999/02/22-rdf-syntax-ns#type"), HB.AuditEntry):
        one = lambda p: next(iter(g.objects(e, p)), None)  # noqa: E731
        out.append(
            {
                "iri": str(e),
                "at": str(one(HB.at)),
                "outcome": str(one(HB.outcome)),
                "operation": str(one(HB.operation)),
                "status": int(one(HB.status)),
                "actor": str(one(HB.actor)) if one(HB.actor) else None,
                "real": str(one(HB.realActor)) if one(HB.realActor) else None,
                "acting_as": bool(one(HB.actingAs)),
                "graphs": sorted(str(o) for o in g.objects(e, HB.targetGraph)),
                "graph_text": [str(o) for o in g.objects(e, HB.targetGraphText)],
                "mode": str(one(HB.writeMode)) if one(HB.writeMode) else None,
                "by": str(one(HB.authorisedBy)) if one(HB.authorisedBy) else None,
                "reason": str(one(HB.authorisedReason)) if one(HB.authorisedReason) else None,
                "hash": str(one(HB.payloadHash)) if one(HB.payloadHash) else None,
                "bytes": int(one(HB.payloadBytes)) if one(HB.payloadBytes) else None,
                "security": bool(one(HB.securityRead)),
                "note": str(one(HB.reason)) if one(HB.reason) else None,
            }
        )
    return sorted(out, key=lambda x: x["at"])


@pytest.fixture(autouse=True)
def _fresh_level_cache(monkeypatch):
    audit._level_cache.clear()
    monkeypatch.delenv("HOLONBRIDGE_AUDIT_LEVEL", raising=False)
    yield
    audit._level_cache.clear()


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
def actor():
    return {"person": ADMIN, "real": ADMIN, "acting_as": False}


@pytest.fixture
def client(stub, conn, actor):
    app = FastAPI()
    app.state.fuseki = stub
    app.add_middleware(audit.AuditMiddleware)
    app.include_router(audit_routes.router)

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

    @app.post("/graph/push")
    async def push(body: dict, conn: ConnDep, client: ClientDep, animus: AnimusDep):
        return await write_turtle_to_graph(
            turtle=body["turtle"], graph_iri=body["graph_iri"], mode=body.get("mode", "merge"),
            shapes_graph=None, reduction_rule_id=None, conn=conn, client=client,
            shacl_required=False, shacl_delta=False, animus=animus,
        )

    @app.post("/sparql/select")
    async def select(conn: ConnDep, animus: AnimusDep):
        return {"ok": True}

    @app.get("/holon")
    async def holon(conn: ConnDep, animus: AnimusDep, on_behalf_of: str | None = None):
        return {"ok": True}

    @app.get("/boom")
    async def boom(conn: ConnDep, animus: AnimusDep):
        raise RuntimeError("kaboom")

    return TestClient(app, raise_server_exceptions=False)


def force_level(stub, level):
    """Write a level straight into the config graph, the way an operator with
    access to the store could. The API cannot set 'off' or 'denials'
    permanently -- that is the point -- so tests that need them do it here."""
    stub.ds.update(
        f'INSERT DATA {{ GRAPH <{CONFIG}> {{ <{CONFIG}> <{audit.HB}auditLevel> "{level}" }} }}'
    )
    audit._level_cache.clear()


def push(client, graph=KURT_HOLONS, mode="merge", turtle=TURTLE):
    return client.post("/graph/push", json={"turtle": turtle, "graph_iri": graph, "mode": mode})


# --- policy --------------------------------------------------------------------


@pytest.mark.parametrize(
    "level, outcome, mutation, security, expected",
    [
        ("off", "denied", True, True, False),
        ("denials", "denied", True, False, True),
        ("denials", "allowed", True, False, False),
        ("mutations", "allowed", True, False, True),
        ("mutations", "error", True, False, True),
        ("mutations", "allowed", False, True, False),
        ("standard", "allowed", False, True, True),
        ("standard", "allowed", False, False, False),
        ("standard", "error", False, True, False),
        ("standard", "denied", False, False, True),
        ("bogus", "denied", True, True, False),
    ],
)
def test_the_recording_policy(level, outcome, mutation, security, expected):
    assert audit.should_record(level, outcome, mutation, security) is expected


def test_mutation_classification():
    assert audit.is_mutation("POST", "/graph/push")
    assert audit.is_mutation("DELETE", "/graph")
    assert not audit.is_mutation("POST", "/sparql/select")
    assert not audit.is_mutation("POST", "/sparql/construct")
    assert not audit.is_mutation("POST", "/validate")
    assert not audit.is_mutation("GET", "/graphs")


def test_naming_follows_the_holons_graph_convention():
    assert audit.audit_graph("urn:example:holons") == "urn:example:audit"
    assert audit.audit_graph("urn:bank:ds:holons") == "urn:bank:ds:audit"
    with pytest.raises(ValueError):
        audit.audit_graph("urn:example:other")


def test_foreign_user_graphs():
    refs = ["urn:x:persona:p:user:kurt:holons", "urn:x:persona:p:user:jane:holons",
            "urn:x:persona:p:user:public:holons", "urn:x:holons"]
    assert audit.foreign_user_graphs(refs, "kurt") == ["urn:x:persona:p:user:jane:holons"]


def test_annotate_is_a_no_op_outside_a_request():
    audit.annotate(graphs=["urn:x"], reason="nothing listening")  # must not raise


# --- entries -------------------------------------------------------------------


def test_an_entry_parses_and_never_carries_the_payload(stub, client):
    push(client)
    (e,) = entries(stub)
    assert e["hash"].startswith("sha256:") and e["bytes"] == len(TURTLE)
    dump = stub.ds.get_context(URIRef(AUDIT)).serialize(format="turtle")
    assert "secret" not in dump  # digest and size only, never content


def test_hostile_values_cannot_change_an_entrys_structure(stub, client):
    hostile = "urn:example:g> ; a <urn:example:role:admin"
    push(client, graph=hostile)
    (e,) = entries(stub)
    assert e["graphs"] == [] and e["graph_text"] == [hostile]  # kept as text, not as an IRI
    audit_graph = stub.ds.get_context(URIRef(AUDIT))
    assert not list(audit_graph.triples((None, None, URIRef("urn:example:role:admin"))))


# --- the middleware ------------------------------------------------------------


def test_an_admin_write_is_recorded_with_its_authority(stub, client):
    assert push(client).status_code == 200
    (e,) = entries(stub)
    assert e["outcome"] == "allowed" and e["status"] == 200
    assert e["operation"] == "POST /graph/push"
    assert e["actor"] == ADMIN and e["real"] is None
    assert e["graphs"] == [KURT_HOLONS] and e["mode"] == "merge"
    assert e["reason"] == "admin role bypass" and e["by"] is None


def test_a_denied_write_is_recorded_with_the_reason(stub, client, actor):
    actor.update(person=JANE, real=JANE)
    assert push(client).status_code == 403
    (e,) = entries(stub)
    assert e["outcome"] == "denied" and e["status"] == 403
    assert e["actor"] == JANE and e["graphs"] == [KURT_HOLONS]
    assert "no explicit grantsWrite" in e["reason"]
    assert not list(stub.ds.get_context(URIRef(KURT_HOLONS)))  # and nothing was written


def test_a_delegated_write_records_the_delegation(stub, client, actor):
    now = datetime.now(timezone.utc)
    iri = "urn:example:delegation:d1"
    stub.ds.get_context(URIRef(HOLONS)).parse(
        data=f"<{KURT}> a <{HOLON}Person> . <{JANE}> a <{HOLON}Person> .\n"
        + dg.build_delegation(
            delegation_iri=iri, delegator=KURT, delegate=JANE, persona=PERSONA,
            graphs=[KURT_HOLONS], permissions=["write"], valid_from=now - timedelta(hours=1),
            valid_until=now + timedelta(days=1)),
        format="turtle",
    )
    actor.update(person=JANE, real=JANE)
    assert push(client).status_code == 200
    (e,) = entries(stub)
    assert e["by"] == iri and "delegated write" in e["reason"]


def test_act_as_is_recorded_with_both_identities(stub, client, actor):
    actor.update(person=JANE, real=ADMIN, acting_as=True)
    push(client)  # denied: Jane has no grant, and this is Jane as far as the ACL knows
    (e,) = entries(stub)
    assert e["actor"] == JANE and e["real"] == ADMIN and e["acting_as"] is True


def test_a_replace_is_recorded_as_such(stub, client):
    push(client, mode="replace")
    (e,) = entries(stub)
    assert e["mode"] == "replace"


def test_a_read_only_post_is_not_recorded(stub, client):
    assert client.post("/sparql/select").status_code == 200
    assert entries(stub) == []


def test_reads_are_recorded_only_when_security_relevant(stub, client, actor):
    client.get("/holon")
    assert entries(stub) == []  # an ordinary read is not audited

    client.get("/holon", params={"on_behalf_of": "kurt"})
    (e,) = entries(stub)
    assert e["operation"] == "GET /holon" and e["security"] is True

    actor["acting_as"] = True
    client.get("/holon")
    assert len(entries(stub)) == 2  # a read under act_as is a security read too


def test_a_failing_mutation_is_recorded_as_an_error(stub, client, monkeypatch):
    async def explode(*a, **k):
        raise RuntimeError("store down")

    monkeypatch.setattr(stub, "put_graph", explode)
    assert push(client, mode="replace").status_code == 500
    (e,) = entries(stub)
    assert e["outcome"] == "error" and e["status"] == 500


def test_a_failure_to_write_the_audit_entry_never_fails_the_request(stub, client, caplog):
    stub.fail_audit = True
    response = push(client)
    assert response.status_code == 200
    assert "FAILED to record" in caplog.text
    assert entries(stub) == []


def test_requests_that_never_reached_a_dataset_are_skipped(stub, client):
    assert client.get("/nope").status_code == 404
    assert entries(stub) == []


# --- levels --------------------------------------------------------------------


def test_level_off_records_nothing(stub, client, actor):
    force_level(stub, "off")
    actor.update(person=JANE, real=JANE)
    push(client)  # a denial, which would otherwise be recorded
    assert entries(stub) == []


def test_level_denials_records_only_refusals(stub, client, actor):
    force_level(stub, "denials")
    push(client)  # an allowed admin write
    assert entries(stub) == []
    actor.update(person=JANE, real=JANE)
    push(client)
    assert [e["outcome"] for e in entries(stub)] == ["denied"]


def test_level_mutations_leaves_security_reads_out(stub, client):
    asyncio.run(audit.set_level(stub, Conn("u", "example", False, "local"), "mutations"))
    client.get("/holon", params={"on_behalf_of": "kurt"})
    assert entries(stub) == []
    push(client)
    assert len(entries(stub)) == 1


def test_the_process_default_comes_from_the_environment(stub, client, monkeypatch):
    monkeypatch.setenv("HOLONBRIDGE_AUDIT_LEVEL", "off")
    audit._level_cache.clear()
    push(client)
    assert entries(stub) == []


def test_a_bad_environment_value_falls_back_to_standard(monkeypatch):
    monkeypatch.setenv("HOLONBRIDGE_AUDIT_LEVEL", "loud")
    assert audit.default_level() == "standard"


# --- protecting the audit graph ------------------------------------------------


def test_nobody_can_write_the_audit_graph_not_even_an_admin(stub):
    q = lambda s: stub.select(None, s)  # noqa: E731
    for check in (check_write, check_replace):
        decision = asyncio.run(check(q, HOLONS, person=ADMIN, target=AUDIT))
        assert not decision.allowed and "audit graph" in decision.reason


def test_a_push_to_the_audit_graph_is_refused_for_an_admin(stub, client):
    assert push(client, graph=AUDIT).status_code == 403
    assert entries(stub) == [] or all(e["outcome"] == "denied" for e in entries(stub))


def test_only_admins_may_read_the_audit_graph_through_sparql(stub):
    q = lambda s: stub.select(None, s)  # noqa: E731
    text = f"SELECT * WHERE {{ GRAPH <{AUDIT}> {{ ?s ?p ?o }} }}"

    def read(person):
        return asyncio.run(
            authorize_query(q, HOLONS, person=person, sparql_text=text,
                            persona_of_graph=lambda g: None)
        )

    assert read(ADMIN).allowed
    denied = read(JANE)
    assert not denied.allowed and "admins only" in denied.reason


# --- GET /audit and /audit/level -----------------------------------------------


def test_only_admins_can_list_entries(stub, client, actor):
    actor.update(person=JANE, real=JANE)
    assert client.get("/audit").status_code == 403


def test_listing_is_newest_first_and_filterable(stub, client, actor):
    push(client)
    actor.update(person=JANE, real=JANE)
    push(client)
    actor.update(person=ADMIN, real=ADMIN)

    body = client.get("/audit").json()
    assert body["count"] == 2
    assert [e["outcome"] for e in body["entries"]] == ["denied", "allowed"]
    assert body["entries"][0]["graphs"] == [KURT_HOLONS]

    only = client.get("/audit", params={"outcome": "denied"}).json()
    assert [e["actor"] for e in only["entries"]] == [JANE]
    assert client.get("/audit", params={"actor": "jane"}).json()["count"] == 1
    assert client.get("/audit", params={"outcome": "bogus"}).status_code == 400


def test_reading_the_audit_log_is_not_itself_logged(stub, client):
    push(client)
    client.get("/audit")
    client.get("/audit")
    assert len(entries(stub)) == 1


def test_a_refused_attempt_to_read_the_log_is_logged(stub, client, actor):
    actor.update(person=JANE, real=JANE)
    client.get("/audit")
    (e,) = entries(stub)
    assert e["outcome"] == "denied" and e["operation"] == "GET /audit"


def test_setting_the_level_works_and_is_always_recorded(stub, client):
    assert client.get("/audit/level").json()["effective"] == "standard"
    response = client.post("/audit/level", json={"level": "mutations"})
    assert response.status_code == 200 and response.json()["effective"] == "mutations"
    assert client.get("/audit/level").json()["effective"] == "mutations"

    # ...and the change itself is on the record.
    (e,) = entries(stub)
    assert e["operation"] == "POST /audit/level"
    assert e["note"] == "audit level standard -> mutations"

    # 'mutations' still records writes, but no longer records security reads.
    push(client)
    assert len(entries(stub)) == 2
    client.get("/holon", params={"on_behalf_of": "kurt"})
    assert len(entries(stub)) == 2


def test_an_invalid_level_is_rejected(client):
    assert client.post("/audit/level", json={"level": "verbose"}).status_code == 400
