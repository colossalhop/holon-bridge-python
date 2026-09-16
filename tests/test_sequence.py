"""Tests for the unsound mint() CAS confirmation fixed 2026-09-15 -- see
the ``CHANGED 2026-09-15`` note in ``holonbridge/sequence.py``.

Reported by Ben Wortley: the guarded DELETE/INSERT...WHERE that advances
the counter genuinely is a correct compare-and-set (Jena serialises
UPDATE execution, so a losing attempt's guarded write is a true no-op).
The bug was in how a losing attempt found out it had lost -- it re-read
only the counter's *value* afterwards, which the winner had already set
to the exact number the loser also computed, so both attempts believed
they owned it. Both then minted a MintedIdentifier record for the same
identifier, and the loser handed its caller a duplicate of an id already
given out.

``FakeFusekiStore`` below simulates exactly enough of Fuseki to
reproduce this: an in-memory counter (value + mint token) mutated by a
synchronous, non-yielding ``update()`` -- matching Jena's real guarantee
that a single SPARQL UPDATE is one transaction no other UPDATE can
interleave with -- and a ``select()`` that yields control (``await
asyncio.sleep(0)``) before returning, so two concurrent ``mint()`` calls
can genuinely both read the same ``current`` value before either writes,
which is the whole precondition for the race.
"""

from __future__ import annotations

import asyncio
import re

from holonbridge.conn import Conn
from holonbridge.sequence import mint

_CAS_CURRENT_RE = re.compile(r'\?old = "(\d+)"\^\^xsd:integer')
_CAS_INSERT_RE = re.compile(
    r'seq:value "(\d+)"\^\^xsd:integer ;\s*seq:mintToken "([0-9a-f]+)" \.', re.DOTALL
)
_RECORD_IRI_RE = re.compile(r"<([^>]+)> a hmint:MintedIdentifier")


def _conn() -> Conn:
    return Conn(base_url="http://fuseki.test", dataset="ds", overridden=False, bank_name="local")


class FakeFusekiStore:
    """Just enough of Fuseki's semantics to reproduce (and prove the fix
    for) the mint() race -- see the module docstring."""

    def __init__(self) -> None:
        self.value: int | None = None
        self.token: str | None = None
        self.minted: dict[str, int] = {}  # iri -> times inserted

    async def select(self, conn, query: str) -> dict:
        # Snapshot the state BEFORE yielding, not after: a real round trip
        # to Fuseki reads whatever the store held at the moment the request
        # was issued, then the response comes back later. Yielding first
        # and reading the (possibly already-mutated) state second would
        # accidentally read post-write state and never reproduce the race
        # this fixture exists to reproduce.
        value, token = self.value, self.token
        await asyncio.sleep(0)
        if "?token" in query:
            bindings = []
            if value is not None:
                row = {"value": {"value": str(value)}}
                if token is not None:
                    row["token"] = {"value": token}
                bindings = [row]
            return {"results": {"bindings": bindings}}
        bindings = [{"value": {"value": str(value)}}] if value is not None else []
        return {"results": {"bindings": bindings}}

    async def update(self, conn, sparql: str) -> None:
        if "INSERT DATA" in sparql:
            match = _RECORD_IRI_RE.search(sparql)
            assert match, sparql
            iri = match.group(1)
            self.minted[iri] = self.minted.get(iri, 0) + 1
            return

        # The guarded CAS update. Deliberately no ``await`` before the
        # mutation below -- a real Jena UPDATE is one transaction, so this
        # whole check-then-write must run as one atomic step relative to
        # every other coroutine, exactly like the real backend.
        current_match = _CAS_CURRENT_RE.search(sparql)
        insert_match = _CAS_INSERT_RE.search(sparql)
        assert current_match and insert_match, sparql
        current = int(current_match.group(1))
        nxt, token = int(insert_match.group(1)), insert_match.group(2)

        if self.value is None or self.value == current:
            self.value = nxt
            self.token = token
        # else: another attempt already advanced the counter past what
        # this attempt read -- correctly a no-op, matching real Jena.


async def test_concurrent_mints_never_return_the_same_identifier():
    store = FakeFusekiStore()
    conn = _conn()

    a, b = await asyncio.gather(
        mint(store, conn, name="x", purpose="test-a"),
        mint(store, conn, name="x", purpose="test-b"),
    )

    assert a.iri != b.iri
    # A retry after losing the CAS correctly burns a sequence number --
    # gaps are meaningful by this module's own design (see its module
    # docstring) -- so the two values need only be distinct, never that
    # they land on {1, 2} specifically.
    assert a.value != b.value


async def test_concurrent_mints_each_write_exactly_one_provenance_record():
    store = FakeFusekiStore()
    conn = _conn()

    a, b = await asyncio.gather(
        mint(store, conn, name="x", purpose="test-a"),
        mint(store, conn, name="x", purpose="test-b"),
    )

    # Not "one record total" -- one record for EACH minted identifier, and
    # never more than one for the same iri. The bug this guards against
    # produced two hasGenerationDate assertions on a single shared iri,
    # not a missing record.
    assert store.minted == {a.iri: 1, b.iri: 1}


async def test_sequential_mints_are_unaffected():
    """The fix must not change behaviour when there is no contention at
    all -- plain, one-at-a-time minting still just counts up."""
    store = FakeFusekiStore()
    conn = _conn()

    first = await mint(store, conn, name="y", purpose="p")
    second = await mint(store, conn, name="y", purpose="p")

    assert (first.value, second.value) == (1, 2)
    assert first.iri != second.iri
    assert store.minted == {first.iri: 1, second.iri: 1}


async def test_three_way_contention_still_yields_distinct_identifiers():
    store = FakeFusekiStore()
    conn = _conn()

    results = await asyncio.gather(
        *(mint(store, conn, name="z", purpose=f"p{i}") for i in range(3))
    )

    assert len({r.iri for r in results}) == 3
    assert len({r.value for r in results}) == 3
