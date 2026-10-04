"""Named-projection registry and route tests.

Stub-at-the-Fuseki-boundary, routing ACL/identity through the AnimusDep +
acl.py path for real. The identity, grant, Toolset and audit-config answers
now live in ``tests/_identity.py`` (``IdentityStub``), shared with the other
route tests; this stub only adds the named-query and named-projection
registries.

``stub.executed`` means "what the backend was asked to run for the user's
benefit": it records the projection's CONSTRUCT and nothing else. The bridge
issues plenty of incidental reads on every request (parameter-schema lookup,
the audit config row), and a catch-all that recorded those made the run tests
assert on the bridge's plumbing rather than on what they were about.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from holonbridge.config import Settings
from holonbridge.server import create_app

from ._identity import TOKEN, IdentityStub, auth
from ._identity import row as _row

HB_NS = "https://w3id.org/holonbridge/"
HB_QUERY_TYPE = f"{HB_NS}NamedQuery"
HB_PROJECTION_TYPE = f"{HB_NS}NamedProjection"

CONSTRUCT_QUERY_IRI = "urn:ds:named-query:describe-thing"
CONSTRUCT_QUERY_SPARQL = (
    "PREFIX ex: <urn:ex:>\n"
    "CONSTRUCT { {{target}} ex:label ?label }\n"
    "WHERE { GRAPH <urn:ds:holons> { {{target}} ex:label ?label } }"
)
UPDATE_QUERY_IRI = "urn:ds:named-query:clear-thing"
UPDATE_QUERY_SPARQL = "DELETE WHERE { GRAPH <urn:ds:holons> { ?s ?p ?o } }"

PROJECTION_IRI = "https://w3id.org/holonbridge/projection/describe-thing-ace"


def query_registry_rows() -> list[dict]:
    return [
        _row(q=CONSTRUCT_QUERY_IRI, type=HB_QUERY_TYPE, p=f"{HB_NS}id", o="describe-thing"),
        _row(q=CONSTRUCT_QUERY_IRI, type=HB_QUERY_TYPE, p=f"{HB_NS}sparql", o=CONSTRUCT_QUERY_SPARQL),
        _row(q=CONSTRUCT_QUERY_IRI, type=HB_QUERY_TYPE, p=f"{HB_NS}queryType", o="CONSTRUCT"),
        _row(q=UPDATE_QUERY_IRI, type=HB_QUERY_TYPE, p=f"{HB_NS}id", o="clear-thing"),
        _row(q=UPDATE_QUERY_IRI, type=HB_QUERY_TYPE, p=f"{HB_NS}sparql", o=UPDATE_QUERY_SPARQL),
    ]


def query_param_rows() -> list[dict]:
    return [
        _row(q=CONSTRUCT_QUERY_IRI, param="_:p1", p=f"{HB_NS}name", o="target"),
        _row(q=CONSTRUCT_QUERY_IRI, param="_:p1", p=f"{HB_NS}datatype", o="xsd:anyURI"),
        _row(q=CONSTRUCT_QUERY_IRI, param="_:p1", p=f"{HB_NS}required", o="true"),
    ]


def projection_registry_rows(prompt_text: str = "Rendered: {{result}}") -> list[dict]:
    return [
        _row(q=PROJECTION_IRI, type=HB_PROJECTION_TYPE, p=f"{HB_NS}id", o="describe-thing-ace"),
        _row(q=PROJECTION_IRI, type=HB_PROJECTION_TYPE, p=f"{HB_NS}namedQuery", o=CONSTRUCT_QUERY_IRI),
        _row(q=PROJECTION_IRI, type=HB_PROJECTION_TYPE, p=f"{HB_NS}promptText", o=prompt_text),
        _row(q=PROJECTION_IRI, type=HB_PROJECTION_TYPE, p=f"{HB_NS}executionMode", o="deferred"),
    ]


class RegistryStub(IdentityStub):
    """Identity/ACL/Toolset from ``IdentityStub``, plus the two registries."""

    def __init__(self) -> None:
        super().__init__()
        self.query_rows = query_registry_rows()
        self.query_param_rows = query_param_rows()
        self.projection_rows: list[dict] = []
        self.executed: list[str] = []
        self.updates: list[str] = []
        self.construct_result = "<urn:ex:thing> <urn:ex:label> \"A Thing\" .\n"

    async def select(self, conn, query, *, default_graph=None):
        infra = self.infra_select(query)
        if infra is not None:
            return infra
        if "?link" in query:
            return {"results": {"bindings": self.query_param_rows}}
        if "NamedProjection" in query:
            return {"results": {"bindings": self.projection_rows}}
        if "NamedQuery" in query:
            return {"results": {"bindings": self.query_rows}}
        return {"results": {"bindings": []}}

    async def construct(self, conn, query, *, default_graph=None, timeout=None):
        self.executed.append(query)
        return self.construct_result

    async def update(self, conn, update):
        self.updates.append(update)

    async def get_graph(self, conn, graph_iri):
        return ""

    async def post_graph(self, conn, graph_iri, turtle):
        return None

    async def put_graph(self, conn, graph_iri, turtle):
        return None

    async def drop_graph(self, conn, graph_iri):
        return None

    async def shacl_validate(self, conn, *, target_graph, shapes_turtle):
        return ""

    async def ping(self, conn):
        return True

    async def aclose(self):
        return None


@pytest.fixture
def stub() -> RegistryStub:
    return RegistryStub()


@pytest.fixture
def client(stub: RegistryStub):
    app = create_app(Settings(bearer_token=TOKEN, named_query_ttl=0.0))
    with TestClient(app) as test_client:
        app.state.fuseki = stub
        yield test_client


# --- registration ---------------------------------------------------------


def test_register_wraps_an_existing_reachable_query(client, stub):
    response = client.post(
        "/named-projection",
        json={
            "id": "describe-thing-ace",
            "named_query": "describe-thing",
            "prompt_text": "Rendered: {{result}}",
        },
        headers=auth(),
    )
    assert response.status_code == 200
    body = response.json()
    assert body["ok"] is True
    assert body["namedQuery"] == "describe-thing"
    assert len(stub.updates) == 1
    assert "NamedProjection" in stub.updates[0]
    assert CONSTRUCT_QUERY_IRI in stub.updates[0]


def test_register_rejects_an_unknown_named_query(client):
    response = client.post(
        "/named-projection",
        json={"id": "x", "named_query": "nope", "prompt_text": "{{result}}"},
        headers=auth(),
    )
    assert response.status_code == 404
    assert response.json()["detail"]["error"] == "unknown_named_query"


def test_register_rejects_an_update_form_named_query(client):
    response = client.post(
        "/named-projection",
        json={"id": "x", "named_query": "clear-thing", "prompt_text": "{{result}}"},
        headers=auth(),
    )
    assert response.status_code == 400
    assert "update-form" in response.json()["detail"]


def test_register_rejects_a_query_the_caller_cannot_reach(client, stub):
    stub.restricted_tools = {CONSTRUCT_QUERY_IRI}
    # persona_reachable_tools stays empty -- the caller's active persona
    # (if any) has no holon:hasToolset membership granting it back.
    response = client.post(
        "/named-projection",
        json={"id": "x", "named_query": "describe-thing", "prompt_text": "{{result}}"},
        headers=auth(),
    )
    assert response.status_code == 403
    assert "cannot currently reach it" in response.json()["detail"]


def test_register_requires_a_write_grant(client, stub):
    stub.write_grant = False
    response = client.post(
        "/named-projection",
        json={"id": "x", "named_query": "describe-thing", "prompt_text": "{{result}}"},
        headers=auth(),
    )
    assert response.status_code == 403


def test_register_rejects_execution_mode_other_than_deferred(client):
    response = client.post(
        "/named-projection",
        json={
            "id": "x",
            "named_query": "describe-thing",
            "prompt_text": "{{result}}",
            "execution_mode": "server",
        },
        headers=auth(),
    )
    assert response.status_code == 422  # rejected by the pydantic pattern constraint


# --- listing / reading -----------------------------------------------------


def test_list_and_get_a_registered_projection(client, stub):
    stub.projection_rows = projection_registry_rows()
    body = client.get("/named-projections", headers=auth()).json()
    assert body["count"] == 1
    assert body["projections"][0]["id"] == "describe-thing-ace"

    detail = client.get("/named-projection/describe-thing-ace", headers=auth()).json()
    assert detail["namedQuery"] == CONSTRUCT_QUERY_IRI
    assert detail["promptText"] == "Rendered: {{result}}"


def test_unknown_projection_lists_what_is_available(client, stub):
    stub.projection_rows = projection_registry_rows()
    response = client.get("/named-projection/nope", headers=auth())
    assert response.status_code == 404
    assert "describe-thing-ace" in response.json()["detail"]["available"]


# --- running -----------------------------------------------------------------


def test_run_binds_params_and_interpolates_the_result(client, stub):
    stub.projection_rows = projection_registry_rows()
    response = client.post(
        "/named-projection/describe-thing-ace/run",
        json={"params": {"target": "https://example.org/thing/1"}},
        headers=auth(),
    )
    assert response.status_code == 200
    body = response.json()
    assert body["executed"] is True
    assert body["status"] == "deferred"
    assert body["result"] == stub.construct_result
    assert body["prompt"] == f"Rendered: {stub.construct_result}"
    assert "<https://example.org/thing/1>" in body["sparql"]
    assert len(stub.executed) == 1


def test_dry_run_returns_the_raw_prompt_unfilled(client, stub):
    stub.projection_rows = projection_registry_rows()
    response = client.post(
        "/named-projection/describe-thing-ace/run",
        json={"params": {"target": "https://example.org/thing/1"}, "dry_run": True},
        headers=auth(),
    )
    body = response.json()
    assert body["executed"] is False
    assert body["prompt"] == "Rendered: {{result}}"
    assert stub.executed == []


def test_missing_required_param_is_a_client_error(client, stub):
    stub.projection_rows = projection_registry_rows()
    response = client.post(
        "/named-projection/describe-thing-ace/run", json={"params": {}}, headers=auth()
    )
    assert response.status_code == 400
    assert response.json()["detail"]["missing"] == ["target"]


def test_prompt_without_a_placeholder_gets_the_result_appended(client, stub):
    stub.projection_rows = projection_registry_rows(prompt_text="Just render it.")
    response = client.post(
        "/named-projection/describe-thing-ace/run",
        json={"params": {"target": "https://example.org/thing/1"}},
        headers=auth(),
    )
    body = response.json()
    assert body["prompt"] == f"Just render it.\n\n{stub.construct_result}"


def test_running_an_unreachable_projection_is_indistinguishable_from_unknown(client, stub):
    stub.projection_rows = projection_registry_rows()
    stub.restricted_tools = {PROJECTION_IRI}
    response = client.post(
        "/named-projection/describe-thing-ace/run",
        json={"params": {"target": "https://example.org/thing/1"}},
        headers=auth(),
    )
    assert response.status_code == 404
    assert response.json()["detail"]["error"] == "unknown_named_projection"


# --- deletion ----------------------------------------------------------------


def test_delete_requires_a_replace_grant(client, stub):
    stub.projection_rows = projection_registry_rows()
    stub.replace_grant = False
    response = client.delete("/named-projection/describe-thing-ace", headers=auth())
    assert response.status_code == 403


def test_delete_removes_a_known_projection(client, stub):
    stub.projection_rows = projection_registry_rows()
    response = client.delete("/named-projection/describe-thing-ace", headers=auth())
    assert response.status_code == 200
    assert response.json()["ok"] is True
    assert len(stub.updates) == 1
    assert PROJECTION_IRI in stub.updates[0]


def test_delete_unknown_projection_is_404(client, stub):
    response = client.delete("/named-projection/nope", headers=auth())
    assert response.status_code == 404


# --- reload ------------------------------------------------------------------


def test_reload_invalidates_the_cache(client, stub):
    stub.projection_rows = projection_registry_rows()
    client.get("/named-projections", headers=auth())
    stub.projection_rows = []
    body = client.post("/named-projections/reload", headers=auth()).json()
    assert body["count"] == 0
