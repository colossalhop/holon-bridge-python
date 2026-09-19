---
id: https://w3id.org/databook/prompt-ingestion-pipelines-v1
title: "Prompt-based ingestion pipelines: DAG stages, stage prompts, and candidate-staged writes"
type: databook
version: 0.1.0
created: 2026-09-19
author:
  - name: Kurt Cagle
    iri: https://holongraph.com/people/kurt-cagle
    role: orchestrator
  - name: Claude Sonnet 5
    role: transformer
description: >
  Design capture for extending Pipeline manifests with prompt-bearing
  stages, so a text-to-RDF ingestion step that needs to read the graph
  before mapping (the common case for controlled-natural-language and
  free-text ingestion) is a two- or three-node DAG rather than a new,
  separate registry. Not yet implemented -- this is the scoping document,
  grounded directly against the current pipeline, named-projection, and
  trigger/candidate code (holonbridge/pipeline.py,
  holonbridge/named_projections.py, holonbridge/triggers.py,
  holonbridge/ingest.py, holonbridge/messages.py) so the plan extends
  working patterns rather than inventing a parallel one.
process:
  transformer: "Claude Sonnet 5"
  transformer_type: llm
  inputs:
    - iri: https://github.com/kurtcagle/holon-bridge-python/blob/main/holonbridge/pipeline.py
      role: reference
    - iri: https://github.com/kurtcagle/holon-bridge-python/blob/main/holonbridge/named_projections.py
      role: reference
    - iri: https://github.com/kurtcagle/holon-bridge-python/blob/main/holonbridge/triggers.py
      role: reference
    - iri: https://github.com/kurtcagle/holon-bridge-python/blob/main/holonbridge/ingest.py
      role: reference
    - iri: https://github.com/kurtcagle/holon-bridge-python/blob/main/holonbridge/messages.py
      role: reference
    - iri: https://github.com/kurtcagle/holon-bridge-python/blob/main/docs/named-projection-architecture.databook.md
      role: reference
  timestamp: 2026-09-19T00:00:00Z
  agent:
    name: Claude Sonnet 5
    role: orchestrator
---

## Status

Design capture, not implemented. No code has been changed in
`kurtcagle/holon-bridge-python` as of this writing. This note follows the
same discipline as `docs/named-projection-architecture.databook.md`: every
claim about current behavior below was checked directly against the live
source of the modules it touches, not recalled from memory.

## Where this came from

The question that started this: does the bridge support a named,
prompt-based *ingestion* pipeline -- the mirror image of Named Projection,
which wraps a named query's result in a stored prompt template for a
deferred LLM call. The motivating shape is controlled-natural-language
ingestion (an ACE-style grammar is the concrete example kept in mind
throughout, though nothing here is grammar-specific), and more generally
any free-text-to-RDF ingestion step.

The first-pass answer was "no first-class support, but the pieces are
close": Pipeline manifests (`holonbridge/pipeline.py`) already recognize
`llm` as a transformer type and correctly refuse to execute it (recorded
as `"Deferred"`, alongside `human`/`composite`/`xslt`), and Named
Projection already established the "stored prompt template, deferred to
the caller, `status: deferred`" contract for the read side. Neither piece
carries what an ingestion stage actually needs: a `PipelineNode` has no
field to hold a prompt, and there is no mechanism for one stage's output
to flow into another's template -- `pipeline.py` only orders stages, it
does not thread data between them.

A second, more specific requirement then narrowed the design: the common
case is not "map raw text to RDF in one shot," it's "read the graph
first, to resolve mentions against holons that already exist, then map."
That is inherently a two-node shape (a context-read stage feeding a
mapping stage), which is an argument for extending Pipeline's DAG rather
than adding a flat, single-call sibling to Named Projection the way
Named Projection itself is a sibling of Named Query -- a flat registry
that wraps exactly one upstream query does not generalize to "however
many context reads a mapping stage needs," where a DAG already does, for
free, via `build:dependsOn`.

The last requirement is the one with the most consequence: whatever
lands the LLM's output in the graph has to go through the *same* ACL and
SHACL gate every other write in the bridge goes through -- `push_turtle`,
`create_holon`, `create_message`, and any pipeline `sparql`/`rule` stage
all converge on `holonbridge/ingest.py`'s `write_turtle_to_graph`.
Reading `holonbridge/triggers.py` to work out how to model "this stage
produced a payload that needs to land somewhere" surfaced two things
worth stating plainly: first, the bridge already has exactly this
concept -- Named Trigger stages its rule's output as a
`holon:CandidateStatus` record with `hev:proposedTurtle`, pending human
(or automatic) approval, in `urn:{dataset}:candidates` -- so an
ingestion stage's output should be staged the same way, not through a
new mechanism. Second, `approve_candidate` as it exists today does
**not** go through `write_turtle_to_graph` -- it calls
`client.post_graph` directly, with no ACL check, no SHACL gate, and no
write-lock. That is a pre-existing gap, not something introduced by this
design, but it directly contradicts the "same constraints as every other
process" requirement if left as-is, and it affects the trigger-based
candidates already in production, not only the new ingestion case. This
note proposes fixing it as part of the same change.

## Decision: extend Pipeline's DAG; do not add a flat sibling registry

Rejected alternative: a `named_ingestions.py` module mirroring
`named_projections.py` one-to-one (a single stored prompt wrapping a
single named query, `{{input}}` in place of `{{result}}`). This is less
code, but the "read the graph first" requirement breaks its 1:1 shape
almost immediately -- a mapping stage may need more than one context
read (existing-entity candidates, a relevant ontology fragment, prior
holons in the same ingestion batch), and `build:dependsOn` already
expresses arbitrary fan-in generally. A flat registry would need a
second, parallel list-of-queries field that duplicates what the DAG
already does, and would still need its own version of the "produced
Turtle needs review before it lands" mechanism -- at which point it is a
fixed-shape Pipeline manifest wearing a single-call disguise.

Adopted: Pipeline manifests gain a `build:promptText` field on `Stage`
nodes (so an `llm`-transformer stage carries its own template, the way
`hb:NamedProjection` carries `hb:promptText`), plus a small amount of
stage-to-stage data threading so a preceding read-only stage's result
can be interpolated into a dependent stage's prompt. A single-stage
manifest (no `dependsOn` at all) is the trivial case under the same
schema, not a separate registration path -- see Worked examples below.
The produced Turtle is staged as a `holon:CandidateStatus`, generalized
to admit a pipeline origin alongside its existing trigger origin, and
lands only through `approve_candidate` once that function is routed
through `write_turtle_to_graph`.

## Data model

### Stage prompts

```turtle
@prefix build: <https://w3id.org/databook/ns#> .

<stage:map> a build:Stage ;
    build:transformer  "llm" ;
    build:promptText   "Existing candidates:\n{{context}}\n\nMap the following text to Turtle, reusing an existing IRI wherever it matches:\n\n{{input}}" ;
    build:dependsOn    <stage:context> ;
    build:targetGraph  <urn:{dataset}:holons> .
```

`build:promptText` is new on `PipelineNode`/`Stage` (today's fields are
`id`, `label`, `transformer`, `input_type`, `output_type`, `order`,
`rule`, `shapes`, `projection`, `target_graph`, `depends_on` -- see
`holonbridge/pipeline.py`'s `_NODE_FIELDS`/`PipelineNode`). Two fixed
placeholders, deliberately not a declarable set (same reasoning
`named_projections.py`'s module docstring gives for `{{result}}` being
fixed rather than caller-declared):

- `{{input}}` -- the payload the pipeline run was invoked with (the raw
  source text, or the `params` passed to `run_pipeline`/`ingest`).
- `{{context}}` -- the rendered result of this stage's upstream
  dependency, when it has exactly one non-`Source` dependency whose
  transformer is a read-only kind (see below). A stage with more than
  one context dependency addresses each by id: `{{context:stage-id}}` --
  left as a documented extension, not required for the first cut (see
  Explicitly out of scope).

### Stage-to-stage context: the actual gap

`run_pipeline` today only uses `depends_on` for ordering
(`topological_order`'s Kahn's-algorithm sort); no stage's return value is
captured anywhere a later stage can read it. `_run_rule_stage` runs a
Named Rule that writes into a graph via `execute_named_rule`; there is
no notion of a rule invoked purely to *read* and hand its result
forward.

Proposed: a `sparql`/`rule`-transformer stage that declares no
`target_graph` is treated as **context-only** -- it still runs via the
existing `execute_named_rule`/rule-loading path (no new query mechanism),
but its result (the bound SELECT's JSON, or the bound
CONSTRUCT/DESCRIBE's Turtle -- same two shapes `render_prompt` already
handles for Named Projection) is captured on the `Message` for this run,
keyed by stage id, rather than written anywhere. `run_pipeline` passes
that captured map forward so a dependent `llm` stage's `render_prompt`
call can resolve `{{context}}` against it. This reuses
`named_projections.render_prompt`'s substitution function directly
(generalized to take a dict of named slots instead of one fixed
`{{result}}`) rather than writing a second interpolation routine.

`StageRecord` (`holonbridge/messages.py`) gains a `result` field
alongside `detail`/`status`/`triples_written` to carry this -- `detail`
stays the short human-readable summary it already is (`"deferred"`
stages currently put their explanation there); `result` is the
machine-consumable payload a dependent stage actually binds against.
Messages already live in the graph (`urn:{dataset}:messages`) specifically
so a restart doesn't lose run state -- this is the same durability the
context data should get, since a caller may fetch a `Deferred` stage's
rendered prompt well after the run that produced it, potentially after a
restart.

### Candidate provenance, generalized

Today, `triggers.py`'s `_write_candidate` gives every `holon:CandidateStatus`
exactly one shape of provenance:

```turtle
<candidate> a holon:CandidateStatus ;
    hev:proposedByTrigger    <trigger> ;
    hev:proposedFor          <focus> ;
    hev:proposedFromFiring   <firing> ;
    hev:proposedTargetGraph  "..." ;
    hev:proposedTurtle       "..." ;
    hev:proposedRule         "..." ;
    hev:candidateStatusValue "Pending" ;
    hev:proposedAt           "..."^^xsd:dateTime .
```

`approve_candidate`/`reject_candidate`/`list_candidates`/`get_candidate`
only ever read the common fields -- `target_graph`, `turtle`, `status`,
`proposed_at` -- never the trigger-specific ones (`trigger_iri`, `focus`,
`firing_iri`, `rule_id`). That means a second provenance shape can sit
alongside the first with no change to the read/approve/reject path,
only to how a `Candidate` is loaded (`list_candidates`'s
`_candidates_query` already selects generic `?p ?o` pairs off any
`holon:CandidateStatus`; it just needs to populate whichever provenance
fields are present rather than assuming the trigger set):

```turtle
<candidate> a holon:CandidateStatus ;
    hev:proposedByPipeline   <pipeline-id> ;
    hev:proposedFromStage    <stage-id> ;
    hev:proposedFromMessage  <message-iri> ;
    hev:proposedTargetGraph  "..." ;
    hev:proposedTurtle       "..." ;
    hev:candidateStatusValue "Pending" ;
    hev:proposedAt           "..."^^xsd:dateTime .
```

No new class, no new graph role -- `urn:{dataset}:candidates` already
exists and already means "written content pending review before it
becomes ground truth," which is exactly what a deferred `llm` stage's
output is.

### Fixing `approve_candidate`

`holonbridge/triggers.py`'s `approve_candidate` currently does:

```python
if candidate.turtle.strip():
    await client.post_graph(conn, candidate.target_graph, candidate.turtle)
```

-- a direct Graph Store Protocol write, bypassing
`ingest.write_turtle_to_graph` entirely: no `check_write`/`check_replace`
ACL decision, no SHACL gate, no `write_lock.for_conn` serialization
against a concurrent write to the same graph. This predates this design
and already affects every trigger-produced candidate in the field today.

Proposed fix, in the same change: route `approve_candidate` through
`write_turtle_to_graph`, with `mode="merge"` (candidates are always
additive -- see the existing docstring's own reasoning for why approval
is deliberately never Replace/Sync/Supersede) and the caller's `animus`
threaded through from whoever calls `approve_candidate` (the reviewer,
not the original trigger or pipeline). This means approving a candidate
can now itself 403 (reviewer lacks write access to the target graph) or
422 (the proposed Turtle fails SHACL) where today it cannot -- both
correct outcomes: a human clicking approve should not be a way to land
triples that the ordinary write path would have refused.

## Worked examples

**Single-stage (no context read needed) -- the default case:**

```turtle
@prefix build: <https://w3id.org/databook/ns#> .

<pipeline:ace-simple> a build:Manifest ;
    build:pipelineId "ace-simple" .

<stage:map> a build:Stage ;
    build:transformer  "llm" ;
    build:promptText   "Parse the following controlled-natural-language text into Turtle:\n\n{{input}}" ;
    build:targetGraph  <urn:{dataset}:holons> .
```

One node, no `dependsOn`. Registered and run exactly like any other
manifest (`register_pipeline`, `run_pipeline`) -- nothing about the
trivial case requires more ceremony than the general one; it is simply
the smallest legal graph under the same vocabulary.

**Context-read, then map, then validate -- the case expected to
dominate:**

```turtle
<pipeline:ace-context-mapped> a build:Manifest ;
    build:pipelineId "ace-context-mapped" .

<stage:context> a build:Stage ;
    build:transformer "sparql" ;
    build:rule        "entity-candidates" .   # existing Named Rule/Query, read-only: no targetGraph

<stage:map> a build:Stage ;
    build:transformer  "llm" ;
    build:promptText   "Existing entities that may match:\n{{context}}\n\nParse this text, reusing an existing IRI wherever it refers to one of the above:\n\n{{input}}" ;
    build:dependsOn    <stage:context> ;
    build:targetGraph  <urn:{dataset}:holons> .

<stage:validate> a build:Stage ;
    build:transformer  "shacl" ;
    build:dependsOn    <stage:map> ;
    build:targetGraph  <urn:{dataset}:holons> .
```

## Execution walkthrough

1. Caller registers the manifest once (`register_pipeline`).
2. Caller runs it (`run_pipeline`, or `ingest(..., pipeline="ace-context-mapped")`
   if landing an initial payload at the same time). `stage:context` runs
   for real -- it is `sparql`, already in `pipeline.py`'s `EXECUTABLE` set
   -- and its result is captured on the `Message` keyed by stage id.
3. `stage:map` is recorded `"Deferred"`, same as today, but its detail
   now carries the fully-rendered prompt: `{{context}}` substituted from
   step 2's captured result, `{{input}}` substituted from the run's
   params. The caller (an agent, human, or external LLM) receives this
   from `run_pipeline`'s response or a later `get_message` poll.
4. Caller performs the actual text-to-RDF transform outside the bridge
   and gets back Turtle.
5. Caller proposes that Turtle as a candidate, referencing this pipeline
   run and stage (new operation -- see below), landing a `Pending`
   `holon:CandidateStatus` in `urn:{dataset}:candidates`. Nothing has
   touched `urn:{dataset}:holons` yet.
6. A reviewer (human, or a policy that auto-approves under some
   confidence threshold -- out of scope here, same posture Named Trigger
   already takes with `review_required`) calls `approve_candidate`. This
   now runs the fixed, gated path: ACL check, SHACL validation against
   `stage:map`'s declared shapes (or the dataset default), write-lock,
   then the actual merge.
7. `stage:validate` can be re-run (`run_pipeline` again, same manifest
   id) to confirm the now-landed graph conforms -- belt-and-braces on
   top of the SHACL check `approve_candidate` itself now performs, useful
   because the two checks run against different snapshots (pre-merge
   delta vs. post-merge full graph).

## New or changed surface

`holonbridge/pipeline.py`:
- `PipelineNode.prompt_text: str = ""`, loaded from `build:promptText`.
- `Manifest`/`run_pipeline` capture each context-only stage's rendered
  result, keyed by stage id, and pass it to `_run_llm_stage` (new -- the
  `llm` branch currently fails straight to the generic "Deferred, not
  executed" case; it needs its own branch that renders the prompt via a
  generalized `render_prompt` and puts the result in the stage's
  `Message.stages[i].detail`/new `result` field, still marking the stage
  `"Deferred"`).
- `EXECUTABLE`/`DEFERRED` sets are unchanged -- `llm` stays `Deferred`;
  what changes is what accompanies that status, not whether the bridge
  pretends to run it.

`holonbridge/messages.py`:
- `StageRecord.result: str = ""` (or a small `dict[str, Any]`) alongside
  `detail`, persisted the same way every other `StageRecord` field is.

`holonbridge/triggers.py` (or a new small shared module, since this is
no longer trigger-specific -- naming left open, see Open questions):
- `Candidate` gains optional `pipeline_id`/`stage_id`/`message_iri`
  fields alongside the existing `trigger_iri`/`focus`/`firing_iri`, all
  optional, exactly one provenance set populated per candidate.
- A new `propose_pipeline_candidate(client, conn, *, pipeline_id, stage_id,
  message_iri, turtle, target_graph) -> Candidate` sibling to
  `_write_candidate`, same `holon:CandidateStatus` class, pipeline-shaped
  provenance predicates.
- `approve_candidate(client, conn, candidate, *, animus, shapes_graph=None) -> dict`
  signature change: now needs `animus` (for the ACL check) and returns
  whatever `write_turtle_to_graph` returns (validation report included)
  instead of `None`; every existing caller updates accordingly.

MCP tools (`holonbridge_mcp/tools/`):
- `run_pipeline`'s existing response shape gains rendered prompt text on
  `Deferred` `llm` stages -- additive, no signature change.
- New `propose_candidate(pipeline_id: str, stage_id: str, message_id: str,
  turtle: str, target_graph: str | None = None) -> dict`.
- `approve_candidate`'s tool wrapper starts threading the caller's
  resolved identity through (it likely already has this available the
  way every other write-shaped tool does; confirm against
  `holonbridge_mcp/session.py`/`identity.py` before assuming).

## Tests to add

- Single-stage manifest: register, run, `Deferred` detail contains the
  rendered prompt with `{{input}}` substituted, nothing else.
- Two-stage manifest: context stage's SELECT result appears verbatim
  (JSON) inside the `llm` stage's rendered prompt at `{{context}}`.
- Context stage declaring a `targetGraph` is rejected at registration
  (or at minimum warned) -- a stage that both writes and forwards
  context is a modeling error the schema should catch, not silently
  allow.
- `propose_pipeline_candidate` then `approve_candidate`: candidate lands
  in `urn:{dataset}:candidates` as `Pending`, `Pending` -> `Approved`
  merges into the target graph, target graph diff shows exactly the
  proposed triples.
- `approve_candidate` against a caller with no write access to the
  target graph -> 403, candidate stays `Pending`.
- `approve_candidate` where the proposed Turtle fails SHACL -> 422,
  candidate stays `Pending`, nothing merged.
- Regression: an existing trigger-produced candidate still
  approves/rejects correctly through the now-gated path.

## Explicitly out of scope for the first PR

- Multiple named context dependencies (`{{context:stage-id}}` addressing)
  -- the single-`{{context}}` case (one upstream read stage) covers the
  motivating scenario; multi-context is a real future need but adds
  parsing complexity this scope doesn't require yet.
- Automatic approval policy (confidence thresholds, auto-approve rules)
  for pipeline-originated candidates -- mirrors Named Trigger's own
  `review_required` default of `True` with no policy engine yet; a
  pipeline-originated candidate defaults to requiring manual review the
  same way.
- A server-executed `llm` mode (the bridge calling an LLM directly) --
  same deferral `named-projection-architecture.databook.md` already made
  for Named Projection's Option B, for the same reasons (cost, latency,
  API-key coupling `run_named_query`/`run_pipeline` have never needed).
- The actual controlled-natural-language grammar or mapping rules used
  by any specific `llm` stage's `promptText` -- this note is bridge-side
  plumbing only.

## Open questions

- Where does candidate-provenance generalization actually live?
  `triggers.py` currently owns `Candidate`/`approve_candidate`/etc., but
  once a second producer (pipelines) exists, keeping candidate lifecycle
  code in a module named for its first producer is misleading. Proposed:
  a new `holonbridge/candidates.py` housing `Candidate`,
  `list_candidates`, `get_candidate`, `approve_candidate`,
  `reject_candidate`, `CandidateError`, with `triggers.py` and the new
  pipeline path both importing from it. Not done in this note because it
  is a pure move, not a design decision, but flagged so it isn't lost.
- Should a context-only stage's captured result also be persisted for
  audit (what did the mapping stage actually see) independent of whether
  the run is still in flight? `Message`/`StageRecord` already live in
  the graph, so this may already fall out of the `StageRecord.result`
  field for free -- worth confirming retention/query needs before
  deciding whether anything extra is needed.
- Naming: `build:promptText` mirrors `hb:promptText`'s naming, but they
  are different vocabularies (`build:` vs `hb:`) describing the same
  kind of thing for the same reason Named Projection exists. Worth a
  short pass to check whether the `build:` vocabulary should define its
  own prompt-bearing-stage shape formally (a SHACL shape for `Stage`
  when `transformer = "llm"`) rather than leaving it as one more
  optionally-present field, consistent with how deliberate the rest of
  this vocabulary's field set already is.
