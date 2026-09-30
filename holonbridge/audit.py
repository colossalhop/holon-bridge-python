"""Audit log: who did what through the bridge, and what was refused.

Why this exists (context for anyone opening this cold): a write that goes
through ``write_turtle_to_graph`` (or ``/sparql/update``, ``/graph-op``,
``DELETE /graph``, the admin routes ...) leaves no trace of *who* made it,
under what authority, or that it happened at all -- an admin write, a
delegated write and the owner's own write are indistinguishable in the
stored data. Refusals are invisible too. ``holon:AssertionEvent`` (see
``routes/events.py``) is not the answer: those are *domain* events, submitted
by callers as content. An audit entry is a record about the bridge's own
behaviour, written by the bridge, and it must not share a graph or a
vocabulary with domain events.

Design, briefly:

- One ASGI middleware (:class:`AuditMiddleware`) sees every request and its
  outcome, so there is no per-route hook to forget. It records every
  mutation, every 401/403, and -- at the ``standard`` level -- "security
  reads" (a read under ``act_as``, ``on_behalf_of``, or of another
  person's private persona graph).
- Handlers that know more (the target graph, what authorised the write, a
  payload digest) call :func:`annotate`; the middleware folds it into the
  entry. Annotation is a no-op outside a request, so nothing else changes.
- Entries go to a graph of their own, ``urn:{dataset}:audit`` (derived from
  the holons graph the same way ``acl._admin_role`` derives the admin
  role). The bridge writes it through its own client; **nobody** can write
  it through the API, admin included (``acl.check_write``/``check_replace``
  refuse it before the admin bypass), and only admins can read it
  (``acl.authorize_query`` for SPARQL, ``GET /audit`` for the listing).
- Payloads are never copied, only hashed and sized: copying would dual-write
  state and would leak private persona-graph content into a log others may
  read.

What this is not: event sourcing. Writes are state-first, so a graph cannot
be rebuilt from its audit entries.

Failure posture (a deliberate deviation worth stating): a failure to write
an entry is logged loudly and never fails the request. The middleware runs
after the handler, so it cannot make the *data* write conditional on the
*audit* write. Failing closed for identity/delegation/admin changes would
need an intent entry written before the operation; that is not built.

Levels, per dataset (``off`` < ``denials`` < ``mutations`` < ``standard``),
set with ``POST /audit/level`` (stored in the dataset's ``meta`` graph,
cached for :data:`_CONFIG_TTL` seconds) or, as the process default, the
``HOLONBRIDGE_AUDIT_LEVEL`` environment variable. The default is
``standard``.
"""

from __future__ import annotations

import asyncio
import contextvars
import hashlib
import logging
import os
import re
import time
import uuid
from datetime import datetime, timezone
from typing import Any, Iterable

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request

from . import delegation as dg

logger = logging.getLogger(__name__)

HB = "https://w3id.org/holonbridge/"
XSD = "http://www.w3.org/2001/XMLSchema#"

#: Least to most verbose. See the module docstring.
LEVELS: tuple[str, ...] = ("off", "denials", "mutations", "standard")
DEFAULT_LEVEL = "standard"

#: How long a dataset's configured level is cached, in seconds.
_CONFIG_TTL = 30.0

#: POST routes that only read, and so are not mutations.
READ_ONLY_POSTS: frozenset[str] = frozenset(
    {"/sparql/select", "/sparql/construct", "/validate"}
)

#: Never recorded (unless denied): the audit reader itself, and liveness.
_UNRECORDED_PREFIXES: tuple[str, ...] = ("/audit", "/health")

_MUTATING_METHODS = frozenset({"POST", "PUT", "PATCH", "DELETE"})
_USER_GRAPH = re.compile(r":persona:[^:]+:user:([^:]+):")


# --------------------------------------------------------------------------
# Naming
# --------------------------------------------------------------------------

def _swap(holons_graph: str, tail: str) -> str:
    suffix = ":holons"
    if not holons_graph.endswith(suffix):
        raise ValueError(f"expected holons_graph to end with {suffix!r}, got {holons_graph!r}")
    return holons_graph[: -len(suffix)] + tail


def audit_graph(holons_graph: str) -> str:
    """``urn:example:holons`` -> ``urn:example:audit`` (bank-scoped form
    follows for free), derived the same way ``acl._admin_role`` and
    ``acl._scratch_area`` derive their org-tier resources."""
    return _swap(holons_graph, ":audit")


def config_iri(holons_graph: str) -> str:
    """The resource whose ``hb:auditLevel`` in the ``meta`` graph configures
    this dataset."""
    return _swap(holons_graph, ":audit:config")


def is_audit_graph(target: str, holons_graph: str) -> bool:
    return target == audit_graph(holons_graph)


# --------------------------------------------------------------------------
# Per-request annotation
# --------------------------------------------------------------------------

_current: contextvars.ContextVar[dict[str, Any] | None] = contextvars.ContextVar(
    "holonbridge_audit", default=None
)


def annotate(**fields: Any) -> None:
    """Attach detail to the current request's audit entry. Recognised keys:
    ``graphs`` (list of IRIs), ``write_mode``, ``authorised_by``,
    ``authorised_reason``, ``payload_hash``, ``payload_bytes``,
    ``security_read`` (bool), ``reason``. ``None`` values are ignored, and
    this is a no-op outside a request, so callers never need to check."""
    ctx = _current.get()
    if ctx is None:
        return
    for key, value in fields.items():
        if value is not None:
            ctx[key] = value


def payload_digest(text: str) -> tuple[str, int]:
    """``("sha256:<hex>", byte_length)`` for a payload."""
    raw = text.encode("utf-8")
    return "sha256:" + hashlib.sha256(raw).hexdigest(), len(raw)


def foreign_user_graphs(graph_refs: Iterable[str], caller_slug: str) -> list[str]:
    """The persona-user graphs among ``graph_refs`` that belong to somebody
    other than the caller. ``public`` is the persona's shared graph, not a
    person's, so it is not foreign."""
    found = []
    for graph in graph_refs:
        match = _USER_GRAPH.search(graph)
        if match and match.group(1) not in ("public", caller_slug):
            found.append(graph)
    return sorted(found)


# --------------------------------------------------------------------------
# Levels
# --------------------------------------------------------------------------

def default_level() -> str:
    value = os.environ.get("HOLONBRIDGE_AUDIT_LEVEL", DEFAULT_LEVEL).strip().lower()
    return value if value in LEVELS else DEFAULT_LEVEL


_level_cache: dict[tuple[str, str], tuple[float, str]] = {}


def forget_level(conn) -> None:
    _level_cache.pop((conn.bank_name, conn.dataset), None)


async def level_for(client, conn) -> str:
    """The audit level for ``conn``'s dataset: its ``hb:auditLevel`` in the
    ``meta`` graph if set, else the process default. Cached briefly; any
    failure to read it falls back to the default rather than raising."""
    key = (conn.bank_name, conn.dataset)
    hit = _level_cache.get(key)
    now = time.monotonic()
    if hit and now - hit[0] < _CONFIG_TTL:
        return hit[1]

    level = default_level()
    try:
        result = await client.select(
            conn,
            f"""PREFIX hb: <{HB}>
SELECT ?l WHERE {{ GRAPH <{conn.graph("meta")}> {{ <{config_iri(conn.holons_graph)}> hb:auditLevel ?l }} }} LIMIT 1""",
        )
        rows = result.get("results", {}).get("bindings", [])
        if rows and rows[0]["l"]["value"] in LEVELS:
            level = rows[0]["l"]["value"]
    except Exception as exc:  # noqa: BLE001 - never let config lookup break a request
        logger.warning("audit: could not read level for %s: %s", conn.dataset, exc)
    _level_cache[key] = (now, level)
    return level


async def set_level(client, conn, level: str) -> None:
    """Persist ``level`` for this dataset. Raises ``ValueError`` if it is not
    one of :data:`LEVELS`. One atomic request."""
    if level not in LEVELS:
        raise ValueError(f"level must be one of {list(LEVELS)}")
    cfg, meta = config_iri(conn.holons_graph), conn.graph("meta")
    await client.update(
        conn,
        f"""PREFIX hb: <{HB}>
DELETE WHERE {{ GRAPH <{meta}> {{ <{cfg}> hb:auditLevel ?old }} }} ;
INSERT DATA {{ GRAPH <{meta}> {{ <{cfg}> hb:auditLevel {dg._literal(level)} }} }}""",
    )
    forget_level(conn)


# --------------------------------------------------------------------------
# Classification
# --------------------------------------------------------------------------

def is_mutation(method: str, route_path: str) -> bool:
    return method.upper() in _MUTATING_METHODS and route_path not in READ_ONLY_POSTS


def outcome_for(status_code: int) -> str:
    if status_code in (401, 403):
        return "denied"
    if status_code >= 500:
        return "error"
    return "allowed"


def should_record(level: str, outcome: str, mutation: bool, security_read: bool) -> bool:
    """The whole policy in one place. ``off`` records nothing; ``denials``
    only refusals; ``mutations`` refusals and every mutation (including
    failed ones); ``standard`` adds security reads."""
    if level == "off" or level not in LEVELS:
        return False
    if outcome == "denied":
        return True
    if level == "denials":
        return False
    if mutation:
        return True
    return level == "standard" and security_read and outcome == "allowed"


# --------------------------------------------------------------------------
# Entries
# --------------------------------------------------------------------------

def _iso_micro(when: datetime) -> str:
    """xsd:dateTime with microseconds, so entries made within the same
    second still order correctly (``delegation._iso`` truncates to seconds,
    which is right for validity windows but not for a log)."""
    return when.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")


def _lit(value: object) -> str:
    return dg._literal(str(value)[:500])


def _iri(value: str | None) -> str | None:
    if not value:
        return None
    try:
        return dg.safe_iri(value)
    except dg.DelegationError:
        return None


def new_entry_iri(holons_graph: str) -> str:
    return f"{audit_graph(holons_graph)}:entry:{uuid.uuid4().hex}"


def build_entry(entry: dict[str, Any]) -> str:
    """Turtle for one audit entry. Everything that came from a request is
    either validated as an IRI (:func:`delegation.safe_iri`) or written as a
    length-capped, escaped literal, so a hostile path or graph name cannot
    change the structure of the statement."""
    props: list[str] = [
        f'hb:at "{_iso_micro(entry["at"])}"^^xsd:dateTime',
        f"hb:outcome {_lit(entry['outcome'])}",
        f"hb:operation {_lit(entry['operation'])}",
        f"hb:method {_lit(entry['method'])}",
        f"hb:path {_lit(entry['path'])}",
        f"hb:status {int(entry['status'])}",
    ]
    actor, real = _iri(entry.get("actor")), _iri(entry.get("real_actor"))
    if actor:
        props.append(f"hb:actor <{actor}>")
    if real and real != actor:
        props.append(f"hb:realActor <{real}>")
    if entry.get("acting_as"):
        props.append('hb:actingAs "true"^^xsd:boolean')
    for graph in entry.get("graphs") or []:
        iri = _iri(graph)
        props.append(f"hb:targetGraph <{iri}>" if iri else f"hb:targetGraphText {_lit(graph)}")
    if entry.get("write_mode"):
        props.append(f"hb:writeMode {_lit(entry['write_mode'])}")
    by = _iri(entry.get("authorised_by"))
    if by:
        props.append(f"hb:authorisedBy <{by}>")
    if entry.get("authorised_reason"):
        props.append(f"hb:authorisedReason {_lit(entry['authorised_reason'])}")
    if entry.get("payload_hash"):
        props.append(f"hb:payloadHash {_lit(entry['payload_hash'])}")
    if entry.get("payload_bytes") is not None:
        props.append(f"hb:payloadBytes {int(entry['payload_bytes'])}")
    if entry.get("security_read"):
        props.append('hb:securityRead "true"^^xsd:boolean')
    if entry.get("reason"):
        props.append(f"hb:reason {_lit(entry['reason'])}")

    return (
        f"@prefix hb:  <{HB}> .\n@prefix xsd: <{XSD}> .\n\n"
        f"<{entry['iri']}> a hb:AuditEntry ;\n    "
        + " ;\n    ".join(props)
        + " .\n"
    )


async def record(client, conn, entry: dict[str, Any]) -> bool:
    """Write one entry to the audit graph through the bridge's own client
    (bypassing the API's ACL, which refuses this graph to everyone). Returns
    False and logs, rather than raising, on any failure."""
    try:
        entry.setdefault("iri", new_entry_iri(conn.holons_graph))
        await asyncio.wait_for(
            client.post_graph(conn, audit_graph(conn.holons_graph), build_entry(entry)),
            timeout=5.0,
        )
        return True
    except Exception as exc:  # noqa: BLE001 - see the module docstring's failure posture
        logger.warning("audit: FAILED to record %s: %s", entry.get("operation"), exc)
        return False


# --------------------------------------------------------------------------
# Middleware
# --------------------------------------------------------------------------

class AuditMiddleware(BaseHTTPMiddleware):
    """Records requests per the policy in :func:`should_record`.

    Needs ``request.state.conn`` and (when there is one) ``request.state.animus``,
    which ``deps.require_conn`` / ``deps.require_animus`` set. A request that
    never reached ``require_conn`` (a 404 for an unknown path, say) has no
    dataset to record against and is skipped.
    """

    async def dispatch(self, request: Request, call_next):
        ctx: dict[str, Any] = {}
        token = _current.set(ctx)
        status_code = 500
        try:
            response = await call_next(request)
            status_code = response.status_code
            return response
        finally:
            _current.reset(token)
            await self._maybe_record(request, status_code, ctx)

    async def _maybe_record(self, request: Request, status_code: int, ctx: dict[str, Any]) -> None:
        try:
            conn = getattr(request.state, "conn", None)
            if conn is None:
                return
            route = request.scope.get("route")
            template = getattr(route, "path", None) or request.url.path
            outcome = outcome_for(status_code)
            mutation = is_mutation(request.method, template)
            if template.startswith(_UNRECORDED_PREFIXES) and outcome != "denied" and not mutation:
                return

            animus = getattr(request.state, "animus", None)
            acting_as = bool(getattr(animus, "acting_as", False))
            security_read = (
                bool(ctx.get("security_read"))
                or acting_as
                or (template == "/holon" and "on_behalf_of" in request.query_params)
            )

            client = request.app.state.fuseki
            level = await level_for(client, conn)
            # A change to the audit configuration is always recorded, whatever
            # level it sets: otherwise turning audit off would erase the
            # record of turning it off.
            forced = mutation and template.startswith("/audit") and outcome == "allowed"
            if not forced and not should_record(level, outcome, mutation, security_read):
                return

            entry: dict[str, Any] = {
                "at": datetime.now(timezone.utc),
                "outcome": outcome,
                "operation": f"{request.method} {template}",
                "method": request.method,
                "path": request.url.path,
                "status": status_code,
                "actor": getattr(animus, "person", None),
                "real_actor": getattr(animus, "real_person", None),
                "acting_as": acting_as,
                "security_read": (not mutation) and security_read,
            }
            entry.update({k: v for k, v in ctx.items() if k != "security_read"})
            await record(client, conn, entry)
        except Exception as exc:  # noqa: BLE001
            logger.warning("audit: middleware error: %s", exc)
