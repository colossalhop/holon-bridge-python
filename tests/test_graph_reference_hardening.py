"""Graph-reference hardening: a query or update must not reach a graph the ACL
never looked at.

A live test found that a caller with no grants at all could write to a graph
through ``INSERT { GRAPH ?g ... } WHERE { VALUES ?g { <g> } }``, and the
parser's own output showed ``DROP GRAPH <g>``, ``FROM <g>``, ``WITH``,
``USING``, ``COPY``/``MOVE``/``ADD`` and ``LOAD`` all reporting "references no
graph" -- an empty result being exactly what makes the caller conclude there
is nothing to check.

Three levels, so a regression is caught wherever it happens: the analysis
itself, the ACL functions, and the real ``/sparql/*`` routes (where the
exploit actually was).
"""

from __future__ import annotations

import asyncio

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from rdflib import Dataset, URIRef

from holonbridge import audit
from holonbridge.acl import (
    Animus,
    analyse_graph_refs,
    authorize_query,
    authorize_update,
    extract_graph_refs,
)
from holonbridge.conn import Conn
from holonbridge.deps import get_client, require_animus, require_conn
from holonbridge.routes import sparql as sparql_routes

HOLON = "https://w3id.org/holon/"
HOLONS = "urn:example:holons"
AUDIT = "urn:example:audit"
CONFIG = "urn:example:audit:config"
ADMIN = "urn:example:person:root"
JANE = "urn:example:person:jane"
PERSONA = "urn:example:persona:phoebe"
PRIVATE = "urn:example:persona:phoebe:user:kurt:holons"
OTHER = "urn:example:persona:phoebe:user:kurt:scene"
GROUND = "urn:example:scene"

FIXTURE = f"""
@prefix holon: <{HOLON}> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
<urn:example:role:admin> a holon:Role .
<{ADMIN}> a holon:Person ; rdfs:label "Root" ; holon:hasRole <urn:example:role:admin> .
<{JANE}> a holon:Person ; rdfs:label "Jane" .
<{PERSONA}> a holon:Persona .
"""

WRITE_TEMPLATE = "INSERT DATA {{ GRAPH <{g}> {{ <urn:s> <urn:p> <urn:o> }} }}"


class Store:
    """An rdflib store that also records what the ROUTE actually ran, so a
    test can prove a refused request never reached the backend."""

    def __init__(self) -> None:
        self.ds = Dataset()
        self.ds.get_context(URIRef(HOLONS)).parse(data=FIXTURE, format="turtle")
        self.updates: list[str] = []
        self.user_selects: list[str] = []

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

    async def update(self, conn, update):
        self.updates.append(update)
        self.ds.update(update)

    async def construct(self, conn, query, *, default_graph=None):
        return ""


def grant(store, *, person=JANE, write=(), replace=(), read=False):
    lines = [f"@prefix holon: <{HOLON}> ."]
    for g in write:
        lines.append(f"<{g}> holon:grantsWrite <{person}> .")
    for g in replace:
        lines.append(f"<{g}> holon:grantsReplace <{person}> .")
    if read:
        lines += [
            f"<{person}> holon:hasRole <urn:example:role:reader> .",
            "<urn:example:role:reader> holon:grants <urn:example:grant:r> .",
            f"<urn:example:grant:r> a holon:ReadGrant ; holon:scope <{PERSONA}> .",
        ]
    store.ds.get_context(URIRef(HOLONS)).parse(data="\n".join(lines), format="turtle")


@pytest.fixture
def store() -> Store:
    return Store()


@pytest.fixture
def conn() -> Conn:
    return Conn(base_url="http://localhost:3030", dataset="example", overridden=False,
                bank_name="local")


def q_fn(store):
    return lambda s: store.select(None, s)


def update(store, person, text):
    return asyncio.run(authorize_update(q_fn(store), HOLONS, person=person, sparql_text=text))


def read(store, conn, person, text):
    return asyncio.run(
        authorize_query(q_fn(store), HOLONS, person=person, sparql_text=text,
                        persona_of_graph=conn.persona_for_graph)
    )


# --- 1. the analysis ---------------------------------------------------------------

DYNAMIC = [
    "SELECT * WHERE { GRAPH ?g { ?s ?p ?o } }",
    "SELECT * WHERE { VALUES ?g { <urn:a> } GRAPH ?g { ?s ?p ?o } }",
    "SELECT * WHERE { { SELECT ?s WHERE { GRAPH ?g { ?s ?p ?o } } } }",
    "SELECT * WHERE { <urn:x> ?p ?o OPTIONAL { GRAPH ?g { ?s ?p2 ?o2 } } }",
    "SELECT * WHERE { ?s ?p ?o FILTER EXISTS { GRAPH ?g { ?s ?p ?o } } }",  # untranslated by rdflib
    "SELECT * WHERE { ?s ?p ?o FILTER NOT EXISTS { GRAPH ?g { ?s ?p ?o } } }",
    "SELECT * WHERE { { GRAPH <urn:a> { ?s ?p ?o } } UNION { GRAPH ?g { ?s ?p ?o } } }",
    "SELECT * FROM NAMED <urn:a> WHERE { GRAPH ?g { ?s ?p ?o } }",
    "SELECT * WHERE { SERVICE ?v { ?s ?p ?o } }",
    "CONSTRUCT { ?s ?p ?o } WHERE { GRAPH ?g { ?s ?p ?o } }",
    "ASK { GRAPH ?g { ?s ?p ?o } }",
    "INSERT { GRAPH ?g { <urn:s> <urn:p> <urn:o> } } WHERE { VALUES ?g { <urn:a> } }",
    "DELETE WHERE { GRAPH ?g { ?s ?p ?o } }",
    "DELETE { GRAPH ?g { ?s ?p ?o } } WHERE { GRAPH ?g { ?s ?p ?o } }",
    "DROP ALL",
    "DROP NAMED",
    "CLEAR ALL",
    "CLEAR NAMED",
]


@pytest.mark.parametrize("text", DYNAMIC)
def test_a_graph_position_that_is_not_a_fixed_iri_is_dynamic(text):
    analysis = analyse_graph_refs(text)
    assert analysis is not None and analysis.dynamic is True


@pytest.mark.parametrize(
    "text, refs",
    [
        ("SELECT * WHERE { GRAPH <urn:a> { ?s ?p ?o } }", {"urn:a"}),
        ("SELECT * FROM <urn:a> WHERE { ?s ?p ?o }", {"urn:a"}),
        ("SELECT * FROM <urn:a> FROM NAMED <urn:b> WHERE { ?s ?p ?o }", {"urn:a", "urn:b"}),
        ("SELECT * WHERE { ?s ?p ?o FILTER NOT EXISTS { GRAPH <urn:a> { ?s ?p ?o } } }", {"urn:a"}),
        ("WITH <urn:a> DELETE { ?s ?p ?o } INSERT { ?s ?p 1 } WHERE { ?s ?p ?o }", {"urn:a"}),
        ("DELETE { GRAPH <urn:w> { ?s ?p ?o } } USING <urn:a> WHERE { ?s ?p ?o }", {"urn:a", "urn:w"}),
        ("DELETE { GRAPH <urn:w> { ?s ?p ?o } } USING NAMED <urn:a> WHERE { GRAPH <urn:a> { ?s ?p ?o } }",
         {"urn:a", "urn:w"}),
        ("INSERT { GRAPH <urn:a> { ?s ?p 1 } } WHERE { GRAPH <urn:b> { ?s ?p ?o } }", {"urn:a", "urn:b"}),
        ("LOAD <http://example.org/x> INTO GRAPH <urn:a>", {"urn:a"}),
    ],
)
def test_every_way_of_naming_a_graph_is_seen(text, refs):
    analysis = analyse_graph_refs(text)
    assert analysis is not None and analysis.dynamic is False
    assert set(analysis.all_refs) == refs
    assert extract_graph_refs(text) == refs  # the older entry point sees them too


@pytest.mark.parametrize(
    "text, replace",
    [
        ("DROP GRAPH <urn:a>", {"urn:a"}),
        ("CLEAR GRAPH <urn:a>", {"urn:a"}),
        ("CREATE GRAPH <urn:a>", {"urn:a"}),
        ("COPY <urn:a> TO <urn:b>", {"urn:a", "urn:b"}),
        ("MOVE <urn:a> TO <urn:b>", {"urn:a", "urn:b"}),
        ("ADD <urn:a> TO <urn:b>", {"urn:a", "urn:b"}),
        ("COPY DEFAULT TO <urn:b>", {"urn:b"}),
    ],
)
def test_wholesale_operations_are_classified_as_replace(text, replace):
    analysis = analyse_graph_refs(text)
    assert analysis is not None and set(analysis.replace_refs) == replace
    assert not analysis.refs and not analysis.dynamic


@pytest.mark.parametrize(
    "text",
    [
        "INSERT DATA { <urn:s> <urn:p> <urn:o> }",
        "DELETE WHERE { ?s ?p ?o }",
        "DELETE { ?s ?p ?o } INSERT { ?s ?p 2 } WHERE { ?s ?p ?o }",
        "CLEAR DEFAULT",
        "DROP DEFAULT",
        "COPY DEFAULT TO <urn:b>",
        "LOAD <http://example.org/x>",
    ],
)
def test_writing_the_default_graph_is_flagged(text):
    analysis = analyse_graph_refs(text)
    assert analysis is not None and analysis.default_write is True and not analysis.dynamic


def test_load_is_admin_only_whatever_it_targets():
    for text in ("LOAD <http://example.org/x>", "LOAD <http://example.org/x> INTO GRAPH <urn:a>"):
        assert analyse_graph_refs(text).admin_only_ops == ("LOAD",)


@pytest.mark.parametrize(
    "text",
    [
        "SELECT * WHERE { ?s ?p ?o }",
        "SELECT * WHERE { GRAPH <urn:a> { ?s ?p ?o } }",
        "WITH <urn:a> DELETE { ?s ?p ?o } INSERT { ?s ?p 1 } WHERE { ?s ?p ?o }",  # WITH is not the default graph
        "INSERT DATA { GRAPH <urn:a> { <urn:s> <urn:p> <urn:o> } }",
    ],
)
def test_ordinary_requests_are_not_over_flagged(text):
    analysis = analyse_graph_refs(text)
    assert analysis is not None
    assert not analysis.dynamic and not analysis.default_write and not analysis.admin_only_ops


def test_unparseable_text_is_none_not_empty():
    assert analyse_graph_refs("INSERT DATA { this is not sparql") is None
    assert extract_graph_refs("INSERT DATA { this is not sparql") is None


# --- 2. reads ------------------------------------------------------------------------


@pytest.mark.parametrize("text", [t for t in DYNAMIC if t.split()[0] in ("SELECT", "CONSTRUCT", "ASK")])
def test_a_non_admin_cannot_run_a_dynamic_read(store, conn, text):
    decision = read(store, conn, JANE, text)
    assert not decision.allowed and "does not name" in decision.reason


@pytest.mark.parametrize("text", [t for t in DYNAMIC if t.split()[0] in ("SELECT", "CONSTRUCT", "ASK")])
def test_an_admin_still_can(store, conn, text):
    assert read(store, conn, ADMIN, text).allowed


def test_from_is_checked_like_any_other_reference(store, conn):
    text = f"SELECT * FROM <{PRIVATE}> WHERE {{ ?s ?p ?o }}"
    assert not read(store, conn, JANE, text).allowed  # was: "references no graph"
    grant(store, read=True)
    assert read(store, conn, JANE, text).allowed
    assert read(store, conn, JANE, f"SELECT * FROM NAMED <{GROUND}> WHERE {{ ?s ?p ?o }}").allowed


def test_the_audit_graph_cannot_be_reached_through_from(store, conn):
    for graph in (AUDIT, CONFIG):
        text = f"SELECT * FROM <{graph}> WHERE {{ ?s ?p ?o }}"
        assert not read(store, conn, JANE, text).allowed
        assert read(store, conn, ADMIN, text).allowed


def test_a_static_read_is_unchanged(store, conn):
    assert read(store, conn, JANE, f"SELECT * WHERE {{ GRAPH <{GROUND}> {{ ?s ?p ?o }} }}").allowed
    assert read(store, conn, JANE, "SELECT * WHERE { ?s ?p ?o }").allowed
    assert not read(store, conn, JANE, f"SELECT * WHERE {{ GRAPH <{PRIVATE}> {{ ?s ?p ?o }} }}").allowed


# --- 3. updates ----------------------------------------------------------------------

REFUSED_FOR_A_USER_WITH_NO_GRANTS = [
    WRITE_TEMPLATE.format(g=PRIVATE),  # the ordinary case, for reference
    f"INSERT {{ GRAPH ?g {{ <urn:s> <urn:p> <urn:o> }} }} WHERE {{ VALUES ?g {{ <{PRIVATE}> }} }}",  # the live exploit
    "DELETE WHERE { GRAPH ?g { ?s ?p ?o } }",
    f"WITH <{PRIVATE}> DELETE {{ ?s ?p ?o }} INSERT {{ ?s ?p 1 }} WHERE {{ ?s ?p ?o }}",
    f"DELETE {{ GRAPH <{OTHER}> {{ ?s ?p ?o }} }} USING <{PRIVATE}> WHERE {{ ?s ?p ?o }}",
    f"DROP GRAPH <{PRIVATE}>",
    f"CLEAR GRAPH <{PRIVATE}>",
    "DROP ALL",
    "DROP NAMED",
    "CLEAR ALL",
    f"CREATE GRAPH <{PRIVATE}>",
    f"COPY <{GROUND}> TO <{PRIVATE}>",
    f"MOVE <{PRIVATE}> TO <{OTHER}>",
    f"ADD <{GROUND}> TO <{PRIVATE}>",
    f"LOAD <http://example.org/x> INTO GRAPH <{PRIVATE}>",
    "LOAD <http://example.org/x>",
    "INSERT DATA { <urn:s> <urn:p> <urn:o> }",
    "DELETE WHERE { ?s ?p ?o }",
    "CLEAR DEFAULT",
    WRITE_TEMPLATE.format(g=PRIVATE) + f" ; DROP GRAPH <{OTHER}>",
]


@pytest.mark.parametrize("text", REFUSED_FOR_A_USER_WITH_NO_GRANTS)
def test_a_user_with_no_grants_cannot_do_any_of_it(store, text):
    assert not update(store, JANE, text).allowed


def test_an_unresolved_or_unparseable_update_is_refused(store):
    assert not update(store, None, WRITE_TEMPLATE.format(g=PRIVATE)).allowed
    assert not update(store, ADMIN, "INSERT DATA { this is not sparql").allowed


def test_write_grants_open_exactly_what_they_name(store):
    grant(store, write=[PRIVATE])
    assert update(store, JANE, WRITE_TEMPLATE.format(g=PRIVATE)).allowed
    assert update(store, JANE, f"WITH <{PRIVATE}> DELETE {{ ?s ?p ?o }} WHERE {{ ?s ?p ?o }}").allowed
    assert not update(store, JANE, WRITE_TEMPLATE.format(g=OTHER)).allowed


def test_a_write_grant_does_not_open_a_wholesale_operation(store):
    grant(store, write=[PRIVATE])
    for text in (f"DROP GRAPH <{PRIVATE}>", f"CLEAR GRAPH <{PRIVATE}>", f"CREATE GRAPH <{PRIVATE}>"):
        decision = update(store, JANE, text)
        assert not decision.allowed and "grantsReplace" in decision.reason


def test_a_replace_grant_opens_drop_and_clear_but_not_a_write(store):
    grant(store, replace=[PRIVATE])
    assert update(store, JANE, f"DROP GRAPH <{PRIVATE}>").allowed
    assert update(store, JANE, f"CLEAR GRAPH <{PRIVATE}>").allowed
    assert not update(store, JANE, WRITE_TEMPLATE.format(g=PRIVATE)).allowed  # replace does not imply write


def test_copy_move_and_add_need_replace_on_both_ends(store):
    grant(store, replace=[PRIVATE])
    for verb in ("COPY", "MOVE", "ADD"):
        assert not update(store, JANE, f"{verb} <{PRIVATE}> TO <{OTHER}>").allowed
    grant(store, replace=[OTHER])
    for verb in ("COPY", "MOVE", "ADD"):
        assert update(store, JANE, f"{verb} <{PRIVATE}> TO <{OTHER}>").allowed


def test_one_bad_operation_refuses_the_whole_request(store):
    grant(store, write=[PRIVATE])
    assert update(store, JANE, WRITE_TEMPLATE.format(g=PRIVATE)).allowed
    assert not update(store, JANE, WRITE_TEMPLATE.format(g=PRIVATE) + f" ; DROP GRAPH <{PRIVATE}>").allowed


def test_the_default_graph_and_load_are_admin_only(store):
    grant(store, write=[PRIVATE])
    for text in ("INSERT DATA { <urn:s> <urn:p> <urn:o> }", "CLEAR DEFAULT", "LOAD <http://example.org/x>"):
        assert not update(store, JANE, text).allowed
        assert update(store, ADMIN, text).allowed


def test_an_admin_can_still_do_named_maintenance(store):
    for text in (
        WRITE_TEMPLATE.format(g=PRIVATE),
        f"DROP SILENT GRAPH <{PRIVATE}>",
        f"CLEAR GRAPH <{OTHER}>",
        f"MOVE <{PRIVATE}> TO <{OTHER}>",
        f"WITH <{PRIVATE}> DELETE {{ ?s ?p ?o }} WHERE {{ ?s ?p ?o }}",
    ):
        assert update(store, ADMIN, text).allowed, text


@pytest.mark.parametrize(
    "text",
    [
        "DROP ALL",
        "DROP NAMED",
        "CLEAR ALL",
        "DELETE WHERE { GRAPH ?g { ?s ?p ?o } }",
        f"INSERT {{ GRAPH ?g {{ <urn:s> <urn:p> <urn:o> }} }} WHERE {{ VALUES ?g {{ <{PRIVATE}> }} }}",
    ],
)
def test_a_dynamic_update_is_refused_even_to_an_admin(store, text):
    # The audit graph's protection is a per-graph check; it cannot see through
    # an update that names no graph, so `DROP ALL` would otherwise erase the log.
    decision = update(store, ADMIN, text)
    assert not decision.allowed and "does not name" in decision.reason


@pytest.mark.parametrize("graph", [AUDIT, CONFIG])
@pytest.mark.parametrize(
    "template",
    [
        "DROP GRAPH <{g}>",
        "CLEAR GRAPH <{g}>",
        "CREATE GRAPH <{g}>",
        "COPY <urn:example:scene> TO <{g}>",
        "MOVE <{g}> TO <urn:example:elsewhere>",
        "ADD <urn:example:scene> TO <{g}>",
        "WITH <{g}> DELETE {{ ?s ?p ?o }} WHERE {{ ?s ?p ?o }}",
        "INSERT DATA {{ GRAPH <{g}> {{ <urn:s> <urn:p> <urn:o> }} }}",
        "LOAD <http://example.org/x> INTO GRAPH <{g}>",
    ],
)
def test_no_route_to_the_audit_graphs_survives_for_anyone(store, graph, template):
    text = template.format(g=graph)
    assert not update(store, ADMIN, text).allowed
    assert not update(store, JANE, text).allowed


# --- 4. the real HTTP routes -------------------------------------------------------------


@pytest.fixture
def api(store, conn):
    app = FastAPI()
    app.include_router(sparql_routes.router)
    who = {"person": JANE}

    async def _animus() -> Animus:
        return Animus("x", "GitHubIdentity", person=who["person"], real_person=who["person"])

    app.dependency_overrides[require_conn] = lambda: conn
    app.dependency_overrides[get_client] = lambda: store
    app.dependency_overrides[require_animus] = _animus
    client = TestClient(app, raise_server_exceptions=False)
    client.who = who  # type: ignore[attr-defined]
    return client


def post_update(api, text):
    return api.post("/sparql/update", json={"update": text})


def post_select(api, text):
    return api.post("/sparql/select", json={"query": text})


def test_the_exact_live_exploit_is_now_refused_and_never_reaches_the_store(api, store):
    text = (f"INSERT {{ GRAPH ?g {{ <urn:probe> <urn:p> \"via variable\" }} }} "
            f"WHERE {{ VALUES ?g {{ <{PRIVATE}> }} }}")
    assert post_update(api, text).status_code == 403
    assert store.updates == []
    assert not list(store.ds.get_context(URIRef(PRIVATE)))


@pytest.mark.parametrize("text", [t for t in REFUSED_FOR_A_USER_WITH_NO_GRANTS if t.split()[0] != "SELECT"])
def test_no_refused_update_ever_reaches_the_backend(api, store, text):
    response = post_update(api, text)
    assert response.status_code == 403, text
    assert store.updates == []


def test_a_granted_write_still_goes_through(api, store):
    grant(store, write=[PRIVATE])
    response = post_update(api, WRITE_TEMPLATE.format(g=PRIVATE))
    assert response.status_code == 200 and len(store.updates) == 1
    assert list(store.ds.get_context(URIRef(PRIVATE)))


def test_a_granted_wholesale_operation_goes_through(api, store):
    grant(store, replace=[PRIVATE])
    assert post_update(api, f"DROP GRAPH <{PRIVATE}>").status_code == 200


def test_a_dynamic_read_is_refused_over_http(api, store):
    text = "SELECT * WHERE { GRAPH ?g { ?s ?p ?o } }"
    response = post_select(api, text)
    assert response.status_code == 403 and "does not name" in response.json()["detail"]


def test_from_over_http_is_checked(api, store):
    response = post_select(api, f"SELECT * FROM <{PRIVATE}> WHERE {{ ?s ?p ?o }}")
    assert response.status_code == 403


def test_an_admin_over_http_keeps_named_maintenance_but_not_drop_all(api, store):
    api.who["person"] = ADMIN
    assert post_update(api, f"DROP SILENT GRAPH <{PRIVATE}>").status_code == 200
    assert post_update(api, "DROP ALL").status_code == 403
    assert post_select(api, "SELECT * WHERE { GRAPH ?g { ?s ?p ?o } }").status_code == 200


def test_the_audit_graph_survives_every_attempt_over_http(api, store):
    store.ds.get_context(URIRef(AUDIT)).parse(
        data="<urn:example:audit:entry:1> <urn:p> <urn:o> .", format="turtle"
    )
    for who in (JANE, ADMIN):
        api.who["person"] = who
        for text in (f"DROP GRAPH <{AUDIT}>", "DROP ALL", f"CLEAR GRAPH <{AUDIT}>",
                     f"MOVE <{AUDIT}> TO <urn:example:elsewhere>", "DELETE WHERE { GRAPH ?g { ?s ?p ?o } }"):
            assert post_update(api, text).status_code == 403, (who, text)
    assert len(list(store.ds.get_context(URIRef(AUDIT)))) == 1
    assert store.updates == []
