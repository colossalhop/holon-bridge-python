"""Regression tests for the orphan ledger entry a lost fluent race used to leave
(fixed 2026-09-30 -- see the ``CHANGED 2026-09-30`` note in
``holonbridge/fluent.py``).

``update_fluent`` runs a ledger append and a scene update in one SPARQL
request. The scene update is a compare-and-set whose guard fails if another
transition got in first; the ledger append beside it used to be an
unconditional ``INSERT DATA``. A loser's scene update was a correct no-op, but
its ledger entry still landed -- superseding the same predecessor as the
winner's and superseded by nothing -- so the fluent ended with two live
StateAssertions.

These tests run the real ``update_fluent`` and the real ``sequence.mint``
against ``rdflib``'s SPARQL Update engine rather than a hand-written fake, for
the reason that matters here: the bug lives in what the two SPARQL statements
*do*, which a fake that pattern-matches their text cannot see. ``RdflibStore``
below adds only the two properties of Fuseki the race depends on:

* ``update`` runs synchronously with no ``await`` before it mutates -- a real
  SPARQL Update is one transaction no other Update can interleave with;
* ``select`` answers from the state at the moment it was *issued* and then
  yields (``await asyncio.sleep(0)``) -- like a network round trip -- so two
  concurrent transitions can both read the same current value before either
  writes, which is the whole precondition for the race.

rdflib is not Jena. What is exercised is SPARQL 1.1 Update semantics (an
unconditional INSERT next to a guarded DELETE/INSERT...WHERE in one request),
which is exactly the behaviour at issue.
"""

from __future__ import annotations

import asyncio
from decimal import Decimal

import pytest
from rdflib import Dataset, Literal, URIRef
from rdflib.namespace import XSD

from holonbridge import fluent as fluent_mod
from holonbridge.conn import Conn
from holonbridge.fluent import FluentError, Operation, update_fluent

HOLON = "https://w3id.org/holon/"
HEVT = "https://w3id.org/holon/event/"
FLUENT = "urn:ds:fluent:score"
PROP = "urn:ds:prop:score"
SEED_ASSERTION = "urn:ds:assertion:seed"

ALICE = "urn:ds:person:alice"
BOB = "urn:ds:person:bob"

CONFORMS = (
    "@prefix sh: <http://www.w3.org/ns/shacl#> .\n[] a sh:ValidationReport ; sh:conforms true .\n"
)
ANY_SHAPES = """
@prefix sh: <http://www.w3.org/ns/shacl#> .
@prefix ex: <https://example.org/> .
ex:AnyShape a sh:NodeShape ; sh:targetClass ex:Nothing .
"""


def _conn() -> Conn:
    return Conn(base_url="http://fuseki.test", dataset="ds", overridden=False, bank_name="local")


def _binding(term) -> dict:
    if isinstance(term, URIRef):
        return {"type": "uri", "value": str(term)}
    out = {"type": "literal", "value": str(term)}
    if getattr(term, "datatype", None):
        out["datatype"] = str(term.datatype)
    return out


class RdflibStore:
    """A Fuseki stand-in backed by a real SPARQL engine -- see the module
    docstring for the two properties it adds."""

    def __init__(self, shapes: str = "") -> None:
        self.ds = Dataset()
        self.shapes = shapes
        self.updates: list[str] = []

    async def select(self, conn, query: str) -> dict:
        rows = list(self.ds.query(query))  # snapshot NOW, as the request is issued
        variables = [str(v) for v in self.ds.query(query).vars]
        bindings = [
            {v: _binding(row[v]) for v in variables if row[v] is not None} for row in rows
        ]
        await asyncio.sleep(0)  # the response arrives later; another coroutine may run
        return {"head": {"vars": variables}, "results": {"bindings": bindings}}

    async def update(self, conn, sparql: str) -> None:
        self.updates.append(sparql)
        self.ds.update(sparql)  # no await before this: one atomic step

    async def get_graph(self, conn, graph_iri: str) -> str:
        return self.shapes if graph_iri == conn.shapes_graph else ""

    async def construct(self, conn, query: str) -> str:
        return self.ds.query(query).graph.serialize(format="turtle")

    async def post_graph(self, conn, graph_iri: str, turtle: str) -> None:
        self.ds.graph(URIRef(graph_iri)).parse(data=turtle, format="turtle")

    async def drop_graph(self, conn, graph_iri: str) -> None:
        self.ds.update(f"DROP SILENT GRAPH <{graph_iri}>")

    async def shacl_validate(self, conn, *, target_graph: str, shapes_turtle: str) -> str:
        return CONFORMS

    # -- assertions helpers ---------------------------------------------------

    def ledger(self, conn) -> list[str]:
        q = f"""SELECT ?a WHERE {{ GRAPH <{conn.graph("events")}> {{
          ?a <{HEVT}forFluent> <{FLUENT}> }} }}"""
        return sorted(str(r.a) for r in self.ds.query(q))

    def live(self, conn) -> list[str]:
        """Ledger entries for the fluent that nothing supersedes and that are
        not invalidated -- the set the pre-commit check scopes to, and which
        must have exactly one member."""
        q = f"""SELECT ?a WHERE {{ GRAPH <{conn.graph("events")}> {{
          ?a <{HEVT}forFluent> <{FLUENT}> .
          FILTER NOT EXISTS {{ ?later <{HEVT}supersedes> ?a }}
          FILTER NOT EXISTS {{ ?a <{HEVT}invalidatedAt> ?x }} }} }}"""
        return sorted(str(r.a) for r in self.ds.query(q))

    def forks(self, conn) -> dict[str, int]:
        """Predecessors superseded by MORE than one entry -- a forked chain."""
        q = f"""SELECT ?p (COUNT(?a) AS ?n) WHERE {{ GRAPH <{conn.graph("events")}> {{
          ?a <{HEVT}supersedes> ?p ; <{HEVT}forFluent> <{FLUENT}> }} }} GROUP BY ?p HAVING (COUNT(?a) > 1)"""
        return {str(r.p): int(r.n) for r in self.ds.query(q)}

    def current(self, conn) -> tuple[str | None, str | None]:
        q = f"""SELECT ?v ?a WHERE {{ GRAPH <{conn.scene_graph}> {{
          <{FLUENT}> <{HOLON}currentValue> ?v . OPTIONAL {{ <{FLUENT}> <{HOLON}currentAssertion> ?a }} }} }}"""
        rows = list(self.ds.query(q))
        return (str(rows[0].v), str(rows[0].a)) if rows else (None, None)


def _seed(store: RdflibStore, conn: Conn, *, mode: str = "SetValueMode", with_current: bool = True) -> None:
    store.ds.graph(URIRef(conn.holons_graph)).add((URIRef(FLUENT), URIRef(f"{HOLON}fluentProperty"), URIRef(PROP)))
    store.ds.graph(URIRef(conn.ontology_graph)).add(
        (URIRef(PROP), URIRef(f"{HOLON}fluentOperationMode"), URIRef(f"{HOLON}{mode}"))
    )
    if with_current:
        scene, events = store.ds.graph(URIRef(conn.scene_graph)), store.ds.graph(URIRef(conn.graph("events")))
        one = Literal("1", datatype=XSD.decimal)
        scene.add((URIRef(FLUENT), URIRef(f"{HOLON}currentValue"), one))
        scene.add((URIRef(FLUENT), URIRef(f"{HOLON}currentAssertion"), URIRef(SEED_ASSERTION)))
        events.add((URIRef(SEED_ASSERTION), URIRef(f"{HEVT}forFluent"), URIRef(FLUENT)))
        events.add((URIRef(SEED_ASSERTION), URIRef(f"{HEVT}hasValue"), one))


@pytest.fixture(autouse=True)
def _no_triggers(monkeypatch):
    """StateTrigger evaluation runs after a confirmed transition and is
    irrelevant here; it would only add noise from an unconfigured store."""

    async def noop(*_a, **_k):
        return None

    monkeypatch.setattr(fluent_mod, "_evaluate_state_triggers", noop)


# --- the race ---------------------------------------------------------------------


async def test_two_concurrent_sets_leave_exactly_one_live_assertion():
    conn, store = _conn(), RdflibStore()
    _seed(store, conn)

    a, b = await asyncio.gather(
        update_fluent(store, conn, fluent=FLUENT, operation=Operation.SET, value=2, asserted_by=ALICE),
        update_fluent(store, conn, fluent=FLUENT, operation=Operation.SET, value=3, asserted_by=BOB),
    )

    assert a.assertion_iri != b.assertion_iri
    # the seed entry plus one per successful transition -- nothing orphaned
    assert len(store.ledger(conn)) == 3
    assert len(store.live(conn)) == 1
    assert store.forks(conn) == {}  # no predecessor superseded twice
    # and the one live assertion is the one the scene points at
    assert store.current(conn)[1] == store.live(conn)[0]


async def test_the_loser_supersedes_the_winner_rather_than_the_seed():
    """The loser retries from a fresh read, so the chain is linear: seed ->
    winner -> loser, never seed -> {winner, loser}."""
    conn, store = _conn(), RdflibStore()
    _seed(store, conn)

    results = await asyncio.gather(
        update_fluent(store, conn, fluent=FLUENT, operation=Operation.SET, value=2, asserted_by=ALICE),
        update_fluent(store, conn, fluent=FLUENT, operation=Operation.SET, value=3, asserted_by=BOB),
    )

    superseded = sorted(r.superseded for r in results)
    assert SEED_ASSERTION in superseded
    other = next(s for s in superseded if s != SEED_ASSERTION)
    assert other in {r.assertion_iri for r in results}  # the second one superseded the first


async def test_two_concurrent_first_ever_sets_do_not_orphan_an_entry():
    """The Init shape of the guard (FILTER NOT EXISTS) is a different code path
    from the compare-and-set on an existing value, and had the same hole."""
    conn, store = _conn(), RdflibStore()
    _seed(store, conn, with_current=False)

    await asyncio.gather(
        update_fluent(store, conn, fluent=FLUENT, operation=Operation.SET, value=2, asserted_by=ALICE),
        update_fluent(store, conn, fluent=FLUENT, operation=Operation.SET, value=3, asserted_by=BOB),
    )

    assert len(store.ledger(conn)) == 2
    assert len(store.live(conn)) == 1
    assert store.forks(conn) == {}


async def test_three_way_contention_still_yields_one_linear_chain():
    conn, store = _conn(), RdflibStore()
    _seed(store, conn)

    await asyncio.gather(
        *(
            update_fluent(
                store, conn, fluent=FLUENT, operation=Operation.SET, value=10 + i, asserted_by=ALICE
            )
            for i in range(3)
        )
    )

    assert len(store.ledger(conn)) == 4
    assert len(store.live(conn)) == 1
    assert store.forks(conn) == {}


async def test_a_lost_race_writes_nothing_to_the_ledger(monkeypatch):
    """The same property, deterministically and without concurrency: hand the
    first attempt a stale read, so its guarded update genuinely loses, and check
    that attempt left nothing behind before the retry succeeded."""
    conn, store = _conn(), RdflibStore()
    _seed(store, conn)
    await update_fluent(store, conn, fluent=FLUENT, operation=Operation.SET, value=2, asserted_by=ALICE)
    assert len(store.ledger(conn)) == 2  # seed + the winner

    real_read_current = fluent_mod._read_current
    stale = fluent_mod.TypedValue(kind="literal", lexical="1", datatype=str(XSD.decimal))
    calls = {"n": 0}

    async def stale_first(client, conn_, *, fluent, scene_graph=None):
        calls["n"] += 1
        if calls["n"] == 1:
            return stale, SEED_ASSERTION  # what a loser read before the winner landed
        return await real_read_current(client, conn_, fluent=fluent, scene_graph=scene_graph)

    monkeypatch.setattr(fluent_mod, "_read_current", stale_first)
    result = await update_fluent(store, conn, fluent=FLUENT, operation=Operation.SET, value=9, asserted_by=BOB)

    assert calls["n"] == 2  # the stale read, then the fresh one the retry made: one lost attempt
    assert len(store.ledger(conn)) == 3  # seed + winner + this transition; no orphan from the lost attempt
    assert len(store.live(conn)) == 1
    assert store.forks(conn) == {}
    assert result.superseded != SEED_ASSERTION  # the retry chained onto the winner


# --- behaviour that must not change -------------------------------------------------


async def test_sequential_transitions_still_form_a_chain():
    conn, store = _conn(), RdflibStore()
    _seed(store, conn, mode="NumericAccumulator")

    first = await update_fluent(store, conn, fluent=FLUENT, operation=Operation.INSERT, value=5, asserted_by=ALICE)
    second = await update_fluent(store, conn, fluent=FLUENT, operation=Operation.REMOVE, value=2, asserted_by=ALICE)

    assert first.superseded == SEED_ASSERTION
    assert second.superseded == first.assertion_iri
    assert store.current(conn)[0] == "4"  # 1 + 5 - 2
    assert len(store.live(conn)) == 1


async def test_a_delta_on_a_fluent_with_no_value_is_still_refused_before_any_write():
    conn, store = _conn(), RdflibStore()
    _seed(store, conn, mode="NumericAccumulator", with_current=False)

    with pytest.raises(FluentError, match="has no current value"):
        await update_fluent(store, conn, fluent=FLUENT, operation=Operation.INSERT, value=1, asserted_by=ALICE)

    assert store.ledger(conn) == []


# --- the pre-commit trial -----------------------------------------------------------


async def test_the_precommit_trial_statements_touch_only_scratch_graphs():
    """The ledger statement now reads the scene graph (its guard), so the trial
    copy of it must have BOTH graph IRIs swapped for the scratch copies. Left
    pointing at the live scene graph it would still run and still match -- the
    copy equals the live graph at that moment -- so only this check catches a
    regression: the trial must be confined to the copies."""
    conn, store = _conn(), RdflibStore(shapes=ANY_SHAPES)
    _seed(store, conn)

    await update_fluent(store, conn, fluent=FLUENT, operation=Operation.SET, value=2, asserted_by=ALICE)

    live = (f"<{conn.graph('events')}>", f"<{conn.scene_graph}>")
    trial = [u for u in store.updates if "scratch:fluent-" in u and not u.lstrip().startswith("COPY")]
    assert len(trial) == 1  # exactly one trial request, carrying both statements
    assert not any(graph in trial[0] for graph in live)
    # ...while the real request, sent afterwards, does name the live graphs
    real = store.updates[-1]
    assert all(graph in real for graph in live)
    assert store.current(conn)[0] == "2"


async def test_a_gated_transition_that_loses_the_race_leaves_no_orphan_either():
    conn, store = _conn(), RdflibStore(shapes=ANY_SHAPES)
    _seed(store, conn)

    await asyncio.gather(
        update_fluent(store, conn, fluent=FLUENT, operation=Operation.SET, value=2, asserted_by=ALICE),
        update_fluent(store, conn, fluent=FLUENT, operation=Operation.SET, value=3, asserted_by=BOB),
    )

    assert len(store.ledger(conn)) == 3
    assert len(store.live(conn)) == 1
    assert store.forks(conn) == {}
    leftover = [g for g in store.ds.graphs() if "scratch" in str(g.identifier)]
    assert all(len(g) == 0 for g in leftover)  # every scratch graph was dropped
