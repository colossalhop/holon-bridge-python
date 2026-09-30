"""Who may turn auditing down, and how.

A live test found the first design let an admin silence the log with a plain
SPARQL update to the ``meta`` graph -- and that update went unrecorded,
because it took effect before the middleware decided whether to log it.
These tests pin the replacement:

1. the configuration lives in a bridge-owned graph nobody can write through
   the API, so the audited routes are the only way to change it;
2. the API has a floor -- ``mutations`` -- and ``off``/``denials`` are either
   a time-boxed, reasoned, self-reverting suspension or an operator decision
   made in the environment;
3. a suspension is recorded when it starts and when it ends.
"""

from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone

import pytest
from fastapi import FastAPI, Request
from fastapi.testclient import TestClient
from rdflib import Dataset, Namespace, URIRef

from holonbridge import audit
from holonbridge.acl import Animus, check_replace, check_write
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
JANE = "urn:example:person:jane"
KURT_HOLONS = "urn:example:persona:phoebe:user:kurt:holons"
TURTLE = "<urn:example:a> <urn:example:b> <urn:example:c> ."

FIXTURE = f"""
@prefix holon: <{HOLON}> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
<urn:example:role:admin> a holon:Role .
<{ADMIN}> a holon:Person ; rdfs:label "Root" ; holon:hasRole <urn:example:role:admin> .
<{JANE}> a holon:Person ; rdfs:label "Jane" .
"""


class GraphStoreStub:
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
                "at": str(one(HB.at)),
                "outcome": str(one(HB.outcome)),
                "operation": str(one(HB.operation)),
                "note": str(one(HB.reason)) if one(HB.reason) else None,
                "actor": str(one(HB.actor)) if one(HB.actor) else None,
            }
        )
    return sorted(out, key=lambda x: x["at"])


def config_triples(stub):
    return list(stub.ds.get_context(URIRef(CONFIG)))


@pytest.fixture(autouse=True)
def _clean_environment(monkeypatch):
    audit._config_cache.clear()
    monkeypatch.delenv("HOLONBRIDGE_AUDIT_LEVEL", raising=False)
    monkeypatch.delenv("HOLONBRIDGE_AUDIT_LEVELS", raising=False)
    yield
    audit._config_cache.clear()


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
    return {"person": ADMIN, "real": ADMIN}


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
        animus = Animus("x", "GitHubIdentity", person=actor["person"], real_person=actor["real"])
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

    return TestClient(app, raise_server_exceptions=False)


def push(client, graph=KURT_HOLONS, mode="merge"):
    return client.post("/graph/push", json={"turtle": TURTLE, "graph_iri": graph, "mode": mode})


def suspend(client, level="off", minutes=30, reason="bulk load"):
    return client.post("/audit/suspend", json={"level": level, "minutes": minutes, "reason": reason})


def effective(client):
    return client.get("/audit/level").json()["effective"]


# --- 1. the configuration cannot be written through the API ----------------------


def test_the_config_graph_is_protected_like_the_audit_graph(stub):
    q = lambda s: stub.select(None, s)  # noqa: E731
    for check in (check_write, check_replace):
        decision = asyncio.run(check(q, HOLONS, person=ADMIN, target=CONFIG))
        assert not decision.allowed and "audit graph" in decision.reason


def test_an_admin_cannot_push_to_the_config_graph(stub, client):
    assert push(client, graph=CONFIG).status_code == 403
    assert push(client, graph=CONFIG, mode="replace").status_code == 403
    assert config_triples(stub) == []


def test_the_old_meta_graph_setting_no_longer_does_anything(stub, client):
    # The exact hole found live: an admin writes the level triple into the
    # ordinary meta graph. It is now ignored.
    stub.ds.update(
        f'INSERT DATA {{ GRAPH <{META}> {{ <{CONFIG}> <{audit.HB}auditLevel> "off" }} }}'
    )
    audit._config_cache.clear()
    assert effective(client) == "standard"
    assert asyncio.run(audit.level_for(stub, Conn("u", "example", False, "local"))) == "standard"


# --- 2. the API floor ------------------------------------------------------------


@pytest.mark.parametrize("level", ["off", "denials", "verbose", ""])
def test_the_api_refuses_to_set_a_level_below_the_floor(stub, client, level):
    response = client.post("/audit/level", json={"level": level})
    assert response.status_code == 400
    if level in ("off", "denials"):
        assert "suspend" in response.json()["detail"]
    assert effective(client) == "standard"
    assert config_triples(stub) == []


def test_the_api_accepts_mutations_standard_and_default(client):
    assert client.post("/audit/level", json={"level": "mutations"}).json()["effective"] == "mutations"
    assert client.post("/audit/level", json={"level": "standard"}).json()["effective"] == "standard"
    client.post("/audit/level", json={"level": "mutations"})
    cleared = client.post("/audit/level", json={"level": "default"}).json()
    assert cleared["api_level"] is None and cleared["effective"] == "standard"


def test_only_admins_can_change_anything(stub, client, actor):
    actor.update(person=JANE, real=JANE)
    for call in (
        lambda: client.post("/audit/level", json={"level": "mutations"}),
        lambda: suspend(client),
        lambda: client.post("/audit/resume"),
    ):
        assert call().status_code == 403
    assert config_triples(stub) == []
    assert {e["outcome"] for e in entries(stub)} == {"denied"}  # and every attempt is on record


# --- operator decisions ----------------------------------------------------------


def test_the_operator_can_set_a_permanent_off_in_the_environment(client, monkeypatch):
    monkeypatch.setenv("HOLONBRIDGE_AUDIT_LEVELS", "example=off,other=denials")
    audit._config_cache.clear()
    body = client.get("/audit/level").json()
    assert body["effective"] == "off" and body["operator_level"] == "off"


def test_a_per_dataset_setting_beats_the_global_one(monkeypatch):
    monkeypatch.setenv("HOLONBRIDGE_AUDIT_LEVEL", "mutations")
    monkeypatch.setenv("HOLONBRIDGE_AUDIT_LEVELS", "example=denials,bogus=nonsense")
    assert audit.operator_level("example") == "denials"
    assert audit.operator_level("elsewhere") == "mutations"
    assert audit.operator_level("bogus") == "mutations"  # an invalid level is ignored


def test_the_api_level_overrides_the_operators_and_default_returns_to_it(client, monkeypatch):
    monkeypatch.setenv("HOLONBRIDGE_AUDIT_LEVELS", "example=off")
    audit._config_cache.clear()
    assert effective(client) == "off"
    assert client.post("/audit/level", json={"level": "standard"}).json()["effective"] == "standard"
    assert client.post("/audit/level", json={"level": "default"}).json()["effective"] == "off"


# --- 3. time-boxed suspension ----------------------------------------------------


def test_a_suspension_lowers_the_level_and_is_recorded_with_its_reason(stub, client):
    response = suspend(client, level="off", minutes=30, reason="bulk load of the CDL corpus")
    assert response.status_code == 200 and response.json()["effective"] == "off"

    body = client.get("/audit/level").json()
    assert body["suspension"]["level"] == "off"
    assert body["suspension"]["reason"] == "bulk load of the CDL corpus"
    assert body["suspension"]["by"] == ADMIN

    # The suspension is recorded even though it took audit to 'off'.
    (e,) = entries(stub)
    assert e["operation"] == "POST /audit/suspend"
    assert e["note"] == "audit suspended to off for 30 min: bulk load of the CDL corpus"

    push(client)  # inside the window: nothing further is recorded
    assert len(entries(stub)) == 1


def test_a_suspension_to_denials_still_records_refusals(stub, client, actor):
    suspend(client, level="denials")
    push(client)
    assert len(entries(stub)) == 1  # only the suspension itself
    actor.update(person=JANE, real=JANE)
    push(client)
    assert [e["outcome"] for e in entries(stub)][-1] == "denied"


def test_resuming_early_ends_it_and_is_recorded(stub, client):
    suspend(client)
    response = client.post("/audit/resume")
    assert response.status_code == 200 and response.json()["was_suspended"] is True
    assert effective(client) == "standard"
    assert entries(stub)[-1]["note"] == "audit suspension to off ended early"

    push(client)  # recording is back
    assert len(entries(stub)) == 3


def test_resuming_when_nothing_is_suspended_is_harmless_and_still_recorded(stub, client):
    assert client.post("/audit/resume").json()["was_suspended"] is False
    assert entries(stub)[-1]["note"] == "no suspension was running"


def test_an_expired_suspension_ends_itself_and_says_so_once(stub, client):
    past = datetime.now(timezone.utc) - timedelta(minutes=5)
    stub.ds.update(
        f"""PREFIX hb: <{audit.HB}>
INSERT DATA {{ GRAPH <{CONFIG}> {{
  <{CONFIG}> hb:suspendedTo "off" ;
             hb:suspendedUntil "{audit._iso_micro(past)}"^^<{audit.XSD}dateTime> ;
             hb:suspendedReason "left over" ;
             hb:suspendedBy <{ADMIN}> .
}} }}"""
    )
    audit._config_cache.clear()

    push(client)  # the first request to notice the expiry
    resumed = [e for e in entries(stub) if e["operation"] == "audit.resumed"]
    assert len(resumed) == 1
    assert resumed[0]["note"].startswith("audit suspension to off ended at expiry")
    assert resumed[0]["actor"] == ADMIN  # whoever had suspended it
    assert config_triples(stub) == []  # cleaned up

    # ...and recording is back: the very request that noticed was itself recorded.
    assert any(e["operation"] == "POST /graph/push" for e in entries(stub))

    push(client)
    push(client)
    assert len([e for e in entries(stub) if e["operation"] == "audit.resumed"]) == 1


def test_a_running_suspension_is_not_ended_early(stub, client):
    suspend(client, minutes=60)
    push(client)
    assert [e for e in entries(stub) if e["operation"] == "audit.resumed"] == []
    assert effective(client) == "off"


def test_a_new_suspension_replaces_the_old_one(client):
    suspend(client, level="off", minutes=30, reason="first")
    suspend(client, level="denials", minutes=60, reason="second")
    body = client.get("/audit/level").json()
    assert body["suspension"]["level"] == "denials" and body["suspension"]["reason"] == "second"


@pytest.mark.parametrize(
    "kwargs",
    [
        {"level": "standard"},  # not a lowering
        {"level": "mutations"},  # settable permanently instead
        {"level": "bogus"},
        {"minutes": 0},
        {"minutes": audit.MAX_SUSPEND_MINUTES + 1},
        {"reason": ""},
        {"reason": "   "},
    ],
)
def test_a_suspension_must_be_well_formed(stub, client, kwargs):
    assert suspend(client, **kwargs).status_code == 400
    assert config_triples(stub) == []
    assert effective(client) == "standard"


def test_the_longest_allowed_suspension_works(client):
    assert suspend(client, minutes=audit.MAX_SUSPEND_MINUTES).status_code == 200


def test_a_hostile_reason_cannot_break_the_stored_configuration(stub, client):
    hostile = 'x" . <urn:example:evil> <urn:example:p> "y'
    assert suspend(client, reason=hostile).status_code == 200
    assert effective(client) == "off"
    assert not list(stub.ds.get_context(URIRef(CONFIG)).triples((URIRef("urn:example:evil"), None, None)))


def test_the_listing_now_shows_the_note(stub, client):
    suspend(client, reason="maintenance")
    body = client.get("/audit").json()
    assert body["entries"][0]["note"] == "audit suspended to off for 30 min: maintenance"
