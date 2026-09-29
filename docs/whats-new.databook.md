---
id: https://w3id.org/databook/holon-bridge-python-whats-new
title: "What's New — holon-bridge-python"
type: databook
version: 1.0.1
created: 2026-09-27
updated: 2026-09-29
author:
  - name: Kurt Cagle
    iri: https://holongraph.com/people/kurt-cagle
    role: orchestrator
  - name: Claude Sonnet 5
    role: transformer
description: >
  Running log of substantive changes to holon-bridge-python, newest entry
  first. "Substantive" means a merged PR, a fixed bug, or a shipped
  feature someone would want to know about without reading the full commit
  history -- not every commit. Update both the prose entry below and the
  hb:ReleaseNote data block whenever something substantive ships; bump
  `version` and `updated` on every edit, `created` never changes.
process:
  transformer: "Claude Sonnet 5"
  transformer_type: llm
  transformer_iri: https://api.anthropic.com/v1/models/claude-sonnet-5
  timestamp: 2026-09-27T23:55:00Z
  agent:
    name: Claude Sonnet 5
    role: orchestrator
---

## How to update this file

1. Add a new dated section at the top of **Log**, below this section --
   newest first, same shape as the existing entries: a short heading, a
   bullet per substantive change, a link to the PR or commit for each.
2. Add a matching `hb:ReleaseNote` resource to the data block at the
   bottom for each bullet -- same date, same one-line label, a
   `dcterms:description` a sentence or two longer than the bullet, and
   `rdfs:seeAlso` pointing at the same PR/commit link.
3. Bump `version` (patch bump for a normal update) and `updated` in the
   frontmatter. `created` stays 2026-09-27 forever.
4. If this file gets long enough that scrolling past old entries is
   annoying, move everything older than a few months into
   `whats-new-archive.databook.md` and leave a one-line pointer here --
   not needed yet.

## Log

### 2026-09-29

- **Delegation: a Person can share their own persona graphs with another
  Person, revocably, without impersonation.** New `holonbridge/delegation.py`,
  `holonbridge/routes/delegation.py` (`POST /delegation`,
  `POST /delegation/revoke`, `GET /delegation`), `shapes/delegation.ttl`, and
  the `create_delegation` / `revoke_delegation` / `list_delegations` MCP
  tools. A `holon:Delegation` is a stored, time-boxed record naming the
  delegator, delegate, persona, the exact graphs covered and the
  permissions (`read`, `write`); `acl.check_write` and
  `acl.authorize_query` honour an active one, so every existing write and
  raw-SPARQL path picks it up with no call-site changes. Never confers
  replace, admin or a Role; only ever covers the delegator's own
  persona-user graphs; bounded lifetime (default 7 days, max 90); a
  deactivated delegator's delegations stop working immediately.
  [PR #27](https://github.com/kurtcagle/holon-bridge-python/pull/27)
- **`GET /holon` and the `get_holon` MCP tool gain `on_behalf_of`.** Reads
  the delegator's scope, limited to exactly the graphs the delegation names
  -- the one deliberate, guarded exception to "a caller can only ever get
  their own scope". Refused with a 403 when no active read delegation
  exists, never silently falling back to the caller's own scope.
  [PR #27](https://github.com/kurtcagle/holon-bridge-python/pull/27)
- **Request-supplied IRIs are now validated before they reach generated
  Turtle or SPARQL** in the delegation code (`delegation.safe_iri`), with
  control characters escaped in literals. Written with regression tests
  that fail if the defence is removed.
  [PR #27](https://github.com/kurtcagle/holon-bridge-python/pull/27)

### 2026-09-27

- **Lucene full-text search provisioning.** New `holonbridge/provisioning.py`,
  `POST /datasets/{name}/text-index`, and the `provision_text_index` MCP
  tool -- adds a `jena-text` Lucene index to an existing dataset's Fuseki
  assembler file, with a sane default field set (`rdfs:label`/`comment`,
  `skos:prefLabel`/`altLabel`/`definition`/`comment`, `dcterms:title`,
  `sh:name`/`description`) and per-dataset `extra_predicates`. Admin-gated,
  preview-before-commit by default. [PR #24](https://github.com/kurtcagle/holon-bridge-python/pull/24)
- **Scheduler no longer takes the whole bridge down on a Fuseki hiccup at
  startup.** `Scheduler.start()` now degrades to an empty task list plus a
  loud warning if `reload()` fails, instead of letting the exception abort
  the entire FastAPI lifespan. Closes HB_SCHEDULER_STARTUP_HARD_DEPENDENCY,
  hit for real in production the same day this was found.
  [PR #25](https://github.com/kurtcagle/holon-bridge-python/pull/25)
- **Fixed invalid Turtle in the text-index provisioning tool.** The
  `text:map ( ... )` collection items were being joined with commas, which
  is invalid inside a Turtle collection (valid only in a predicate-object
  list). Because Fuseki's directory-config loader aborts the *entire*
  server on one bad assembler file, this took every dataset on the
  instance down, not just the one being provisioned. Fixed the join
  separator and added a parse-before-write safety check so a syntax error
  is now a raised error, never a written file discovered broken at the
  next restart. [PR #26](https://github.com/kurtcagle/holon-bridge-python/pull/26)
- Verified the whole Lucene path end to end: offline backfill of
  pre-existing data (`jena.textindexer`) against `chloe`, live auto-indexing
  of new writes against a fresh `test2` dataset, and the per-dataset
  identity-bootstrap requirement (`holonbridge/bootstrap.py`,
  `holonbridge-bootstrap-admin`) that a brand-new dataset needs before any
  `AnimusDep`-gated write will succeed in it. See
  `docs/provisioning-new-dataset-for-search.databook.md` for the full
  runbook.

<!-- databook:id: release-log -->
```turtle
@prefix hb:      <https://w3id.org/holonbridge/> .
@prefix rdfs:    <http://www.w3.org/2000/01/rdf-schema#> .
@prefix dcterms: <http://purl.org/dc/terms/> .
@prefix xsd:     <http://www.w3.org/2001/XMLSchema#> .

hb:release-2026-09-27-a a hb:ReleaseNote ;
    dcterms:date "2026-09-27"^^xsd:date ;
    rdfs:label "Lucene full-text search provisioning" ;
    dcterms:description "Added holonbridge/provisioning.py, POST /datasets/{name}/text-index, and the provision_text_index MCP tool for adding a jena-text Lucene index to an existing dataset's assembler file, with sane defaults and per-dataset extra_predicates." ;
    rdfs:seeAlso <https://github.com/kurtcagle/holon-bridge-python/pull/24> .

hb:release-2026-09-27-b a hb:ReleaseNote ;
    dcterms:date "2026-09-27"^^xsd:date ;
    rdfs:label "Scheduler no longer kills the whole bridge on a Fuseki hiccup at startup" ;
    dcterms:description "Scheduler.start() now degrades to an empty task list with a warning instead of letting a connection error abort the entire FastAPI lifespan on startup. Closes HB_SCHEDULER_STARTUP_HARD_DEPENDENCY." ;
    rdfs:seeAlso <https://github.com/kurtcagle/holon-bridge-python/pull/25> .

hb:release-2026-09-27-c a hb:ReleaseNote ;
    dcterms:date "2026-09-27"^^xsd:date ;
    rdfs:label "Fixed invalid Turtle in text-index provisioning" ;
    dcterms:description "text:map collection items were being comma-joined, which is invalid Turtle and took down every dataset on the instance when Fuseki's directory-config loader hit it. Fixed the join separator and added a parse-before-write safety check." ;
    rdfs:seeAlso <https://github.com/kurtcagle/holon-bridge-python/pull/26> .

hb:release-2026-09-27-d a hb:ReleaseNote ;
    dcterms:date "2026-09-27"^^xsd:date ;
    rdfs:label "End-to-end verification of dataset text-search provisioning" ;
    dcterms:description "Confirmed offline backfill (jena.textindexer) against chloe's pre-existing data, live auto-indexing of new writes against a fresh test2 dataset, and documented the per-dataset identity-bootstrap requirement for AnimusDep-gated writes on a brand-new dataset." ;
    rdfs:seeAlso <https://github.com/kurtcagle/holon-bridge-python/blob/main/docs/provisioning-new-dataset-for-search.databook.md> .

hb:release-2026-09-29-a a hb:ReleaseNote ;
    dcterms:date "2026-09-29"^^xsd:date ;
    rdfs:label "Delegation: revocable, time-boxed read/write access to a Person's own persona graphs" ;
    dcterms:description "Added holon:Delegation (holonbridge/delegation.py, routes/delegation.py, shapes/delegation.ttl) and the create_delegation, revoke_delegation and list_delegations MCP tools. acl.check_write and acl.authorize_query honour an active delegation; check_replace never does. Covers only the delegator's own persona-user graphs, never confers replace, admin or a Role, and a deactivated delegator's delegations stop working immediately." ;
    rdfs:seeAlso <https://github.com/kurtcagle/holon-bridge-python/pull/27> .

hb:release-2026-09-29-b a hb:ReleaseNote ;
    dcterms:date "2026-09-29"^^xsd:date ;
    rdfs:label "GET /holon and get_holon gain on_behalf_of" ;
    dcterms:description "Reads a delegator's scope restricted to exactly the graphs a read delegation names; the one deliberate, guarded exception to callers only ever getting their own scope. Refused with a 403 when no active read delegation exists." ;
    rdfs:seeAlso <https://github.com/kurtcagle/holon-bridge-python/pull/27> .

hb:release-2026-09-29-c a hb:ReleaseNote ;
    dcterms:date "2026-09-29"^^xsd:date ;
    rdfs:label "Request-supplied IRIs validated before reaching generated Turtle or SPARQL" ;
    dcterms:description "delegation.safe_iri refuses characters that could change a generated statement's structure, and literals now escape control characters. Regression tests fail if either layer is removed." ;
    rdfs:seeAlso <https://github.com/kurtcagle/holon-bridge-python/pull/27> .
```
