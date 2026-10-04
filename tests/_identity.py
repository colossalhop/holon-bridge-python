"""Shared test doubles for the identity / ACL / Toolset layer.

Why this exists: ``require_animus`` made every ACL-gated route demand an
``x-holon-animus-id`` header that resolves to a Person, and ``acl.py`` /
``toolset.py`` / ``audit.py`` each issue their own SPARQL against the store on
every request. A route-level test whose stub only knows about its own registry
gets a 401 (or, worse, a catch-all that silently swallows those queries).

``IdentityStub`` answers that infrastructure traffic in one place. Subclasses
ask it first and fall through to their own domain handling:

    async def select(self, conn, query, *, default_graph=None):
        infra = self.infra_select(query)
        if infra is not None:
            return infra
        ...domain queries...

The substring routing is the technique ``test_named_projections.py`` already
used; this lifts it out so the other route tests can share it.

Knobs (set on the stub instance):

``admin``                  caller holds the admin role (bypasses grant checks)
``write_grant``            caller holds ``holon:grantsWrite`` (default True)
``replace_grant``          caller holds ``holon:grantsReplace`` (default True)
``restricted_tools``       IRIs that belong to some ``holon:Toolset``
``persona_reachable_tools``  restricted IRIs the active persona can reach

With the defaults the caller is an ordinary non-admin founder who may append
and replace, and nothing is Toolset-restricted -- the posture most route tests
want. A test of a denial path flips one knob.

A stub that wants a ``executed`` list of "what the backend ran for the user"
should record only its own domain queries and constructs; do not record
whatever ``infra_select`` declined, because the bridge issues incidental reads
on every request and a catch-all recorder turns those into test noise.
"""

from __future__ import annotations

from typing import Any

TOKEN = "test-token"
EXTERNAL_ID = "kurtcagle"
PERSON_IRI = "urn:ds:person:kurt"
PERSON_LABEL = "Kurt"

ANIMUS_HEADERS = {"x-holon-animus-id": EXTERNAL_ID}


def row(**cells: str) -> dict:
    return {key: {"value": value} for key, value in cells.items()}


def auth(token: str = TOKEN) -> dict[str, str]:
    """Bearer token plus the animus header ``require_animus`` insists on."""
    return {"Authorization": f"Bearer {token}", **ANIMUS_HEADERS}


class IdentityStub:
    def __init__(self) -> None:
        self.admin = False
        self.write_grant = True
        self.replace_grant = True
        self.restricted_tools: set[str] = set()
        self.persona_reachable_tools: set[str] = set()

    def infra_select(self, query: str) -> dict[str, Any] | None:
        """Answer identity, ACL, Toolset, audit and parameter-schema queries.

        Returns ``None`` for anything else so the caller can handle its own
        domain queries. Order matters and mirrors the original stub in
        ``test_named_projections.py``.
        """
        if "hasExternalIdentity" in query:
            return {"results": {"bindings": [row(person=PERSON_IRI, label=PERSON_LABEL)]}}
        if "memberOfTeam" in query:
            return {"results": {"bindings": []}}
        if "role:admin" in query:
            return {"boolean": self.admin}
        if "grantsWrite" in query:
            return {"boolean": self.admin or self.write_grant}
        if "grantsReplace" in query:
            return {"boolean": self.admin or self.replace_grant}
        if "deniedTo" in query:
            return {"boolean": False}
        if "holon:hasToolset" in query:
            return {
                "results": {"bindings": [row(tool=t) for t in self.persona_reachable_tools]}
            }
        if "anyToolset" in query:
            return {"results": {"bindings": [row(tool=t) for t in self.restricted_tools]}}
        # Audit middleware reads its config row on every request; no row means
        # "not suspended, default level".
        if "audit:config" in query:
            return {"results": {"bindings": []}}
        # Parameter metadata stored as a SHACL NodeShape. The stubs that care
        # about parameters serve the older ``?link`` shape instead, so this
        # form is simply empty.
        if "sh:NodeShape" in query and "sh:targetNode" in query:
            return {"results": {"bindings": []}}
        return None
