---
id: https://w3id.org/databook/named-projection-architecture-v1
title: "Named Projection: architecture and implementation scope"
type: databook
version: 0.1.0
created: 2026-09-16
author:
  - name: Kurt Cagle
    iri: https://holongraph.com/people/kurt-cagle
    role: orchestrator
  - name: Claude Sonnet 5
    role: transformer
description: >
  Design capture and implementation scope for register_named_projection and
  the full Named Projection tool family on kurtcagle/holon-bridge-python.
  Not yet implemented -- this is the scoping document, grounded directly
  against the current named-query registry code (holonbridge/named_queries.py,
  holonbridge/routes/named_queries.py, holonbridge/acl.py, holonbridge/toolset.py)
  so the plan is a close mirror of an existing, working pattern rather than a
  fresh design.
process:
  transformer: "Claude Sonnet 4.6"
  transformer_type: human
  inputs:
    - iri: https://github.com/kurtcagle/holon-bridge-python/blob/main/holonbridge/named_queries.py
      role: reference
    - iri: https://github.com/kurtcagle/holon-bridge-python/blob/main/holonbridge/routes/named_queries.py
      role: reference
    - iri: https://github.com/kurtcagle/holon-bridge-python/blob/main/holonbridge/acl.py
      role: reference
    - iri: https://github.com/kurtcagle/holon-bridge-python/blob/main/holonbridge/toolset.py
      role: reference
  timestamp: 2026-09-16T02:00:00Z
  agent:
    name: Claude Sonnet 5
    role: orchestrator
---

## Status

Design capture, not implemented. No code has been changed in
`kurtcagle/holon-bridge-python` as of this writing; this document is the
scope a PR would follow, checked directly against the live source of the
pattern it mirrors. (A first implementation has since shipped -- see
`holonbridge/named_projections.py` and its sibling route/tool/test files
-- this document is kept as the design record it was written as.)

## Where this came from

Working through an ACE-CNL rendering task on a live HolonBridge instance,
the concept "a named query plus a deferred prompt-based transform" was
hand-implemented as a small ad hoc `hpres:` vocabulary, pushed straight
into a `urn:example:named-presentations` graph via `push_turtle`
(no registry code, no ACL, no Toolset gating -- a prototype, not
infrastructure). The decision was made to turn that into a real
registration endpoint, named `register_named_projection` rather than
`register_named_presentation`.

**On the name.** "Projection" already means something specific in this
architecture on two counts, both of which support the rename rather than
conflict with it: it's one of HGA's four graph layers (scene / boundary /
event / projection), and `get_holon`'s `projection_mode` parameter
(`immersive`/`cinematic`/`active_inference`/`exploded_view`) already
means "a named way of rendering a holon." A Named Projection -- a
registered recipe that renders a holon (or any query result) into a
presentation form -- is a direct extension of exactly that idea, just
parameterized by a stored query + prompt instead of a fixed enum. One
naming caution worth flagging rather than silently absorbing: a live
deployment of this bridge also exposes a "Projection Hook" tool family
(`register_projection_hook`, `run_projection_hook`, etc.) for a
data-sync/delta-delivery mechanism, and `search_code` against
`kurtcagle/holon-bridge-python` for "projection" returned **zero
matches** at the time this scope was written -- that feature wasn't in
this repo at all, so it either lived in a newer unpushed branch or a
different codebase than the one this scope targeted. Worth a quick
confirmation before shipping, so "Named Projection" and "Projection
Hook" don't end up as two unrelated features sharing a name in the same
running server. (Resolved in the shipped implementation: the new graph
role is named `named-projections`, deliberately distinct from the
pre-existing `projections`/`projection-log` roles Projection Hook
already owns in this repo -- see `holonbridge/conn.py`'s module
docstring.)

## Data model

New class in the existing `hb:` namespace (`https://w3id.org/holonbridge/`
-- no new namespace needed, this is the same scheme `hb:NamedQuery`
already lives in):

```turtle
@prefix hb: <https://w3id.org/holonbridge/> .

<https://w3id.org/holonbridge/projection/{id}>
    a hb:NamedProjection ;
    hb:id            "{id}" ;
    hb:namedQuery     <IRI of an existing hb: or hquery: named query> ;
    hb:promptText    "{{...}} interpolated prompt template" ;
    hb:outputFormat  "ace-cnl" ;               # free text, not an enum -- same looseness as hb:queryType
    hb:label         "..." ;                    # optional
    hb:description   "..." ;                    # optional
    hb:executionMode "deferred" ;               # "deferred" | "server" -- see Execution semantics
    hb:registeredAt  "2026-09-16T..."^^xsd:dateTime .
```

Registry graph: `urn:{dataset}:named-projections` -- one more `urn:{dataset}:{role}`
graph under the existing convention, no core change needed to
`conn.graph()` itself. Needs adding to the `graphs` dict `get_endpoint`
reports (currently enumerates `holons`/`ontology`/`events`/.../`named-queries`/
`named-rules`/.../`pipelines`/... by hand) so it shows up there the way
`named-queries` and `pipelines` already do.

## Module: `holonbridge/named_projections.py`

Mirrors `named_queries.py` closely enough that most of it is a rename +
field-shape change, not new design:

- `NamedProjection` dataclass: `id`, `iri`, `named_query` (IRI),
  `prompt_text`, `output_format`, `execution_mode`, `label`,
  `description`, `registered_at`. No `vocabulary` field -- unlike named
  queries, there's exactly one shape here, no `hb:`/`hquery:` split to
  reconcile (nothing about "deferred prompt applied to a query result"
  needs two binding strategies).
- `load_named_projections(client, conn, *, graph=None) -> LoadResult`:
  same `STRENDS(STR(?type), "NamedProjection")` loose-matching-by-suffix
  loader as `_queries_query`, same degrade-not-fail behavior on an
  unreachable registry.
- No `apply_query_params`/binding logic of its own -- a projection doesn't
  bind parameters directly; it delegates to the wrapped named query's own
  `apply_query_params` at run time (see the route below). This keeps
  `_bind_placeholders`/`_bind_values` as the single source of truth for
  parameter binding, rather than a second implementation that could drift.

## Routes: `holonbridge/routes/named_projections.py`

Same `AnimusDep`/Toolset-reachability shape as `named_queries.py`
throughout -- every route requires resolved identity; list/get/run are
gated by `resolve_reachable`, extended to treat `hb:NamedProjection` as a
third reachable-tool shape alongside named queries and named rules
(`toolset.py`'s own docstring already anticipates this: `check_invoke`'s
docstring reads "May person invoke named_query (or a NamedRule, same
shape)?" -- Named Projection becomes a third).

| Route | Mirrors | Notes |
|---|---|---|
| `GET /named-projections` | `list_named_queries` | same `filter` query param; no `vocabulary` param (nothing to filter by) |
| `GET /named-projection/{id}` | `get_named_query` | full definition incl. prompt text |
| `POST /named-projection/{id}/run` | `run_named_query` | see Execution semantics below |
| `POST /named-projection` | `register_named_query` | see Registration ACL below |
| `DELETE /named-projection/{id}` | `delete_named_query` | `check_replace`, identical tier |
| `POST /named-projections/reload` | `reload_named_queries` | ungated cache maintenance, identical reasoning |

### Execution semantics -- the one real design decision

`run_named_projection` has two honest options, and this scope recommends
shipping the first and leaving the second as a documented extension
point rather than guessing which one should be baked in immediately:

**Option A -- deferred (recommended default).** The route resolves the
wrapped named query, binds and runs it exactly as `run_named_query`
does, then returns the query result together with `prompt_text` with the
result already interpolated into it (`{{turtle}}`/`{{result}}`,
whichever placeholder the prompt declares) and `"status": "deferred"`.
No LLM call happens inside the bridge. This is exactly what was hand-run
manually for the worked example, it needs zero new external dependency
or cost at the bridge layer, and it matches the Pipeline pattern's own
established `llm`/`human`/`external` "Deferred" semantics (`run_pipeline`
already treats deferred stages as a first-class, expected outcome, not a
failure) -- so a caller that already understands Pipeline Deferred needs
no new mental model here.

**Option B -- server-executed.** The route calls an LLM synchronously
(the same Anthropic-API-fallback path `nl_query` already has,
`ANTHROPIC_API_KEY`-gated) and returns fully rendered text. Fully
automated, but couples every projection run to bridge-side API cost,
latency, and an API key dependency that `run_named_query` itself has
never needed. `hb:executionMode` is included in the data model now
specifically so Option B can be added later as a per-projection choice
without a breaking schema change -- a projection registered
`hb:executionMode "server"` would use `nl_query`'s existing LLM path;
`"deferred"` (the default) does not touch it at all.

### Registration ACL -- one addition beyond `register_named_query`'s pattern

Base case, same as `register_named_query`: `check_write` on the
`named-projections` graph, always.

**Addition specific to projections:** a Named Projection is a thin
wrapper that, once reachable, lets its caller transitively invoke the
named query it wraps -- without that caller necessarily being able to
reach the underlying query directly. `register_named_query`'s own
docstring is explicit about exactly this failure shape for update-form
queries ("a looser check here would let anyone who can add a label to
the registry install something that later runs with more reach than
they personally have"); the identical risk applies here for *any* wrapped
query, not just update-form ones, because Toolset reachability is
evaluated once per tool, not transitively through a projection to its
query. So `register_named_projection` should additionally require that
the registering caller can themselves currently reach `named_query`
(same `resolve_reachable` check `_reachable_ids` already runs for
list/get/run, called once more here at registration time) -- reject with
403 if not. This is the same "check at the definer's-rights point, not
at every later invocation" shape `register_named_query` already
established for update-body graph refs.

```python
# sketch, not final code
async def register_named_projection(body, conn, client, animus, cache):
    ...
    check_write(registry)  # as today

    query_result = await cache.get(client, conn, kind="named-queries", loader=load_named_queries)
    wrapped = query_result.by_id_or_iri(body.named_query)
    if wrapped is None:
        raise HTTPException(404, {"error": "unknown_named_query", "id": body.named_query})

    persona, _ = personas.get(person_id=animus.person, dataset=conn.dataset)
    reachable = await _reachable_ids(query_result, conn, client, persona)
    if wrapped.id not in reachable:
        raise HTTPException(403, "cannot register a projection over a query you cannot yourself reach")
    ...
```

Deletion: `check_replace`, identical tier to `delete_named_query`.

## Toolset reachability wiring

`toolset.resolve_reachable` is already generic over "a list of candidate
tool IRIs" -- it doesn't care what kind of tool they are. The only change
needed is calling it a third time (queries, rules, now projections) with
`NamedProjection`'s own loaded IRIs, and folding a projection's
reachability into the same 404-shape-for-unreachable-or-unknown
convention `named_queries.py`'s `_not_found` already establishes.

## MCP tools: `holonbridge_mcp/tools/named_projections.py`

One-to-one with `named_queries.py`'s tool file, renamed:

```
list_named_projections(filter: str | None = None) -> dict
get_named_projection(projection_id: str) -> dict
run_named_projection(projection_id: str, params: dict | None = None, dry_run: bool = False, graph: str | None = None) -> dict
register_named_projection(id: str, named_query: str, prompt_text: str, label: str | None = None, description: str | None = None, output_format: str | None = None, execution_mode: str = "deferred") -> dict
delete_named_projection(projection_id: str) -> dict
reload_named_projections() -> dict
```

`get_named_projection_schema` is deliberately **not** in the first cut --
a projection's parameter contract is exactly its wrapped query's
contract, so `get_named_query_schema(wrapped_query_id)` already answers
it; adding a proxying duplicate is a nice-to-have, not a requirement, and
this scope leaves it out to keep the first PR small.

## Tests to add

Mirroring whatever `test_named_queries.py`-equivalent coverage already
exists:

- register over a nonexistent `named_query` id → 404
- register over a real query the caller cannot reach → 403
- register, then run with params → params flow through to the wrapped
  query's own `apply_query_params`, result comes back with `prompt_text`
  interpolated, `status: "deferred"`
- run with `dry_run=True` → bound SPARQL and interpolated prompt
  returned, nothing executed
- delete requires `check_replace`, not `check_write` -- same pattern as
  `delete_named_query`
- Toolset-restricted projection: unreachable caller gets the same 404
  shape as an unknown id

(The shipped implementation's `tests/test_named_projections.py` covers
all of the above, plus rejection of update-form wrapped queries and
rejection of any `execution_mode` other than `"deferred"`.)

## Migration note

Once this ships, the ad hoc `hpres:` prototype registered by hand during
the original session should be re-registered through the real
`register_named_projection` endpoint and the old `hpres:` graph
(`urn:example:named-presentations`) retired. Not done as part of this
scope; flagged so it isn't forgotten once the endpoint exists.

## Explicitly out of scope for the first PR

- Option B (server-executed LLM call) -- data model leaves room for it,
  code does not implement it yet.
- `get_named_projection_schema`.
- Reconciling the "Projection" vs "Projection Hook" naming question
  against whatever codebase actually hosts Projection Hook -- flagged
  above; resolved in the shipped implementation via the distinct
  `named-projections` graph role.
