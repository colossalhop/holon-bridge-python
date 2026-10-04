"""Delegation: one Person authorising another to read and/or write inside
their own persona-user graphs, without impersonation.

Why this exists (context for anyone opening this cold): ``act_as`` (see
``acting_as.py``) substitutes one identity for another wholesale, is
admin-only, in-memory, and expires after thirty minutes. That is right for
exercising the grant-check code as a real non-admin caller; it is wrong for
"my assistant may work in my graph", where the assistant must keep their own
identity, receive access to *one* graph rather than the delegator's whole
authority, and hold that access durably and revocably.

A ``holon:Delegation`` is a stored, time-boxed, revocable record in the
dataset's ``holons`` graph -- the same place ``holon:grantsWrite`` edges
already live -- naming exactly which graphs are covered and for which
permissions. Nothing here impersonates anyone. ``acl.check_write`` and
``acl.authorize_query`` consult :func:`find_delegation` as one more way to
answer "may this person touch this graph"; the caller is still the delegate,
the target graph still names whose graph it is.

What a delegation can never confer (enforced at creation in
``routes/delegation.py``, and by the query shapes below, not by convention):

- ``replace``. ``check_replace`` is deliberately never consulted here; see
  its own docstring -- appends are the norm, wholesale overwrite is a
  separate, stricter decision that no delegation reaches.
- Admin, or any Role. A delegation names graphs, not authority.
- Anything the delegator does not themselves hold. A delegator can only
  delegate their *own* persona-user graphs (derived at creation, never
  accepted from the request), and only write access they already have.
- Re-delegation. Because the covered graphs are always the delegator's own
  persona-user graphs, a delegate has no graph of their own to pass on that
  was delegated to them: there is no chain to walk.

This module has no import of ``acl`` (which imports it) and none of FastAPI:
it builds SPARQL and Turtle and reads SPARQL-JSON, so it can be tested
against an in-memory rdflib graph, the same way ``test_identity_admin.py``
exercises ``acl.py``'s helpers. The decision shape (``AclDecision``) is built
by the caller.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Awaitable, Callable, Iterable

HOLON = "https://w3id.org/holon/"
XSD = "http://www.w3.org/2001/XMLSchema#"

QueryFn = Callable[[str], "dict | Awaitable[dict]"]

#: What a delegation can grant. ``replace`` is deliberately absent.
PERMISSIONS: tuple[str, ...] = ("read", "write")

#: Graph roles a delegation may cover. Matches persona_scope.SCOPED_ROLES;
#: ``events`` is an audit ledger and is never delegable.
DELEGABLE_ROLES: tuple[str, ...] = ("holons", "scene")

DEFAULT_LIFETIME = timedelta(days=7)
MAX_LIFETIME = timedelta(days=90)


class DelegationError(ValueError):
    """A delegation request that cannot be honoured; message is user-facing."""


class DelegationRefused(DelegationError):
    """No active delegation covers what was asked for (HTTP 403)."""


class DelegationAmbiguous(DelegationError):
    """More than one delegation could apply; the caller must choose (HTTP 409)."""


def delegation_iri(holons_graph: str, slug: str) -> str:
    """The Delegation resource IRI for ``slug``, derived from the dataset's
    ``holons`` graph the same way ``acl._admin_role`` and
    ``acl._scratch_area`` derive their org-tier resources: swap the
    trailing ``:holons`` for the resource's own path segment --
    ``urn:example:holons`` -> ``urn:example:delegation:{slug}``, and the
    bank-scoped form follows for free."""
    suffix = ":holons"
    if not holons_graph.endswith(suffix):
        raise ValueError(f"expected holons_graph to end with {suffix!r}, got {holons_graph!r}")
    if not slug or any(ch in slug for ch in '<> "{}|^`:'):
        raise ValueError(f"{slug!r} cannot be used in a Delegation IRI")
    return f"{holons_graph[: -len(suffix)]}:delegation:{slug}"


@dataclass(frozen=True)
class DelegationMatch:
    """One active delegation that answered a lookup."""

    delegation: str
    delegator: str
    persona: str


# --------------------------------------------------------------------------
# Small helpers (duplicated from acl.py/persona.py on purpose -- acl imports
# this module, and reaching back for its private helpers would be circular)
# --------------------------------------------------------------------------

async def _run(query_fn: QueryFn, query: str) -> dict:
    result = query_fn(query)
    if hasattr(result, "__await__"):
        result = await result  # type: ignore[assignment]
    return result  # type: ignore[return-value]


def _bindings(result: dict) -> list[dict]:
    return result.get("results", {}).get("bindings", [])


_IRI_UNSAFE = frozenset('<>"{}|^`\\')


def safe_iri(value: str) -> str:
    """``value`` if it can be interpolated between ``<`` and ``>`` in Turtle
    or SPARQL without changing the statement's structure, otherwise
    :class:`DelegationError`.

    Every IRI this module puts into generated text goes through here. It
    matters because two of them (the delegate and, for an admin, the
    delegator) originate in request bodies, and the Turtle built from them
    is written into the ground-truth ``holons`` graph on the caller's
    behalf: an unchecked ``>`` would let a caller append arbitrary triples
    there. Whitespace and control characters are refused for the same
    reason.
    """
    if (
        not value
        or any(ch in _IRI_UNSAFE or ch.isspace() or ord(ch) < 0x20 for ch in value)
    ):
        raise DelegationError(f"{value!r} is not a usable IRI")
    return value


def _literal(value: str) -> str:
    escaped = (
        value.replace("\\", "\\\\")
        .replace('"', '\\"')
        .replace("\n", "\\n")
        .replace("\r", "\\r")
        .replace("\t", "\\t")
    )
    return f'"{escaped}"'


def _iso(when: datetime) -> str:
    """xsd:dateTime lexical form, always UTC with a trailing Z."""
    return when.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _now_expr(now: datetime | None) -> str:
    """SPARQL expression for 'the current instant'. Production passes
    ``None`` and lets the store's own ``NOW()`` decide; tests inject a
    fixed instant so expiry is deterministic."""
    if now is None:
        return "NOW()"
    return f'"{_iso(now)}"^^<{XSD}dateTime>'


def validate_request(
    *,
    delegator: str,
    delegate: str,
    permissions: Iterable[str],
    roles: Iterable[str],
    lifetime: timedelta,
) -> None:
    """Shape-level checks that need no store access. Raises
    :class:`DelegationError`."""
    if delegator == delegate:
        raise DelegationError("a person cannot delegate to themselves")
    perms = set(permissions)
    if not perms:
        raise DelegationError("at least one permission is required")
    unknown = perms - set(PERMISSIONS)
    if unknown:
        raise DelegationError(
            f"unsupported permission(s) {sorted(unknown)}; "
            f"a delegation may grant only {list(PERMISSIONS)} (never replace)"
        )
    role_set = set(roles)
    if not role_set:
        raise DelegationError("at least one graph role is required")
    bad_roles = role_set - set(DELEGABLE_ROLES)
    if bad_roles:
        raise DelegationError(
            f"graph role(s) {sorted(bad_roles)} cannot be delegated; "
            f"allowed: {list(DELEGABLE_ROLES)}"
        )
    if lifetime <= timedelta(0):
        raise DelegationError("lifetime must be positive")
    if lifetime > MAX_LIFETIME:
        raise DelegationError(
            f"lifetime exceeds the {MAX_LIFETIME.days}-day maximum; renew instead"
        )


# --------------------------------------------------------------------------
# Lookup -- what acl.py and the read routes call
# --------------------------------------------------------------------------

async def find_delegation(
    query_fn: QueryFn,
    holons_graph: str,
    *,
    delegate: str,
    permission: str,
    target: str | None = None,
    delegator: str | None = None,
    now: datetime | None = None,
) -> list[DelegationMatch]:
    """Active delegations to ``delegate`` carrying ``permission``,
    optionally narrowed to one covered graph (``target``) and/or one
    ``delegator``.

    Active means: within its validity window, not revoked, and the
    delegator is still an active Person. A deactivated delegator's
    delegations stop working immediately without anyone having to
    remember to retract them.

    ``target`` is matched against the graph IRIs stored on the
    delegation (``holon:delegatedGraph``), not recomputed from naming
    rules, so this stays a plain triple lookup that costs the same as the
    ``grantsWrite`` ASK it sits beside.
    """
    if permission not in PERMISSIONS:
        raise DelegationError(f"unknown permission {permission!r}")

    holons_graph = safe_iri(holons_graph)
    delegate = safe_iri(delegate)
    target_clause = f"?d holon:delegatedGraph <{safe_iri(target)}> ." if target else ""
    delegator_clause = (
        f"FILTER(?delegator = <{safe_iri(delegator)}>)" if delegator else ""
    )
    current = _now_expr(now)

    # Both negative conditions merged into one FILTER NOT EXISTS via UNION,
    # not two separate FILTER NOT EXISTS clauses -- see this change's own
    # commit message for why. covered_graphs() below looks almost identical
    # but substitutes a fixed delegator IRI rather than binding ?delegator
    # as a variable, and does not hit this; left as two clauses there since
    # there's nothing to fix.
    query = f"""PREFIX holon: <{HOLON}>
SELECT DISTINCT ?d ?delegator ?persona WHERE {{
  GRAPH <{holons_graph}> {{
    ?d a holon:Delegation ;
       holon:delegate <{delegate}> ;
       holon:delegator ?delegator ;
       holon:delegatedPersona ?persona ;
       holon:delegatedPermission {_literal(permission)} ;
       holon:validFrom ?from ;
       holon:validUntil ?until .
    {target_clause}
    ?delegator a holon:Person .
    {delegator_clause}
    FILTER (?from <= {current} && {current} < ?until)
    FILTER NOT EXISTS {{
      {{ ?d holon:revokedAt ?revoked }}
      UNION
      {{ ?delegator holon:status "inactive" }}
    }}
  }}
}} ORDER BY ?d"""
    rows = _bindings(await _run(query_fn, query))
    return [
        DelegationMatch(r["d"]["value"], r["delegator"]["value"], r["persona"]["value"])
        for r in rows
    ]


@dataclass(frozen=True)
class ReadDelegation:
    """The outcome of resolving an ``on_behalf_of`` read: whose scope to
    read, under which persona (short name), and exactly which of the
    delegator's private graphs the delegation covers."""

    delegator: str
    persona: str
    graphs: frozenset[str]


async def covered_graphs(
    query_fn: QueryFn,
    holons_graph: str,
    *,
    delegate: str,
    delegator: str,
    persona_iri: str,
    permission: str = "read",
    now: datetime | None = None,
) -> frozenset[str]:
    """Union of ``holon:delegatedGraph`` across every active delegation
    from ``delegator`` to ``delegate`` under ``persona_iri`` carrying
    ``permission``."""
    holons_graph, delegate, delegator, persona_iri = (
        safe_iri(holons_graph), safe_iri(delegate), safe_iri(delegator), safe_iri(persona_iri)
    )
    current = _now_expr(now)
    query = f"""PREFIX holon: <{HOLON}>
SELECT DISTINCT ?graph WHERE {{
  GRAPH <{holons_graph}> {{
    ?d a holon:Delegation ;
       holon:delegate <{delegate}> ;
       holon:delegator <{delegator}> ;
       holon:delegatedPersona <{persona_iri}> ;
       holon:delegatedPermission {_literal(permission)} ;
       holon:delegatedGraph ?graph ;
       holon:validFrom ?from ;
       holon:validUntil ?until .
    <{delegator}> a holon:Person .
    FILTER (?from <= {current} && {current} < ?until)
    FILTER NOT EXISTS {{ ?d holon:revokedAt ?revoked }}
    FILTER NOT EXISTS {{ <{delegator}> holon:status "inactive" }}
  }}
}}"""
    return frozenset(r["graph"]["value"] for r in _bindings(await _run(query_fn, query)))


async def resolve_read_delegation(
    query_fn: QueryFn,
    holons_graph: str,
    *,
    delegate: str,
    delegator: str,
    current_persona: str | None,
    persona_iri_of: Callable[[str], str],
    now: datetime | None = None,
) -> ReadDelegation:
    """Decide which persona and graphs an ``on_behalf_of`` read may use.

    ``current_persona`` is the delegate's own switched persona (short
    name) or None. If the delegator granted read under exactly one
    persona, that persona is used regardless of the delegate's own switch
    -- "read as my principal" means the principal's view. If they granted
    under several, the delegate's current persona must be one of them;
    otherwise :class:`DelegationAmbiguous` says which to choose.

    ``persona_iri_of`` maps a short persona name to its Persona IRI
    (``conn.persona_graph``), keeping this module free of ``Conn``.
    """
    matches = await find_delegation(
        query_fn, holons_graph, delegate=delegate, permission="read",
        delegator=delegator, now=now,
    )
    if not matches:
        raise DelegationRefused("no active read delegation from that person")
    names = sorted({m.persona.rsplit(":", 1)[-1] for m in matches})
    if current_persona in names:
        chosen = current_persona
    elif len(names) == 1:
        chosen = names[0]
    else:
        raise DelegationAmbiguous(
            f"read access was delegated under several personas {names}; "
            "switch_persona to one of them first"
        )
    graphs = await covered_graphs(
        query_fn, holons_graph, delegate=delegate, delegator=delegator,
        persona_iri=persona_iri_of(chosen), now=now,
    )
    if not graphs:  # cannot happen if find_delegation matched; fail closed anyway
        raise DelegationRefused("no active read delegation from that person")
    return ReadDelegation(delegator=delegator, persona=chosen, graphs=graphs)


async def list_delegations(
    query_fn: QueryFn,
    holons_graph: str,
    *,
    person: str | None = None,
    direction: str = "both",
    now: datetime | None = None,
) -> list[dict]:
    """Every delegation ``person`` gave and/or received, with a derived
    status (``active`` / ``expired`` / ``revoked`` / ``not_yet_valid``).
    ``person=None`` lists all of them (admin use)."""
    if direction not in ("given", "received", "both"):
        raise DelegationError("direction must be given, received or both")
    holons_graph = safe_iri(holons_graph)
    if person is not None:
        person = safe_iri(person)

    if person is None:
        who = ""
    elif direction == "given":
        who = f"FILTER(?delegator = <{person}>)"
    elif direction == "received":
        who = f"FILTER(?delegate = <{person}>)"
    else:
        who = f"FILTER(?delegator = <{person}> || ?delegate = <{person}>)"

    current = _now_expr(now)
    query = f"""PREFIX holon: <{HOLON}>
SELECT ?d ?delegator ?delegate ?persona ?from ?until ?revoked
       (GROUP_CONCAT(DISTINCT ?perm; separator=",") AS ?permissions)
       (GROUP_CONCAT(DISTINCT ?graph; separator=" ") AS ?graphs)
       (IF(BOUND(?revoked), "revoked",
          IF({current} < ?from, "not_yet_valid",
             IF({current} >= ?until, "expired", "active"))) AS ?status)
WHERE {{
  GRAPH <{holons_graph}> {{
    ?d a holon:Delegation ;
       holon:delegator ?delegator ;
       holon:delegate ?delegate ;
       holon:delegatedPersona ?persona ;
       holon:delegatedPermission ?perm ;
       holon:delegatedGraph ?graph ;
       holon:validFrom ?from ;
       holon:validUntil ?until .
    OPTIONAL {{ ?d holon:revokedAt ?revoked }}
    {who}
  }}
}}
GROUP BY ?d ?delegator ?delegate ?persona ?from ?until ?revoked
ORDER BY ?d"""
    # rdflib yields one all-unbound row for an empty GROUP BY input where
    # Fuseki yields none; skipping unbound rows makes both behave the same.
    rows = [r for r in _bindings(await _run(query_fn, query)) if "d" in r]
    return [
        {
            "delegation": r["d"]["value"],
            "delegator": r["delegator"]["value"],
            "delegate": r["delegate"]["value"],
            "persona": r["persona"]["value"],
            "permissions": sorted(r["permissions"]["value"].split(",")),
            "graphs": sorted(r["graphs"]["value"].split(" ")),
            "valid_from": r["from"]["value"],
            "valid_until": r["until"]["value"],
            "revoked_at": r.get("revoked", {}).get("value"),
            "status": r["status"]["value"],
        }
        for r in rows
    ]


# --------------------------------------------------------------------------
# Creation and revocation payloads
# --------------------------------------------------------------------------

def build_delegation(
    *,
    delegation_iri: str,
    delegator: str,
    delegate: str,
    persona: str,
    graphs: Iterable[str],
    permissions: Iterable[str],
    valid_from: datetime,
    valid_until: datetime,
    note: str | None = None,
) -> str:
    """Turtle for one Delegation. ``graphs`` are the delegator's own
    persona-user graph IRIs, already derived by the caller from ``Conn``
    -- never accepted from a request."""
    delegation_iri, delegator, delegate, persona = (
        safe_iri(delegation_iri), safe_iri(delegator), safe_iri(delegate), safe_iri(persona)
    )
    graph_list = sorted({safe_iri(g) for g in graphs})
    perm_list = sorted(set(permissions))
    bad = set(perm_list) - set(PERMISSIONS)
    if bad:
        raise DelegationError(f"unsupported permission(s) {sorted(bad)}")
    if note is not None and len(note) > 500:
        raise DelegationError("note is limited to 500 characters")
    lines = [
        f"@prefix holon: <{HOLON}> .",
        f"@prefix xsd:   <{XSD}> .",
        "@prefix rdfs:  <http://www.w3.org/2000/01/rdf-schema#> .",
        "",
        f"<{delegation_iri}> a holon:Delegation ;",
        f"    holon:delegator <{delegator}> ;",
        f"    holon:delegate <{delegate}> ;",
        f"    holon:delegatedPersona <{persona}> ;",
    ]
    lines += [f"    holon:delegatedGraph <{g}> ;" for g in graph_list]
    lines += [f"    holon:delegatedPermission {_literal(p)} ;" for p in perm_list]
    if note:
        lines.append(f"    rdfs:comment {_literal(note)} ;")
    lines += [
        f'    holon:validFrom "{_iso(valid_from)}"^^xsd:dateTime ;',
        f'    holon:validUntil "{_iso(valid_until)}"^^xsd:dateTime .',
    ]
    return "\n".join(lines) + "\n"


def revoke_update(holons_graph: str, delegation_iri: str, when: datetime) -> str:
    """SPARQL Update that stamps ``holon:revokedAt`` once. Idempotent: a
    second revoke finds the stamp already present and inserts nothing, so
    the shape's ``sh:maxCount 1`` on revokedAt can never be broken by a
    repeat call. The record is retained, not deleted -- same
    retraction-not-deletion stance as ``deactivate_person``."""
    holons_graph, delegation_iri = safe_iri(holons_graph), safe_iri(delegation_iri)
    return f"""PREFIX holon: <{HOLON}>
PREFIX xsd:   <{XSD}>
INSERT {{ GRAPH <{holons_graph}> {{ <{delegation_iri}> holon:revokedAt "{_iso(when)}"^^xsd:dateTime }} }}
WHERE  {{ GRAPH <{holons_graph}> {{
  <{delegation_iri}> a holon:Delegation .
  FILTER NOT EXISTS {{ <{delegation_iri}> holon:revokedAt ?already }}
}} }}"""


def revoke_all_update(holons_graph: str, person: str, when: datetime) -> str:
    """Revoke every still-live delegation ``person`` gave or received.

    Not yet called by ``deactivate_person``: ``find_delegation`` already
    ignores an inactive delegator's delegations, and an inactive delegate
    cannot authenticate at all, so wiring this into that route's single
    atomic update is belt-and-suspenders, deferred to keep this change out
    of ``routes/identity_admin.py``."""
    holons_graph, person = safe_iri(holons_graph), safe_iri(person)
    return f"""PREFIX holon: <{HOLON}>
PREFIX xsd:   <{XSD}>
INSERT {{ GRAPH <{holons_graph}> {{ ?d holon:revokedAt "{_iso(when)}"^^xsd:dateTime }} }}
WHERE  {{ GRAPH <{holons_graph}> {{
  ?d a holon:Delegation .
  {{ ?d holon:delegator <{person}> }} UNION {{ ?d holon:delegate <{person}> }}
  FILTER NOT EXISTS {{ ?d holon:revokedAt ?already }}
}} }}"""


def new_delegation_slug() -> str:
    return uuid.uuid4().hex[:16]


def default_window(
    lifetime: timedelta | None = None, *, now: datetime | None = None
) -> tuple[datetime, datetime]:
    start = now or datetime.now(timezone.utc)
    return start, start + (lifetime or DEFAULT_LIFETIME)
