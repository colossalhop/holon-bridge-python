"""Sequence minting.

Counters live in ``urn:{dataset}:sequences``, one resource per named
sequence. Minting is a compare-and-set: the UPDATE only fires if the counter
still holds the value we read, so two concurrent minters cannot both claim
the same number. A losing minter retries.

The counter graph follows the dataset naming convention, which is exactly
what the ``urn:data:*`` datasets got wrong — a mismatched counter graph
silently mints from zero every time.

Each successful mint also writes a MintedIdentifier provenance record,
keyed by a bank+dataset-scoped IRI (``urn:{bank}:{dataset}:id-{identifier}``)
rather than the counter's own IRI -- the counter tracks "what's the next
number," the record tracks "what was this number actually used for, and
who said so." Gap-detection depends on this record existing for every
mint that gets consumed, not on the counter alone.

CHANGED 2026-09-15: fixed an unsound CAS confirmation flagged by Ben
Wortley. The guarded UPDATE below (DELETE/INSERT ... WHERE FILTER ?old =
current) genuinely is a correct compare-and-set at the graph level -- Jena
serialises UPDATE execution, so of two concurrent attempts that both read
the same ``current`` and compute the same ``nxt``, only the one whose
FILTER still matches at execution time actually fires; the other's
DELETE/INSERT is a true no-op. The bug was in how a losing attempt found
out it had lost: it re-read the counter's *value* afterwards and compared
that to its own ``nxt`` -- but the winner had already set the counter to
that identical value, so the loser's read-back matched too. Both attempts
then believed they owned ``nxt``, both went on to insert a
MintedIdentifier record for the same computed ``iri``, and the loser
handed its caller a duplicate of an id already given out.

The fix attaches a random per-attempt token to the same guarded UPDATE
that sets ``seq:value``, and the confirmation read-back now checks that
*this attempt's own token* -- not just the value -- is what is currently
recorded. Only the attempt whose guarded UPDATE actually fired can ever
see its own token reflected back; a loser's read-back always shows the
winner's token instead, and a mismatch on the token is treated exactly
like the old value mismatch already was: retry from the top, with a fresh
read of the (now-advanced) counter. This closes the race without needing
any second network round trip -- the token rides along in the same
UPDATE and the same confirmation SELECT that were already here.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import datetime, timezone

from .conn import Conn
from .fuseki import FusekiClient
from .turtle import escape_literal

SEQ_NS = "https://w3id.org/holon/sequence/"
MINT_NS = "https://w3id.org/holon/mint#"

_PREFIXES = f"""
PREFIX seq:   <{SEQ_NS}>
PREFIX hmint: <{MINT_NS}>
PREFIX xsd:   <http://www.w3.org/2001/XMLSchema#>
PREFIX rdfs:  <http://www.w3.org/2000/01/rdf-schema#>
"""


class SequenceError(RuntimeError):
    pass


@dataclass(frozen=True)
class MintedId:
    sequence: str
    value: int
    identifier: str
    iri: str


async def mint(
    client: FusekiClient,
    conn: Conn,
    *,
    name: str,
    purpose: str,
    authorised_by: str | None = None,
    prefix: str | None = None,
    pad: int = 4,
    attempts: int = 8,
) -> MintedId:
    """Mint the next identifier in a named sequence.

    ``name`` is the sequence key (for example ``FI`` or ``event``).
    ``prefix`` defaults to ``name`` and is what appears in the identifier.
    ``purpose`` is required -- it's what makes the MintedIdentifier record
    legible on its own, independent of whatever consumed the id.
    ``authorised_by`` is an IRI naming the actor or process responsible;
    omitted if not supplied, though every call site should eventually pass
    one once actor identity exists end-to-end.
    """

    graph = conn.graph("sequences")
    counter = f"{SEQ_NS}{name}"
    label = prefix if prefix is not None else name

    for _ in range(attempts):
        current = await _read(client, conn, graph=graph, counter=counter)
        nxt = current + 1
        # Identifies THIS attempt, and only this attempt -- see the module
        # docstring. Generated fresh every loop iteration, never reused
        # across a retry, so a stale token from an earlier losing attempt
        # can never be mistaken for a fresh one's confirmation.
        attempt_token = uuid.uuid4().hex

        update = f"""{_PREFIXES}
DELETE {{
  GRAPH <{graph}> {{
    <{counter}> seq:value ?old .
    <{counter}> seq:mintToken ?oldToken .
  }}
}}
INSERT {{
  GRAPH <{graph}> {{
    <{counter}> a seq:Sequence ;
                rdfs:label "{escape_literal(name)}" ;
                seq:prefix "{escape_literal(label)}" ;
                seq:pad {pad} ;
                seq:value "{nxt}"^^xsd:integer ;
                seq:mintToken "{attempt_token}" .
  }}
}}
WHERE {{
  OPTIONAL {{ GRAPH <{graph}> {{ <{counter}> seq:value ?old . }} }}
  OPTIONAL {{ GRAPH <{graph}> {{ <{counter}> seq:mintToken ?oldToken . }} }}
  FILTER ( !BOUND(?old) || ?old = "{current}"^^xsd:integer )
}}"""
        await client.update(conn, update)

        confirmed_value, confirmed_token = await _read_confirmation(
            client, conn, graph=graph, counter=counter
        )
        if confirmed_value == nxt and confirmed_token == attempt_token:
            # This attempt's own guarded UPDATE is what actually fired --
            # not merely "the counter now reads nxt", which a concurrent
            # winner could equally have produced. See the module docstring.
            identifier = f"{label}-{nxt:0{pad}d}" if label else f"{nxt:0{pad}d}"
            iri = f"urn:{conn.bank_name}:{conn.dataset}:id-{identifier}"
            authorised_clause = (
                f" ;\n            hmint:authorisedBy <{authorised_by}>"
                if authorised_by
                else ""
            )

            record = f"""{_PREFIXES}
INSERT DATA {{
  GRAPH <{graph}> {{
    <{iri}> a hmint:MintedIdentifier ;
            hmint:hasIdentifier "{escape_literal(identifier)}"^^xsd:string ;
            hmint:hasSequence <{counter}> ;
            hmint:hasPurpose "{escape_literal(purpose)}" ;
            hmint:hasGenerationDate "{datetime.now(timezone.utc).isoformat()}"^^xsd:dateTime{authorised_clause} .
  }}
}}"""
            await client.update(conn, record)

            return MintedId(sequence=name, value=nxt, identifier=identifier, iri=iri)

    raise SequenceError(
        f"could not mint from sequence {name!r} after {attempts} attempts "
        "(contention or a counter being written elsewhere)"
    )


async def peek(client: FusekiClient, conn: Conn, *, name: str) -> int:
    """Current value of a sequence without advancing it."""
    return await _read(
        client, conn, graph=conn.graph("sequences"), counter=f"{SEQ_NS}{name}"
    )


async def _read(
    client: FusekiClient, conn: Conn, *, graph: str, counter: str
) -> int:
    query = f"""{_PREFIXES}
SELECT ?value WHERE {{
  GRAPH <{graph}> {{ <{counter}> seq:value ?value . }}
}} LIMIT 1"""
    results = await client.select(conn, query)
    bindings = results.get("results", {}).get("bindings", [])
    if not bindings:
        return 0
    return int(bindings[0]["value"]["value"])


async def _read_confirmation(
    client: FusekiClient, conn: Conn, *, graph: str, counter: str
) -> tuple[int, str | None]:
    """Read back both the counter's value and the attempt token currently
    recorded alongside it, in one query -- see the module docstring for why
    the value alone is not enough to confirm which attempt actually won."""
    query = f"""{_PREFIXES}
SELECT ?value ?token WHERE {{
  GRAPH <{graph}> {{ <{counter}> seq:value ?value . }}
  OPTIONAL {{ GRAPH <{graph}> {{ <{counter}> seq:mintToken ?token . }} }}
}} LIMIT 1"""
    results = await client.select(conn, query)
    bindings = results.get("results", {}).get("bindings", [])
    if not bindings:
        return 0, None
    row = bindings[0]
    value = int(row["value"]["value"])
    token = row["token"]["value"] if "token" in row else None
    return value, token
