"""Named-query registry loading and parameter binding.

The bridge understands two vocabularies that describe the same kind of thing,
and this module is the single place that difference is reconciled.

**Why there are two.** ``hb:`` (``https://w3id.org/holonbridge/``) is the
bridge's own original scheme. ``hquery:`` is the HGA Named Query
Specification. Both register a query, a body, and some parameters.

**Why the difference survives loading.** ``hb:`` bodies carry ``{{placeholder}}``
tokens and want string substitution. ``hquery:`` bodies carry ordinary SPARQL
variables and want them bound. Running an ``hquery:`` query through
``{{...}}`` substitution matches nothing, so the query executes
unparameterised and returns every row — a wrong answer with no error. Every
loaded query therefore carries its vocabulary, and binding dispatches on it.

**Why binding appends VALUES.** SPARQL's grammar places ``ValuesClause`` after
the entire query form, past ORDER BY and LIMIT. Appending therefore needs no
parsing of the body and cannot corrupt a well-formed query. Unsupplied
parameters stay unbound, which preserves the "omit for all" behaviour HGA
queries rely on. Note the corollary, confirmed live 2026-09-22 against
Person_age's asOfDate and Player_age-eligibility's team/minimumAge: a
parameter used ONLY inside a BIND/FILTER (never a real triple-pattern
variable) can never actually be affected by this append-after-everything
join, no matter how the query is phrased -- SPARQL joins the trailing VALUES
in only after the whole WHERE clause (including every BIND/FILTER in it) has
already evaluated. Such a parameter is accepted (shows in a run's "bound"
list) and silently does nothing. There is no hquery:-side fix for this; the
working alternative is an hb:-vocabulary query, where {{placeholder}}
substitution happens as text replacement before parsing and so isn't
subject to the timing issue at all (see Person_age_as_of in the bridgerton
dataset for a worked example) -- at the cost of losing hquery:'s "omit for
all" behaviour, since an unresolved {{placeholder}} with no default fails
the call outright rather than binding nothing.

**Class matching is by local name.** The loader finds anything typed
``*NamedQuery`` in the registry graph and derives the vocabulary from that
type's namespace, rather than hardcoding predicate IRIs for each scheme.
Properties are matched by local name too. This tolerates the two schemes
differing in spelling and survives a third being added. The trade is that a
different vocabulary also called ``NamedQuery`` would be picked up; see
:data:`QUERY_CLASS_SUFFIX` to tighten it.

**CHANGED 2026-09-23: author-supplied SHACL parameter shapes.** A query's
``Parameter`` list no longer has to come from the flat ``hquery:parameter``/
``hb:parameter`` blank nodes alone. If a ``sh:NodeShape`` exists in the same
registry graph with ``sh:targetNode`` pointing at the query's own IRI, its
``sh:property`` list is parsed instead -- wholesale, not merged -- and wins
over the flat declarations when both exist for the same query. This is the
extension point ``params.shacl_shape_for_query``'s own comment already
flagged as intended-but-not-built: richer constraint vocabulary (``sh:in``,
``sh:pattern``, ``sh:minInclusive``/``sh:maxInclusive``) than the flat
five-field ``Parameter`` shape can express, using real SHACL rather than a
bespoke parallel structure. Nothing about the flat-declaration path changed;
a query with no author-supplied shape loads exactly as it always has. See
:func:`_parse_author_shape_params`.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any, Mapping

from .conn import Conn
from .fuseki import FusekiClient, FusekiError
from .rdfutil import collect, local_name, namespace, pick
from .params import (
    Parameter,
    ParameterError,
    placeholders,
    render_term,
    substitute_params,
    values_clause,
)
from .sparql_kind import accepts_values_clause, form

log = logging.getLogger("holonbridge.named_queries")

HB_NAMESPACE = "https://w3id.org/holonbridge/"

#: Local name that marks a registered query. Change to a full IRI match here
#: if the loose matching described in the module docstring becomes a problem.
QUERY_CLASS_SUFFIX = "NamedQuery"

# Property local names, in precedence order. First match wins.
_QUERY_FIELDS: dict[str, tuple[str, ...]] = {
    "id": ("id", "identifier"),
    "sparql": ("sparql", "queryText", "queryString", "query", "body"),
    "label": ("label", "title"),
    "description": ("description", "comment"),
    "query_type": ("queryType", "form"),
    "target_graph": ("targetGraph", "defaultGraph", "graph"),
}
_PARAM_LINKS = ("parameter", "parameters", "hasParameter", "param")
# "parameterName"/"parameterDatatype"/"parameterDescription" added
# 2026-09-22: the holon-named-queries skill documents these as the
# canonical hquery:Parameter property names, but they were missing from
# this table entirely. rdfutil.pick() is exact local-name equality, so
# pick(props, _PARAM_FIELDS["name"]) returned None for any Parameter
# authored per the skill's own documented shape -- and in the loader's
# loop below, that isn't just a missing name, `if not name: continue`
# drops the whole Parameter node. A query loaded with a real SPARQL body
# and correctly-authored parameter metadata still came back with
# parameters: [], and run_named_query rejected any caller-supplied
# parameter as undeclared. Confirmed live 2026-09-22 against Person_age
# and Player_age-eligibility in the bridgerton dataset. Purely additive:
# nothing already relying on the shorter aliases changes behaviour.
_PARAM_FIELDS: dict[str, tuple[str, ...]] = {
    "name": ("name", "varName", "variable", "paramName", "parameterName"),
    "datatype": ("datatype", "dataType", "kind", "range", "parameterDatatype"),
    "description": ("description", "comment", "parameterDescription"),
    "required": ("required", "isRequired"),
    "default": ("default", "defaultValue"),
}

# Field local names for an author-supplied SHACL sh:property node. Separate
# table from _PARAM_FIELDS above (different vocabulary, real SHACL this
# time, not the bespoke hb:/hquery: predicates) -- sh:in is handled outside
# this table entirely, since it's a SHACL list rather than a plain value and
# needs its own list-traversal query (_author_shape_in_query).
_SHAPE_PARAM_FIELDS: dict[str, tuple[str, ...]] = {
    "path": ("path",),
    "nodeKind": ("nodeKind",),
    "datatype": ("datatype",),
    "description": ("description", "comment"),
    "default": ("defaultValue",),
    "minCount": ("minCount",),
    "pattern": ("pattern",),
    "minInclusive": ("minInclusive",),
    "maxInclusive": ("maxInclusive",),
}


@dataclass
class NamedQuery:
    """A query as loaded from the registry."""

    id: str
    iri: str
    sparql: str
    vocabulary: str  # "hb" or "hquery"
    label: str = ""
    description: str = ""
    query_type: str = "SELECT"
    target_graph: str | None = None
    params: list[Parameter] = field(default_factory=list)
    source: str = "rdf"

    @property
    def declared(self) -> dict[str, Parameter]:
        return {p.name: p for p in self.params}

    def summary(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "iri": self.iri,
            "label": self.label or self.id,
            "description": self.description,
            "queryType": self.query_type,
            "vocabulary": self.vocabulary,
            "targetGraph": self.target_graph,
            "parameters": [
                {
                    "name": p.name,
                    "datatype": p.datatype,
                    "required": p.required,
                    "description": p.description,
                    "default": p.default,
                    "allowedValues": list(p.allowed_values)
                    if p.allowed_values
                    else None,
                    "pattern": p.pattern,
                    "minInclusive": p.min_inclusive,
                    "maxInclusive": p.max_inclusive,
                }
                for p in self.params
            ],
        }

    def detail(self) -> dict[str, Any]:
        return {**self.summary(), "sparql": self.sparql}


@dataclass
class BoundQuery:
    sparql: str
    bound: list[str]
    missing: list[str]
    unused: list[str]
    strategy: str


@dataclass
class LoadResult:
    queries: list[NamedQuery]
    warnings: list[str] = field(default_factory=list)

    def by_id(self, query_id: str) -> NamedQuery | None:
        for query in self.queries:
            if query.id == query_id:
                return query
        return None


# --- loading ------------------------------------------------------------------


def _queries_query(graph: str) -> str:
    return f"""SELECT ?q ?type ?p ?o
WHERE {{
  GRAPH <{graph}> {{
    ?q a ?type .
    FILTER( STRENDS(STR(?type), "{QUERY_CLASS_SUFFIX}") )
    ?q ?p ?o .
  }}
}}"""


def _params_query(graph: str) -> str:
    links = " || ".join(f'STRENDS(STR(?link), "{name}")' for name in _PARAM_LINKS)
    return f"""SELECT ?q ?param ?p ?o
WHERE {{
  GRAPH <{graph}> {{
    ?q a ?type .
    FILTER( STRENDS(STR(?type), "{QUERY_CLASS_SUFFIX}") )
    ?q ?link ?param .
    FILTER( {links} )
    ?param ?p ?o .
  }}
}}"""


def _author_shapes_query(graph: str) -> str:
    """Every field of every sh:property node belonging to an author-supplied
    shape that targets a registered query by IRI (``sh:NodeShape
    sh:targetNode <query IRI>``). Deliberately the same ``?q ?param ?p ?o``
    row shape ``_params_query`` produces, so the exact same
    ``collect()``/owner-map pattern used for the flat declarations below
    works unchanged here against a different query and a different (real
    SHACL, not hb:/hquery:) predicate vocabulary.
    """
    return f"""PREFIX sh: <http://www.w3.org/ns/shacl#>
SELECT ?q ?param ?p ?o
WHERE {{
  GRAPH <{graph}> {{
    ?shape a sh:NodeShape ;
           sh:targetNode ?q ;
           sh:property ?param .
    ?param ?p ?o .
  }}
}}"""


def _author_shape_in_query(graph: str) -> str:
    """``sh:in``'s value is a SHACL list, not a plain literal/IRI, so it
    can't fit the flat ``?param ?p ?o`` shape ``_author_shapes_query`` uses
    for every other field on a ``sh:property`` node -- this walks the list
    (``rdf:rest*/rdf:first``) separately.
    """
    return f"""PREFIX sh: <http://www.w3.org/ns/shacl#>
PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
SELECT ?param ?val
WHERE {{
  GRAPH <{graph}> {{
    ?shape a sh:NodeShape ; sh:targetNode ?q ; sh:property ?param .
    ?param sh:in ?list .
    ?list rdf:rest*/rdf:first ?val .
  }}
}}"""


def _parse_author_shape_params(
    shape_rows: list[dict], in_rows: list[dict]
) -> dict[str, list[Parameter]]:
    """Parameters declared via an author-supplied SHACL shape -- preferred
    over the flat hb:/hquery: declarations for a given query when both
    exist, per this module's docstring. Uses the exact ``sh:path`` ==
    ``_PARAM_PATH_NS + name`` convention ``params.shacl_shape_for_query``
    already generates for the derived (read-only) schema view, so a shape
    an author hand-extends is speaking the same language the bridge would
    have derived on its own, not a second, incompatible convention.

    ``sh:nodeKind sh:IRI`` takes precedence over ``sh:datatype`` for a given
    property, matching how ``params.is_iri_datatype``/
    ``shacl_shape_for_query`` already treat IRI-vs-literal as mutually
    exclusive elsewhere in this codebase.
    """
    props = collect(shape_rows, "param")
    owner = {r["param"]["value"]: r["q"]["value"] for r in shape_rows}

    allowed: dict[str, list[str]] = {}
    for row in in_rows:
        allowed.setdefault(row["param"]["value"], []).append(row["val"]["value"])

    by_query: dict[str, list[Parameter]] = {}
    for node, fields in props.items():
        path = pick(fields, _SHAPE_PARAM_FIELDS["path"])
        if not path:
            continue
        name = local_name(path)

        node_kind = pick(fields, _SHAPE_PARAM_FIELDS["nodeKind"])
        datatype = (
            "IRI"
            if node_kind and local_name(node_kind) == "IRI"
            else pick(fields, _SHAPE_PARAM_FIELDS["datatype"])
        )
        min_count = pick(fields, _SHAPE_PARAM_FIELDS["minCount"])
        min_inc = pick(fields, _SHAPE_PARAM_FIELDS["minInclusive"])
        max_inc = pick(fields, _SHAPE_PARAM_FIELDS["maxInclusive"])
        in_values = allowed.get(node)

        by_query.setdefault(owner[node], []).append(
            Parameter(
                name=name,
                datatype=datatype,
                description=pick(fields, _SHAPE_PARAM_FIELDS["description"]) or "",
                required=(min_count or "0") not in {"0", ""},
                default=pick(fields, _SHAPE_PARAM_FIELDS["default"]),
                allowed_values=tuple(in_values) if in_values else None,
                min_inclusive=float(min_inc) if min_inc is not None else None,
                max_inclusive=float(max_inc) if max_inc is not None else None,
                pattern=pick(fields, _SHAPE_PARAM_FIELDS["pattern"]),
            )
        )
    return by_query


async def load_named_queries(
    client: FusekiClient, conn: Conn, *, graph: str | None = None
) -> LoadResult:
    """Load every registered query from ``urn:{dataset}:named-queries``.

    Degrades rather than failing: an unreachable registry yields an empty
    result with a warning, and a query whose parameter metadata will not load
    is still returned, because it remains runnable unbound.
    """
    registry = graph or conn.graph("named-queries")
    warnings: list[str] = []

    try:
        rows = (await client.select(conn, _queries_query(registry)))["results"]["bindings"]
    except (FusekiError, KeyError) as exc:
        message = f"named-query load from <{registry}> failed: {exc}"
        log.warning(message)
        return LoadResult(queries=[], warnings=[message])

    types: dict[str, str] = {}
    for row in rows:
        types.setdefault(row["q"]["value"], row["type"]["value"])
    grouped = collect(rows, "q")

    params_by_query: dict[str, list[Parameter]] = {}
    try:
        param_rows = (await client.select(conn, _params_query(registry)))["results"][
            "bindings"
        ]
        param_props = collect(param_rows, "param")
        owner = {r["param"]["value"]: r["q"]["value"] for r in param_rows}
        for node, props in param_props.items():
            name = pick(props, _PARAM_FIELDS["name"])
            if not name:
                continue
            required = (pick(props, _PARAM_FIELDS["required"]) or "").lower() in {
                "true",
                "1",
            }
            params_by_query.setdefault(owner[node], []).append(
                Parameter(
                    name=name,
                    datatype=pick(props, _PARAM_FIELDS["datatype"]),
                    description=pick(props, _PARAM_FIELDS["description"]) or "",
                    required=required,
                    default=pick(props, _PARAM_FIELDS["default"]),
                )
            )
    except (FusekiError, KeyError) as exc:
        message = f"parameter metadata load failed: {exc}; queries remain runnable unbound"
        log.warning(message)
        warnings.append(message)

    author_params_by_query: dict[str, list[Parameter]] = {}
    try:
        shape_rows = (await client.select(conn, _author_shapes_query(registry)))[
            "results"
        ]["bindings"]
        in_rows = (await client.select(conn, _author_shape_in_query(registry)))[
            "results"
        ]["bindings"]
        author_params_by_query = _parse_author_shape_params(shape_rows, in_rows)
    except (FusekiError, KeyError) as exc:
        message = (
            f"author-shape parameter load failed: {exc}; "
            "falling back to flat declarations where present"
        )
        log.warning(message)
        warnings.append(message)

    queries: list[NamedQuery] = []
    seen: dict[str, NamedQuery] = {}

    for iri, props in grouped.items():
        sparql = pick(props, _QUERY_FIELDS["sparql"])
        if not sparql:
            warnings.append(f"<{iri}> has no query body; skipped")
            continue

        type_iri = types.get(iri, "")
        vocabulary = "hb" if "holonbridge" in namespace(type_iri) else "hquery"

        # hquery: queries carry no explicit id — the IRI's local name is the id.
        query_id = pick(props, _QUERY_FIELDS["id"]) or local_name(iri)

        declared_type = (pick(props, _QUERY_FIELDS["query_type"]) or "").upper()
        # An author-supplied shape wins wholesale over the flat declarations
        # for this query when one exists -- not merged, per this module's
        # docstring, so there's exactly one place to look to know what a
        # given query actually accepts.
        resolved_params = author_params_by_query.get(iri) or params_by_query.get(
            iri, []
        )
        query = NamedQuery(
            id=query_id,
            iri=iri,
            sparql=sparql,
            vocabulary=vocabulary,
            label=pick(props, _QUERY_FIELDS["label"]) or query_id,
            description=pick(props, _QUERY_FIELDS["description"]) or "",
            query_type=declared_type or form(sparql),
            target_graph=pick(props, _QUERY_FIELDS["target_graph"]),
            params=sorted(resolved_params, key=lambda p: p.name),
        )

        if query_id in seen:
            other = seen[query_id]
            # Canonical hquery: wins; the shadowed definition is reported, not
            # dropped silently, because a duplicate id is a registry bug.
            keep, drop = (
                (query, other) if query.vocabulary == "hquery" else (other, query)
            )
            warnings.append(
                f"id {query_id!r} is registered twice: keeping the {keep.vocabulary}: "
                f"definition <{keep.iri}>, shadowing <{drop.iri}>"
            )
            queries = [q for q in queries if q.id != query_id]
            queries.append(keep)
            seen[query_id] = keep
            continue

        seen[query_id] = query
        queries.append(query)

    queries.sort(key=lambda q: q.id)
    return LoadResult(queries=queries, warnings=warnings)


# --- binding ------------------------------------------------------------------


def apply_query_params(
    query: NamedQuery, supplied: Mapping[str, Any] | None
) -> BoundQuery:
    """Bind caller-supplied parameters, dispatching on vocabulary."""
    values = {k: v for k, v in (supplied or {}).items() if v is not None}

    if query.vocabulary != "hquery":
        return _bind_placeholders(query, values)
    return _bind_values(query, values)


def _bind_placeholders(query: NamedQuery, supplied: Mapping[str, Any]) -> BoundQuery:
    declared = query.declared
    result = substitute_params(query.sparql, supplied, declared)
    known = set(placeholders(query.sparql)) | set(declared)
    unused = sorted(name for name in supplied if name not in known)
    return BoundQuery(
        sparql=result.sparql,
        bound=result.substituted,
        missing=result.missing,
        unused=unused,
        strategy="placeholder",
    )


def _bind_values(query: NamedQuery, supplied: Mapping[str, Any]) -> BoundQuery:
    declared = query.declared

    # An undeclared VALUES variable does not error — it quietly constrains
    # nothing. Reject the typo rather than running a query nobody meant.
    undeclared = sorted(name for name in supplied if name not in declared)
    if undeclared:
        raise ParameterError(
            f"{query.id} does not declare {', '.join(undeclared)}; "
            f"declared parameters are {', '.join(sorted(declared)) or '(none)'}"
        )

    missing = sorted(
        p.name
        for p in query.params
        if p.required and p.name not in supplied and p.default is None
    )

    pairs: list[tuple[str, str]] = []
    for name, param in sorted(declared.items()):
        if name in supplied:
            value: Any = supplied[name]
        elif param.default is not None:
            value = param.default
        else:
            continue  # unsupplied stays unbound: "omit for all"
        pairs.append((name, render_term(value, param.datatype, param=param)))

    clause = values_clause(pairs)
    sparql = query.sparql
    if clause:
        if not accepts_values_clause(sparql):
            raise ParameterError(
                f"{query.id} cannot take a VALUES clause: it is "
                f"{'an update' if form(sparql) == 'UPDATE' else 'already bound by a trailing VALUES clause'}"
            )
        sparql = f"{sparql.rstrip()}\n{clause}"

    return BoundQuery(
        sparql=sparql,
        bound=[name for name, _ in pairs],
        missing=missing,
        unused=[],
        strategy="values",
    )
