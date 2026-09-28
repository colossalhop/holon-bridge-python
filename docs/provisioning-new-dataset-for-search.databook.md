---
id: https://w3id.org/databook/provisioning-new-dataset-for-search-v1
title: "Provisioning a New Fuseki Dataset for Full-Text Search"
type: databook
version: 1.0.0
created: 2026-09-27
author:
  - name: Kurt Cagle
    iri: https://holongraph.com/people/kurt-cagle
    role: orchestrator
  - name: Claude Sonnet 5
    role: transformer
description: >
  Step-by-step procedure for standing up a brand-new Fuseki dataset on this
  instance and getting Lucene full-text search (and SHACL) working on it,
  end to end. Written directly from a real first run against `chloe` and a
  clean second run against `test2` on 2026-09-27 -- including the two
  things that actually went wrong the first time and how each is now
  avoided or handled.
process:
  transformer: "Claude Sonnet 5"
  transformer_type: llm
  transformer_iri: https://api.anthropic.com/v1/models/claude-sonnet-5
  inputs:
    - iri: https://github.com/kurtcagle/holon-bridge-python/blob/main/holonbridge/provisioning.py
      role: reference
    - iri: https://github.com/kurtcagle/holon-bridge-python/blob/main/holonbridge/bootstrap.py
      role: reference
    - iri: https://github.com/kurtcagle/holon-bridge-python/pull/24
      role: primary
    - iri: https://github.com/kurtcagle/holon-bridge-python/pull/26
      role: primary
  timestamp: 2026-09-27T23:50:00Z
  agent:
    name: Claude Sonnet 5
    role: orchestrator
---

## Overview

Getting a new Fuseki dataset from "doesn't exist" to "has SHACL and full-text
search working end to end" is seven steps, three of which are manual and
four of which go through `holon-bridge-python`. None of it is hard, but the
order matters, and skipping the identity-bootstrap step in particular
produces an error message (`no Person found for GitHubIdentity identifier
...`) that doesn't obviously point back at "this dataset is empty."

This assumes Fuseki and the bridge are running on the same machine (true of
the current `holongraph` bank), directory-mode configuration (one `.ttl`
file per dataset under `run/configuration/`), and that `FUSEKI_CONFIG_DIR`
is already set on the bridge process.

## Prerequisites

- `FUSEKI_CONFIG_DIR` set in the bridge's `.env`, pointing at Fuseki's
  `run/configuration/` directory.
- The bridge running as `holonbridge-bootstrap-admin` (or
  `python -m holonbridge.bootstrap`) -- part of the same install, not a
  separate thing to set up.
- Admin animus on your own credential (the same role `act_as` requires).

## Step 1 — Create the assembler file

Dataset creation itself is **not** automated, on purpose -- see
`routes/dataset_admin.py`'s own docstring: it's a destructive, server-level
capability that the bridge deliberately keeps out of the shared-bearer-token
surface until per-caller accountability (HB_PER_PERSON_AUTH) lands. Create
`run/configuration/{name}.ttl` by hand:

```turtle
PREFIX :       <http://base/#>
PREFIX fuseki: <http://jena.apache.org/fuseki#>
PREFIX ja:     <http://jena.hpl.hp.com/2005/11/Assembler#>
PREFIX rdf:    <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
PREFIX rdfs:   <http://www.w3.org/2000/01/rdf-schema#>
PREFIX tdb2:   <http://jena.apache.org/2016/tdb#>

:service_tdb_all  rdf:type            fuseki:Service;
        rdfs:label                    "TDB2 {name}";
        fuseki:dataset                :tdb_dataset_readwrite;
        fuseki:name                   "{name}";
        fuseki:serviceQuery           "query" , "sparql" , "";
        fuseki:serviceReadGraphStore  "get";
        fuseki:serviceReadWriteGraphStore
                "data";
        fuseki:serviceUpdate          "" , "update";
        fuseki:serviceUpload          "upload" ;
        fuseki:endpoint [ fuseki:operation fuseki:shacl ;
                          fuseki:name "shacl" ] .

:tdb_dataset_readwrite
        rdf:type       tdb2:DatasetTDB2;
        tdb2:location  "c:\\Apache\\apache-jena-fuseki-6.1.0\\run/databases/{name}" .
```

Replace `{name}` in all four places (label, dataset name, TDB2 location).
The `fuseki:endpoint [ fuseki:operation fuseki:shacl ; ... ]` block gives
you the SHACL validation endpoint from the start, at no extra cost --
worth always including even if you don't need it immediately.

## Step 2 — Restart Fuseki, confirm the dataset exists

Restart Fuseki so it re-reads `run/configuration/`. Then, from the bridge
(any MCP session or a direct `GET /datasets`), confirm the new dataset
shows up in `list_datasets` with `state: true` and a `shacl` entry in its
`services` list.

## Step 3 — Bootstrap an admin identity

A brand-new dataset's `holons` graph is empty, which means it has no
`Person` record for anyone -- including you. Every `AnimusDep`-gated route
(which is almost everything, including a plain `sparql_update`) will 401
with `no Person found for GitHubIdentity identifier '{your-github-login}'`
until this is done once:

```
C:\ProgramData\holon-bridge-python\.venv\Scripts\python.exe -m holonbridge.bootstrap ^
    --slug kurt --name "Kurt Cagle" --github-user kurtcagle ^
    --dataset {name} --bank holongraph
```

(Or the `holonbridge-bootstrap-admin` console script directly, same flags,
if the venv is already active.) This bypasses `AnimusDep` on purpose --
see `holonbridge/bootstrap.py`'s module docstring, it exists specifically
because the ordinary REST API has no route that can create the first
identity a fresh dataset needs before any of its other routes will run.
Idempotent: safe to re-run, a no-op if the identity already exists.

## Step 4 — Provision the text index

```
provision_text_index(dataset="{name}", commit=false)
```

Always preview first. Nine default fields come for free (`rdfs:label`,
`rdfs:comment`, `skos:prefLabel`/`altLabel`/`definition`/`comment`,
`dcterms:title`, `sh:name`, `sh:description`) -- vocabulary-level, safe
defaults for any dataset. Add fields specific to this dataset's own
schema via `extra_predicates`, e.g.:

```
extra_predicates=[{"field": "noteText", "prefix": "chloe", "local": "noteText"}]
```

any prefix used there must already be declared in the dataset's own `.ttl`
file, or the call refuses rather than guess at a namespace IRI. Once the
preview looks right, re-run with `commit=true`.

## Step 5 — Restart Fuseki again

Config-file changes only take effect on the next Fuseki restart --
`provision_text_index` never restarts it for you, by design.

## Step 6 — Backfill, only if the dataset already had data before the index existed

`jena-text` indexes new writes automatically from here on, with zero
further action -- confirmed live: an `INSERT DATA` into `test2` right
after its restart was searchable immediately, no reindex needed.

But it does **not** retroactively index anything that was already in the
dataset before the `text:TextDataset` wrapper existed. If you just added
search to a dataset that already had real data in it (as with `chloe`),
run the one-time offline backfill:

1. **Stop Fuseki.** The indexer opens the TDB2 store directly; it cannot
   run alongside a Fuseki holding the same files open.
2. ```
   java -cp C:\Apache\apache-jena-fuseki-6.1.0\fuseki-server.jar jena.textindexer --desc=C:\Apache\apache-jena-fuseki-6.1.0\run\configuration\{name}.ttl
   ```
3. **Start Fuseki again.**

Skip this step entirely for a dataset that was empty when the index was
added -- there's nothing to backfill.

## Step 7 — Confirm it works

```sparql
PREFIX text: <http://jena.apache.org/text#>
SELECT ?s ?score ?hit WHERE {
  (?s ?score ?hit) text:query (rdfs:label "something you know is in there" 5) .
}
```

Swap `rdfs:label` for any other indexed predicate (including an
`extra_predicates` one). A real hit comes back with a subject and a
relevance score.

## What went wrong the first time, and why it won't again

**A syntax bug took the whole Fuseki instance down, not just one dataset.**
The first `provision_text_index` implementation joined the entityMap's
`text:map ( ... )` collection items with commas -- valid between objects
in a predicate-object list, invalid inside a Turtle collection (which is
whitespace-separated only). Because Fuseki's own
`readConfigurationDirectory` aborts the *entire* server on one bad
assembler file rather than skipping it, every dataset on the instance went
down over one comma. Fixed twice over: the join separator is now
whitespace, and the tool now parses its own generated content with
`holonbridge.turtle.parse` before writing or previewing anything -- a
syntax error is a raised error now, never a file that looks fine until the
next restart finds out otherwise. (See PR #26.)

**A fresh dataset 401s on its very first write.** Not a bug -- identity
resolution is per-dataset, keyed off that dataset's own `holons` graph, so
a dataset with no `Person` record yet has no way to authorise anyone,
including its own operator. Step 3 above is the fix, and it's a
one-time cost per dataset.

## Reusable test query

<!-- databook:id: validate-text-search -->
<!-- databook:label: Confirm a text index is live and returning scored hits -->
```sparql
PREFIX text: <http://jena.apache.org/text#>
PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>

SELECT ?s ?score ?hit WHERE {
  (?s ?score ?hit) text:query (rdfs:label "test" 5) .
}
```
