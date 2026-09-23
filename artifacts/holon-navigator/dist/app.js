(function(){
  var SERVER = "Holonbridge-Workbench";
  // Every holon-bridge connector this page knows how to talk to, and the
  // Bank/Dataset it should land on the moment someone switches to it (the
  // pair actually reachable on THAT connector's bridge -- Holonbridge-
  // Workbench's "holongraph" bank/"worldtest" dataset mean nothing to
  // CS-HB-MCP4's own "local" bank, and vice versa). onServerChange() reads
  // this to reset BANK/DATASET before reconnecting; a connector added here
  // later also needs an entry in the published artifact's
  // capabilities.mcp.servers manifest, or its calls will be refused.
  var CONNECTORS = {
    "Holonbridge-Workbench": {bank: "holongraph", dataset: "worldtest"},
    "CS-HB-MCP4": {bank: "local", dataset: "acmeco"}
  };
  // BANK/DATASET/HOLONS_GRAPH/ONTOLOGY_GRAPH/SHACL_GRAPH/HOME_IRI are all
  // mutable, not fixed constants -- "worldtest" on the "holongraph" bank is
  // only the STARTING point. enterDataset() (added 2026-09-15, alongside
  // the Bank/Dataset pickers in the topbar) reassigns every one of these
  // after a switch: the three graph IRIs come straight back from
  // get_endpoint()'s own `graphs` map rather than being re-derived by
  // string-pattern here, since a different bank's server could in
  // principle name them differently even though every bank observed so
  // far (holongraph: worldtest, apas) follows the same
  // "urn:holongraph:{dataset}:{holons|ontology|shacl}" convention; HOME_IRI
  // is resolved per-dataset by querying for a holon:Home instance in the
  // (now-current) holons graph -- see homeQuery() and enterDataset() below.
  // A dataset with no holon:Home yet is "unbound": enterDataset() detects
  // that and offers to mint one instead of trying to boot the rest of the
  // app against a dataset with nothing in it to show.
  var BANK = "holongraph";
  var DATASET = "worldtest";
  var HOLONS_GRAPH = "urn:holongraph:worldtest:holons";
  var ONTOLOGY_GRAPH = "urn:holongraph:worldtest:ontology";
  var SHACL_GRAPH = "urn:holongraph:worldtest:shacl";
  var HOLON_CLASS = "https://w3id.org/holon/Holon";
  var HOME_IRI = null;
  // Bumped at the start of every enterDataset() call; a stale async
  // callback (a watchTool event or a promise chain) that captured an
  // earlier generation number checks it before touching shared state or
  // the DOM, so a fast double-switch (or a switch fired while a slow
  // request from the PREVIOUS dataset is still in flight) can't have the
  // old dataset's data clobber the new dataset's already-rendered view.
  var datasetGeneration = 0;

  // Global "loading" indicator -- the slim bar fixed to the top of the
  // viewport (#globalProgress, styled above). Rather than instrument each
  // of the ~50 call sites that talk to Holonbridge-Workbench individually,
  // every one of them calls callTool() below instead of mcp.callTool()
  // directly; callTool() is a drop-in wrapper with the same signature and
  // return value, so it needs no changes to any existing .then()/.catch()
  // chain. activeRequests counts calls in flight (not sub-second-fast
  // single lookups specifically, but ANY bridge call: tree expansion, a
  // detail load, a save, a dataset switch) so two overlapping calls don't
  // let the bar disappear after only the first one finishes.
  var activeRequests = 0;
  var $globalProgress = document.getElementById('globalProgress');
  function beginLoad(){
    activeRequests++;
    if ($globalProgress) $globalProgress.classList.add('active');
  }
  function endLoad(){
    activeRequests = Math.max(0, activeRequests - 1);
    if (activeRequests === 0 && $globalProgress) $globalProgress.classList.remove('active');
  }
  function callTool(server, tool, args){
    beginLoad();
    return mcp.callTool(server, tool, args).then(
      function(res){ endLoad(); return res; },
      function(err){ endLoad(); throw err; }
    );
  }

  var STATUS_PREDICATE = "https://w3id.org/holon/status";
  // Deprecation reuses the same holon:status predicate this dataset already
  // puts on holons (holon:RegisteredStatus, holon:ConsumedStatus, and
  // holon:TombstonedStatus for a retired holon) -- holon:DeprecatedStatus is
  // a new individual in that same family, applied to a skos:Concept or
  // skos:ConceptScheme instead. Like the existing status values, it needs
  // no formal ontology declaration of its own (none of the others have
  // one either); it's just a value this viewer recognises.
  //
  // STATUS_PREDICATE and DEPRECATED_STATUS_IRI are declared up here,
  // ahead of DEPRECATED_SET_QUERY below, rather than down near the other
  // status/predicate constants -- this script runs top-to-bottom as one
  // IIFE, and DEPRECATED_SET_QUERY's string concatenation needs both
  // already assigned at the time it runs, not just hoisted as `var`
  // declarations. Moved 2026-09-12 after finding they'd been declared
  // (and correctly used everywhere else) far below this point, so every
  // build of DEPRECATED_SET_QUERY was silently baking in the literal text
  // "<undefined>" for both -- a query that can never match anything,
  // which is why deprecatedSet always came back empty and no Deprecate/
  // Reactivate toggle, anywhere in the app, ever visibly did anything.
  var DEPRECATED_STATUS_IRI = "https://w3id.org/holon/DeprecatedStatus";
  // Containment for the tree view: holon:isPartOf is the generic holon
  // relation; geo:administrativePartOf is a genuine rdfs:subPropertyOf it
  // (Continent -> Country -> City) but the dataset carries no RDFS
  // entailment, so both are named explicitly via a property path.
  var ISPARTOF_PREDICATE = "https://w3id.org/holon/isPartOf";
  var ADMIN_PARTOF_PREDICATE = "https://w3id.org/data/ontology/geography#administrativePartOf";
  var PART_OF_PATH = "<" + ISPARTOF_PREDICATE + ">|<" + ADMIN_PARTOF_PREDICATE + ">";

  // geo:administrativePartOf's own rdfs:comment in the ontology graph is
  // explicit: "Spatial/administrative containment in the Continent ->
  // Country -> City sense, as distinct from holon:isPartOf's orbital-system
  // sense". These are the classes that chain participates in -- confirmed
  // empirically (2026-09-14) against every pre-existing containment triple
  // between two of them (22 Continent->Country, 32 City->Country/
  // ConstituentCountry, 7 District->City -- zero counterexamples) before
  // adding FederatedState, which no instance yet occupies but whose own
  // SHACL shape (FederatedStateShape's isContiguousWith) already groups it
  // with Country/ConstituentCountry in the same administrative family.
  var GEO_ADMIN_PLACE_KINDS = [
    "https://w3id.org/data/ontology/geography#Continent",
    "https://w3id.org/data/ontology/geography#Country",
    "https://w3id.org/data/ontology/geography#ConstituentCountry",
    "https://w3id.org/data/ontology/geography#FederatedState",
    "https://w3id.org/data/ontology/geography#District",
    "https://w3id.org/data/ontology/geography#City"
  ];
  function isGeoAdminPlaceKind(types){
    return (types || []).some(function(t){ return GEO_ADMIN_PLACE_KINDS.indexOf(t) !== -1; });
  }
  // The single place that decides which containment predicate a NEW
  // isPartOf-style link should use: geo:administrativePartOf when both
  // ends are geography admin place-kinds, holon:isPartOf otherwise (the
  // orbital-system sense -- Moon->Planet -- and everything non-geographic).
  // Added 2026-09-14 after Kurt caught several interface-created holons
  // (Greece/Poland/The Netherlands/India under their continents; Warsaw/
  // Beijing/Amsterdam/Brussels/Swansea under their countries) carrying the
  // generic predicate while every hand-authored instance of the same
  // Continent->Country->City chain used the specific one. Every creation
  // path (buildCreateTurtle, Add Child's "attach existing", the Parent/
  // Child Holon(s) relationship fields) now calls this instead of each one
  // separately hardcoding ISPARTOF_PREDICATE, so the choice stays
  // consistent everywhere a containment link gets minted.
  function containmentPredicateFor(parentTypes, childTypes){
    return (isGeoAdminPlaceKind(parentTypes) && isGeoAdminPlaceKind(childTypes))
      ? ADMIN_PARTOF_PREDICATE
      : ISPARTOF_PREDICATE;
  }
  function typesOfIri(targetIri){
    var h = holons.find(function(x){ return x.iri === targetIri; });
    return h ? h.types : [];
  }
  // Connections for the tree view: holon:isConnectedTo is the generic,
  // symmetric, non-containment counterpart to holon:isPartOf (see the
  // comment on connectionsQuery below) -- every domain-specific relation
  // that participates in it (geo:crosses, holon:affiliation,
  // worldtest:headquarters, ...) declares itself as rdfs:subPropertyOf it
  // in the ontology graph, with no entailment active, so connectionsQuery
  // walks that chain itself via a property path rather than hardcoding
  // any domain-specific predicate name.
  var IS_CONNECTED_TO_PREDICATE = "https://w3id.org/holon/isConnectedTo";

  // The full family of containment predicates THIS dataset actually uses --
  // every ?p with ?p rdfs:subPropertyOf* holon:isPartOf in the ontology
  // graph, discovered live rather than assumed. Added 2026-09-15 after
  // switching this viewer to browse datasets beyond worldtest exposed a real
  // bug: the Containment Tree and the detail panel's Parent/Child Holon(s)
  // fields both hardcoded exactly PART_OF_PATH's two names (holon:isPartOf,
  // geo:administrativePartOf), so bridgerton -- whose entire org-unit tree
  // runs on sl:isPartOfOrg, a genuine rdfs:subPropertyOf holon:isPartOf that
  // simply isn't either of those two IRIs -- showed a League with clubs but
  // every club showing zero children, since Team/Board->Club links use only
  // sl:isPartOfOrg. get_holon's own neighbourhood queries never had this bug
  // (they always discovered the family live); the tree/detail queries below
  // now do the same rather than hardcoding a fixed list. Cached per dataset
  // (cleared in resetDatasetState) since it's ontology-wide schema info, not
  // per-holon, like loadInverseNames/loadEnumSchemes/loadDeprecatedSet.
  var PART_OF_PREDICATES_QUERY = [
    "PREFIX holon: <https://w3id.org/holon/>",
    "PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>",
    "SELECT DISTINCT ?p WHERE { ?p rdfs:subPropertyOf* holon:isPartOf }"
  ].join("\n");
  var partOfPredicatesPromise = null;

  function loadPartOfPredicates(){
    if (!partOfPredicatesPromise){
      partOfPredicatesPromise = callTool(SERVER, 'sparql_select', {query: PART_OF_PREDICATES_QUERY, graph: ONTOLOGY_GRAPH})
        .then(function(res){
          var bindings = (res.payload && res.payload.results && res.payload.results.bindings) || [];
          var set = {};
          bindings.forEach(function(b){ set[b.p.value] = true; });
          set[ISPARTOF_PREDICATE] = true;   // always counts, even with zero ontology declarations
          return set;
        })
        .catch(function(){
          var fallback = {};
          fallback[ISPARTOF_PREDICATE] = true;
          fallback[ADMIN_PARTOF_PREDICATE] = true;
          return fallback;
        });
    }
    return partOfPredicatesPromise;
  }

  // ORDER BY LCASE(STR(?label)), not ORDER BY ?label: Jena orders RDF
  // terms by kind before value, so every plain-literal label (the older
  // holons, "Africa") sorted ahead of every language-tagged one (anything
  // created since labels became "..."@en, "Antarctica"@en) -- which is why
  // new holons always landed in a second alphabetical run at the bottom of
  // the All Holons list. It was also case-sensitive ("the Eiffel Tower"
  // after "Wren"). Sorting on the lowercased lexical form ignores both.
  // loadList() re-sorts client-side with localeCompare as well, so the
  // list order never depends on the endpoint's collation.
  var LIST_QUERY = [
    "PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>",
    "SELECT ?holon ?label (GROUP_CONCAT(DISTINCT STR(?type); separator=\"|\") AS ?types) WHERE {",
    "  ?holon a <" + HOLON_CLASS + "> ; rdfs:label ?label .",
    "  OPTIONAL { ?holon a ?type . FILTER(?type != <" + HOLON_CLASS + ">) }",
    "} GROUP BY ?holon ?label ORDER BY LCASE(STR(?label))"
  ].join("\n");

  function detailQuery(iri){
    return "SELECT ?p ?o WHERE { <" + iri + "> ?p ?o }";
  }

  // The inverse of detailQuery -- every holon that points AT `iri`, via
  // any predicate. Left ungrouped (unlike LIST_QUERY/childrenQuery's
  // GROUP_CONCAT pattern) because loadReferences groups these client-side
  // by PREDICATE, not by subject -- mirroring how the Properties kv list
  // groups values under one key, so several referencing holons that share
  // a predicate (e.g. several Members of the same Organization) render as
  // one row with several chips, not one row each.
  function referencesQuery(iri){
    return [
      "PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>",
      "SELECT ?s ?p ?label WHERE {",
      "  ?s ?p <" + iri + "> ; a <" + HOLON_CLASS + "> ; rdfs:label ?label .",
      "}"
    ].join("\n");
  }

  // Every sh:inverseName ever declared on a property shape, keyed by the
  // property's sh:path -- this is a custom annotation (not core SHACL) this
  // dataset uses to give the inverse of a directed relation a proper name
  // (e.g. holon:affiliation's forward name is "Affiliation"; its
  // inverseName is "Member"), consumed only by the References section. A
  // predicate with several property-shape declarations (one per targetClass)
  // is expected to carry the same inverseName on all of them; first value
  // seen wins if they ever disagree. Loaded once and cached for the session,
  // like loadShapeTargetClasses/loadClassHierarchy -- it's dataset-wide
  // schema metadata, not per-holon.
  var INVERSE_NAME_QUERY = [
    "PREFIX sh: <http://www.w3.org/ns/shacl#>",
    "SELECT ?path ?inverseName WHERE {",
    "  ?shape sh:property ?prop .",
    "  ?prop sh:path ?path ; sh:inverseName ?inverseName .",
    "}"
  ].join("\n");
  var inverseNamesPromise = null;

  function loadInverseNames(){
    if (!inverseNamesPromise){
      inverseNamesPromise = callTool(SERVER, 'sparql_select', {query: INVERSE_NAME_QUERY, graph: SHACL_GRAPH})
        .then(function(res){
          var bindings = (res.payload && res.payload.results && res.payload.results.bindings) || [];
          var map = {};
          bindings.forEach(function(b){ if (!map[b.path.value]) map[b.path.value] = b.inverseName.value; });
          return map;
        })
        .catch(function(){ return {}; });
    }
    return inverseNamesPromise;
  }

  // Which sh:in-enumerated property paths are backed by a real SKOS
  // taxonomy (a skos:ConceptScheme in the ontology graph), and which
  // scheme. Not every sh:in field qualifies -- holon:controllerType's list
  // is plain string literals, and schema:healthStatus's IRIs carry no
  // skos:Concept typing or skos:inScheme -- so this is discovered per-path
  // by checking whether the *existing* sh:in values actually resolve to a
  // skos:Concept, rather than assumed from the control type. Only a path
  // that comes back with a scheme here gets the "+ New value" affordance in
  // the shape-driven property editor, since only for those is "create a new
  // one" a well-defined operation (mint a concept in that scheme, then
  // splice it into every sh:in list sharing this path -- see
  // buildAppendConceptToInSparql). Loaded once and cached for the session,
  // like loadInverseNames/loadShapeTargetClasses.
  var ENUM_SCHEME_QUERY = [
    "PREFIX sh: <http://www.w3.org/ns/shacl#>",
    "PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>",
    "PREFIX skos: <http://www.w3.org/2004/02/skos/core#>",
    // Jena's ARQ rejects aggregating a variable into an output of the same
    // name (?scheme -> (SAMPLE(?scheme) AS ?scheme) is a parse error --
    // "Variable used when already in-scope") -- ?schemeOut sidesteps that.
    "SELECT ?path (SAMPLE(?scheme) AS ?schemeOut) WHERE {",
    "  GRAPH <" + SHACL_GRAPH + "> {",
    "    ?shape sh:property ?prop .",
    "    ?prop sh:path ?path ; sh:in ?inList .",
    "    ?inList rdf:rest*/rdf:first ?inVal .",
    "  }",
    "  GRAPH <" + ONTOLOGY_GRAPH + "> {",
    "    ?inVal a skos:Concept ; skos:inScheme ?scheme .",
    "  }",
    "} GROUP BY ?path"
  ].join("\n");
  var enumSchemesPromise = null;

  function loadEnumSchemes(){
    if (!enumSchemesPromise){
      enumSchemesPromise = callTool(SERVER, 'sparql_select', {query: ENUM_SCHEME_QUERY})
        .then(function(res){
          var bindings = (res.payload && res.payload.results && res.payload.results.bindings) || [];
          var map = {};
          bindings.forEach(function(b){ map[b.path.value] = b.schemeOut.value; });
          return map;
        })
        .catch(function(){ return {}; });
    }
    return enumSchemesPromise;
  }

  // The namespace a new concept for this path's enum should be minted
  // under -- derived from an existing sh:in value's own IRI (everything up
  // to its last "/") rather than hardcoded per-predicate, so this keeps
  // working if a scheme's namespace ever changes or a new SKOS-backed enum
  // is added later.
  function conceptNamespaceFor(existingIri){
    var idx = existingIri.lastIndexOf('/');
    return idx === -1 ? existingIri : existingIri.slice(0, idx + 1);
  }

  // Mints a brand-new skos:Concept in the given scheme. The full definition
  // (skos:inScheme, skos:prefLabel) lives in ONTOLOGY_GRAPH, matching every
  // existing concept there. But every pre-existing concept ALSO has a
  // lightweight mirror asserted directly in HOLONS_GRAPH -- just
  // "a skos:Concept ; rdfs:label "..."@en", no skos:inScheme/skos:prefLabel
  // -- because SHACL validation on this dataset (push_turtle's shapes_graph)
  // is scoped to the holons+shacl graphs, not unioned with the ontology
  // graph, so an sh:class skos:Concept check can only ever see that mirror.
  // Without it, a value using a freshly-minted concept fails validation even
  // though the concept is "real" in the ontology graph. (Confirmed against
  // Euro/Human/English/PoundSterling, all of which carry exactly this
  // mirror shape.) Both graphs are written in one INSERT DATA so a concept
  // is never left half-created.
  function buildCreateConceptSparql(iri, label, scheme){
    return [
      "PREFIX skos: <http://www.w3.org/2004/02/skos/core#>",
      "PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>",
      "INSERT DATA {",
      "  GRAPH <" + ONTOLOGY_GRAPH + "> {",
      "    <" + iri + "> a skos:Concept ;",
      "      skos:inScheme <" + scheme + "> ;",
      "      skos:prefLabel " + langLiteral(label) + " .",
      "  }",
      "  GRAPH <" + HOLONS_GRAPH + "> {",
      "    <" + iri + "> a skos:Concept ;",
      "      rdfs:label " + langLiteral(label) + " .",
      "  }",
      "}"
    ].join("\n");
  }

  // sh:in is a closed list -- minting the concept above isn't enough to
  // make it a valid value, since SHACL checks membership in the literal
  // RDF list, not "any skos:Concept in this scheme". This splices the new
  // IRI onto the end of *every* sh:in list that shares this path, across
  // every NodeShape that declares one (solar-system#bodyType, for example,
  // has two separate property shapes with two separate lists -- a new body
  // type needs appending to both, or it would validate for one target
  // class but not the other). Same last-node-swap technique used to add
  // geo:District to PlaceKindExclusivityShape's sh:xone: find each list's
  // terminal node (?lastNode rdf:rest rdf:nil) and replace that rdf:nil
  // with a fresh one-element tail. SPARQL Update mints one fresh blank node
  // per WHERE solution, so this is safe even when several distinct lists
  // match at once.
  function buildAppendConceptToInSparql(path, newIri){
    return [
      "PREFIX sh: <http://www.w3.org/ns/shacl#>",
      "PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>",
      "DELETE {",
      "  GRAPH <" + SHACL_GRAPH + "> { ?lastNode rdf:rest rdf:nil }",
      "}",
      "INSERT {",
      "  GRAPH <" + SHACL_GRAPH + "> {",
      "    ?lastNode rdf:rest _:newNode .",
      "    _:newNode rdf:first <" + newIri + "> .",
      "    _:newNode rdf:rest rdf:nil .",
      "  }",
      "}",
      "WHERE {",
      "  GRAPH <" + SHACL_GRAPH + "> {",
      "    ?shape sh:property ?prop .",
      "    ?prop sh:path <" + path + "> ; sh:in ?listHead .",
      "    ?listHead rdf:rest* ?lastNode .",
      "    ?lastNode rdf:rest rdf:nil .",
      "  }",
      "}"
    ].join("\n");
  }

  // ---- Taxonomies: skos:ConceptScheme / skos:Concept CRUD ---------------
  // Everything below backs the "Taxonomies" tab -- a standalone browser/
  // editor for the SKOS taxonomies themselves (Gender, Species, Agent Kind,
  // Body Type, and whatever new ones get created here), separate from the
  // inline "+ New value..." convenience wired into the shape-driven enum
  // editor above. There is no delete here, by design: matching this
  // dataset's existing "never delete, tombstone instead" convention
  // (holon:TombstonedStatus is already used that way for a retired holon),
  // a Concept or ConceptScheme is deprecated, never removed -- see
  // DEPRECATED_STATUS_IRI above and loadDeprecatedSet below.

  // Every skos:ConceptScheme with its rdfs:label and how many concepts it
  // currently has. (COUNT(?concept) AS ?n) is a differently-named output,
  // so this doesn't hit the "?scheme -> ?scheme" self-aggregation parse
  // error ENUM_SCHEME_QUERY had (fixed 2026-09-11) -- worth naming every
  // aggregate output something other than its input variable as a rule.
  var SCHEME_LIST_QUERY = [
    "PREFIX skos: <http://www.w3.org/2004/02/skos/core#>",
    "PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>",
    "SELECT ?scheme (SAMPLE(?label) AS ?labelOut) (COUNT(?concept) AS ?n) WHERE {",
    "  GRAPH <" + ONTOLOGY_GRAPH + "> {",
    "    ?scheme a skos:ConceptScheme .",
    "    OPTIONAL { ?scheme rdfs:label ?label }",
    "    OPTIONAL { ?concept skos:inScheme ?scheme }",
    "  }",
    "} GROUP BY ?scheme"
  ].join("\n");

  // Every concept in one scheme, with its prefLabel, its skos:definition
  // (0:1 -- SAMPLE is enough, there's never more than one in practice), and
  // any altLabels (0:infinity, GROUP_CONCAT'd, matching the house
  // '|'-separator convention used for multi-valued GROUP_CONCAT elsewhere
  // in this file). SAMPLE for the label too -- a concept has exactly one
  // prefLabel in practice, but GROUP BY still requires every non-grouped,
  // non-aggregated variable to be wrapped.
  function schemeConceptsQuery(schemeIri){
    return [
      "PREFIX skos: <http://www.w3.org/2004/02/skos/core#>",
      "SELECT ?concept (SAMPLE(?label) AS ?labelOut) (SAMPLE(?definition) AS ?definitionOut) (GROUP_CONCAT(DISTINCT ?altLabel; separator=\"|\") AS ?altLabels) WHERE {",
      "  GRAPH <" + ONTOLOGY_GRAPH + "> {",
      "    ?concept skos:inScheme <" + schemeIri + "> .",
      "    OPTIONAL { ?concept skos:prefLabel ?label }",
      "    OPTIONAL { ?concept skos:definition ?definition }",
      "    OPTIONAL { ?concept skos:altLabel ?altLabel }",
      "  }",
      "} GROUP BY ?concept"
    ].join("\n");
  }

  // Every ontology-graph resource currently deprecated (holon:status
  // holon:DeprecatedStatus) -- concepts and schemes alike share one flat
  // set, checked synchronously wherever a concept might be picked or shown.
  var DEPRECATED_SET_QUERY = [
    "SELECT ?s WHERE {",
    "  GRAPH <" + ONTOLOGY_GRAPH + "> { ?s <" + STATUS_PREDICATE + "> <" + DEPRECATED_STATUS_IRI + "> }",
    "}"
  ].join("\n");
  var deprecatedSetPromise = null;

  function loadDeprecatedSet(force){
    if (force) deprecatedSetPromise = null;
    if (!deprecatedSetPromise){
      deprecatedSetPromise = callTool(SERVER, 'sparql_select', {query: DEPRECATED_SET_QUERY})
        .then(function(res){
          var bindings = (res.payload && res.payload.results && res.payload.results.bindings) || [];
          var set = {};
          bindings.forEach(function(b){ set[b.s.value] = true; });
          deprecatedSet = set;
          return set;
        })
        .catch(function(){ return deprecatedSet; });
    }
    return deprecatedSetPromise;
  }

  // Reverse of loadEnumSchemes()'s path -> scheme map: every sh:in path
  // that already draws from this scheme, so a concept minted from the
  // Taxonomies view (not from a specific field's "+ New value...") still
  // gets spliced into every list that should offer it. A scheme with no
  // property shape pointing at it yet (freshly created) simply resolves to
  // an empty list -- its concepts exist but aren't wired into any shape,
  // which matches the "scheme creation is scheme-only" scope agreed on;
  // wiring a new sh:in-based property shape to it is a separate step.
  function pathsForScheme(schemeIri){
    return loadEnumSchemes().then(function(map){
      return Object.keys(map).filter(function(p){ return map[p] === schemeIri; });
    });
  }

  // Fallback namespace for a scheme's first-ever concept, when there's no
  // existing concept IRI to derive one from (conceptNamespaceFor handles
  // every other case). Mirrors the convention every current taxonomy
  // follows -- <scheme's own namespace>/<lowercased local name with the
  // trailing "Scheme" stripped>/ -- e.g. .../taxonomy/SpeciesScheme's
  // sibling concepts live under .../taxonomy/species/.
  function newSchemeConceptNamespace(schemeIri){
    var base = conceptNamespaceFor(schemeIri);
    var local = schemeIri.slice(base.length).replace(/Scheme$/, '');
    var slug = local ? (local.charAt(0).toLowerCase() + local.slice(1)) : 'concepts';
    return base + slug + '/';
  }

  // Mints a brand-new, empty skos:ConceptScheme. Deliberately scheme-only --
  // it isn't usable by the shape-driven property editor until some SHACL
  // property shape's sh:in list actually draws from it (see pathsForScheme
  // above), which is a separate step done by hand or asked for directly.
  function buildCreateSchemeSparql(iri, label){
    return [
      "PREFIX skos: <http://www.w3.org/2004/02/skos/core#>",
      "PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>",
      "INSERT DATA {",
      "  GRAPH <" + ONTOLOGY_GRAPH + "> {",
      "    <" + iri + "> a skos:ConceptScheme ;",
      "      rdfs:label " + langLiteral(label) + " .",
      "  }",
      "}"
    ].join("\n");
  }

  function buildRenameSchemeSparql(iri, newLabel){
    return [
      "PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>",
      "DELETE { GRAPH <" + ONTOLOGY_GRAPH + "> { <" + iri + "> rdfs:label ?old } }",
      "INSERT { GRAPH <" + ONTOLOGY_GRAPH + "> { <" + iri + "> rdfs:label " + langLiteral(newLabel) + " } }",
      "WHERE { OPTIONAL { GRAPH <" + ONTOLOGY_GRAPH + "> { <" + iri + "> rdfs:label ?old } } }"
    ].join("\n");
  }

  function buildRenameConceptSparql(iri, newLabel){
    return [
      "PREFIX skos: <http://www.w3.org/2004/02/skos/core#>",
      "DELETE { GRAPH <" + ONTOLOGY_GRAPH + "> { <" + iri + "> skos:prefLabel ?old } }",
      "INSERT { GRAPH <" + ONTOLOGY_GRAPH + "> { <" + iri + "> skos:prefLabel " + langLiteral(newLabel) + " } }",
      "WHERE { OPTIONAL { GRAPH <" + ONTOLOGY_GRAPH + "> { <" + iri + "> skos:prefLabel ?old } } }"
    ].join("\n");
  }

  // skos:definition is 0:1 -- a plain optional field, exactly like
  // holon:description on a holon (see buildUpdateSparql) or rdfs:label
  // above: DELETE+WHERE always clears whatever was there, and the INSERT
  // block is only added at all when there's a new value to write, so
  // passing an empty string genuinely clears the definition rather than
  // writing an empty literal.
  function buildSetConceptDefinitionSparql(iri, definition){
    var parts = [
      "PREFIX skos: <http://www.w3.org/2004/02/skos/core#>",
      "DELETE { GRAPH <" + ONTOLOGY_GRAPH + "> { <" + iri + "> skos:definition ?old } }"
    ];
    if (definition){
      parts.push("INSERT { GRAPH <" + ONTOLOGY_GRAPH + "> { <" + iri + "> skos:definition " + langLiteral(definition) + " } }");
    }
    parts.push("WHERE { OPTIONAL { GRAPH <" + ONTOLOGY_GRAPH + "> { <" + iri + "> skos:definition ?old } } }");
    return parts.join("\n");
  }

  // skos:altLabel is 0:infinity -- unlike prefLabel/definition there's no
  // single "old value" to replace, so alt labels are added and removed one
  // at a time rather than replaced wholesale. Adding is a grounded
  // INSERT DATA (langLiteral, matching every existing altLabel in this
  // dataset -- confirmed live: they're all @en-tagged, same as prefLabel).
  // Removing matches by STR(?al) rather than the exact tagged literal, so
  // it still finds (and removes) a value regardless of what language tag
  // or datatype it actually carries -- robust to an altLabel that predates
  // this convention or was added by hand without one.
  function buildAddAltLabelSparql(iri, label){
    return [
      "PREFIX skos: <http://www.w3.org/2004/02/skos/core#>",
      "INSERT DATA { GRAPH <" + ONTOLOGY_GRAPH + "> { <" + iri + "> skos:altLabel " + langLiteral(label) + " } }"
    ].join("\n");
  }

  function buildRemoveAltLabelSparql(iri, label){
    return [
      "PREFIX skos: <http://www.w3.org/2004/02/skos/core#>",
      "DELETE { GRAPH <" + ONTOLOGY_GRAPH + "> { <" + iri + "> skos:altLabel ?al } }",
      "WHERE { GRAPH <" + ONTOLOGY_GRAPH + "> { <" + iri + "> skos:altLabel ?al . FILTER(STR(?al) = " + turtleLiteral(label) + ") } }"
    ].join("\n");
  }

  // Deprecate: swaps in holon:DeprecatedStatus, replacing whatever status
  // (if any) was already there. Never touches any other triple -- the
  // concept/scheme's own definition is untouched and fully reversible.
  function buildSetStatusSparql(iri, statusIri){
    return [
      "DELETE { GRAPH <" + ONTOLOGY_GRAPH + "> { <" + iri + "> <" + STATUS_PREDICATE + "> ?old } }",
      "INSERT { GRAPH <" + ONTOLOGY_GRAPH + "> { <" + iri + "> <" + STATUS_PREDICATE + "> <" + statusIri + "> } }",
      "WHERE { OPTIONAL { GRAPH <" + ONTOLOGY_GRAPH + "> { <" + iri + "> <" + STATUS_PREDICATE + "> ?old } } }"
    ].join("\n");
  }

  // Reactivate: removes the status triple entirely, returning to the same
  // implicit-active state every not-yet-deprecated concept/scheme is in.
  function buildClearStatusSparql(iri){
    return [
      "DELETE { GRAPH <" + ONTOLOGY_GRAPH + "> { <" + iri + "> <" + STATUS_PREDICATE + "> ?old } }",
      "WHERE { GRAPH <" + ONTOLOGY_GRAPH + "> { <" + iri + "> <" + STATUS_PREDICATE + "> ?old } }"
    ].join("\n");
  }

  // Children of `parentIri` in the containment tree, each flagged with
  // whether it in turn has children (EXISTS is computed in an inner
  // SELECT — Jena's ARQ rejects a plain-projected EXISTS alongside a
  // GROUP BY in the same scope). Discovers the containment predicate live
  // via rdfs:subPropertyOf* holon:isPartOf against ONTOLOGY_GRAPH, the same
  // way connectionsQuery below always has for isConnectedTo, rather than
  // hardcoding a fixed predicate list -- see the comment on
  // PART_OF_PREDICATES_QUERY above for why. Cross-graph join, so called
  // with no `graph` argument (like connectionsQuery); every graph is named
  // explicitly instead.
  function childrenQuery(parentIri){
    return [
      "PREFIX holon: <https://w3id.org/holon/>",
      "PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>",
      "SELECT ?child ?label (GROUP_CONCAT(DISTINCT STR(?type); separator=\"|\") AS ?types) ?hasChildren WHERE {",
      "  {",
      "    SELECT DISTINCT ?child ?label (EXISTS{",
      "      GRAPH <" + ONTOLOGY_GRAPH + "> { ?gp rdfs:subPropertyOf* holon:isPartOf . }",
      "      GRAPH <" + HOLONS_GRAPH + "> { ?gc ?gp ?child . }",
      "    } AS ?hasChildren) WHERE {",
      "      GRAPH <" + ONTOLOGY_GRAPH + "> { ?p rdfs:subPropertyOf* holon:isPartOf . }",
      "      GRAPH <" + HOLONS_GRAPH + "> {",
      "        ?child ?p <" + parentIri + "> ; rdfs:label ?label .",
      "      }",
      "    }",
      "  }",
      "  OPTIONAL { GRAPH <" + HOLONS_GRAPH + "> { ?child a ?type . FILTER(?type != <" + HOLON_CLASS + ">) } }",
      "} GROUP BY ?child ?label ?hasChildren ORDER BY LCASE(STR(?label))"
    ].join("\n");
  }

  // Connections of `parentIri` for the tree view, shown alongside its
  // containment children (italic, per Kurt) rather than in a separate
  // panel -- every OTHER holon this one points at via a property declared,
  // in the ontology graph, as rdfs:subPropertyOf+ holon:isConnectedTo (the
  // sibling of holon:isPartOf -- see IS_CONNECTED_TO_PREDICATE above and
  // the property's own rdfs:comment). Cross-graph join (data in
  // HOLONS_GRAPH, the subPropertyOf declaration in ONTOLOGY_GRAPH), so
  // this is called with no `graph` argument -- like labelsQuery/
  // classInstancesQuery, it names each GRAPH explicitly rather than
  // relying on a single default graph. hasChildren is computed exactly as
  // childrenQuery does (same live subPropertyOf-of-holon:isPartOf
  // discovery, not a fixed predicate list), so a connection's target can be
  // expanded downward through its OWN containment children like any other
  // tree node; `via` carries the connecting predicate(s), humanised for the
  // row's title.
  function connectionsQuery(parentIri){
    return [
      "PREFIX holon: <https://w3id.org/holon/>",
      "PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>",
      "SELECT ?target ?label (GROUP_CONCAT(DISTINCT STR(?type); separator=\"|\") AS ?types)",
      "       (GROUP_CONCAT(DISTINCT STR(?p); separator=\"|\") AS ?via) ?hasChildren WHERE {",
      "  {",
      "    SELECT DISTINCT ?target ?label ?p (EXISTS{",
      "      GRAPH <" + ONTOLOGY_GRAPH + "> { ?gp2 rdfs:subPropertyOf* holon:isPartOf . }",
      "      GRAPH <" + HOLONS_GRAPH + "> { ?gc ?gp2 ?target . }",
      "    } AS ?hasChildren) WHERE {",
      "      GRAPH <" + HOLONS_GRAPH + "> {",
      "        <" + parentIri + "> ?p ?target .",
      "        ?target a <" + HOLON_CLASS + "> ; rdfs:label ?label .",
      "      }",
      "      GRAPH <" + ONTOLOGY_GRAPH + "> { ?p (rdfs:subPropertyOf)+ <" + IS_CONNECTED_TO_PREDICATE + "> }",
      "    }",
      "  }",
      "  OPTIONAL { GRAPH <" + HOLONS_GRAPH + "> { ?target a ?type . FILTER(?type != <" + HOLON_CLASS + ">) } }",
      "} GROUP BY ?target ?label ?hasChildren ORDER BY LCASE(STR(?label))"
    ].join("\n");
  }

  // A single node's own label/types, for the tree root (Home), which has
  // no parent to be listed as someone else's child.
  function nodeInfoQuery(iri){
    return [
      "PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>",
      "SELECT ?label (GROUP_CONCAT(DISTINCT STR(?type); separator=\"|\") AS ?types) WHERE {",
      "  <" + iri + "> rdfs:label ?label .",
      "  OPTIONAL { <" + iri + "> a ?type . FILTER(?type != <" + HOLON_CLASS + ">) }",
      "} GROUP BY ?label"
    ].join("\n");
  }

  // Finds this dataset's holon:Home instance (see the holon-schema-patterns
  // skill: "exactly one instance expected per dataset" -- the canonical,
  // cross-dataset-stable landing point). Takes the holons graph IRI as a
  // parameter rather than closing over HOLONS_GRAPH directly, since
  // enterDataset() needs to run this against the FRESHLY-resolved graph
  // for whatever dataset is being switched into, before HOLONS_GRAPH
  // itself has necessarily been reassigned. No result means the dataset
  // hasn't been holon-bootstrapped yet ("unbound") -- see
  // renderUnboundState()/buildRootHolonTurtle() below.
  function homeQuery(graphIri){
    return [
      "PREFIX holon: <https://w3id.org/holon/>",
      "PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>",
      "SELECT ?home ?label WHERE {",
      "  GRAPH <" + graphIri + "> { ?home a holon:Home . OPTIONAL { ?home rdfs:label ?label } }",
      "} LIMIT 1"
    ].join("\n");
  }

  // Mints a brand-new holon:Home for a dataset that doesn't have one yet.
  // IRI convention confirmed empirically against the apas dataset (already
  // live on this same "holongraph" bank): its holons graph is
  // urn:holongraph:apas:holons and its Home is urn:holongraph:apas:home --
  // the same graph IRI with its final path segment swapped from "holons"
  // to "home". Deriving it that way (rather than hardcoding a namespace)
  // means this keeps working for a dataset on a differently-named bank too,
  // as long as that bank follows the same holons/home sibling pattern --
  // and if it doesn't, the write still succeeds with a slightly odd IRI
  // rather than failing outright.
  function homeIriFor(graphIri){
    return graphIri.replace(/holons$/, 'home');
  }
  // Dual-typed a holon:Home ; a holon:Holon -- fixed 2026-09-19 after
  // exampleOrg's Home turned out to be typed holon:Home ONLY, which
  // made it silently invisible everywhere in this Navigator (List, By Type,
  // Tree, search): LIST_QUERY requires "?holon a holon:Holon" verbatim to
  // include anything at all, and this tool does no RDFS entailment (a
  // holon:Home rdfs:subClassOf holon:Holon declaration, even if one
  // existed, would never get inferred client-side -- see SUBCLASS_QUERY's
  // comment elsewhere in this file). This same function is what minted that
  // under-typed Home in the first place, so without this fix every freshly
  // bootstrapped dataset would keep reproducing the identical invisible-
  // Home bug going forward.
  function buildRootHolonTurtle(homeIri, label, comment){
    var lines = [
      "@prefix holon: <https://w3id.org/holon/> .",
      "@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .",
      "",
      "<" + homeIri + ">",
      "  a holon:Home, holon:Holon ;",
      "  rdfs:label " + langLiteral(label) + (comment ? " ;" : " .")
    ];
    if (comment) lines.push("  rdfs:comment " + langLiteral(comment) + " .");
    return lines.join("\n");
  }

  // rdfs:subClassOf pairs from the ontology graph, fetched once at startup,
  // so the viewer can tell a "kind" subclass (geo:River, geo:District, ...)
  // from the base class it always co-occurs with (geo:GeoFeature) on the
  // same holon -- this dataset carries no RDFS entailment, so a holon that
  // is both is genuinely double-typed in the data, not inferred.
  var directSuper = {};       // type IRI -> [supertype IRI, ...]
  var ancestorCache = {};     // type IRI -> {ancestor IRI: true, ...} (transitive)

  var SUBCLASS_QUERY = "SELECT ?sub ?sup WHERE { ?sub <http://www.w3.org/2000/01/rdf-schema#subClassOf> ?sup }";

  // Every class any SHACL NodeShape targets, fetched once at startup so the
  // By Type view can show a header (and an Add button) for a domain type
  // even before it has a single instance -- e.g. sol:Vehicle, added to the
  // taxonomy with no bodies in it yet.
  var SHAPE_TARGET_CLASSES_QUERY = "PREFIX sh: <http://www.w3.org/ns/shacl#> SELECT DISTINCT ?targetClass WHERE { ?shape sh:targetClass ?targetClass }";
  var shapeTargetClasses = [];

  function loadShapeTargetClasses(){
    return callTool(SERVER, 'sparql_select', {query: SHAPE_TARGET_CLASSES_QUERY, graph: SHACL_GRAPH})
      .then(function(res){
        var bindings = (res.payload && res.payload.results && res.payload.results.bindings) || [];
        shapeTargetClasses = bindings.map(function(b){ return b.targetClass.value; });
      })
      .catch(function(){ /* best-effort: By Type just won't pre-list shape-only types */ });
  }

  // Which child TYPES a parent's own NodeShape actually permits, read
  // straight from the SHACL rather than guessed: a property shape whose
  // sh:path is [sh:inversePath holon:isPartOf] describes "things that name
  // ME as their holon:isPartOf parent" -- i.e. exactly this shape's
  // permitted children -- and its sh:class (or, for an sh:or list, each
  // alternative's sh:class) says which classes those must be. This is how
  // sol:StellarSystemShape/StarShape/PlanetShape declare Star/Planet/Moon
  // as the only legal isPartOf child of each respectively (added
  // 2026-09-12, alongside reparenting every planet from the stellar system
  // straight to its star, so a multi-star system like Alpha Centauri can
  // still give each star its own planets rather than flattening everything
  // onto the system itself). Most NodeShapes in this dataset don't declare
  // this at all -- permittedChildTypesFor() below treats that as
  // "unrestricted", so nothing elsewhere in the graph is affected by a
  // constraint that was never written for it.
  var CHILD_TYPE_CONSTRAINTS_QUERY = [
    "PREFIX sh: <http://www.w3.org/ns/shacl#>",
    "PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>",
    "SELECT ?targetClass ?class WHERE {",
    "  ?shape sh:targetClass ?targetClass ; sh:property ?prop .",
    "  ?prop sh:path ?pathNode .",
    "  ?pathNode sh:inversePath <" + ISPARTOF_PREDICATE + "> .",
    "  {",
    "    ?prop sh:class ?class .",
    "  } UNION {",
    "    ?prop sh:or ?orList .",
    "    ?orList rdf:rest*/rdf:first ?orMember .",
    "    ?orMember sh:class ?class .",
    "  }",
    "}"
  ].join("\n");
  var childTypeConstraints = {};   // parent type IRI -> [permitted child type IRI, ...]

  function loadChildTypeConstraints(){
    return callTool(SERVER, 'sparql_select', {query: CHILD_TYPE_CONSTRAINTS_QUERY, graph: SHACL_GRAPH})
      .then(function(res){
        var bindings = (res.payload && res.payload.results && res.payload.results.bindings) || [];
        var map = {};
        bindings.forEach(function(b){
          var t = b.targetClass.value, c = b.class.value;
          if (!map[t]) map[t] = [];
          if (map[t].indexOf(c) === -1) map[t].push(c);
        });
        childTypeConstraints = map;
      })
      .catch(function(){ /* best-effort: Add Child just stays unrestricted */ });
  }

  // Merges any constraints declared for a holon's own type set into one
  // permitted-child-type list, or returns null when NONE of its types
  // declare a constraint at all -- null is the "unrestricted, show
  // everything" signal buildAddChildForm checks for, so a parent with no
  // sh:inversePath/isPartOf property anywhere keeps today's open behaviour.
  function permittedChildTypesFor(parentTypes){
    var found = false;
    var set = {};
    (parentTypes || []).forEach(function(t){
      var list = childTypeConstraints[t];
      if (!list) return;
      found = true;
      list.forEach(function(c){ set[c] = true; });
    });
    return found ? Object.keys(set) : null;
  }

  // A property is a "containment echo" -- e.g. sol:orbits on a Moon, whose
  // sh:class is sol:Planet -- when its target class is itself a class that
  // already permits this holon's own type as a child via the
  // sh:inversePath/isPartOf mechanism (childTypeConstraints). Such a
  // property describes the same relationship as holon:isPartOf under a
  // domain-specific name, and is already offered as an "echo" checkbox
  // under + Add Child Holon (see echoPropertiesFor below) -- excluding it
  // here keeps + Add Connection reserved for genuine non-containment
  // relationships (isSiblingOf, memberOf, ...) instead of listing the same
  // property under two different forms. Added 2026-09-12 per Kurt: "would
  // orbits be a parent holon property for a moon, or a connection holon...
  // isSiblingOf is a connection" -- orbits mirrors isPartOf so it stays
  // Add-Child-only; isSiblingOf doesn't (a Moon is never a permitted child
  // of another Moon) so it correctly remains Connection-only.
  // `propertyClasses` is the property's full target-class list (one entry
  // for a plain sh:class, several for an sh:or union); any one of them
  // being a declared parent of this holon's type is enough.
  function isContainmentEchoProperty(holonTypes, propertyClasses){
    return (propertyClasses || []).some(function(cls){
      var children = childTypeConstraints[cls];
      if (!children) return false;
      return (holonTypes || []).some(function(t){ return children.indexOf(t) !== -1; });
    });
  }

  // The object properties on a CHILD's own shape(s) that "echo" the
  // isPartOf link -- i.e. whose sh:class is one of the parent's types, so
  // pointing them at the parent is exactly what the shape expects. For a
  // Moon under a Planet that's sol:orbits (MoonShape: sh:class sol:Planet);
  // for a Planet under a Star it's sol:orbits again (sh:class sol:Star).
  // Added 2026-09-12 after a moon (Himalia) created via Add Child got its
  // holon:isPartOf but not its sol:orbits, leaving it half-linked. Resolves
  // to [{path, name, maxCount}] -- empty when nothing on the child's shape
  // points at the parent's class, which is the common case for most types.
  function echoPropertiesFor(childTypes, parentTypes){
    parentTypes = parentTypes || [];
    if (!childTypes || !childTypes.length || !parentTypes.length) return Promise.resolve([]);
    return loadPropertyShapes(childTypes).then(function(props){
      return props.filter(function(p){
        if (!p.classes || !p.classes.length) return false;
        if (p.path === ISPARTOF_PREDICATE || p.path === ADMIN_PARTOF_PREDICATE) return false;
        return p.classes.some(function(c){ return parentTypes.indexOf(c) !== -1; });
      }).map(function(p){ return {path: p.path, name: p.name, maxCount: p.maxCount}; });
    }).catch(function(){ return []; });
  }

  // Writes one echo property on an EXISTING child. A single-valued
  // property (sh:maxCount 1 -- sol:orbits is) is replaced, not added to,
  // so attaching a moon that already orbited something else re-points it
  // rather than leaving it orbiting two bodies; anything unbounded is a
  // plain grounded INSERT, same as relationInsertData.
  function buildEchoPropertySparql(childIri, predicate, parentIri, single){
    if (!single){
      return 'INSERT DATA { GRAPH <' + HOLONS_GRAPH + '> { <' + childIri + '> <' + predicate + '> <' + parentIri + '> } }';
    }
    return [
      'DELETE { GRAPH <' + HOLONS_GRAPH + '> { <' + childIri + '> <' + predicate + '> ?old } }',
      'INSERT { GRAPH <' + HOLONS_GRAPH + '> { <' + childIri + '> <' + predicate + '> <' + parentIri + '> } }',
      'WHERE { OPTIONAL { GRAPH <' + HOLONS_GRAPH + '> { <' + childIri + '> <' + predicate + '> ?old } } }'
    ].join('\n');
  }

  // The full set of types the By Type view should offer a group for: every
  // shape-targeted class, every type currently in use, and every "sibling"
  // of a used type (something else that shares a parent via rdfs:subClassOf
  // -- e.g. sol:Vehicle shows up because sol:Prop, its sibling under
  // holon:Item, already has instances). All client-side, no extra queries.
  function computeAllTypes(){
    var set = {};
    shapeTargetClasses.forEach(function(t){ if (t !== HOLON_CLASS) set[t] = true; });
    holons.forEach(function(h){ h.types.forEach(function(t){ set[t] = true; }); });
    var supToSubs = {};
    Object.keys(directSuper).forEach(function(sub){
      directSuper[sub].forEach(function(sup){
        if (!supToSubs[sup]) supToSubs[sup] = [];
        supToSubs[sup].push(sub);
      });
    });
    Object.keys(set).forEach(function(t){
      (directSuper[t] || []).forEach(function(sup){
        (supToSubs[sup] || []).forEach(function(sib){ set[sib] = true; });
      });
    });
    return Object.keys(set);
  }

  function loadClassHierarchy(){
    return callTool(SERVER, 'sparql_select', {query: SUBCLASS_QUERY, graph: ONTOLOGY_GRAPH})
      .then(function(res){
        var bindings = (res.payload && res.payload.results && res.payload.results.bindings) || [];
        bindings.forEach(function(b){
          var sub = b.sub.value, sup = b.sup.value;
          if (!directSuper[sub]) directSuper[sub] = [];
          directSuper[sub].push(sup);
        });
      })
      .catch(function(){ /* best-effort: display just falls back to raw type order */ });
  }

  function ancestorsOf(type){
    if (ancestorCache[type]) return ancestorCache[type];
    var seen = {};
    var stack = (directSuper[type] || []).slice();
    while (stack.length){
      var t = stack.pop();
      if (seen[t]) continue;
      seen[t] = true;
      (directSuper[t] || []).forEach(function(s){ if (!seen[s]) stack.push(s); });
    }
    ancestorCache[type] = seen;
    return seen;
  }

  // A holon can carry several rdf:type values at once (e.g. geo:GeoFeature
  // + geo:River) -- this picks out the one(s) that aren't a superclass of
  // another type also present, so "River" wins over the generic
  // "GeoFeature" it always accompanies. Falls back to the full list
  // unchanged when the hierarchy hasn't loaded or nothing is comparable.
  function mostSpecificTypes(types){
    if (!types || types.length < 2) return types || [];
    var specific = types.filter(function(t){
      return !types.some(function(other){ return other !== t && ancestorsOf(other)[t]; });
    });
    return specific.length ? specific : types;
  }

  // The single type shown in compact rows (list/tree) and used to seed the
  // "Add Child" type dropdown's implicit default -- most specific first.
  function primaryType(types){
    if (!types || !types.length) return null;
    return mostSpecificTypes(types)[0];
  }

  function slugify(s){
    var base = String(s).toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
    base = base.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    return base || 'holon';
  }

  // PascalCase local-name convention used by every skos:Concept in this
  // dataset's taxonomies (agentkind/PlayerCharacter, gender/Female,
  // species/Elf, bodytype/GasGiant, ...) -- distinct from slugify() above,
  // which produces the lowercase-hyphenated form used for holon IRIs.
  // "Non-Binary" -> "NonBinary". Falls back to "Concept" for a label with
  // no alphanumeric content at all, so a new concept IRI is never just the
  // scheme's bare namespace.
  function pascalSlug(s){
    var base = String(s).normalize('NFKD').replace(/[̀-ͯ]/g, '');
    var words = base.replace(/[^A-Za-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean);
    return words.map(function(w){ return w.charAt(0).toUpperCase() + w.slice(1); }).join('') || 'Concept';
  }

  function uniqueSlug(base){
    var existing = {};
    holons.forEach(function(h){ existing[h.iri] = true; });
    var slug = base, n = 1;
    while (existing['https://w3id.org/data/holons/' + slug]){
      n++;
      slug = base + '-' + n;
    }
    return slug;
  }

  function turtleLiteral(s){
    return '"' + String(s)
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\r/g, '\\r')
      .replace(/\n/g, '\\n') + '"';
  }

  // rdfs:label and holon:description are both shaped as rdf:langString
  // (sh:datatype rdf:langString) in this dataset's SHACL, not xsd:string --
  // a plain turtleLiteral() on either is a SHACL violation waiting to
  // happen. Every write path that sets one of these two fields (new-holon
  // creation in buildCreateTurtle, and the Edit form's save in
  // buildUpdateSparql) must go through this instead of turtleLiteral()
  // directly. Fixed 2026-09-10 after Eleanor Rigby's description was found
  // to have regressed to xsd:string via an Edit-form save.
  function langLiteral(s){
    return turtleLiteral(s) + '@en';
  }

  // Builds the Turtle for a brand-new child holon. Uses the generic
  // holon:isPartOf containment relation regardless of the parent's own
  // domain (geography's administrativePartOf is a stricter sub-property
  // of it, not a separate concept) and matches the provenance shape every
  // existing holon in this dataset carries (status/creator/created/
  // generatedAtTime), so a holon created here isn't missing fields that
  // hand-authored ones have.
  // echoPredicates (optional): extra object properties to write on the new
  // holon pointing at the same parent -- the "echoes" of holon:isPartOf the
  // child's own shape declares with sh:class matching the parent's type
  // (sol:orbits for a Planet under a Star or a Moon under a Planet). See
  // echoPropertiesFor() / buildAddChildForm.
  function buildCreateTurtle(parentIri, iri, name, typeIri, description, creator, echoPredicates){
    var now = new Date();
    var dateStr = now.toISOString().slice(0, 10);
    var dtStr = now.toISOString().replace(/\.\d{3}Z$/, 'Z');
    // typeIri may be a single IRI or an array -- a holon created as a
    // subclass pick (e.g. Person where the shape asked for Agent) carries
    // BOTH explicitly, since this dataset has no RDFS entailment.
    var typeList = Array.isArray(typeIri) ? typeIri.filter(Boolean) : (typeIri ? [typeIri] : []);
    var typeClause = 'a holon:Holon';
    typeList.forEach(function(t){ typeClause += ', <' + t + '>'; });
    var props = [
      typeClause,
      'rdfs:label ' + langLiteral(name),
      'holon:status holon:RegisteredStatus'
    ];
    // parentIri may be null for a holon deliberately created outside the
    // containment tree (Add Connection's "Part of: none"). Which predicate
    // to write is decided by containmentPredicateFor -- geo:administrative
    // PartOf when the parent and this new holon's own type are both
    // geography admin place-kinds (Continent/Country/.../City), plain
    // holon:isPartOf otherwise -- rather than always hardcoding the
    // generic one, which is what let several interface-created countries
    // and cities (Greece, Poland, Warsaw, ...) end up inconsistent with
    // every hand-authored holon of the same kind. See containmentPredicateFor.
    if (parentIri){
      var containmentPred = containmentPredicateFor(typesOfIri(parentIri), typeList);
      props.push('<' + containmentPred + '> <' + parentIri + '>');
    }
    (echoPredicates || []).forEach(function(pred){
      if (parentIri && pred !== ISPARTOF_PREDICATE && pred !== ADMIN_PARTOF_PREDICATE) props.push('<' + pred + '> <' + parentIri + '>');
    });
    if (description) props.push('holon:description ' + langLiteral(description));
    if (creator) props.push('dct:creator <' + creator + '>');
    props.push('dct:created "' + dateStr + '"^^xsd:date');
    props.push('prov:generatedAtTime "' + dtStr + '"^^xsd:dateTime');

    return [
      '@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .',
      '@prefix dct: <http://purl.org/dc/terms/> .',
      '@prefix prov: <http://www.w3.org/ns/prov#> .',
      '@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .',
      '@prefix holon: <https://w3id.org/holon/> .',
      '',
      '<' + iri + '>',
      '  ' + props.join(' ;\n  ') + ' .'
    ].join('\n');
  }

  // Builds a SPARQL UPDATE that replaces an existing holon's label, its
  // full set of domain types (holon:Holon itself is filtered out of
  // ?oldType so it's never touched), and its description, in a single
  // DELETE/INSERT. A holon can carry several non-Holon types at once (e.g.
  // geo:GeoFeature + geo:River) -- typeIris is the complete replacement
  // set, not a single value, so editing one field never silently collapses
  // the others. Each OPTIONAL guards a field that may not currently exist
  // (e.g. no prior description); omitting the corresponding INSERT line
  // clears a field instead of replacing it. Every pattern is wrapped in
  // the holons graph explicitly, since push happens against a named graph
  // in a quad store rather than a single default graph.
  function buildUpdateSparql(iri, name, typeIris, description){
    var deleteLines = [
      '<' + iri + '> rdfs:label ?oldLabel .',
      '<' + iri + '> holon:description ?oldDesc .',
      '<' + iri + '> a ?oldType .'
    ];
    var insertLines = ['<' + iri + '> rdfs:label ' + langLiteral(name) + ' .'];
    if (description) insertLines.push('<' + iri + '> holon:description ' + langLiteral(description) + ' .');
    (typeIris || []).forEach(function(t){ insertLines.push('<' + iri + '> a <' + t + '> .'); });
    var whereLines = [
      'OPTIONAL { <' + iri + '> rdfs:label ?oldLabel }',
      'OPTIONAL { <' + iri + '> holon:description ?oldDesc }',
      'OPTIONAL { <' + iri + '> a ?oldType . FILTER(?oldType != <' + HOLON_CLASS + '>) }'
    ];
    return [
      'PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>',
      'PREFIX holon: <https://w3id.org/holon/>',
      'DELETE {',
      '  GRAPH <' + HOLONS_GRAPH + '> {',
      '    ' + deleteLines.join('\n    '),
      '  }',
      '}',
      'INSERT {',
      '  GRAPH <' + HOLONS_GRAPH + '> {',
      '    ' + insertLines.join('\n    '),
      '  }',
      '}',
      'WHERE {',
      '  GRAPH <' + HOLONS_GRAPH + '> {',
      '    ' + whereLines.join('\n    '),
      '  }',
      '}'
    ].join('\n');
  }

  // ---- Shape-driven property editor -------------------------------------
  // For a selected holon's rdf:type set, looks up every sh:property on any
  // NodeShape that sh:targetClass's one of those types, merges duplicate
  // paths (several shapes can each add a constraint to the same predicate,
  // e.g. AgentShape + AgentHealthShape both touching holon:Agent -- SHACL
  // ANDs those together, so merging takes the most restrictive cardinality
  // and the first non-empty value for everything else), and renders one
  // editable control per property in the Edit form, informed by the
  // shacl-ui:editor hints already authored throughout this shapes graph.
  // Only properties the user actually touches are written back -- an
  // untouched field is left exactly as the graph already has it. An sh:or
  // union of target classes (geo:strait -> Ocean-or-Sea) is read as a full
  // `classes` list since 2026-09-12 -- see propertyShapeQuery's ?orClasses
  // -- so those render as a holon picker over every listed class, not as a
  // text box that would literal-ize the IRI on save.
  var shapeCache = {};          // "type1|type2" -> Promise<[propMeta,...]>
  var classInstanceCache = {};  // classIri -> Promise<[{iri,label},...]>
  var classInstanceData = {};   // classIri -> resolved [{iri,label},...]
  var labelCache = {};          // iri -> label, for sh:in enum values

  function propertyShapeQuery(typeIris){
    var values = typeIris.map(function(t){ return '<' + t + '>'; }).join(' ');
    return [
      "PREFIX sh: <http://www.w3.org/ns/shacl#>",
      "PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>",
      "PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>",
      "PREFIX sh-ui: <http://www.w3.org/ns/shacl-ui/>",
      "SELECT ?prop ?path ?name ?description ?order ?minCount ?maxCount ?datatype ?class ?nodeKind ?group ?groupLabel ?groupOrder ?editor ?unit",
      "  (GROUP_CONCAT(DISTINCT STR(?inVal); separator=\"|\") AS ?inValues)",
      "  (GROUP_CONCAT(DISTINCT STR(?orClass); separator=\"|\") AS ?orClasses)",
      "WHERE {",
      "  VALUES ?type { " + values + " }",
      "  ?shape sh:targetClass ?type ; sh:property ?prop .",
      "  ?prop sh:path ?path .",
      // Plain-IRI paths only: an [sh:inversePath holon:isPartOf] property
      // (see CHILD_TYPE_CONSTRAINTS_QUERY) describes this class's permitted
      // CHILDREN, not a property it carries itself -- without this filter
      // it would surface in the Edit form as a bogus field keyed by a
      // blank node.
      "  FILTER(isIRI(?path))",
      "  OPTIONAL { ?prop sh:name ?name }",
      "  OPTIONAL { ?prop sh:description ?description }",
      "  OPTIONAL { ?prop sh:order ?order }",
      "  OPTIONAL { ?prop sh:minCount ?minCount }",
      "  OPTIONAL { ?prop sh:maxCount ?maxCount }",
      "  OPTIONAL { ?prop sh:datatype ?datatype }",
      "  OPTIONAL { ?prop sh:class ?class }",
      "  OPTIONAL { ?prop sh:nodeKind ?nodeKind }",
      "  OPTIONAL { ?prop sh:group ?group . OPTIONAL { ?group rdfs:label ?groupLabel } OPTIONAL { ?group sh:order ?groupOrder } }",
      "  OPTIONAL { ?prop sh-ui:editor ?editor }",
      "  OPTIONAL { ?prop sh:unit ?unit }",
      "  OPTIONAL { ?prop sh:in ?inList . ?inList rdf:rest*/rdf:first ?inVal }",
      // A holon-reference property that offers more than one acceptable
      // target class (geo:strait -> Ocean-or-Sea, geo:isPartOfBasin's kin)
      // declares that as sh:or rather than a single sh:class -- ?class above
      // stays empty for these, which used to mean pickControl() fell through
      // to a plain text box and a save would literal-ize what's actually a
      // holon IRI (found 2026-09-12 via geo:strait on Southern Ocean/Drake
      // Passage). ?orClasses recovers every sh:or alternative's sh:class so
      // mergePropsByPath can build a full `classes` list instead of relying
      // on the single `class` binding.
      "  OPTIONAL {",
      "    ?prop sh:or ?orList .",
      "    ?orList rdf:rest*/rdf:first ?orMember .",
      "    ?orMember sh:class ?orClass .",
      "  }",
      "} GROUP BY ?prop ?path ?name ?description ?order ?minCount ?maxCount ?datatype ?class ?nodeKind ?group ?groupLabel ?groupOrder ?editor ?unit",
      "ORDER BY ?order"
    ].join("\n");
  }

  // Resolves display labels for sh:in enum values (and sh:class instance
  // picks). Every skos:Concept in this dataset's taxonomies (gender,
  // species, agentKind, bodyType) carries skos:prefLabel, not rdfs:label --
  // easy to miss, since humanize()'s camelCase-splitting fallback happens
  // to reproduce most of these labels anyway (PlayerCharacter -> "Player
  // Character"), but a label that doesn't camelCase-derive cleanly (an
  // abbreviation, accented text, a multi-word phrase picked verbatim) would
  // silently fall back to the raw IRI fragment without this UNION branch.
  function labelsQuery(iris){
    var values = iris.map(function(i){ return '<' + i + '>'; }).join(' ');
    return [
      "PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>",
      "PREFIX skos: <http://www.w3.org/2004/02/skos/core#>",
      "SELECT DISTINCT ?v ?label WHERE {",
      "  VALUES ?v { " + values + " }",
      "  { GRAPH <" + HOLONS_GRAPH + "> { ?v rdfs:label ?label } }",
      "  UNION",
      "  { GRAPH <" + ONTOLOGY_GRAPH + "> { ?v rdfs:label ?label } }",
      "  UNION",
      "  { GRAPH <" + ONTOLOGY_GRAPH + "> { ?v skos:prefLabel ?label } }",
      "}"
    ].join("\n");
  }

  // rdfs:label is OPTIONAL here (it didn't used to be) -- an instance with
  // no label was previously dropped from this query's results entirely,
  // silently vanishing from the Add Connection picker AND (now) the
  // Classes tab's Instances list, even though it still counted towards
  // instanceCount. loadClassInstances() below falls back to humanize() for
  // the missing-label case, same convention used everywhere else in this
  // file, so it still needs a usable sort key here: COALESCE onto the IRI
  // itself when there's no label to sort by.
  function classInstancesQuery(classIri){
    return [
      "PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>",
      "SELECT DISTINCT ?s ?label WHERE {",
      "  { GRAPH <" + HOLONS_GRAPH + "> { ?s a <" + classIri + "> . OPTIONAL { ?s rdfs:label ?label } } }",
      "  UNION",
      "  { GRAPH <" + ONTOLOGY_GRAPH + "> { ?s a <" + classIri + "> . OPTIONAL { ?s rdfs:label ?label } } }",
      "} ORDER BY LCASE(STR(COALESCE(?label, ?s)))"
    ].join("\n");
  }

  // Merges raw per-property-shape rows into one metadata record per path,
  // ANDing cardinality (tightest minCount/maxCount wins) and taking the
  // first non-empty value for everything else, since in practice a given
  // predicate's name/datatype/class don't disagree across the shapes that
  // touch it -- only whether a *particular* shape happens to mention them.
  function mergePropsByPath(rows){
    var byPath = {};
    var order = [];
    rows.forEach(function(b){
      var path = b.path.value;
      if (SKIP_PREDICATES[path]) return;
      if (!byPath[path]){
        byPath[path] = {
          path: path, name: null, description: null, order: 9999,
          minCount: 0, maxCount: null, datatype: null, class: null,
          nodeKind: null, group: null, groupLabel: null, groupOrder: 9999,
          editor: null, unit: null, inValues: {}, classesSet: {}
        };
        order.push(path);
      }
      var p = byPath[path];
      if (b.name && !p.name) p.name = b.name.value;
      if (b.description && !p.description) p.description = b.description.value;
      if (b.order){ var o = parseInt(b.order.value, 10); if (o < p.order) p.order = o; }
      if (b.minCount){ var mn = parseInt(b.minCount.value, 10); if (mn > p.minCount) p.minCount = mn; }
      if (b.maxCount){ var mx = parseInt(b.maxCount.value, 10); p.maxCount = (p.maxCount === null) ? mx : Math.min(p.maxCount, mx); }
      if (b.datatype && !p.datatype) p.datatype = b.datatype.value;
      if (b['class'] && !p['class']) p['class'] = b['class'].value;
      if (b['class']) p.classesSet[b['class'].value] = true;
      if (b.orClasses && b.orClasses.value){
        b.orClasses.value.split('|').filter(Boolean).forEach(function(c){ p.classesSet[c] = true; });
      }
      if (b.nodeKind && !p.nodeKind) p.nodeKind = b.nodeKind.value;
      if (b.group && !p.group){
        p.group = b.group.value;
        p.groupLabel = b.groupLabel ? b.groupLabel.value : humanize(b.group.value);
        p.groupOrder = b.groupOrder ? parseInt(b.groupOrder.value, 10) : 9999;
      }
      if (b.editor && !p.editor) p.editor = b.editor.value;
      if (b.unit && !p.unit) p.unit = b.unit.value;
      if (b.inValues && b.inValues.value){
        b.inValues.value.split('|').filter(Boolean).forEach(function(v){ p.inValues[v] = true; });
      }
    });
    return order.map(function(path){
      var p = byPath[path];
      p.inValues = Object.keys(p.inValues);
      // `classes` is every acceptable target class for a holon-reference
      // property -- one entry for a plain sh:class property (same value as
      // `class`), several for an sh:or union like geo:strait's Ocean-or-Sea.
      // `class` itself is kept as classes[0] purely so existing single-class
      // call sites (which predate sh:or support) keep working unchanged.
      p.classes = Object.keys(p.classesSet);
      delete p.classesSet;
      if (!p['class'] && p.classes.length) p['class'] = p.classes[0];
      if (!p.name) p.name = humanize(path);
      return p;
    }).sort(function(a, b){
      if (a.groupOrder !== b.groupOrder) return a.groupOrder - b.groupOrder;
      if (a.order !== b.order) return a.order - b.order;
      return a.name.localeCompare(b.name);
    });
  }

  function loadPropertyShapes(typeIris){
    typeIris = typeIris || [];
    if (!typeIris.length) return Promise.resolve([]);
    var key = typeIris.slice().sort().join('|');
    if (shapeCache[key]) return shapeCache[key];
    var p = callTool(SERVER, 'sparql_select', {query: propertyShapeQuery(typeIris), graph: SHACL_GRAPH})
      .then(function(res){
        var bindings = (res.payload && res.payload.results && res.payload.results.bindings) || [];
        return mergePropsByPath(bindings);
      });
    shapeCache[key] = p;
    return p;
  }

  // Best-effort: applies each property shape's sh:description as a tooltip
  // (title attribute) on the matching kv-key element, and appends a QUDT
  // unit symbol (sh:unit) after each of that property's numeric values --
  // both in the read-only view. Safe to call repeatedly -- loadPropertyShapes
  // is cached by type-set key, and renderDetail re-runs on every live update,
  // always against a freshly built container.
  function applyShapeTooltips(container, typeIris){
    if (!typeIris || !typeIris.length) return;
    loadPropertyShapes(typeIris).then(function(props){
      props.forEach(function(p){
        var key = container.querySelector('[data-prop-path="' + p.path + '"]');
        if (!key) return;
        if (p.description){
          key.title = p.description;
          key.classList.add('has-tip');
        }
        if (p.unit){
          var valEl = key.parentElement ? key.parentElement.querySelector('.kv-val') : null;
          if (valEl){
            var sym = unitSymbol(p.unit);
            valEl.querySelectorAll('.num').forEach(function(n){ n.textContent = n.textContent + ' ' + sym; });
          }
        }
      });
    }).catch(function(){ /* best-effort: view mode still works without tooltips/units */ });
  }

  // Best-effort: fills an empty placeholder appended right after the
  // Properties section (view mode only) with a "References" section -- the
  // inverse of that kv list. Every holon that references `iri` is grouped
  // by the predicate it's referenced through (several referencing holons
  // sharing a predicate render as one row with several chips, same as a
  // multi-valued forward property), and each row's key is that predicate's
  // sh:inverseName when the shapes graph declares one (e.g. viewing an
  // Organization, holon:affiliation's incoming rows are labelled "Member",
  // not the forward name "Affiliation") -- falling back to
  // "<Forward Name> Of" for any relation that hasn't been given an
  // inverseName yet, so a new relation predicate never renders as nothing.
  // Leaves the placeholder empty if the query fails or nothing references
  // this holon.
  function loadReferences(container, iri){
    Promise.all([
      callTool(SERVER, 'sparql_select', {query: referencesQuery(iri), graph: HOLONS_GRAPH})
        .then(function(res){ return (res.payload && res.payload.results && res.payload.results.bindings) || []; }),
      loadInverseNames()
    ]).then(function(results){
      var bindings = results[0];
      var inverseNames = results[1];
      if (!bindings.length) return;
      var groups = {};
      var order = [];
      bindings.forEach(function(b){
        var p = b.p.value;
        if (!groups[p]){ groups[p] = []; order.push(p); }
        var refIri = b.s.value;
        groups[p].push({
          iri: refIri,
          label: b.label ? b.label.value : (iriToLabel[refIri] || humanize(refIri))
        });
      });
      order.sort(function(a, b){ return (inverseNames[a] || humanize(a)).localeCompare(inverseNames[b] || humanize(b)); });
      var secLabel = document.createElement('div');
      secLabel.className = 'section-label';
      secLabel.textContent = 'References';
      container.appendChild(secLabel);
      var kv = document.createElement('div');
      kv.className = 'kv';
      order.forEach(function(p){
        var row = document.createElement('div');
        row.className = 'kv-row';
        var key = document.createElement('div');
        key.className = 'kv-key';
        key.textContent = inverseNames[p] || (humanize(p) + ' Of');
        row.appendChild(key);
        var val = document.createElement('div');
        val.className = 'kv-val';
        groups[p].slice().sort(function(a, b){ return a.label.localeCompare(b.label); }).forEach(function(entry){
          var chip = document.createElement('button');
          chip.type = 'button';
          chip.className = 'chip';
          chip.innerHTML = '<span>' + entry.label + '</span><span class="arrow">&#8594;</span>';
          chip.addEventListener('click', function(){ selectHolon(entry.iri); });
          val.appendChild(chip);
        });
        row.appendChild(val);
        kv.appendChild(row);
      });
      container.appendChild(kv);
    }).catch(function(){ /* best-effort: view still works without a References section */ });
  }

  function resolveLabels(iris){
    var missing = iris.filter(function(i){ return !labelCache[i]; });
    if (!missing.length) return Promise.resolve();
    return callTool(SERVER, 'sparql_select', {query: labelsQuery(missing)})
      .then(function(res){
        var bindings = (res.payload && res.payload.results && res.payload.results.bindings) || [];
        bindings.forEach(function(b){ labelCache[b.v.value] = b.label.value; });
      })
      .catch(function(){ /* best-effort: falls back to humanize() in the UI */ });
  }

  function loadClassInstances(classIri){
    if (classInstanceCache[classIri]) return classInstanceCache[classIri];
    var p = callTool(SERVER, 'sparql_select', {query: classInstancesQuery(classIri)})
      .then(function(res){
        var bindings = (res.payload && res.payload.results && res.payload.results.bindings) || [];
        var arr = bindings.map(function(b){ return {iri: b.s.value, label: b.label ? b.label.value : humanize(b.s.value)}; });
        classInstanceData[classIri] = arr;
        return arr;
      })
      .catch(function(){ classInstanceData[classIri] = []; return []; });
    classInstanceCache[classIri] = p;
    return p;
  }

  // Memoized claude.use('sample') -- resolves the sample() function once,
  // or null the first time this view can't run it at all (absent, or a
  // permanent hide-code already seen this load). Safe to call repeatedly;
  // never re-prompts.
  function getSample(){
    if (sampleHidden) return Promise.resolve(null);
    if (!samplePromise){
      samplePromise = (typeof claude !== 'undefined' && claude && typeof claude.use === 'function')
        ? claude.use('sample').catch(function(){ return null; })
        : Promise.resolve(null);
    }
    return samplePromise;
  }

  var NUMERIC_DATATYPE_RE = /(integer|int|long|short|decimal|double|float|nonNegativeInteger|positiveInteger)$/;

  // Short display symbols for the QUDT (http://qudt.org/vocab/unit/) unit
  // IRIs actually used by this dataset's SHACL shapes (sh:unit). Falls back
  // to humanize()-ing the unit's local name for any unit added later that
  // isn't in this map yet, so a new sh:unit value never renders as nothing.
  var QUDT_UNIT_SYMBOLS = {
    'http://qudt.org/vocab/unit/KiloGM': 'kg',
    'http://qudt.org/vocab/unit/M': 'm',
    'http://qudt.org/vocab/unit/KiloM': 'km',
    'http://qudt.org/vocab/unit/KiloM2': 'km²',
    'http://qudt.org/vocab/unit/KiloM-PER-HR': 'km/h',
    'http://qudt.org/vocab/unit/MIN': 'min',
    'http://qudt.org/vocab/unit/DAY': 'd',
    'http://qudt.org/vocab/unit/YR': 'yr',
    'http://qudt.org/vocab/unit/AU': 'AU'
  };

  function unitSymbol(unitIri){
    if (!unitIri) return '';
    if (QUDT_UNIT_SYMBOLS[unitIri]) return QUDT_UNIT_SYMBOLS[unitIri];
    return humanize(unitIri.split(/[#/]/).pop());
  }

  // Picks a control kind from the shacl-ui:editor hint first, falling back
  // to datatype/class/nodeKind heuristics when a property carries no hint
  // (most geography/solar-system shapes predate the shacl-ui vocabulary).
  function pickControl(meta){
    var editor = meta.editor ? meta.editor.split(/[#/]/).pop() : null;
    if (editor === 'BooleanEditor' || /boolean$/.test(meta.datatype || '')) return 'boolean';
    if (editor === 'DatePickerEditor' || /date$/i.test(meta.datatype || '')) return 'date';
    if (meta.inValues && meta.inValues.length) return 'enum';
    if (meta.classes && meta.classes.length) return 'instance';
    if (editor === 'NumberFieldEditor' || NUMERIC_DATATYPE_RE.test(meta.datatype || '')) return 'number';
    if (editor === 'TextAreaWithLangEditor') return 'lang-textarea';
    if (editor === 'TextFieldWithLangEditor' || /langString$/.test(meta.datatype || '')) return 'lang-text';
    if (meta.nodeKind && /IRI$/.test(meta.nodeKind)) return 'iri';
    return 'text';
  }

  function serializeShapeValue(control, raw, meta){
    raw = String(raw).trim();
    if (!raw) return null;
    switch (control){
      case 'instance': case 'enum': case 'iri':
        return '<' + raw + '>';
      case 'boolean':
        return '"' + (raw === 'true' ? 'true' : 'false') + '"^^<http://www.w3.org/2001/XMLSchema#boolean>';
      case 'number':
        return '"' + raw + '"^^<' + (meta.datatype || 'http://www.w3.org/2001/XMLSchema#decimal') + '>';
      case 'date':
        return '"' + raw + '"^^<' + (meta.datatype || 'http://www.w3.org/2001/XMLSchema#date') + '>';
      case 'lang-text': case 'lang-textarea':
        return turtleLiteral(raw) + '@en';
      default:
        return (meta.datatype && meta.datatype !== 'http://www.w3.org/2001/XMLSchema#string')
          ? turtleLiteral(raw) + '^^<' + meta.datatype + '>'
          : turtleLiteral(raw);
    }
  }

  // Adds a newly-minted skos:Concept as an <option> in an already-rendered
  // enum <select>, in the same alphabetical-by-label order
  // buildShapeControlInput applies when it first builds the list -- so a
  // value created via "+ New value" behaves identically to one that was
  // already in the shape's sh:in list, whichever select the user happens to
  // be looking at.
  function insertSortedOption(select, iri, label){
    var opt = document.createElement('option');
    opt.value = iri;
    opt.textContent = label;
    var options = Array.prototype.slice.call(select.options);
    var inserted = false;
    for (var i = 1; i < options.length; i++){ // index 0 is the blank "— choose —"
      if (label.localeCompare(options[i].textContent) < 0){
        select.insertBefore(opt, options[i]);
        inserted = true;
        break;
      }
    }
    if (!inserted) select.appendChild(opt);
    return opt;
  }

  function buildShapeControlInput(control, meta, initial){
    var el;
    if (control === 'boolean'){
      el = document.createElement('input');
      el.type = 'checkbox';
      el.style.cssText = 'width:auto; flex:none;';
      if (initial) el.checked = (String(initial.value) === 'true');
      return el;
    }
    if (control === 'date'){
      el = document.createElement('input');
      el.type = 'date';
      if (initial) el.value = String(initial.value).slice(0, 10);
      return el;
    }
    if (control === 'number'){
      el = document.createElement('input');
      el.type = 'number';
      el.step = 'any';
      if (initial) el.value = initial.value;
      return el;
    }
    if (control === 'lang-textarea'){
      el = document.createElement('textarea');
      el.rows = 2;
      if (initial) el.value = initial.value;
      return el;
    }
    if (control === 'enum' || control === 'instance'){
      el = document.createElement('select');
      var blank = document.createElement('option');
      blank.value = '';
      blank.textContent = '— choose —';
      el.appendChild(blank);
      var options = control === 'enum'
        ? (meta.inValues || []).map(function(v){ return {iri: v, label: labelCache[v] || humanize(v)}; })
        // A multi-class (sh:or) property like geo:strait offers instances of
        // EVERY listed class (Ocean or Sea) in one pool, not just the first --
        // deduped by IRI in case a holon somehow carries more than one of
        // those types itself.
        : (function(){
            var seen = {}, out = [];
            (meta.classes || []).forEach(function(c){
              (classInstanceData[c] || []).forEach(function(o){
                if (!seen[o.iri]){ seen[o.iri] = true; out.push(o); }
              });
            });
            return out;
          })();
      options.slice().sort(function(a, b){ return a.label.localeCompare(b.label); }).forEach(function(o){
        var opt = document.createElement('option');
        opt.value = o.iri;
        var isDeprecated = !!deprecatedSet[o.iri];
        // A deprecated concept never disappears from the list -- it stays
        // visible (tagged, grayed via disabled) so an existing holon that
        // already carries it as its value still displays correctly, per the
        // "never delete, only deprecate" rule; it's just not selectable as a
        // *new* choice going forward.
        opt.textContent = o.label + (isDeprecated ? ' (deprecated)' : '');
        if (isDeprecated) opt.disabled = true;
        el.appendChild(opt);
      });
      if (initial) el.value = initial.value;
      return el;
    }
    el = document.createElement('input');
    el.type = 'text';
    if (initial) el.value = initial.value;
    return el;
  }

  // One property's whole editable block: existing values as removable
  // rows, plus an "Add value" button while under maxCount. Returns an
  // object the Save handler consults for serialised triples, but only if
  // isDirty() -- untouched properties are never included in the write.
  function buildShapePropertyField(meta, existingValues, enumSchemes, holonIri){
    var control = pickControl(meta);
    var hadExisting = existingValues.length > 0;
    var wrap = document.createElement('div');
    wrap.className = 'field shape-field';

    var label = document.createElement('label');
    label.textContent = meta.name + (meta.minCount > 0 ? ' *' : '');
    if (meta.description) label.title = meta.description;
    wrap.appendChild(label);

    var rowsWrap = document.createElement('div');
    wrap.appendChild(rowsWrap);

    var dirty = false;
    var rowsState = [];
    var addBtn;

    function refreshAddBtn(){
      if (!addBtn) return;
      addBtn.hidden = (meta.maxCount != null && rowsState.length >= meta.maxCount);
    }

    function addRow(initial){
      var rowEl = document.createElement('div');
      rowEl.style.cssText = 'display:flex; gap:6px; align-items:center; margin-bottom:6px;';
      var input = buildShapeControlInput(control, meta, initial);
      input.style.flex = '1';
      input.addEventListener('input', function(){ dirty = true; });
      input.addEventListener('change', function(){ dirty = true; });
      rowEl.appendChild(input);
      if (control === 'number' && meta.unit){
        var unitTag = document.createElement('span');
        unitTag.style.cssText = "flex:none; font-family:'IBM Plex Mono', monospace; font-size:12px; color:var(--ink-faint);";
        unitTag.textContent = unitSymbol(meta.unit);
        rowEl.appendChild(unitTag);
      }
      var rmBtn = document.createElement('button');
      rmBtn.type = 'button';
      rmBtn.className = 'btn';
      rmBtn.textContent = '✕';
      rmBtn.title = 'Remove this value';
      rmBtn.style.cssText = 'padding:4px 8px; flex:none;';
      rmBtn.addEventListener('click', function(){
        rowsState = rowsState.filter(function(r){ return r.rowEl !== rowEl; });
        rowEl.remove();
        dirty = true;
        refreshAddBtn();
      });
      rowEl.appendChild(rmBtn);
      rowsWrap.appendChild(rowEl);
      rowsState.push({rowEl: rowEl, input: input});
    }

    if (existingValues.length){
      existingValues.forEach(function(v){ addRow(v); });
    } else if (meta.maxCount === 1){
      addRow(null);
    }

    addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'btn';
    addBtn.textContent = '+ Add value';
    addBtn.style.cssText = 'font-size:11.5px; padding:4px 9px;';
    addBtn.addEventListener('click', function(){
      addRow(null);
      dirty = true;
      refreshAddBtn();
    });
    wrap.appendChild(addBtn);
    refreshAddBtn();

    // "+ New value…" -- only for sh:in fields backed by a real SKOS taxonomy
    // (see loadEnumSchemes/ENUM_SCHEME_QUERY): mints a brand-new skos:Concept
    // in that scheme and splices it into every sh:in list sharing this
    // property's path, then drops it into every <select> already rendered
    // for this field and selects it into a row, so it behaves exactly like a
    // value that was already in the shape.
    var newValueScheme = (control === 'enum' && enumSchemes) ? enumSchemes[meta.path] : null;
    if (newValueScheme){
      var newValBtn = document.createElement('button');
      newValBtn.type = 'button';
      newValBtn.className = 'btn';
      newValBtn.textContent = '+ New value…';
      newValBtn.style.cssText = 'font-size:11.5px; padding:4px 9px; margin-left:6px;';
      wrap.appendChild(newValBtn);

      var newValForm = document.createElement('div');
      newValForm.style.cssText = 'display:none; flex-wrap:wrap; gap:6px; align-items:center; margin-top:6px;';
      var newValInput = document.createElement('input');
      newValInput.type = 'text';
      newValInput.placeholder = 'New ' + meta.name.toLowerCase() + '…';
      newValInput.style.flex = '1';
      newValInput.style.minWidth = '140px';
      var newValSave = document.createElement('button');
      newValSave.type = 'button';
      newValSave.className = 'btn';
      newValSave.textContent = 'Add';
      newValSave.style.cssText = 'flex:none; font-size:11.5px; padding:4px 9px;';
      var newValCancel = document.createElement('button');
      newValCancel.type = 'button';
      newValCancel.className = 'btn';
      newValCancel.textContent = 'Cancel';
      newValCancel.style.cssText = 'flex:none; font-size:11.5px; padding:4px 9px;';
      var newValWarn = document.createElement('p');
      newValWarn.style.cssText = 'display:none; margin:2px 0 0; width:100%; font-size:12px; color:var(--bad);';
      newValForm.appendChild(newValInput);
      newValForm.appendChild(newValSave);
      newValForm.appendChild(newValCancel);
      newValForm.appendChild(newValWarn);
      wrap.appendChild(newValForm);

      function closeNewValForm(){
        newValForm.style.display = 'none';
        newValBtn.hidden = false;
      }
      newValBtn.addEventListener('click', function(){
        newValInput.value = '';
        newValWarn.style.display = 'none';
        newValForm.style.display = 'flex';
        newValBtn.hidden = true;
        newValInput.focus();
      });
      newValCancel.addEventListener('click', closeNewValForm);
      newValInput.addEventListener('keydown', function(ev){
        if (ev.key === 'Enter'){ ev.preventDefault(); newValSave.click(); }
        else if (ev.key === 'Escape'){ ev.preventDefault(); closeNewValForm(); }
      });
      newValSave.addEventListener('click', function(){
        var newLabel = newValInput.value.trim();
        newValWarn.style.display = 'none';
        if (!newLabel){
          newValWarn.textContent = 'A label is required.';
          newValWarn.style.display = 'block';
          return;
        }
        var ns = conceptNamespaceFor((meta.inValues && meta.inValues[0]) || newValueScheme);
        var newIri = ns + pascalSlug(newLabel);
        if ((meta.inValues || []).indexOf(newIri) !== -1){
          newValWarn.textContent = 'A value with that name already exists.';
          newValWarn.style.display = 'block';
          return;
        }
        newValSave.disabled = true;
        newValCancel.disabled = true;
        newValSave.textContent = 'Adding…';
        callTool(SERVER, 'sparql_update', {update: buildCreateConceptSparql(newIri, newLabel, newValueScheme)})
          .then(function(){
            return callTool(SERVER, 'sparql_update', {update: buildAppendConceptToInSparql(meta.path, newIri)});
          })
          .then(function(){
            meta.inValues = (meta.inValues || []).concat([newIri]);
            labelCache[newIri] = newLabel;
            rowsState.forEach(function(r){
              if (r.input.tagName === 'SELECT') insertSortedOption(r.input, newIri, newLabel);
            });
            if (rowsState.length){
              rowsState[rowsState.length - 1].input.value = newIri;
            } else {
              addRow({value: newIri});
            }
            dirty = true;
            refreshAddBtn();
            closeNewValForm();
          })
          .catch(function(){
            newValWarn.textContent = 'Couldn’t create that value — try again.';
            newValWarn.style.display = 'block';
          })
          .then(function(){
            newValSave.disabled = false;
            newValCancel.disabled = false;
            newValSave.textContent = 'Add';
          });
      });
    }

    // "+ New <Type>…" -- the holon-reference sibling of "+ New value…" above,
    // for any field whose control is 'instance' (a plain sh:class or sh:or
    // property, like geo:capital -> City): mints a brand-new holon of the
    // field's target class -- or, for a multi-class sh:or property such as
    // geo:strait (Ocean or Sea) or holon:isSiblingOf (Star/Planet/Moon), a
    // chosen one of them -- rather than forcing a pick from the existing
    // instance list. This is what makes a single-valued reference field like
    // Country's Capital genuinely "single value, but can mint a new one":
    // maxCount:1 already limits the field to one row (see addRow/refreshAddBtn
    // above), and this button fills that one row with a freshly-created City
    // instead of only offering the pre-existing ones. Applies uniformly to
    // every sh:class-backed 'instance' field in the dataset, not just Capital
    // -- Headquarters, Central Star, Orbits, and the rest all get the same
    // affordance for free.
    //
    // The new holon defaults to being holon:isPartOf the holon THIS field
    // lives on (holonIri) -- the common case (a new Capital, a new
    // Headquarters) is naturally part of, or closely tied to, the holon
    // whose field is being filled in -- but a Parent Holon dropdown lets that
    // be changed, mirroring buildAddConnectionForm's own "New Holon" mode.
    if (control === 'instance' && meta.classes && meta.classes.length){
      var newInstBtn = document.createElement('button');
      newInstBtn.type = 'button';
      newInstBtn.className = 'btn';
      newInstBtn.textContent = '+ New ' + (meta.classes.length === 1 ? humanize(meta.classes[0]) : 'value') + '…';
      newInstBtn.style.cssText = 'font-size:11.5px; padding:4px 9px; margin-left:6px;';
      wrap.appendChild(newInstBtn);

      var newInstForm = document.createElement('div');
      newInstForm.style.cssText = 'display:none; flex-direction:column; gap:6px; margin-top:8px; padding:10px 12px; border:1px solid var(--line); border-radius:8px; background:var(--paper);';

      var newInstTypeSelect = null;
      if (meta.classes.length > 1){
        var newInstTypeLbl = document.createElement('label');
        newInstTypeLbl.style.cssText = 'font-size:11px; font-weight:600; color:var(--ink-soft);';
        newInstTypeLbl.textContent = 'Type';
        newInstForm.appendChild(newInstTypeLbl);
        newInstTypeSelect = document.createElement('select');
        newInstTypeSelect.style.cssText = 'width:100%; font:inherit; font-size:13px; padding:5px 7px; border:1px solid var(--line); border-radius:6px; background:var(--card); color:var(--ink);';
        meta.classes.slice().sort(function(a, b){ return humanize(a).localeCompare(humanize(b)); }).forEach(function(c){
          var opt = document.createElement('option');
          opt.value = c;
          opt.textContent = humanize(c);
          newInstTypeSelect.appendChild(opt);
        });
        newInstForm.appendChild(newInstTypeSelect);
      }

      var newInstNameInput = document.createElement('input');
      newInstNameInput.type = 'text';
      newInstNameInput.placeholder = 'Name…';
      newInstNameInput.style.cssText = 'width:100%; font:inherit; font-size:13px; padding:5px 7px; border:1px solid var(--line); border-radius:6px; background:var(--card); color:var(--ink);';
      newInstForm.appendChild(newInstNameInput);

      var newInstParentLbl = document.createElement('label');
      newInstParentLbl.style.cssText = 'font-size:11px; font-weight:600; color:var(--ink-soft);';
      newInstParentLbl.textContent = 'Parent Holon';
      newInstForm.appendChild(newInstParentLbl);
      var newInstParentSelect = document.createElement('select');
      newInstParentSelect.style.cssText = 'width:100%; font:inherit; font-size:13px; padding:5px 7px; border:1px solid var(--line); border-radius:6px; background:var(--card); color:var(--ink);';
      holons.slice().sort(function(a, b){ return a.label.localeCompare(b.label); }).forEach(function(h){
        var opt = document.createElement('option');
        opt.value = h.iri;
        opt.textContent = h.label;
        if (h.iri === holonIri) opt.selected = true;
        newInstParentSelect.appendChild(opt);
      });
      newInstForm.appendChild(newInstParentSelect);

      var newInstDescArea = document.createElement('textarea');
      newInstDescArea.rows = 2;
      newInstDescArea.placeholder = 'Description (optional)…';
      newInstDescArea.style.cssText = 'width:100%; font:inherit; font-size:13px; padding:5px 7px; border:1px solid var(--line); border-radius:6px; background:var(--card); color:var(--ink); resize:vertical;';
      newInstForm.appendChild(newInstDescArea);

      var newInstWarn = document.createElement('p');
      newInstWarn.style.cssText = 'display:none; margin:0; font-size:12px; color:var(--bad);';
      newInstForm.appendChild(newInstWarn);

      var newInstActions = document.createElement('div');
      newInstActions.style.cssText = 'display:flex; gap:6px;';
      var newInstSave = document.createElement('button');
      newInstSave.type = 'button';
      newInstSave.className = 'btn';
      newInstSave.textContent = 'Create';
      newInstSave.style.cssText = 'flex:none; font-size:11.5px; padding:4px 9px;';
      var newInstCancel = document.createElement('button');
      newInstCancel.type = 'button';
      newInstCancel.className = 'btn';
      newInstCancel.textContent = 'Cancel';
      newInstCancel.style.cssText = 'flex:none; font-size:11.5px; padding:4px 9px;';
      newInstActions.appendChild(newInstSave);
      newInstActions.appendChild(newInstCancel);
      newInstForm.appendChild(newInstActions);

      wrap.appendChild(newInstForm);

      function closeNewInstForm(){
        newInstForm.style.display = 'none';
        newInstBtn.hidden = false;
      }
      newInstBtn.addEventListener('click', function(){
        newInstNameInput.value = '';
        newInstDescArea.value = '';
        newInstWarn.style.display = 'none';
        newInstForm.style.display = 'flex';
        newInstBtn.hidden = true;
        newInstNameInput.focus();
      });
      newInstCancel.addEventListener('click', closeNewInstForm);
      newInstNameInput.addEventListener('keydown', function(ev){
        if (ev.key === 'Enter'){ ev.preventDefault(); newInstSave.click(); }
        else if (ev.key === 'Escape'){ ev.preventDefault(); closeNewInstForm(); }
      });
      newInstSave.addEventListener('click', function(){
        var newName = newInstNameInput.value.trim();
        newInstWarn.style.display = 'none';
        if (!newName){
          newInstWarn.textContent = 'A name is required.';
          newInstWarn.style.display = 'block';
          return;
        }
        var chosenClass = newInstTypeSelect ? newInstTypeSelect.value : meta.classes[0];
        var parentIri = newInstParentSelect.value || null;
        var newIri = 'https://w3id.org/data/holons/' + uniqueSlug(slugify(newName));
        var turtle = buildCreateTurtle(parentIri, newIri, newName, chosenClass, newInstDescArea.value.trim(), creatorIri);
        newInstSave.disabled = true;
        newInstCancel.disabled = true;
        newInstSave.textContent = 'Creating…';
        callTool(SERVER, 'push_turtle', {turtle: turtle, graph_iri: HOLONS_GRAPH, mode: 'merge'})
          .then(function(){
            var newLabel = newName;
            (classInstanceData[chosenClass] = classInstanceData[chosenClass] || []).push({iri: newIri, label: newLabel});
            iriToLabel[newIri] = newLabel;
            if (!holons.some(function(h){ return h.iri === newIri; })){
              holons.push({iri: newIri, label: newLabel, types: [chosenClass]});
            }
            rowsState.forEach(function(r){
              if (r.input.tagName === 'SELECT') insertSortedOption(r.input, newIri, newLabel);
            });
            if (rowsState.length){
              rowsState[rowsState.length - 1].input.value = newIri;
            } else {
              addRow({value: newIri});
            }
            dirty = true;
            refreshAddBtn();
            closeNewInstForm();
          })
          .catch(function(){
            newInstWarn.textContent = 'Couldn’t create that holon — try again.';
            newInstWarn.style.display = 'block';
          })
          .then(function(){
            newInstSave.disabled = false;
            newInstCancel.disabled = false;
            newInstSave.textContent = 'Create';
          });
      });
    }

    return {
      path: meta.path,
      meta: meta,
      control: control,
      element: wrap,
      isDirty: function(){ return dirty; },
      // "Already set" means present in the data this form was opened
      // with -- not whether a row happens to be on screen right now (a
      // maxCount:1 field always gets one blank row so it can be filled
      // in). This is the sense the Populate-with-AI feature needs.
      isEmpty: function(){ return !hadExisting; },
      getSerializedValues: function(){
        return rowsState
          .map(function(r){ return control === 'boolean' ? (r.input.checked ? 'true' : 'false') : r.input.value; })
          .map(function(raw){ return serializeShapeValue(control, raw, meta); })
          .filter(Boolean);
      },
      // Fills this field with an AI-proposed value without disturbing
      // anything else: reuses the existing blank row if there is one
      // (the maxCount:1 case), otherwise adds a fresh row. Marks dirty
      // so it's included on Save, same as a manual edit.
      populateValue: function(rawValue){
        if (rawValue === null || rawValue === undefined || rawValue === '') return false;
        if (rowsState.length){
          var r = rowsState[0];
          if (control === 'boolean') r.input.checked = (String(rawValue) === 'true');
          else r.input.value = rawValue;
        } else {
          addRow({value: rawValue});
        }
        dirty = true;
        refreshAddBtn();
        return true;
      }
    };
  }

  // Builds the DELETE/INSERT/WHERE for every property the user touched --
  // untouched fields are simply absent from the update, so this editor
  // never clobbers a property it can't fully represent.
  function buildShapePropsUpdate(iri, fields){
    var dirtyFields = fields.filter(function(f){ return f.isDirty(); });
    if (!dirtyFields.length) return null;
    var deleteLines = [], insertLines = [], whereLines = [];
    dirtyFields.forEach(function(f, idx){
      var v = '?sv' + idx;
      deleteLines.push('<' + iri + '> <' + f.path + '> ' + v + ' .');
      whereLines.push('OPTIONAL { <' + iri + '> <' + f.path + '> ' + v + ' }');
      f.getSerializedValues().forEach(function(sv){
        insertLines.push('<' + iri + '> <' + f.path + '> ' + sv + ' .');
      });
    });
    var parts = ['DELETE {', '  GRAPH <' + HOLONS_GRAPH + '> {', '    ' + deleteLines.join('\n    '), '  }', '}'];
    if (insertLines.length){
      parts.push('INSERT {', '  GRAPH <' + HOLONS_GRAPH + '> {', '    ' + insertLines.join('\n    '), '  }', '}');
    }
    parts.push('WHERE {', '  GRAPH <' + HOLONS_GRAPH + '> {', '    ' + whereLines.join('\n    '), '  }', '}');
    return parts.join('\n');
  }

  // Control kinds the AI-populate feature is willing to guess at. Deliberately
  // excludes 'instance' and 'iri' -- those point at another specific holon in
  // this dataset, which is not something Claude's general knowledge can name
  // reliably, so those stay hand-picked from the dataset's own instance list.
  var AI_FILLABLE_CONTROLS = {text: 1, 'lang-text': 1, 'lang-textarea': 1, number: 1, date: 1, boolean: 1, enum: 1};

  // Builds the sample.json() prompt for "Populate with AI": the holon's own
  // identity for context, then exactly the empty fields to propose values
  // for (never fields that already have a value), each described just
  // enough (name/hint/kind, plus the closed choice list for an enum) that
  // Claude can answer from its own trained knowledge -- this artifact has
  // no live internet access, so the prompt says so and asks for null over
  // a guess.
  function buildPopulatePrompt(holonCtx, typeIris, targets){
    var typeLabels = (typeIris || []).map(function(t){ return labelCache[t] || humanize(t); });
    var lines = [
      'You are helping fill in missing structured data for one entry in a worldbuilding knowledge graph called "Worldtest".',
      'Entry name: ' + holonCtx.name,
      'Entry type(s): ' + (typeLabels.length ? typeLabels.join(', ') : '(untyped)')
    ];
    if (holonCtx.description) lines.push('Existing description: ' + holonCtx.description);
    lines.push(
      '',
      'You have no live internet access and no memory beyond this message. Answer from your own general knowledge only; use null for anything you are not reasonably confident about rather than guessing.',
      '',
      'These properties are currently empty on this entry. Propose a plausible, factual value for as many as you reasonably can:',
      JSON.stringify(targets, null, 2),
      '',
      'Respond with ONLY a JSON object whose keys are exactly the "path" values above. For a property with a "choices" list, the value must be exactly one of the listed "iri" strings, or null. For a "boolean" kind, the value must be "true", "false", or null. For every other kind, the value is a short plain string, or null. Include every key listed above. No other text, no markdown fences.'
    );
    return lines.join('\n');
  }

  // Loads this holon's property-shape metadata, resolves whatever extra
  // labels/instance-lists its controls need, then renders. Best-effort:
  // a failure here leaves Name/Type/Description still editable above.
  function loadPropertyShapeSection(container, iri, typeIris, rows, holonCtx, onReady){
    container.innerHTML = '';
    var secLabel = document.createElement('div');
    secLabel.className = 'section-label';
    secLabel.style.marginTop = '22px';
    secLabel.textContent = 'Shape Properties';
    container.appendChild(secLabel);
    var loadingHint = document.createElement('p');
    loadingHint.className = 'hint';
    loadingHint.textContent = 'Loading property shape…';
    container.appendChild(loadingHint);

    loadPropertyShapes(typeIris).then(function(props){
      if (!props.length){
        container.innerHTML = '';
        onReady(null);
        return;
      }
      var classIris = [];
      var enumIris = [];
      props.forEach(function(p){
        if (pickControl(p) === 'instance'){
          (p.classes || []).forEach(function(c){ if (classIris.indexOf(c) === -1) classIris.push(c); });
        }
        (p.inValues || []).forEach(function(v){ if (enumIris.indexOf(v) === -1) enumIris.push(v); });
      });
      return Promise.all([Promise.all(classIris.map(loadClassInstances)), resolveLabels(enumIris), loadEnumSchemes()])
        .then(function(results){
          var enumSchemes = results[2];
          container.innerHTML = '';
          container.appendChild(secLabel);
          var hint = document.createElement('p');
          hint.className = 'hint';
          hint.style.margin = '-4px 0 14px';
          hint.textContent = 'Fields defined by this holon’s SHACL shape. Only fields you change are written back; * marks a required field.';
          container.appendChild(hint);

          var fields = [];

          var aiBar = document.createElement('div');
          aiBar.style.cssText = 'display:flex; align-items:center; gap:10px; flex-wrap:wrap; margin:0 0 16px;';
          var populateBtn = document.createElement('button');
          populateBtn.type = 'button';
          populateBtn.className = 'btn';
          populateBtn.textContent = '✨ Populate with AI';
          populateBtn.title = 'Ask Claude to propose values for empty fields, from its own trained knowledge — this page has no live internet access, so this isn’t a web lookup.';
          aiBar.appendChild(populateBtn);
          var populateStatus = document.createElement('span');
          populateStatus.className = 'hint';
          populateStatus.style.margin = '0';
          aiBar.appendChild(populateStatus);
          container.appendChild(aiBar);

          populateBtn.addEventListener('click', function(){
            populateStatus.textContent = '';
            var eligible = fields.filter(function(f){ return f.isEmpty() && AI_FILLABLE_CONTROLS[f.control]; });
            // The Description field lives outside the shape-driven fields
            // above (it's always on the holon, never SHACL-declared), so it's
            // folded into the same request as its own target keyed by
            // DESCRIPTION_PREDICATE -- "empty" here means blank OR "" (an
            // empty string is still nothing to keep), checked live at click
            // time in case the user typed something after opening the form.
            var descArea = holonCtx.descArea;
            var includeDescription = !!(descArea && !descArea.value.trim());
            var totalEligible = eligible.length + (includeDescription ? 1 : 0);
            if (!totalEligible){
              populateStatus.textContent = 'Every fillable field already has a value.';
              return;
            }
            populateBtn.disabled = true;
            populateBtn.textContent = 'Thinking…';
            getSample()
              .then(function(sample){
                if (!sample){
                  sampleHidden = true;
                  populateBtn.hidden = true;
                  return null;
                }
                var targets = eligible.map(function(f){
                  var t = {path: f.path, name: f.meta.name, kind: f.control};
                  if (f.meta.description) t.hint = f.meta.description;
                  if (f.control === 'enum'){
                    t.choices = (f.meta.inValues || []).map(function(v){ return {iri: v, label: labelCache[v] || humanize(v)}; });
                  }
                  return t;
                });
                if (includeDescription){
                  targets.push({path: DESCRIPTION_PREDICATE, name: 'Description', kind: 'lang-text', hint: 'A sentence or two describing this holon.'});
                }
                var promptCtx = {name: holonCtx.name, description: descArea ? descArea.value.trim() : holonCtx.description};
                return sample.json(buildPopulatePrompt(promptCtx, typeIris, targets), {modelTier: 'default'});
              })
              .then(function(data){
                if (!data || typeof data !== 'object') return;
                var filled = 0;
                eligible.forEach(function(f){
                  var v = data[f.path];
                  if (v === null || v === undefined || v === '') return;
                  if (f.control === 'enum' && (f.meta.inValues || []).indexOf(v) === -1) return;
                  if (f.populateValue(v)) filled++;
                });
                if (includeDescription){
                  var dv = data[DESCRIPTION_PREDICATE];
                  if (dv !== null && dv !== undefined && String(dv).trim()){
                    descArea.value = String(dv).trim();
                    filled++;
                  }
                }
                populateStatus.textContent = filled
                  ? ('Filled ' + filled + ' of ' + totalEligible + ' empty field' + (totalEligible === 1 ? '' : 's') + ' from Claude’s own knowledge — review before saving.')
                  : 'Claude didn’t have a confident answer for any of these fields.';
              })
              .catch(function(err){
                var code = err && err.code;
                var HIDE = {not_granted: 1, sampling_disabled: 1, not_declared: 1, capability_disabled: 1, capability_removed: 1};
                if (HIDE[code]){
                  sampleHidden = true;
                  populateBtn.hidden = true;
                  return;
                }
                var COPY = {
                  rate_limited: 'Rate-limited — try again in a bit.',
                  session_expired: 'Your session expired — sign in again and retry.',
                  refused: 'Claude declined to answer that — try again, or fill these in by hand.',
                  empty_completion: 'Claude didn’t return anything usable — try again.',
                  invalid_json: 'Claude’s answer wasn’t valid JSON — try again.',
                  prompt_too_large: 'Too many empty fields to ask about at once — fill in a few by hand, then try again.',
                  upstream_error: 'Something went wrong reaching Claude — try again.',
                  cancelled: ''
                };
                populateStatus.textContent = COPY.hasOwnProperty(code) ? COPY[code] : 'Couldn’t populate from AI — try again.';
              })
              .then(function(){
                populateBtn.disabled = false;
                if (!populateBtn.hidden) populateBtn.textContent = '✨ Populate with AI';
              });
          });

          var hasGroups = props.some(function(p){ return p.group; });
          var lastGroupKey;
          props.forEach(function(meta){
            var groupKey = meta.group || null;
            if (hasGroups && groupKey !== lastGroupKey){
              var gh = document.createElement('div');
              gh.style.cssText = 'font-family:"IBM Plex Mono",monospace; font-size:10.5px; text-transform:uppercase; letter-spacing:0.06em; color:var(--ink-faint); margin:14px 0 6px;';
              gh.textContent = groupKey ? meta.groupLabel : 'Other';
              container.appendChild(gh);
              lastGroupKey = groupKey;
            }
            var existing = (rows.byPred[meta.path] || []).map(function(o){
              return {value: o.value, lang: o['xml:lang'] || null, datatype: o.datatype || null};
            });
            var field = buildShapePropertyField(meta, existing, enumSchemes, iri);
            fields.push(field);
            container.appendChild(field.element);
          });

          onReady({
            buildUpdate: function(){ return buildShapePropsUpdate(iri, fields); }
          });
        });
    }).catch(function(){
      container.innerHTML = '';
      var note = document.createElement('p');
      note.className = 'hint';
      note.textContent = 'Couldn’t load this holon’s property shape — name, type, and description above can still be edited and saved.';
      container.appendChild(note);
      onReady(null);
    });
  }

  // ---- Holon relationships: parents, children, other connections --------
  // holon:isPartOf / geo:administrativePartOf carry no SHACL property shape
  // at all (confirmed live: zero sh:property blocks reference either path),
  // so they're invisible to the shape-driven editor above -- handled here
  // as their own field instead. "Children" is the inverse of that same
  // relation (some other holon naming this one as parent), so editing it
  // writes triples on the *other* subject, not this holon. "Connections"
  // sweeps up whatever other holon-to-holon links this holon already
  // carries that no shape declared either, so nothing in the raw Properties
  // listing is stuck read-only just because it wasn't shape-modelled.

  // Discovers ?pred live (rdfs:subPropertyOf* holon:isPartOf), same fix and
  // same reason as childrenQuery above -- a fixed two-name UNION missed
  // every domain-specific containment predicate (e.g. bridgerton's
  // sl:isPartOfOrg) that isn't literally holon:isPartOf or
  // geo:administrativePartOf. Cross-graph join, so called with no `graph`
  // argument.
  function directChildrenQuery(iri){
    return [
      "PREFIX holon: <https://w3id.org/holon/>",
      "PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>",
      "SELECT ?child ?label ?pred WHERE {",
      "  GRAPH <" + ONTOLOGY_GRAPH + "> { ?pred rdfs:subPropertyOf* holon:isPartOf . }",
      "  GRAPH <" + HOLONS_GRAPH + "> {",
      "    ?child ?pred <" + iri + "> ; rdfs:label ?label .",
      "  }",
      "}"
    ].join("\n");
  }

  // A single editable holon-to-holon relation field: one row per current
  // value (a <select> over the candidate pool) with a remove button, plus
  // an "+ Add" row-adder. Each row remembers the predicate/value it started
  // with, so add/remove/change (swap the selection) can each be expressed
  // precisely -- this never touches a triple the user didn't actually
  // change, even when several rows share the same predicate.
  // predicateForFn (optional): for the containment fields (Parent/Child
  // Holon(s)), recomputes the right predicate once a row's target is
  // actually picked, rather than freezing every freshly-added row at
  // defaultPredicate -- otherwise a new Parent/Child link minted through
  // this generic editor would always come out holon:isPartOf even between
  // two geography admin places, the same inconsistency Add Child and
  // buildCreateTurtle had. Left undefined for the Connections fields
  // below, which each own one fixed SHACL path and were never affected.
  function buildRelationField(labelText, hintText, existingEntries, options, defaultPredicate, predicateForFn){
    var wrap = document.createElement('div');
    wrap.className = 'field shape-field';
    var label = document.createElement('label');
    label.textContent = labelText;
    wrap.appendChild(label);
    if (hintText){
      var hint = document.createElement('p');
      hint.className = 'hint';
      hint.style.margin = '-2px 0 6px';
      hint.textContent = hintText;
      wrap.appendChild(hint);
    }
    var rowsWrap = document.createElement('div');
    wrap.appendChild(rowsWrap);

    var sortedOptions = options.slice().sort(function(a, b){ return a.label.localeCompare(b.label); });
    var rowsState = [];   // {rowEl, select, predicate, originalIri}
    var removed = [];     // {predicate, oldIri}
    var dirty = false;

    function addRow(entry){
      var rowEl = document.createElement('div');
      rowEl.style.cssText = 'display:flex; gap:6px; align-items:center; margin-bottom:6px;';
      var select = document.createElement('select');
      select.style.flex = '1';
      var blank = document.createElement('option');
      blank.value = '';
      blank.textContent = '— choose —';
      select.appendChild(blank);
      sortedOptions.forEach(function(o){
        var opt = document.createElement('option');
        opt.value = o.iri;
        opt.textContent = o.label;
        select.appendChild(opt);
      });
      if (entry && entry.iri) select.value = entry.iri;
      select.addEventListener('change', function(){ dirty = true; });
      rowEl.appendChild(select);
      var rmBtn = document.createElement('button');
      rmBtn.type = 'button';
      rmBtn.className = 'btn';
      rmBtn.textContent = '✕';
      rmBtn.title = 'Remove this link';
      rmBtn.style.cssText = 'padding:4px 8px; flex:none;';
      rowEl.appendChild(rmBtn);
      rowsWrap.appendChild(rowEl);
      var state = {
        rowEl: rowEl, select: select,
        predicate: entry ? entry.predicate : defaultPredicate,
        originalIri: entry ? entry.iri : null
      };
      // A brand-new row (no entry) has nothing picked yet, so the
      // predicate can't be decided until the user actually chooses a
      // target -- recompute it on every change rather than leaving it
      // stuck at defaultPredicate for the row's whole life. An edited
      // EXISTING row keeps deciding fresh too (its old predicate was
      // right for its old target, not necessarily for a newly-swapped
      // one); only a row nobody has touched keeps its original predicate.
      if (predicateForFn){
        select.addEventListener('change', function(){
          if (select.value) state.predicate = predicateForFn(select.value);
        });
      }
      rmBtn.addEventListener('click', function(){
        if (state.originalIri) removed.push({predicate: state.predicate, oldIri: state.originalIri});
        rowsState = rowsState.filter(function(r){ return r !== state; });
        rowEl.remove();
        dirty = true;
      });
      rowsState.push(state);
    }

    (existingEntries || []).forEach(addRow);

    var addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'btn';
    addBtn.textContent = '+ Add';
    addBtn.style.cssText = 'font-size:11.5px; padding:4px 9px;';
    addBtn.addEventListener('click', function(){ addRow(null); dirty = true; });
    wrap.appendChild(addBtn);

    return {
      element: wrap,
      isDirty: function(){ return dirty; },
      getChanges: function(){
        if (!dirty) return [];
        var changes = removed.map(function(r){ return {predicate: r.predicate, oldIri: r.oldIri, newIri: null}; });
        rowsState.forEach(function(r){
          var newVal = r.select.value || null;
          if (newVal !== r.originalIri) changes.push({predicate: r.predicate, oldIri: r.originalIri, newIri: newVal});
        });
        return changes;
      }
    };
  }

  // Every change already carries the exact old/new IRI, so these are fully
  // grounded DELETE DATA / INSERT DATA operations -- no WHERE clause, so
  // there's no risk of a variable-bound delete sweeping up a sibling's
  // triple that happens to share the same predicate (critical for
  // Children, where several holons share holon:isPartOf to different
  // parents). direction 'out' writes <centerIri> pred obj; 'in' writes
  // subj pred <centerIri> (used for the child -> parent link).
  function relationDeleteData(centerIri, changes, direction){
    var lines = [];
    (changes || []).forEach(function(c){
      if (!c.oldIri) return;
      lines.push(direction === 'out'
        ? '<' + centerIri + '> <' + c.predicate + '> <' + c.oldIri + '> .'
        : '<' + c.oldIri + '> <' + c.predicate + '> <' + centerIri + '> .');
    });
    if (!lines.length) return null;
    return 'DELETE DATA { GRAPH <' + HOLONS_GRAPH + '> {\n  ' + lines.join('\n  ') + '\n} }';
  }

  function relationInsertData(centerIri, changes, direction){
    var lines = [];
    (changes || []).forEach(function(c){
      if (!c.newIri) return;
      lines.push(direction === 'out'
        ? '<' + centerIri + '> <' + c.predicate + '> <' + c.newIri + '> .'
        : '<' + c.newIri + '> <' + c.predicate + '> <' + centerIri + '> .');
    });
    if (!lines.length) return null;
    return 'INSERT DATA { GRAPH <' + HOLONS_GRAPH + '> {\n  ' + lines.join('\n  ') + '\n} }';
  }

  // Builds Parents, Children, and Connections together, since Connections
  // needs to know which paths the shape editor above already claimed (so
  // the same predicate never gets two separate controls on one form).
  function loadRelationshipsSection(container, iri, currentTypes, rows, onReady){
    container.innerHTML = '';
    var secLabel = document.createElement('div');
    secLabel.className = 'section-label';
    secLabel.style.marginTop = '22px';
    secLabel.textContent = 'Holon Relationships';
    container.appendChild(secLabel);
    var loadingHint = document.createElement('p');
    loadingHint.className = 'hint';
    loadingHint.textContent = 'Loading parents, children, and connections…';
    container.appendChild(loadingHint);

    Promise.all([
      callTool(SERVER, 'sparql_select', {query: directChildrenQuery(iri)})
        .then(function(res){ return (res.payload && res.payload.results && res.payload.results.bindings) || []; })
        .catch(function(){ return []; }),
      loadPropertyShapes(currentTypes || []).catch(function(){ return []; }),
      loadPartOfPredicates()
    ]).then(function(results){
      var childBindings = results[0];
      var shapeProps = results[1];
      var partOfPreds = results[2];
      container.innerHTML = '';
      container.appendChild(secLabel);
      var hint = document.createElement('p');
      hint.className = 'hint';
      hint.style.margin = '-4px 0 14px';
      hint.textContent = 'This holon’s place in the containment tree, and its other links to holons. Only what you change is written back.';
      container.appendChild(hint);

      var pool = holons.filter(function(h){ return h.iri !== iri; }).map(function(h){ return {iri: h.iri, label: h.label}; });
      function ensureInPool(v){
        if (!pool.some(function(o){ return o.iri === v; })) pool.push({iri: v, label: iriToLabel[v] || humanize(v)});
      }

      // Any predicate this holon actually asserts that's rdfs:subPropertyOf*
      // holon:isPartOf counts as a parent link -- not just the two names
      // worldtest happens to use. rows already has every outbound predicate
      // (detailQuery fetches unconditionally), so this is a client-side
      // filter against the live-discovered family, no extra round trip.
      var parentEntries = [];
      rows.order.forEach(function(path){
        if (!partOfPreds[path]) return;
        (rows.byPred[path] || []).forEach(function(o){
          if (o.type !== 'uri') return;
          ensureInPool(o.value);
          parentEntries.push({predicate: path, iri: o.value});
        });
      });
      var parentsField = buildRelationField(
        'Parent Holon(s)',
        'Where this holon sits in the containment tree. A new link uses geo:administrativePartOf when this holon and the chosen parent are both geography admin places (Continent/Country/ConstituentCountry/FederatedState/District/City), holon:isPartOf otherwise; an untouched existing link keeps its own predicate.',
        parentEntries, pool, ISPARTOF_PREDICATE,
        function(targetIri){ return containmentPredicateFor(typesOfIri(targetIri), currentTypes); }
      );
      container.appendChild(parentsField.element);

      var childEntries = childBindings.map(function(b){
        ensureInPool(b.child.value);
        return {predicate: b.pred.value, iri: b.child.value};
      });
      var childrenField = buildRelationField(
        'Child Holons',
        'Other holons that name this one as their parent. Adding one sets its parent to this holon (geo:administrativePartOf when both are geography admin places, holon:isPartOf otherwise); removing one clears its current parent link.',
        childEntries, pool, ISPARTOF_PREDICATE,
        function(targetIri){ return containmentPredicateFor(currentTypes, typesOfIri(targetIri)); }
      );
      container.appendChild(childrenField.element);

      var shapePaths = {};
      shapeProps.forEach(function(p){ shapePaths[p.path] = true; });
      var excludedPaths = {};
      excludedPaths[TYPE_PREDICATE] = true;
      excludedPaths[LABEL_PREDICATE] = true;
      excludedPaths[DESCRIPTION_PREDICATE] = true;
      excludedPaths[STATUS_PREDICATE] = true;
      Object.keys(partOfPreds).forEach(function(p){ excludedPaths[p] = true; });
      Object.keys(META_PREDICATES).forEach(function(p){ excludedPaths[p] = true; });

      var connectionFields = [];
      rows.order.forEach(function(path){
        if (excludedPaths[path] || shapePaths[path]) return;
        var values = rows.byPred[path] || [];
        if (!values.length || !values.every(function(o){ return o.type === 'uri'; })) return;
        values.forEach(function(o){ ensureInPool(o.value); });
        var entries = values.map(function(o){ return {predicate: path, iri: o.value}; });
        var f = buildRelationField(humanize(path), null, entries, pool, path);
        connectionFields.push(f);
        container.appendChild(f.element);
      });
      if (!connectionFields.length){
        var none = document.createElement('p');
        none.className = 'hint';
        none.textContent = 'No other holon-to-holon connections on this holon yet.';
        container.appendChild(none);
      }

      onReady({
        getParentChanges: function(){ return parentsField.getChanges(); },
        getChildChanges: function(){ return childrenField.getChanges(); },
        getConnectionChanges: function(){
          var all = [];
          connectionFields.forEach(function(f){ all = all.concat(f.getChanges()); });
          return all;
        }
      });
    }).catch(function(){
      container.innerHTML = '';
      var note = document.createElement('p');
      note.className = 'hint';
      note.textContent = 'Couldn’t load holon relationships — the fields above can still be edited and saved.';
      container.appendChild(note);
      onReady(null);
    });
  }

  var SKIP_PREDICATES = {
    "http://www.w3.org/1999/02/22-rdf-syntax-ns#type": true,
    "http://www.w3.org/2000/01/rdf-schema#label": true,
    "https://w3id.org/holon/description": true
  };
  var META_PREDICATES = {
    "http://purl.org/dc/terms/creator": "Registered by",
    "http://purl.org/dc/terms/created": "Registered",
    "http://www.w3.org/ns/prov#generatedAtTime": "Generated"
  };
  // STATUS_PREDICATE and DEPRECATED_STATUS_IRI now live near the top of
  // the script, ahead of DEPRECATED_SET_QUERY -- see the comment there.
  var DESCRIPTION_PREDICATE = "https://w3id.org/holon/description";
  var LABEL_PREDICATE = "http://www.w3.org/2000/01/rdf-schema#label";
  var TYPE_PREDICATE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";

  var mcp = null;
  var samplePromise = null;     // memoized claude.use('sample') -- resolves the sample() fn, or null if unavailable
  var sampleHidden = false;     // set once a permanent hide-code (not_granted, sampling_disabled, ...) is seen
  var holons = [];              // [{iri, label, types:[...]}]
  var iriToLabel = {};          // iri -> label, for cross-linking
  var selectedIri = null;
  var detailUnsub = null;
  var listCacheInfo = null;
  var currentView = 'list';
  var treeLoaded = false;
  var treeNodes = {};           // iri -> {label, types:[...], hasChildren, expanded, children:null|[iri,...], connections:null|[iri,...], loading}
  var creatorIri = null;        // resolved via whoami, used as dct:creator on new holons
  var addChildOpenFor = null;   // iri of the holon whose "add child" form is open, or null
  var addConnOpenFor = null;    // iri of the holon whose "add connection" form is open, or null
  var editOpenFor = null;       // iri of the holon whose "edit" form is open, or null
  var deleteConfirmFor = null;  // iri awaiting a second click to actually delete, or null
  var addTypeFor = null;        // type iri the "new <Type>" form (from a By Type header) is open for
  var addTypeLabelText = null;  // that type's humanised label, for the form's heading/hints
  var lastDetailBindings = null;
  var lastDetailCache = null;

  // ---- Taxonomies (skos:ConceptScheme / skos:Concept management) state --
  var taxonomiesLoaded = false;
  var schemesData = [];          // [{iri, label, count}] -- a scheme's concepts are
                                  // fetched fresh on every selectScheme() call rather
                                  // than cached here.
  var selectedSchemeIri = null;
  // Every ontology-graph resource currently carrying holon:status
  // holon:DeprecatedStatus (concepts and schemes alike) -- loaded once at
  // startup/refresh, like loadClassHierarchy/loadShapeTargetClasses, and
  // checked synchronously wherever a concept might be selected or shown
  // (the enum <select> in the shape editor, and the read-only Properties
  // value display) so a deprecated value never just vanishes -- it stays
  // visible, tagged, and non-selectable, matching this dataset's existing
  // "never delete, tombstone instead" convention (holon:TombstonedStatus is
  // already used the same way for holons).
  var deprecatedSet = {};

  // Per-tab "show deprecated" preference, shared by every flat-list viewer
  // (Taxonomies' schemes AND its in-detail concepts, Namespaces, Classes,
  // Properties, Node Shapes, Property Shapes) -- keyed by a short tab id
  // (see the buildShowDeprecatedToggle() calls in each tab's render
  // function below). Absent/undefined means "hidden" (the default this
  // was added for, 2026-09-19: a long-lived dataset accumulates enough
  // deprecated/deactivated entries that they used to crowd out the still-
  // live ones); explicitly false means the admin ticked the box to reveal
  // them for this tab. A plain object rather than a single global flag so
  // toggling it on one tab (say, Namespaces, while cleaning up legacy
  // prefixes) doesn't also flip every other tab's view.
  var hideDeprecated = {};
  function isDeprecatedHidden(key){ return hideDeprecated[key] !== false; }

  // Builds the small "Show deprecated"/"Show deactivated" checkbox every
  // flat-list tab's render function drops in next to its "+ New ..."
  // button. `rerender` is called with no arguments on toggle -- callers
  // pass whatever re-render entry point re-applies the corresponding
  // filterByDeprecatedSet/filterByDeactivatedFlag call below (usually the
  // tab's own render function; renderSchemeDetail's concepts toggle passes
  // a closure over its own already-fetched `concepts` array instead, so
  // toggling it doesn't re-issue a live query just to change what's shown).
  function buildShowDeprecatedToggle(key, label, rerender){
    var wrap = document.createElement('label');
    wrap.style.cssText = 'display:flex; align-items:center; gap:6px; font-size:11px; color:var(--ink-soft); margin:0 8px 10px; cursor:pointer; user-select:none;';
    var cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !isDeprecatedHidden(key);
    wrap.appendChild(cb);
    wrap.appendChild(document.createTextNode(label));
    cb.addEventListener('change', function(){
      hideDeprecated[key] = !cb.checked;
      rerender();
    });
    return wrap;
  }

  // Filters a list of {iri, ...} items against the ontology-wide
  // deprecatedSet (Taxonomies, Namespaces, Classes, Properties -- every
  // resource that uses holon:status/holon:DeprecatedStatus rather than
  // SHACL's own sh:deactivated). Returns `items` unchanged when the tab's
  // toggle currently has deprecated entries switched ON.
  function filterByDeprecatedSet(items, key){
    if (!isDeprecatedHidden(key)) return items;
    return items.filter(function(it){ return !deprecatedSet[it.iri]; });
  }

  // The SHACL-shape equivalent of filterByDeprecatedSet above, for Node
  // Shapes/Property Shapes -- those carry their own `deactivated` boolean
  // (from sh:deactivated) rather than participating in the ontology-wide
  // deprecatedSet, since they aren't ontology-graph resources.
  function filterByDeactivatedFlag(items, key){
    if (!isDeprecatedHidden(key)) return items;
    return items.filter(function(it){ return !it.deactivated; });
  }

  // ---- Node Shapes / Property Shapes (SHACL 1.2 Core) tab state ---------
  // Same rail/detail shape as Taxonomies above: a flat list loaded once per
  // dataset (nodeShapesLoaded/propShapesLoaded), the currently selected
  // shape's IRI, and a separate "edit form open for" flag so Edit is its
  // own toggle rather than overloading selection the way the holon Edit
  // form does with editOpenFor.
  var nodeShapesLoaded = false;
  var nodeShapesData = [];        // [{iri, targetClass, label, comment, closed, severity, deactivated, propCount}]
  var selectedNodeShapeIri = null;
  var nodeShapeEditOpenFor = null;
  var propShapesLoaded = false;
  var propShapesData = [];        // [{iri, path, name, severity, deactivated}] -- named (IRI) sh:PropertyShapes only,
                                   // so they can be listed and reused across node shapes via sh:property; an inline
                                   // blank-node property shape hand-authored elsewhere in the graph isn't managed here.
  var selectedPropShapeIri = null;
  var propShapeEditOpenFor = null;
  var allPropertiesPromise = null; // memoized ontology-graph property list, for the "New Property Shape" path picker

  // ---- Classes / Properties (raw ontology vocabulary) tab state ---------
  // Distinct from Node Shapes / Property Shapes above: those are SHACL
  // constraints built ON TOP of a class/predicate; these two tabs browse
  // the underlying vocabulary itself. See the section comment further
  // down (next to CLASSES_LIST_QUERY) for why both loaders merge
  // ontology-graph declarations with usage-derived vocabulary.
  var classesLoaded = false;
  var classesData = [];      // [{iri, label, comment, superClasses:[], instanceCount, shapes:[]}]
  var selectedClassIri = null;
  var classEditOpenFor = null;
  var propertiesLoaded = false;
  var propertiesData = [];   // [{iri, label, comment, domains:[], ranges:[], shapes:[]}]
  var selectedPropertyIri = null;
  var propertyEditOpenFor = null;

  // ---- Namespaces (prefix/URI registry, VANN vocabulary) tab state ------
  // Same rail/detail shape again: a flat list loaded once per dataset, the
  // registry entries live in ONTOLOGY_GRAPH (not SHACL_GRAPH) as tiny
  // owl:Ontology resources carrying vann:preferredNamespacePrefix/
  // vann:preferredNamespaceUri, and deprecation reuses the SAME
  // holon:status/holon:DeprecatedStatus mechanism Taxonomies already uses
  // (via the shared deprecatedSet/loadDeprecatedSet/buildSetStatusSparql/
  // buildClearStatusSparql below) rather than SHACL's sh:deactivated --
  // namespaces aren't SHACL resources, so there's nothing to deactivate.
  var namespacesLoaded = false;
  var namespacesData = [];        // [{iri, prefix, uri, label, comment}]
  var selectedNamespaceIri = null;
  var namespaceEditOpenFor = null;

  var $list = document.getElementById('list');
  var $byType = document.getElementById('byType');
  var $tree = document.getElementById('tree');
  var $taxonomies = document.getElementById('taxonomies');
  var $classes = document.getElementById('classes');
  var $properties = document.getElementById('properties');
  var $nodeShapes = document.getElementById('nodeShapes');
  var $propShapes = document.getElementById('propShapes');
  var $namespaces = document.getElementById('namespaces');
  var $searchWrap = document.getElementById('searchWrap');
  var $detail = document.getElementById('detail');
  var $rail = document.getElementById('rail');
  var $railResizer = document.getElementById('railResizer');
  var $layout = document.querySelector('.layout');
  var $search = document.getElementById('search');
  var $connStatus = document.getElementById('connStatus');
  var $connDot = document.getElementById('connDot');
  var $count = document.getElementById('holonCount');
  var $updated = document.getElementById('updated');
  var $refresh = document.getElementById('refreshBtn');
  var $refreshTop = document.getElementById('refreshBtnTop');
  var $viewSelect = document.getElementById('viewSelect');
  var $serverSelect = document.getElementById('serverSelect');
  var $bankSelect = document.getElementById('bankSelect');
  var $datasetSelect = document.getElementById('datasetSelect');

  function humanize(iri){
    var frag = iri.indexOf('#') !== -1 ? iri.split('#').pop() : iri.split('/').filter(Boolean).pop();
    try { frag = decodeURIComponent(frag); } catch(e){}
    var spaced = frag.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_\-]+/g, ' ').trim();
    if (!spaced) return frag;
    return spaced.split(/\s+/).map(function(w){
      return w.charAt(0).toUpperCase() + w.slice(1);
    }).join(' ');
  }

  function formatDate(v){
    var d = new Date(v);
    if (isNaN(d.getTime())) return v;
    var opts = v.length <= 10 ? {day:'numeric', month:'long', year:'numeric', timeZone:'UTC'}
                               : {day:'numeric', month:'long', year:'numeric', hour:'2-digit', minute:'2-digit', timeZone:'UTC'};
    return d.toLocaleDateString('en-GB', opts);
  }

  function formatNumber(value, datatype){
    if (!datatype || !/(double|decimal|float|integer|int|long)$/.test(datatype)) return null;
    var n = Number(value);
    if (Number.isNaN(n)) return null;
    // Integer-family datatypes (xsd:integer/int/long) always render as plain
    // grouped digits -- "0,000" notation, US-style comma thousands separator,
    // no decimal places -- and never fall into the exponential-notation
    // branch below, no matter how large the value: a country population of
    // 1.4bn should read "1,400,000,000", not "1.400e+9". Only the continuous
    // numeric datatypes (decimal/float/double) still switch to exponential
    // for very large or very small magnitudes.
    if (/(integer|int|long)$/.test(datatype)){
      return n.toLocaleString('en-US', {maximumFractionDigits: 0});
    }
    if (n !== 0 && (Math.abs(n) < 1e-3 || Math.abs(n) >= 1e6)) return n.toExponential(3);
    return n.toLocaleString('en-GB', {maximumFractionDigits: 6});
  }

  // Minimal, self-contained Markdown renderer for holon:description (the
  // free-text Description field). No external library -- description text
  // is short prose (a paragraph or a few list items at most), and keeping
  // this inline avoids depending on a CDN load. Escapes HTML first, so the
  // only tags that ever reach the DOM are the ones this function generates
  // itself; supports paragraphs, headings, blockquotes, bullet/numbered
  // lists, and inline **bold**/*italic*/`code`/[link](url).
  function escapeHtml(s){
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // Takes RAW (unescaped) inline text, escapes it, then applies inline
  // markdown formatting -- block-level detection in markdownToHtml runs on
  // the raw lines first (e.g. ">" or "#" would themselves get escaped away
  // and stop matching if escaping happened before block splitting).
  function mdInline(raw){
    var s = escapeHtml(raw);
    s = s.replace(/`([^`]+)`/g, function(m, c){ return '<code>' + c + '</code>'; });
    s = s.replace(/\*\*([^\n]+?)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/\*([^\n]+?)\*/g, '<em>$1</em>');
    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, function(m, text, url){
      var safeUrl = /^(https?:|mailto:)/i.test(url) ? url : '#';
      return '<a href="' + safeUrl + '" target="_blank" rel="noopener noreferrer">' + text + '</a>';
    });
    return s;
  }

  function markdownToHtml(src){
    if (!src) return '';
    var lines = String(src).replace(/\r\n/g, '\n').split('\n');
    var out = [];
    var i = 0;
    while (i < lines.length){
      var line = lines[i];
      if (!line.trim()){ i++; continue; }
      var h = /^(#{1,6})\s+(.*)$/.exec(line);
      if (h){
        var tag = 'h' + Math.min(h[1].length + 1, 4); // h1 stays reserved for the holon's own title
        out.push('<' + tag + '>' + mdInline(h[2]) + '</' + tag + '>');
        i++;
        continue;
      }
      if (/^>\s?/.test(line)){
        var quoteLines = [];
        while (i < lines.length && /^>\s?/.test(lines[i])){ quoteLines.push(lines[i].replace(/^>\s?/, '')); i++; }
        out.push('<blockquote>' + mdInline(quoteLines.join(' ')) + '</blockquote>');
        continue;
      }
      if (/^[-*+]\s+/.test(line)){
        var items = [];
        while (i < lines.length && /^[-*+]\s+/.test(lines[i])){ items.push('<li>' + mdInline(lines[i].replace(/^[-*+]\s+/, '')) + '</li>'); i++; }
        out.push('<ul>' + items.join('') + '</ul>');
        continue;
      }
      if (/^\d+\.\s+/.test(line)){
        var oitems = [];
        while (i < lines.length && /^\d+\.\s+/.test(lines[i])){ oitems.push('<li>' + mdInline(lines[i].replace(/^\d+\.\s+/, '')) + '</li>'); i++; }
        out.push('<ol>' + oitems.join('') + '</ol>');
        continue;
      }
      var paraLines = [];
      while (i < lines.length && lines[i].trim() && !/^(#{1,6})\s+/.test(lines[i]) && !/^>\s?/.test(lines[i]) && !/^[-*+]\s+/.test(lines[i]) && !/^\d+\.\s+/.test(lines[i])){
        paraLines.push(lines[i]);
        i++;
      }
      out.push('<p>' + mdInline(paraLines.join(' ')) + '</p>');
    }
    return out.join('');
  }

  function setConn(state, label){
    $connDot.className = 'dot' + (state ? ' ' + state : '');
    $connStatus.querySelector('span:last-child').innerHTML = label;
  }

  function mcpErrorCopy(err){
    var code = err && err.code;
    var map = {
      not_granted: ["Connector access not granted", "This view was not granted permission to call your connectors."],
      capability_disabled: ["Live data unavailable here", "This viewer can't run connector calls right now."],
      server_not_connected: [SERVER + " not connected", "Add it in claude.ai Settings → Connectors, or check it's enabled on your Windows box, then refresh."],
      needs_reauth: ["Reconnect " + SERVER, "Reconnect it in claude.ai Settings → Connectors, then refresh."],
      selection_required: ["Choose a connector", "You have more than one " + SERVER + " connector — pick one, then refresh."],
      server_unavailable: [SERVER + " unreachable", "The bridge on your workbench didn't answer. Make sure it's running, then retry."],
      blocked_by_policy: ["Blocked by policy", "Your organisation's policy blocks this call."],
      tool_error: ["Query failed", (err && err.message) || "The bridge reported an error running this query."],
      not_in_manifest: ["Not permitted for this view", "This call fell outside what you allowed this page to do."]
    };
    var entry = map[code] || ["Something went wrong", (err && err.message) || "An unexpected error occurred."];
    return {title: entry[0], hint: entry[1], retryable: !!(err && err.retryable)};
  }

  function renderBanner(container, err, onRetry){
    var copy = mcpErrorCopy(err);
    var div = document.createElement('div');
    div.className = 'banner error';
    div.innerHTML = '<h3>' + copy.title + '</h3><p>' + copy.hint + '</p>';
    if (onRetry){
      var b = document.createElement('button');
      b.className = 'btn primary';
      b.textContent = copy.retryable ? 'Retry' : 'Try again';
      b.addEventListener('click', onRetry);
      div.appendChild(b);
    }
    container.appendChild(div);
    return div;
  }

  function renderListSkeleton(){
    $list.innerHTML = '';
    for (var i=0; i<8; i++){
      var row = document.createElement('div');
      row.style.padding = '9px 10px';
      var sk = document.createElement('div');
      sk.className = 'skeleton';
      sk.style.width = (60 + Math.random()*30) + '%';
      row.appendChild(sk);
      $list.appendChild(row);
    }
  }

  // Shared by the flat list and the by-type groups -- a single holon row,
  // detached (caller appends it wherever it belongs).
  function buildHolonRow(h){
    var row = document.createElement('button');
    row.className = 'row' + (h.iri === selectedIri ? ' active' : '');
    row.type = 'button';
    var lbl = document.createElement('span');
    lbl.className = 'row-label';
    lbl.textContent = h.label;
    row.appendChild(lbl);
    if (h.types.length){
      var tp = document.createElement('span');
      tp.className = 'row-type';
      tp.textContent = humanize(primaryType(h.types));
      tp.title = h.types.map(humanize).join(', ');
      row.appendChild(tp);
    }
    row.addEventListener('click', function(){ selectHolon(h.iri); });
    return row;
  }

  function matchesSearch(h, q){
    if (!q) return true;
    var hay = (h.label + ' ' + h.types.join(' ')).toLowerCase();
    return hay.indexOf(q) !== -1;
  }

  function updateCount(shown){
    $count.textContent = shown === holons.length ? (holons.length + ' holons') : (shown + ' of ' + holons.length);
  }

  function renderEmptyState(container, q){
    var empty = document.createElement('div');
    empty.className = 'list-empty';
    empty.textContent = q ? 'No holons match "' + q + '".' : 'No holons found in this dataset.';
    container.appendChild(empty);
  }

  function renderList(){
    var q = ($search.value || '').toLowerCase().trim();
    $list.innerHTML = '';
    var shown = 0;
    holons.forEach(function(h){
      if (!matchesSearch(h, q)) return;
      shown++;
      $list.appendChild(buildHolonRow(h));
    });
    if (!shown) renderEmptyState($list, $search.value);
    updateCount(shown);
  }

  // A group header for the By Type view: label + count, plus an Add button
  // (for every real type -- not the trailing "Untyped" bucket) that opens
  // the "create a new <Type>" form in the detail pane. Shown for every
  // known type -- see computeAllTypes() -- even ones with zero holons yet,
  // so the header (and its Add button) is how a type gets its first one.
  function buildGroupHeader(g){
    var header = document.createElement('div');
    header.className = 'list-group-header';
    var text = document.createElement('span');
    text.textContent = g.label + ' (' + g.items.length + ')';
    header.appendChild(text);
    if (g.typeIri){
      var addBtn = document.createElement('button');
      addBtn.type = 'button';
      addBtn.className = 'group-add-btn';
      addBtn.textContent = '+';
      addBtn.title = 'Add a new ' + g.label;
      addBtn.setAttribute('aria-label', 'Add a new ' + g.label);
      addBtn.addEventListener('click', function(ev){
        ev.stopPropagation();
        openAddTypeForm(g.typeIri, g.label);
      });
      header.appendChild(addBtn);
    }
    return header;
  }

  // Same holon set as the flat list, grouped under a header per primary
  // type (the same type the row badge shows) -- a holon with no domain
  // type beyond holon:Holon falls into a trailing "Untyped" group. Unlike
  // the flat list, every known type (see computeAllTypes()) gets a header
  // even with zero current members, so a type can be populated for the
  // first time straight from its own header's Add button. A search filters
  // which of those headers show: with no filter, everything appears; while
  // filtering, an empty group only stays visible if its own name matches.
  function renderByType(){
    var q = ($search.value || '').toLowerCase().trim();
    $byType.innerHTML = '';
    var groups = {};
    var order = [];
    function ensureGroup(key, label, typeIri){
      if (!groups[key]){
        groups[key] = {label: label, items: [], typeIri: typeIri};
        order.push(key);
      }
      return groups[key];
    }
    computeAllTypes().forEach(function(t){ ensureGroup(t, humanize(t), t); });
    var shown = 0;
    holons.forEach(function(h){
      if (!matchesSearch(h, q)) return;
      shown++;
      var t = h.types.length ? primaryType(h.types) : null;
      var key = t || ' untyped';
      var g = ensureGroup(key, t ? humanize(t) : 'Untyped', t);
      g.items.push(h);
    });
    var visibleKeys = order.filter(function(key){
      var g = groups[key];
      if (key === ' untyped') return g.items.length > 0;
      if (g.items.length) return true;
      if (!q) return true;
      return g.label.toLowerCase().indexOf(q) !== -1;
    });
    if (!visibleKeys.length){
      renderEmptyState($byType, $search.value);
      updateCount(shown);
      return;
    }
    visibleKeys.sort(function(a, b){
      if (a === ' untyped') return 1;
      if (b === ' untyped') return -1;
      return groups[a].label.localeCompare(groups[b].label);
    });
    visibleKeys.forEach(function(key){
      var g = groups[key];
      $byType.appendChild(buildGroupHeader(g));
      if (g.items.length){
        g.items.forEach(function(h){ $byType.appendChild(buildHolonRow(h)); });
      } else {
        var empty = document.createElement('div');
        empty.className = 'list-empty';
        empty.style.cssText = 'padding:2px 8px 12px; font-size:12px;';
        empty.textContent = 'No holons yet.';
        $byType.appendChild(empty);
      }
    });
    updateCount(shown);
  }

  function renderUpdated(){
    if (!listCacheInfo){ $updated.textContent = ''; return; }
    var d = new Date(listCacheInfo.storedAt);
    $updated.textContent = 'updated ' + d.toLocaleTimeString('en-GB', {hour:'2-digit', minute:'2-digit'});
  }

  function renderTree(){
    $tree.innerHTML = '';
    var root = treeNodes[HOME_IRI];
    if (!root) return;
    $tree.appendChild(renderTreeNode(HOME_IRI, 0));
  }

  function renderTreeNode(iri, depth, isConnection, via){
    var node = treeNodes[iri];
    var wrap = document.createElement('div');

    var row = document.createElement('div');
    row.className = 'tree-row' + (iri === selectedIri ? ' active' : '');
    row.style.paddingLeft = (8 + depth * 18) + 'px';

    var toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'tree-toggle' + (node.hasChildren ? (node.expanded ? ' expanded' : '') : ' leaf');
    toggle.textContent = '▸';
    toggle.tabIndex = node.hasChildren ? 0 : -1;
    toggle.setAttribute('aria-label', node.expanded ? 'Collapse' : 'Expand');
    if (node.hasChildren){
      toggle.addEventListener('click', function(ev){ ev.stopPropagation(); toggleExpand(iri); });
    }
    row.appendChild(toggle);

    var label = document.createElement('span');
    label.className = 'tree-label' + (isConnection ? ' connection' : '');
    label.textContent = node.label;
    if (isConnection){
      label.title = via && via.length ? 'Connection via ' + via.map(humanize).join(', ') : 'Connection';
    }
    row.appendChild(label);

    if (node.types.length){
      var tp = document.createElement('span');
      tp.className = 'tree-type';
      tp.textContent = humanize(primaryType(node.types));
      tp.title = node.types.map(humanize).join(', ');
      row.appendChild(tp);
    }

    row.addEventListener('click', function(){ selectHolon(iri); });
    wrap.appendChild(row);

    if (node.expanded){
      if (node.loading){
        var loading = document.createElement('div');
        loading.className = 'tree-loading';
        loading.style.paddingLeft = (8 + (depth + 1) * 18) + 'px';
        loading.textContent = 'Loading…';
        wrap.appendChild(loading);
      } else if (node.loadError){
        var errWrap = document.createElement('div');
        errWrap.style.paddingLeft = (8 + (depth + 1) * 18) + 'px';
        renderBanner(errWrap, node.loadError, function(){ loadChildren(iri); });
        wrap.appendChild(errWrap);
      } else {
        if (node.children){
          node.children.forEach(function(childIri){
            wrap.appendChild(renderTreeNode(childIri, depth + 1, false));
          });
        }
        if (node.connections){
          node.connections.forEach(function(conn){
            wrap.appendChild(renderTreeNode(conn.iri, depth + 1, true, conn.via));
          });
        }
      }
    }
    return wrap;
  }

  function loadChildren(iri){
    var node = treeNodes[iri];
    if (!node) return;
    node.loading = true;
    node.loadError = null;
    renderTree();
    Promise.all([
      callTool(SERVER, 'sparql_select', {query: childrenQuery(iri)}),
      callTool(SERVER, 'sparql_select', {query: connectionsQuery(iri)})
    ])
      .then(function(results){
        var childBindings = (results[0].payload && results[0].payload.results && results[0].payload.results.bindings) || [];
        var kidIris = childBindings.map(function(b){
          var kIri = b.child.value;
          treeNodes[kIri] = treeNodes[kIri] || {
            label: b.label.value,
            types: b.types ? b.types.value.split('|').filter(Boolean) : [],
            hasChildren: !!(b.hasChildren && b.hasChildren.value === 'true'),
            expanded: false,
            children: null,
            connections: null,
            loading: false
          };
          return kIri;
        });
        var connBindings = (results[1].payload && results[1].payload.results && results[1].payload.results.bindings) || [];
        var connections = connBindings.map(function(b){
          var cIri = b.target.value;
          treeNodes[cIri] = treeNodes[cIri] || {
            label: b.label.value,
            types: b.types ? b.types.value.split('|').filter(Boolean) : [],
            hasChildren: !!(b.hasChildren && b.hasChildren.value === 'true'),
            expanded: false,
            children: null,
            connections: null,
            loading: false
          };
          return {
            iri: cIri,
            via: b.via ? b.via.value.split('|').filter(Boolean) : []
          };
        });
        node.children = kidIris;
        node.connections = connections;
        node.loading = false;
        renderTree();
      })
      .catch(function(err){
        node.loading = false;
        node.loadError = err;
        renderTree();
      });
  }

  function toggleExpand(iri){
    var node = treeNodes[iri];
    if (!node || !node.hasChildren) return;
    node.expanded = !node.expanded;
    if (node.expanded && node.children === null && !node.loading){
      loadChildren(iri);
    } else {
      renderTree();
    }
  }

  function loadTreeRoot(){
    if (!mcp){
      $tree.innerHTML = '<div class="tree-empty">No connector available.</div>';
      return;
    }
    $tree.innerHTML = '';
    var loading = document.createElement('div');
    loading.className = 'tree-empty';
    loading.textContent = 'Loading tree…';
    $tree.appendChild(loading);
    callTool(SERVER, 'sparql_select', {query: nodeInfoQuery(HOME_IRI), graph: HOLONS_GRAPH})
      .then(function(res){
        var bindings = (res.payload && res.payload.results && res.payload.results.bindings) || [];
        var b = bindings[0];
        treeNodes[HOME_IRI] = {
          label: b ? b.label.value : humanize(HOME_IRI),
          types: b && b.types ? b.types.value.split('|').filter(Boolean) : [],
          hasChildren: true,
          expanded: false,
          children: null,
          connections: null,
          loading: false
        };
        treeLoaded = true;
        renderTree();
      })
      .catch(function(err){
        $tree.innerHTML = '';
        renderBanner($tree, err, loadTreeRoot);
      });
  }

  // ---- Taxonomies tab: rendering ----------------------------------------

  function loadTaxonomies(force){
    if (!mcp){
      $taxonomies.innerHTML = '<div class="list-empty">No connector available.</div>';
      return;
    }
    $taxonomies.innerHTML = '';
    var loading = document.createElement('div');
    loading.className = 'list-empty';
    loading.textContent = 'Loading taxonomies…';
    $taxonomies.appendChild(loading);
    Promise.all([
      callTool(SERVER, 'sparql_select', {query: SCHEME_LIST_QUERY})
        .then(function(res){ return (res.payload && res.payload.results && res.payload.results.bindings) || []; }),
      loadDeprecatedSet(force)
    ]).then(function(results){
      var bindings = results[0];
      schemesData = bindings.map(function(b){
        return {
          iri: b.scheme.value,
          label: b.labelOut ? b.labelOut.value : humanize(b.scheme.value),
          count: b.n ? parseInt(b.n.value, 10) : 0
        };
      }).sort(function(a, b){ return a.label.localeCompare(b.label); });
      taxonomiesLoaded = true;
      renderTaxonomies();
      if (selectedSchemeIri) selectScheme(selectedSchemeIri, true);
    }).catch(function(err){
      $taxonomies.innerHTML = '';
      renderBanner($taxonomies, err, function(){ loadTaxonomies(true); });
    });
  }

  function buildSchemeRow(s){
    var row = document.createElement('button');
    var isDeprecated = !!deprecatedSet[s.iri];
    row.className = 'row' + (s.iri === selectedSchemeIri ? ' active' : '');
    row.type = 'button';
    if (isDeprecated) row.style.opacity = '0.55';
    var lbl = document.createElement('span');
    lbl.className = 'row-label';
    lbl.textContent = s.label + (isDeprecated ? ' (deprecated)' : '');
    row.appendChild(lbl);
    var tp = document.createElement('span');
    tp.className = 'row-type';
    tp.textContent = s.count + (s.count === 1 ? ' concept' : ' concepts');
    row.appendChild(tp);
    row.addEventListener('click', function(){ selectScheme(s.iri); });
    return row;
  }

  function renderTaxonomies(){
    $taxonomies.innerHTML = '';
    var addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'btn';
    addBtn.textContent = '+ New Scheme';
    addBtn.style.cssText = 'margin:8px 8px 10px; font-size:11.5px; padding:5px 10px;';
    addBtn.addEventListener('click', openNewSchemeForm);
    $taxonomies.appendChild(addBtn);
    $taxonomies.appendChild(buildShowDeprecatedToggle('taxonomies', 'Show deprecated', renderTaxonomies));

    if (!schemesData.length){
      var empty = document.createElement('div');
      empty.className = 'list-empty';
      empty.textContent = 'No concept schemes yet.';
      $taxonomies.appendChild(empty);
      return;
    }
    var visibleSchemes = filterByDeprecatedSet(schemesData, 'taxonomies');
    if (!visibleSchemes.length){
      var allHidden = document.createElement('div');
      allHidden.className = 'list-empty';
      allHidden.textContent = 'Every scheme is deprecated -- tick "Show deprecated" above to see them.';
      $taxonomies.appendChild(allHidden);
      return;
    }
    visibleSchemes.forEach(function(s){ $taxonomies.appendChild(buildSchemeRow(s)); });
  }

  function selectScheme(schemeIri, skipRerenderRail){
    selectedSchemeIri = schemeIri;
    if (!skipRerenderRail) renderTaxonomies();
    renderDetailSkeleton();
    Promise.all([
      callTool(SERVER, 'sparql_select', {query: schemeConceptsQuery(schemeIri)})
        .then(function(res){ return (res.payload && res.payload.results && res.payload.results.bindings) || []; }),
      loadDeprecatedSet()
    ]).then(function(results){
      var bindings = results[0];
      var concepts = bindings.map(function(b){
        return {
          iri: b.concept.value,
          label: b.labelOut ? b.labelOut.value : humanize(b.concept.value),
          definition: b.definitionOut ? b.definitionOut.value : '',
          altLabels: b.altLabels && b.altLabels.value ? b.altLabels.value.split('|').filter(Boolean) : []
        };
      }).sort(function(a, b){ return a.label.localeCompare(b.label); });
      renderSchemeDetail(schemeIri, concepts);
    }).catch(function(err){
      $detail.innerHTML = '';
      var inner = document.createElement('div');
      inner.className = 'detail-inner';
      $detail.appendChild(inner);
      renderBanner(inner, err, function(){ selectScheme(schemeIri); });
    });
  }

  function renderSchemeDetail(schemeIri, concepts){
    var scheme = schemesData.find(function(s){ return s.iri === schemeIri; });
    var isDeprecated = !!deprecatedSet[schemeIri];
    var inner = document.createElement('div');
    inner.className = 'detail-inner';

    var badges = document.createElement('div');
    badges.className = 'badges';
    var p = document.createElement('span');
    p.className = 'pill type';
    p.textContent = 'Concept Scheme';
    badges.appendChild(p);
    if (isDeprecated){
      var dp = document.createElement('span');
      dp.className = 'pill status';
      dp.textContent = 'Deprecated';
      badges.appendChild(dp);
    }
    inner.appendChild(badges);

    var h2 = document.createElement('h2');
    h2.className = 'title';
    h2.textContent = scheme ? scheme.label : humanize(schemeIri);
    inner.appendChild(h2);

    var iriLine = document.createElement('div');
    iriLine.className = 'iri';
    iriLine.textContent = schemeIri;
    inner.appendChild(iriLine);

    var actions = document.createElement('div');
    actions.className = 'actions';
    var renameBtn = document.createElement('button');
    renameBtn.type = 'button'; renameBtn.className = 'btn'; renameBtn.textContent = 'Rename';
    var toggleBtn = document.createElement('button');
    toggleBtn.type = 'button'; toggleBtn.className = 'btn';
    toggleBtn.textContent = isDeprecated ? 'Reactivate' : 'Deprecate';
    actions.appendChild(renameBtn);
    actions.appendChild(toggleBtn);
    inner.appendChild(actions);

    var renameBox = document.createElement('div');
    inner.appendChild(renameBox);
    renameBtn.addEventListener('click', function(){
      renameBox.innerHTML = '';
      renameBox.appendChild(buildInlineRenameForm(scheme ? scheme.label : '', function(newLabel){
        return callTool(SERVER, 'sparql_update', {update: buildRenameSchemeSparql(schemeIri, newLabel)})
          .then(function(){ return mcp.invalidate(SERVER, 'sparql_select').catch(function(){}); })
          .then(function(){ loadTaxonomies(true); });
      }, function(){ renameBox.innerHTML = ''; }));
    });

    // sparql_select results are cached (the same reason every other write
    // path in this file -- buildEditForm's save, performDelete, refreshAll
    // -- calls mcp.invalidate before its next read): without invalidating
    // here, the re-read right after this toggle can come back from the
    // pre-write cache, so the button's SPARQL succeeds but the screen never
    // shows the change -- which is exactly what looks like "the button
    // doesn't work."
    toggleBtn.addEventListener('click', function(){
      toggleBtn.disabled = true;
      var op = isDeprecated ? callTool(SERVER, 'sparql_update', {update: buildClearStatusSparql(schemeIri)})
                             : callTool(SERVER, 'sparql_update', {update: buildSetStatusSparql(schemeIri, DEPRECATED_STATUS_IRI)});
      op.then(function(){ return mcp.invalidate(SERVER, 'sparql_select').catch(function(){}); })
        .then(function(){ return loadDeprecatedSet(true); })
        .then(function(){ selectScheme(schemeIri); renderTaxonomies(); })
        .catch(function(err){ toggleBtn.disabled = false; renderBanner(inner, err); });
    });

    var hint = document.createElement('p');
    hint.className = 'hint';
    hint.style.margin = '18px 0 10px';
    hint.textContent = isDeprecated
      ? 'This scheme is deprecated -- its concepts stay visible everywhere but are no longer offered as new choices.'
      : 'Concepts in this taxonomy. Deprecating one keeps it in the system (and on any holon already using it) but removes it from the picker.';
    inner.appendChild(hint);

    var secLabel = document.createElement('div');
    secLabel.className = 'section-label';
    secLabel.style.marginTop = '10px';
    secLabel.textContent = 'Concepts (' + concepts.length + ')';
    inner.appendChild(secLabel);

    // Reuses the already-fetched `concepts` array on toggle rather than
    // re-running selectScheme()'s live query -- this is purely a display
    // filter, so there's nothing to re-fetch.
    inner.appendChild(buildShowDeprecatedToggle('concepts', 'Show deprecated concepts', function(){
      renderSchemeDetail(schemeIri, concepts);
    }));

    var addConceptWrap = document.createElement('div');
    inner.appendChild(addConceptWrap);
    addConceptWrap.appendChild(buildAddConceptControl(schemeIri, concepts));

    var kv = document.createElement('div');
    kv.className = 'kv';
    var visibleConcepts = filterByDeprecatedSet(concepts, 'concepts');
    if (concepts.length && !visibleConcepts.length){
      var allHiddenC = document.createElement('p');
      allHiddenC.className = 'hint';
      allHiddenC.textContent = 'Every concept here is deprecated -- tick "Show deprecated concepts" above to see them.';
      inner.appendChild(allHiddenC);
    }
    visibleConcepts.forEach(function(c){
      kv.appendChild(buildConceptRow(schemeIri, c));
    });
    inner.appendChild(kv);

    $detail.innerHTML = '';
    $detail.appendChild(inner);
  }

  function buildConceptRow(schemeIri, c){
    var isDeprecated = !!deprecatedSet[c.iri];
    var row = document.createElement('div');
    row.className = 'kv-row';
    if (isDeprecated) row.style.opacity = '0.55';

    var key = document.createElement('div');
    key.className = 'kv-key';
    key.textContent = c.label + (isDeprecated ? ' (deprecated)' : '');
    row.appendChild(key);

    var val = document.createElement('div');
    val.className = 'kv-val';
    val.style.gap = '6px';

    // Alt labels are now directly editable (see buildConceptEditForm), so
    // they're shown as visible tags here rather than tucked into a hover
    // tooltip -- each one uses the same small-tag look as a row's type
    // badge (row-type), just repurposed for a plain text value.
    c.altLabels.forEach(function(al){
      var tag = document.createElement('span');
      tag.className = 'row-type';
      tag.style.cssText = 'max-width:none;';
      tag.textContent = al;
      val.appendChild(tag);
    });

    var editBtn = document.createElement('button');
    editBtn.type = 'button'; editBtn.className = 'btn'; editBtn.textContent = 'Edit';
    editBtn.style.cssText = 'font-size:11px; padding:3px 8px;';
    val.appendChild(editBtn);

    var toggleBtn = document.createElement('button');
    toggleBtn.type = 'button'; toggleBtn.className = 'btn';
    toggleBtn.textContent = isDeprecated ? 'Reactivate' : 'Deprecate';
    toggleBtn.style.cssText = 'font-size:11px; padding:3px 8px;';
    val.appendChild(toggleBtn);

    if (c.definition){
      var defP = document.createElement('div');
      defP.style.cssText = 'width:100%; font-size:12.5px; color:var(--ink-soft); margin-top:4px; line-height:1.4;';
      defP.textContent = c.definition;
      val.appendChild(defP);
    }

    row.appendChild(val);

    var editRow = document.createElement('div');
    editRow.style.cssText = 'grid-column:1 / -1;';
    row.appendChild(editRow);

    editBtn.addEventListener('click', function(){
      editRow.innerHTML = '';
      editRow.appendChild(buildConceptEditForm(schemeIri, c, function(){ editRow.innerHTML = ''; }));
    });

    // See the scheme-level toggle's comment above -- the invalidate is
    // required here too, or a successful deprecate/reactivate write can be
    // masked by a stale cached read right after it.
    toggleBtn.addEventListener('click', function(){
      toggleBtn.disabled = true;
      var op = isDeprecated ? callTool(SERVER, 'sparql_update', {update: buildClearStatusSparql(c.iri)})
                             : callTool(SERVER, 'sparql_update', {update: buildSetStatusSparql(c.iri, DEPRECATED_STATUS_IRI)});
      op.then(function(){ return mcp.invalidate(SERVER, 'sparql_select').catch(function(){}); })
        .then(function(){ return loadDeprecatedSet(true); })
        .then(function(){ selectScheme(schemeIri); })
        .catch(function(){ toggleBtn.disabled = false; });
    });

    return row;
  }

  // Builds the sample.json() prompt for a concept's "Populate with AI" --
  // same spirit as buildPopulatePrompt for holons (own knowledge only, null
  // over a guess, no live internet access), scoped to the two fields this
  // editor actually has room for: a one-sentence skos:definition, and a
  // short list of skos:altLabel synonyms not already present. Only asks for
  // a definition when the field is currently empty -- Populate never
  // overwrites a value that's already there.
  function buildConceptPopulatePrompt(schemeLabel, currentLabel, needDefinition, existingAltLabels){
    var lines = [
      'You are helping fill in missing structured data for one entry in a controlled vocabulary (a SKOS concept scheme) inside a worldbuilding knowledge graph called "Worldtest".',
      'Concept scheme: ' + schemeLabel,
      'Concept preferred label: ' + currentLabel
    ];
    if (existingAltLabels.length) lines.push('Existing alternate labels: ' + existingAltLabels.join(', '));
    lines.push(
      '',
      'You have no live internet access and no memory beyond this message. Answer from your own general knowledge only; use null (or an empty array) for anything you are not reasonably confident about rather than guessing.',
      ''
    );
    var keys = [];
    if (needDefinition){
      keys.push('"definition": a single clear sentence defining this concept, or null');
    }
    keys.push('"altLabels": an array of 0 to 3 short alternate labels or synonyms for this concept that are NOT already listed above (an empty array if none come to mind)');
    lines.push('Respond with ONLY a JSON object with these keys: ' + keys.join('; ') + '. No other text, no markdown fences.');
    return lines.join('\n');
  }

  // The concept editor: preferred label, skos:definition (0:1), and
  // skos:altLabel (0:infinity) all in one form, plus a "Populate with AI"
  // shortcut that proposes a definition and/or extra alt labels the same
  // way the holon editor's AI button does (see loadPropertyShapeSection).
  // Saving only issues an update per field that actually changed --
  // untouched fields never generate a write, same discipline as the
  // holon-side shape editor and buildShapePropsUpdate.
  function buildConceptEditForm(schemeIri, c, onDone){
    var scheme = schemesData.find(function(s){ return s.iri === schemeIri; });
    var schemeLabel = scheme ? scheme.label : humanize(schemeIri);

    var wrap = document.createElement('div');
    wrap.style.cssText = 'margin-top:8px; padding:12px 14px; border:1px solid var(--line); border-radius:8px; background:var(--paper);';

    var aiBar = document.createElement('div');
    aiBar.style.cssText = 'display:flex; align-items:center; gap:10px; flex-wrap:wrap; margin:0 0 12px;';
    var populateBtn = document.createElement('button');
    populateBtn.type = 'button';
    populateBtn.className = 'btn';
    populateBtn.textContent = '✨ Populate with AI';
    populateBtn.title = 'Ask Claude to propose a definition and alternate labels from its own trained knowledge — this page has no live internet access, so this isn’t a web lookup.';
    populateBtn.style.cssText = 'font-size:11.5px; padding:5px 10px;';
    aiBar.appendChild(populateBtn);
    var populateStatus = document.createElement('span');
    populateStatus.className = 'hint';
    populateStatus.style.margin = '0';
    aiBar.appendChild(populateStatus);
    wrap.appendChild(aiBar);

    var labelField = document.createElement('div');
    labelField.style.cssText = 'margin-bottom:10px;';
    var labelLbl = document.createElement('label');
    labelLbl.style.cssText = 'display:block; font-size:11.5px; font-weight:600; color:var(--ink-soft); margin-bottom:4px;';
    labelLbl.textContent = 'Preferred label';
    labelField.appendChild(labelLbl);
    var labelInput = document.createElement('input');
    labelInput.type = 'text';
    labelInput.value = c.label;
    labelInput.style.cssText = 'width:100%; font:inherit; font-size:13px; padding:5px 8px; border:1px solid var(--line); border-radius:6px; background:var(--card); color:var(--ink);';
    labelField.appendChild(labelInput);
    wrap.appendChild(labelField);

    var defField = document.createElement('div');
    defField.style.cssText = 'margin-bottom:10px;';
    var defLbl = document.createElement('label');
    defLbl.style.cssText = 'display:block; font-size:11.5px; font-weight:600; color:var(--ink-soft); margin-bottom:4px;';
    defLbl.textContent = 'Definition';
    defField.appendChild(defLbl);
    var defArea = document.createElement('textarea');
    defArea.rows = 2;
    defArea.value = c.definition || '';
    defArea.placeholder = 'A short definition for this concept (skos:definition) — optional.';
    defArea.style.cssText = 'width:100%; font:inherit; font-size:13px; padding:5px 8px; border:1px solid var(--line); border-radius:6px; background:var(--card); color:var(--ink); resize:vertical;';
    defField.appendChild(defArea);
    wrap.appendChild(defField);

    var altField = document.createElement('div');
    altField.style.cssText = 'margin-bottom:12px;';
    var altLbl = document.createElement('label');
    altLbl.style.cssText = 'display:block; font-size:11.5px; font-weight:600; color:var(--ink-soft); margin-bottom:4px;';
    altLbl.textContent = 'Alternate labels';
    altField.appendChild(altLbl);
    var altRows = document.createElement('div');
    altField.appendChild(altRows);
    var altState = c.altLabels.slice(); // working copy -- diffed against c.altLabels on Save

    function renderAltRows(){
      altRows.innerHTML = '';
      altState.forEach(function(al, idx){
        var r = document.createElement('div');
        r.style.cssText = 'display:flex; gap:6px; align-items:center; margin-bottom:4px;';
        var span = document.createElement('span');
        span.textContent = al;
        span.style.cssText = 'flex:1; font-size:12.8px;';
        r.appendChild(span);
        var rm = document.createElement('button');
        rm.type = 'button'; rm.className = 'btn'; rm.textContent = '✕';
        rm.title = 'Remove this alternate label';
        rm.style.cssText = 'font-size:11px; padding:2px 7px; flex:none;';
        rm.addEventListener('click', function(){ altState.splice(idx, 1); renderAltRows(); });
        r.appendChild(rm);
        altRows.appendChild(r);
      });
    }
    renderAltRows();

    var addAltRow = document.createElement('div');
    addAltRow.style.cssText = 'display:flex; gap:6px; margin-top:4px;';
    var addAltInput = document.createElement('input');
    addAltInput.type = 'text';
    addAltInput.placeholder = 'Add an alternate label…';
    addAltInput.style.cssText = 'flex:1; font:inherit; font-size:12.8px; padding:4px 8px; border:1px solid var(--line); border-radius:6px; background:var(--card); color:var(--ink);';
    var addAltBtn = document.createElement('button');
    addAltBtn.type = 'button'; addAltBtn.className = 'btn'; addAltBtn.textContent = '+ Add';
    addAltBtn.style.cssText = 'font-size:11px; padding:4px 9px; flex:none;';
    function tryAddAlt(){
      var v = addAltInput.value.trim();
      if (!v || altState.indexOf(v) !== -1){ addAltInput.value = ''; return; }
      altState.push(v);
      addAltInput.value = '';
      renderAltRows();
    }
    addAltBtn.addEventListener('click', tryAddAlt);
    addAltInput.addEventListener('keydown', function(ev){
      if (ev.key === 'Enter'){ ev.preventDefault(); tryAddAlt(); }
    });
    addAltRow.appendChild(addAltInput);
    addAltRow.appendChild(addAltBtn);
    altField.appendChild(addAltRow);
    wrap.appendChild(altField);

    populateBtn.addEventListener('click', function(){
      populateStatus.textContent = '';
      var needDefinition = !defArea.value.trim();
      var existingAlts = altState.slice();
      populateBtn.disabled = true;
      populateBtn.textContent = 'Thinking…';
      getSample()
        .then(function(sample){
          if (!sample){
            sampleHidden = true;
            populateBtn.hidden = true;
            return null;
          }
          var prompt = buildConceptPopulatePrompt(schemeLabel, labelInput.value.trim() || c.label, needDefinition, existingAlts);
          return sample.json(prompt, {modelTier: 'default'});
        })
        .then(function(data){
          if (!data || typeof data !== 'object') return;
          var filled = 0;
          if (needDefinition && data.definition && String(data.definition).trim()){
            defArea.value = String(data.definition).trim();
            filled++;
          }
          if (Array.isArray(data.altLabels)){
            data.altLabels.forEach(function(al){
              var v = String(al || '').trim();
              if (v && altState.indexOf(v) === -1){ altState.push(v); filled++; }
            });
            renderAltRows();
          }
          populateStatus.textContent = filled
            ? ('Filled in ' + filled + ' suggestion' + (filled === 1 ? '' : 's') + ' from Claude’s own knowledge — review before saving.')
            : 'Claude didn’t have a confident suggestion this time.';
        })
        .catch(function(err){
          var code = err && err.code;
          var HIDE = {not_granted: 1, sampling_disabled: 1, not_declared: 1, capability_disabled: 1, capability_removed: 1};
          if (HIDE[code]){
            sampleHidden = true;
            populateBtn.hidden = true;
            return;
          }
          var COPY = {
            rate_limited: 'Rate-limited — try again in a bit.',
            session_expired: 'Your session expired — sign in again and retry.',
            refused: 'Claude declined to answer that — try again, or fill these in by hand.',
            empty_completion: 'Claude didn’t return anything usable — try again.',
            invalid_json: 'Claude’s answer wasn’t valid JSON — try again.',
            prompt_too_large: 'Too much context to ask about at once — try again.',
            upstream_error: 'Something went wrong reaching Claude — try again.',
            cancelled: ''
          };
          populateStatus.textContent = COPY.hasOwnProperty(code) ? COPY[code] : 'Couldn’t populate from AI — try again.';
        })
        .then(function(){
          populateBtn.disabled = false;
          if (!populateBtn.hidden) populateBtn.textContent = '✨ Populate with AI';
        });
    });

    var warn = document.createElement('p');
    warn.style.cssText = 'display:none; margin:0 0 8px; font-size:12px; color:var(--bad);';
    wrap.appendChild(warn);

    var actions = document.createElement('div');
    actions.style.cssText = 'display:flex; gap:6px;';
    var saveBtn = document.createElement('button');
    saveBtn.type = 'button'; saveBtn.className = 'btn primary'; saveBtn.textContent = 'Save';
    saveBtn.style.cssText = 'font-size:11.5px; padding:5px 10px;';
    var cancelBtn = document.createElement('button');
    cancelBtn.type = 'button'; cancelBtn.className = 'btn'; cancelBtn.textContent = 'Cancel';
    cancelBtn.style.cssText = 'font-size:11.5px; padding:5px 10px;';
    cancelBtn.addEventListener('click', onDone);
    actions.appendChild(saveBtn);
    actions.appendChild(cancelBtn);
    wrap.appendChild(actions);

    saveBtn.addEventListener('click', function(){
      var newLabel = labelInput.value.trim();
      warn.style.display = 'none';
      if (!newLabel){
        warn.textContent = 'A label is required.';
        warn.style.display = 'block';
        return;
      }
      var newDef = defArea.value.trim();
      var oldDef = c.definition || '';
      var removedAlts = c.altLabels.filter(function(a){ return altState.indexOf(a) === -1; });
      var addedAlts = altState.filter(function(a){ return c.altLabels.indexOf(a) === -1; });

      saveBtn.disabled = true; cancelBtn.disabled = true; saveBtn.textContent = 'Saving…';
      var chain = Promise.resolve();
      if (newLabel !== c.label){
        chain = chain.then(function(){ return callTool(SERVER, 'sparql_update', {update: buildRenameConceptSparql(c.iri, newLabel)}); });
      }
      if (newDef !== oldDef){
        chain = chain.then(function(){ return callTool(SERVER, 'sparql_update', {update: buildSetConceptDefinitionSparql(c.iri, newDef)}); });
      }
      removedAlts.forEach(function(a){
        chain = chain.then(function(){ return callTool(SERVER, 'sparql_update', {update: buildRemoveAltLabelSparql(c.iri, a)}); });
      });
      addedAlts.forEach(function(a){
        chain = chain.then(function(){ return callTool(SERVER, 'sparql_update', {update: buildAddAltLabelSparql(c.iri, a)}); });
      });
      // Invalidate before the re-read, same as every write path in this
      // file -- sparql_select results are cached, so skipping this would
      // let the writes above succeed while the re-render right after them
      // shows stale (pre-save) data.
      chain
        .then(function(){ return mcp.invalidate(SERVER, 'sparql_select').catch(function(){}); })
        .then(function(){
          if (newLabel !== c.label) labelCache[c.iri] = newLabel;
          onDone();
          selectScheme(schemeIri);
        })
        .catch(function(err){
          warn.textContent = 'Couldn’t save — try again.';
          warn.style.display = 'block';
          saveBtn.disabled = false; cancelBtn.disabled = false; saveBtn.textContent = 'Save';
        });
    });

    return wrap;
  }

  function buildInlineRenameForm(currentValue, onSave, onCancel){
    var wrap = document.createElement('div');
    wrap.style.cssText = 'display:flex; gap:6px; align-items:center; margin-top:6px; flex-wrap:wrap;';
    var input = document.createElement('input');
    input.type = 'text';
    input.value = currentValue;
    input.style.cssText = 'flex:1; min-width:120px; font:inherit; font-size:13px; padding:5px 8px; border:1px solid var(--line); border-radius:6px; background:var(--card); color:var(--ink);';
    var saveBtn = document.createElement('button');
    saveBtn.type = 'button'; saveBtn.className = 'btn'; saveBtn.textContent = 'Save';
    saveBtn.style.cssText = 'font-size:11px; padding:4px 9px; flex:none;';
    var cancelBtn = document.createElement('button');
    cancelBtn.type = 'button'; cancelBtn.className = 'btn'; cancelBtn.textContent = 'Cancel';
    cancelBtn.style.cssText = 'font-size:11px; padding:4px 9px; flex:none;';
    var warn = document.createElement('p');
    warn.style.cssText = 'display:none; margin:2px 0 0; width:100%; font-size:12px; color:var(--bad);';
    wrap.appendChild(input);
    wrap.appendChild(saveBtn);
    wrap.appendChild(cancelBtn);
    wrap.appendChild(warn);
    cancelBtn.addEventListener('click', onCancel);
    input.addEventListener('keydown', function(ev){
      if (ev.key === 'Enter'){ ev.preventDefault(); saveBtn.click(); }
      else if (ev.key === 'Escape'){ ev.preventDefault(); onCancel(); }
    });
    saveBtn.addEventListener('click', function(){
      var v = input.value.trim();
      if (!v){ warn.textContent = 'A label is required.'; warn.style.display = 'block'; return; }
      saveBtn.disabled = true; cancelBtn.disabled = true; saveBtn.textContent = 'Saving…';
      onSave(v).catch(function(){
        warn.textContent = 'Couldn’t save — try again.';
        warn.style.display = 'block';
        saveBtn.disabled = false; cancelBtn.disabled = false; saveBtn.textContent = 'Save';
      });
    });
    input.focus();
    return wrap;
  }

  function buildAddConceptControl(schemeIri, existingConcepts){
    var wrap = document.createElement('div');
    wrap.style.cssText = 'margin:0 0 12px;';
    var addBtn = document.createElement('button');
    addBtn.type = 'button'; addBtn.className = 'btn'; addBtn.textContent = '+ New Concept';
    addBtn.style.cssText = 'font-size:11.5px; padding:5px 10px;';
    wrap.appendChild(addBtn);

    var form = document.createElement('div');
    form.style.cssText = 'display:none; flex-wrap:wrap; gap:6px; align-items:center; margin-top:8px;';
    var input = document.createElement('input');
    input.type = 'text';
    input.placeholder = 'New concept label…';
    input.style.cssText = 'flex:1; min-width:140px; font:inherit; font-size:13px; padding:6px 9px; border:1px solid var(--line); border-radius:6px; background:var(--card); color:var(--ink);';
    var saveBtn = document.createElement('button');
    saveBtn.type = 'button'; saveBtn.className = 'btn'; saveBtn.textContent = 'Add';
    saveBtn.style.cssText = 'flex:none; font-size:11.5px; padding:5px 10px;';
    var cancelBtn = document.createElement('button');
    cancelBtn.type = 'button'; cancelBtn.className = 'btn'; cancelBtn.textContent = 'Cancel';
    cancelBtn.style.cssText = 'flex:none; font-size:11.5px; padding:5px 10px;';
    var warn = document.createElement('p');
    warn.style.cssText = 'display:none; margin:4px 0 0; width:100%; font-size:12px; color:var(--bad);';
    form.appendChild(input); form.appendChild(saveBtn); form.appendChild(cancelBtn); form.appendChild(warn);
    wrap.appendChild(form);

    function close(){ form.style.display = 'none'; addBtn.hidden = false; }
    addBtn.addEventListener('click', function(){
      input.value = ''; warn.style.display = 'none';
      form.style.display = 'flex'; addBtn.hidden = true; input.focus();
    });
    cancelBtn.addEventListener('click', close);
    input.addEventListener('keydown', function(ev){
      if (ev.key === 'Enter'){ ev.preventDefault(); saveBtn.click(); }
      else if (ev.key === 'Escape'){ ev.preventDefault(); close(); }
    });
    saveBtn.addEventListener('click', function(){
      var label = input.value.trim();
      warn.style.display = 'none';
      if (!label){ warn.textContent = 'A label is required.'; warn.style.display = 'block'; return; }
      var ns = existingConcepts.length ? conceptNamespaceFor(existingConcepts[0].iri) : newSchemeConceptNamespace(schemeIri);
      var newIri = ns + pascalSlug(label);
      if (existingConcepts.some(function(c){ return c.iri === newIri; })){
        warn.textContent = 'A concept with that name already exists.';
        warn.style.display = 'block';
        return;
      }
      saveBtn.disabled = true; cancelBtn.disabled = true; saveBtn.textContent = 'Adding…';
      callTool(SERVER, 'sparql_update', {update: buildCreateConceptSparql(newIri, label, schemeIri)})
        .then(function(){ return pathsForScheme(schemeIri); })
        .then(function(paths){
          return paths.reduce(function(chain, path){
            return chain.then(function(){ return callTool(SERVER, 'sparql_update', {update: buildAppendConceptToInSparql(path, newIri)}); });
          }, Promise.resolve());
        })
        .then(function(){ return mcp.invalidate(SERVER, 'sparql_select').catch(function(){}); })
        .then(function(){
          labelCache[newIri] = label;
          loadTaxonomies(true);
          selectScheme(schemeIri);
        })
        .catch(function(){
          warn.textContent = 'Couldn’t create that concept — try again.';
          warn.style.display = 'block';
          saveBtn.disabled = false; cancelBtn.disabled = false; saveBtn.textContent = 'Add';
        });
    });
    return wrap;
  }

  function buildNewSchemeForm(){
    var card = document.createElement('div');
    card.className = 'addchild-form';
    var hint = document.createElement('p');
    hint.className = 'hint';
    hint.textContent = 'Creates an empty skos:ConceptScheme. It won’t appear as a choice anywhere until a SHACL property shape’s sh:in list is wired to draw from it — a separate step.';
    card.appendChild(hint);
    var errorBox = document.createElement('div');
    card.appendChild(errorBox);
    var nameField = document.createElement('div');
    nameField.className = 'field';
    var nameLabel = document.createElement('label');
    nameLabel.textContent = 'Scheme name';
    nameField.appendChild(nameLabel);
    var nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.placeholder = 'e.g. Mood';
    nameField.appendChild(nameInput);
    card.appendChild(nameField);

    var actionsRow = document.createElement('div');
    actionsRow.className = 'form-actions';
    var createBtn = document.createElement('button');
    createBtn.type = 'button'; createBtn.className = 'btn primary'; createBtn.textContent = 'Create Scheme';
    var cancelBtn = document.createElement('button');
    cancelBtn.type = 'button'; cancelBtn.className = 'btn'; cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', closeNewSchemeForm);
    createBtn.addEventListener('click', function(){
      var name = nameInput.value.trim();
      errorBox.innerHTML = '';
      if (!name){
        var warn = document.createElement('p');
        warn.className = 'warn';
        warn.textContent = 'Name is required.';
        errorBox.appendChild(warn);
        return;
      }
      var taxonomyNs = schemesData.length ? conceptNamespaceFor(schemesData[0].iri) : 'https://w3id.org/holon/worldtest/taxonomy/';
      var newIri = taxonomyNs + pascalSlug(name) + 'Scheme';
      if (schemesData.some(function(s){ return s.iri === newIri; })){
        var warn2 = document.createElement('p');
        warn2.className = 'warn';
        warn2.textContent = 'A scheme with that name already exists.';
        errorBox.appendChild(warn2);
        return;
      }
      createBtn.disabled = true; createBtn.textContent = 'Creating…';
      callTool(SERVER, 'sparql_update', {update: buildCreateSchemeSparql(newIri, name)})
        .then(function(){ return mcp.invalidate(SERVER, 'sparql_select').catch(function(){}); })
        .then(function(){ return loadTaxonomies(true); })
        .then(function(){ selectScheme(newIri); })
        .catch(function(err){
          createBtn.disabled = false; createBtn.textContent = 'Create Scheme';
          renderBanner(errorBox, err);
        });
    });
    actionsRow.appendChild(createBtn);
    actionsRow.appendChild(cancelBtn);
    card.appendChild(actionsRow);
    return card;
  }

  function openNewSchemeForm(){
    selectedSchemeIri = null;
    renderTaxonomies();
    $detail.innerHTML = '';
    var inner = document.createElement('div');
    inner.className = 'detail-inner';
    var h2 = document.createElement('h2');
    h2.className = 'title';
    h2.textContent = 'New Concept Scheme';
    inner.appendChild(h2);
    inner.appendChild(buildNewSchemeForm());
    $detail.appendChild(inner);
  }

  function closeNewSchemeForm(){
    renderTaxonomies();
    if (selectedSchemeIri) selectScheme(selectedSchemeIri);
    else renderIdleDetail('Nothing selected');
  }

  // ---- Node Shapes / Property Shapes tabs (SHACL 1.2 Core) ---------------
  // Two more standalone rail/detail tabs, same shape as Taxonomies above:
  // a flat list read straight from SHACL_GRAPH, a "+ New ..." form, and a
  // detail pane with an Edit toggle and a Deactivate/Reactivate toggle
  // (sh:deactivated -- SHACL's own built-in way to disable a shape without
  // deleting it, so this keeps the dataset's "never delete, tombstone
  // instead" convention without inventing a parallel status vocabulary).
  //
  // Property shapes are managed here as NAMED (IRI) sh:PropertyShape
  // resources, not as the blank nodes hanging off a single NodeShape's
  // sh:property list -- that's what makes a property shape independently
  // listable, editable, and attachable to more than one NodeShape (a
  // single "hasPopulationShape" reused by CountryShape and CityShape
  // alike). A NodeShape's sh:property can point at a named shape exactly
  // as validly as at a blank node, per the SHACL spec -- nothing here is a
  // deviation from Core, just a choice of which shape of sh:property target
  // this editor manages. An inline blank-node property shape hand-authored
  // elsewhere in the graph simply doesn't show up in the Property Shapes
  // tab or this NodeShape's attach list; it still validates normally.

  // Default IRI convention for a newly-minted, NAMED property shape's own
  // identity (set by Kurt 2026-09-18): shape:{ClassName}_{propertyName} in
  // a dedicated `shape:` namespace, independent of both the class it's
  // initially coined for and the property (sh:path) it constrains -- see
  // defaultPropertyShapeIri below. This is a DEFAULT, not a hard rule: the
  // New Property Shape form always shows the computed value in an editable
  // "Shape IRI" field, so it's used until the admin explicitly types
  // something else there.
  var SHAPE_NS_DEFAULT = "https://w3-id.org/shape#";

  var SH_NS = "http://www.w3.org/ns/shacl#";
  var SH_TARGETCLASS = SH_NS + "targetClass";
  var SH_PROPERTY = SH_NS + "property";
  var SH_CLOSED = SH_NS + "closed";
  var SH_IGNOREDPROPERTIES = SH_NS + "ignoredProperties";
  var SH_SEVERITY = SH_NS + "severity";
  var SH_DEACTIVATED = SH_NS + "deactivated";
  var SH_NAME = SH_NS + "name";
  var SH_DESCRIPTION2 = SH_NS + "description"; // "2" to avoid shadowing DESCRIPTION_PREDICATE (holon:description) above
  var SH_ORDER = SH_NS + "order";
  var SH_MESSAGE = SH_NS + "message";
  var SH_MINCOUNT = SH_NS + "minCount";
  var SH_MAXCOUNT = SH_NS + "maxCount";
  var SH_DATATYPE = SH_NS + "datatype";
  var SH_CLASS = SH_NS + "class";
  var SH_NODEKIND = SH_NS + "nodeKind";
  var SH_HASVALUE = SH_NS + "hasValue";
  var SH_IN = SH_NS + "in";
  var SH_PATTERN = SH_NS + "pattern";
  var SH_FLAGS = SH_NS + "flags";
  var SH_MINLENGTH = SH_NS + "minLength";
  var SH_MAXLENGTH = SH_NS + "maxLength";
  var SH_LANGUAGEIN = SH_NS + "languageIn";
  var SH_UNIQUELANG = SH_NS + "uniqueLang";
  var SH_MININCLUSIVE = SH_NS + "minInclusive";
  var SH_MAXINCLUSIVE = SH_NS + "maxInclusive";
  var SH_MINEXCLUSIVE = SH_NS + "minExclusive";
  var SH_MAXEXCLUSIVE = SH_NS + "maxExclusive";
  var SH_EQUALS = SH_NS + "equals";
  var SH_DISJOINT = SH_NS + "disjoint";
  var SH_LESSTHAN = SH_NS + "lessThan";
  var SH_LESSTHANOREQUALS = SH_NS + "lessThanOrEquals";
  var RDFS_COMMENT_PRED = "http://www.w3.org/2000/01/rdf-schema#comment"; // LABEL_PREDICATE above already covers rdfs:label

  // SHACL's own prefix-declaration vocabulary, reused for the Namespaces
  // tab (see the "Namespaces tab" section below) instead of VANN. sh:name/
  // sh:description are the same two predicates the Property Shapes form
  // already uses (SH_NAME/SH_DESCRIPTION2 above) -- reused here rather than
  // duplicated, since a namespace registry entry's human-readable label and
  // description are the same kind of fact as a property shape's.
  var SH_PREFIX_PRED = SH_NS + "prefix";
  var SH_NAMESPACE_PRED = SH_NS + "namespace";
  var XSD_ANYURI_IRI = "http://www.w3.org/2001/XMLSchema#anyURI";

  var SEVERITY_OPTIONS = [
    {iri: SH_NS + "Violation", label: "Violation"},
    {iri: SH_NS + "Warning", label: "Warning"},
    {iri: SH_NS + "Info", label: "Info"}
  ];
  var NODEKIND_OPTIONS = [
    {iri: SH_NS + "IRI", label: "IRI"},
    {iri: SH_NS + "Literal", label: "Literal"},
    {iri: SH_NS + "BlankNode", label: "Blank Node"},
    {iri: SH_NS + "IRIOrLiteral", label: "IRI or Literal"},
    {iri: SH_NS + "BlankNodeOrIRI", label: "Blank Node or IRI"},
    {iri: SH_NS + "BlankNodeOrLiteral", label: "Blank Node or Literal"}
  ];
  var DATATYPE_OPTIONS = [
    {iri: "http://www.w3.org/2001/XMLSchema#string", label: "string"},
    {iri: "http://www.w3.org/1999/02/22-rdf-syntax-ns#langString", label: "language-tagged string"},
    {iri: "http://www.w3.org/2001/XMLSchema#integer", label: "integer"},
    {iri: "http://www.w3.org/2001/XMLSchema#decimal", label: "decimal"},
    {iri: "http://www.w3.org/2001/XMLSchema#double", label: "double"},
    {iri: "http://www.w3.org/2001/XMLSchema#boolean", label: "boolean"},
    {iri: "http://www.w3.org/2001/XMLSchema#date", label: "date"},
    {iri: "http://www.w3.org/2001/XMLSchema#dateTime", label: "dateTime"},
    {iri: "http://www.w3.org/2001/XMLSchema#anyURI", label: "anyURI"}
  ];

  // Splits an IRI into {ns, local} on its last '#' if it has one, else its
  // last '/' -- this dataset's ontology classes and properties are '#'-
  // fragment IRIs (geo:Country = .../geography#Country); conceptNamespaceFor
  // above only ever handles the '/'-only case (taxonomy concepts), so this
  // is a separate, more general helper rather than a change to that one.
  function namespaceAndLocal(iri){
    var hashIdx = iri.lastIndexOf('#');
    if (hashIdx !== -1) return {ns: iri.slice(0, hashIdx + 1), local: iri.slice(hashIdx + 1)};
    var slashIdx = iri.lastIndexOf('/');
    return slashIdx === -1 ? {ns: '', local: iri} : {ns: iri.slice(0, slashIdx + 1), local: iri.slice(slashIdx + 1)};
  }

  // A short, human-readable stand-in for a namespace URI when it isn't (or
  // isn't yet) a registered Namespaces-tab entry -- strips the scheme and
  // any trailing "/"/"#" so "https://schema.org/" reads as "schema.org" and
  // "https://w3-id.org/exampleOrg/" as "w3-id.org/exampleOrg".
  function shortenNamespaceUri(ns){
    return ns.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, '').replace(/[\/#]+$/, '');
  }

  // Prefers a registered Namespaces-tab prefix (namespacesData is only
  // populated once that tab has been opened this session, so this quietly
  // falls back to shortenNamespaceUri when it hasn't, rather than loading
  // the registry itself and turning every caller into an async one).
  function namespacePrefixLabel(ns){
    if (!ns) return '';
    var entry = namespacesData.find(function(x){ return x.uri === ns; });
    return entry ? (entry.prefix + ':') : shortenNamespaceUri(ns);
  }

  // Disambiguates same-named classes from different vocabularies -- e.g.
  // schema:Person vs. holon:Person both humanize to plain "Person" -- by
  // appending the (registered-prefix-or-shortened) namespace. Used by the
  // Edit Holon form's Type(s) multi-select below; humanize(iri) alone stays
  // the right call anywhere a namespace clash isn't actually in play.
  function typeLabelWithNamespace(iri){
    var ns = namespaceAndLocal(iri).ns;
    var nsLabel = namespacePrefixLabel(ns);
    return nsLabel ? (humanize(iri) + '  —  ' + nsLabel) : humanize(iri);
  }

  // Appends "2", "3", ... to a candidate shape IRI until it's not already in
  // use -- mirrors uniqueSlug's job for holon IRIs, just against whichever
  // shape list (nodeShapesData/propShapesData) is relevant here.
  function uniqueShapeIri(base, existingList){
    var existing = {};
    existingList.forEach(function(s){ existing[s.iri] = true; });
    var iri = base, n = 1;
    while (existing[iri]){ n++; iri = base + n; }
    return iri;
  }

  // Mints a brand-new owl:Class -- used by the New Node Shape form's
  // "Create a new class..." option (see buildNewNodeShapeForm) so a target
  // class doesn't have to already exist before a shape can be written for
  // it. Deliberately minimal (a type, an optional label, an optional
  // rdfs:subClassOf) -- this dataset has no other class-declaration
  // convention to match (computeAllTypes discovers classes purely from
  // rdf:type usage and rdfs:subClassOf pairs; nothing here previously wrote
  // a plain "a owl:Class" triple on its own).
  function buildCreateClassTurtle(iri, label, parentIri){
    var lines = [
      "@prefix owl: <http://www.w3.org/2002/07/owl#> .",
      "@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .",
      "",
      "<" + iri + ">",
      "  a owl:Class ;"
    ];
    if (label) lines.push("  rdfs:label " + langLiteral(label) + " ;");
    if (parentIri) lines.push("  rdfs:subClassOf <" + parentIri + "> ;");
    var last = lines.pop();
    lines.push(last.replace(/ ;$/, ' .'));
    return lines.join("\n");
  }

  // Mints a brand-new rdf:Property -- used by the New Property Shape form's
  // "Create a new property..." option so sh:path can target a predicate
  // that doesn't exist on any holon yet. Typed rdf:Property rather than
  // guessing owl:DatatypeProperty/owl:ObjectProperty -- the property
  // shape's own sh:datatype/sh:class (set afterward on the Edit screen)
  // is what actually constrains its values; the base type here is
  // deliberately the least-committal one both OWL property kinds subclass.
  function buildCreatePropertyTurtle(iri, label){
    var lines = [
      "@prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .",
      "@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .",
      "",
      "<" + iri + ">",
      "  a rdf:Property ;"
    ];
    if (label) lines.push("  rdfs:label " + langLiteral(label) + " ;");
    var last = lines.pop();
    lines.push(last.replace(/ ;$/, ' .'));
    return lines.join("\n");
  }

  // Shared "namespace + local name" mini-picker used by both the New Node
  // Shape form's "Create a new class..." option and the New Property Shape
  // form's "Create a new property..." option below. Offers every
  // non-deprecated entry from the Namespaces registry tab (see
  // activeNamespaceOptions/namespacesData further down) plus a "Custom
  // URI..." fallback for anyone who hasn't registered a namespace yet --
  // and defaults straight to that fallback when the registry is still
  // empty, so this never blocks on the Namespaces tab being used first.
  function buildNamespaceLocalPicker(){
    var wrap = document.createElement('div');

    var nsField = document.createElement('div');
    nsField.className = 'field';
    var nsLabel = document.createElement('label');
    nsLabel.textContent = 'Namespace';
    nsField.appendChild(nsLabel);
    var nsSelect = document.createElement('select');
    nsField.appendChild(nsSelect);
    wrap.appendChild(nsField);

    var customField = document.createElement('div');
    customField.className = 'field';
    customField.hidden = true;
    var customLabel = document.createElement('label');
    customLabel.textContent = 'Namespace URI';
    customField.appendChild(customLabel);
    var customInput = document.createElement('input');
    customInput.type = 'text';
    customInput.placeholder = 'https://example.org/ns/geography#';
    customField.appendChild(customInput);
    wrap.appendChild(customField);
    nsSelect.addEventListener('change', function(){
      customField.hidden = nsSelect.value !== '__custom__';
    });

    // Namespaces are lazy-loaded per-tab (namespacesLoaded/loadNamespaces,
    // only kicked off when the Namespaces tab itself is opened) -- so an
    // admin who goes straight to New Node Shape/"+ Create a new class..."
    // or New Property Shape/"+ Create a new property..." without ever
    // having visited Namespaces first would otherwise see this dropdown
    // built from a still-empty namespacesData and fall straight to "Custom
    // URI...", with every registered namespace simply missing. Fixed by
    // rendering from whatever's already cached, and if that's nothing yet,
    // showing a "Loading..." placeholder and fetching it (exactly the same
    // load-then-repopulate-in-place pattern the "Path (property)" select
    // just below already uses via loadAllProperties).
    function renderNsOptions(){
      var previousValue = nsSelect.value;
      nsSelect.innerHTML = '';
      var nsBlank = document.createElement('option');
      nsBlank.value = ''; nsBlank.textContent = '— choose a namespace —';
      nsSelect.appendChild(nsBlank);
      activeNamespaceOptions().forEach(function(ns){
        if (deprecatedSet[ns.iri]) return;
        var opt = document.createElement('option');
        opt.value = ns.uri;
        opt.textContent = ns.prefix + ':   (' + ns.uri + ')';
        nsSelect.appendChild(opt);
      });
      var customOpt = document.createElement('option');
      customOpt.value = '__custom__'; customOpt.textContent = 'Custom URI…';
      nsSelect.appendChild(customOpt);
      var stillPresent = false;
      for (var i = 0; i < nsSelect.options.length; i++){
        if (nsSelect.options[i].value === previousValue) { stillPresent = true; break; }
      }
      nsSelect.value = (previousValue && stillPresent) ? previousValue : (namespacesData.length ? '' : '__custom__');
      customField.hidden = nsSelect.value !== '__custom__';
    }

    if (namespacesLoaded){
      renderNsOptions();
    } else {
      var nsLoadingOpt = document.createElement('option');
      nsLoadingOpt.value = ''; nsLoadingOpt.textContent = 'Loading namespaces…';
      nsSelect.appendChild(nsLoadingOpt);
      // "Custom URI..." is added now too (not just after the load resolves)
      // so the field is genuinely usable during the brief loading window --
      // getNamespaceUri() reads customInput only when nsSelect.value is
      // exactly '__custom__', which requires that option to already exist.
      var nsCustomOptEarly = document.createElement('option');
      nsCustomOptEarly.value = '__custom__'; nsCustomOptEarly.textContent = 'Custom URI…';
      nsSelect.appendChild(nsCustomOptEarly);
      nsSelect.value = '__custom__';
      customField.hidden = false;
      loadNamespacesData().then(renderNsOptions).catch(renderNsOptions);
    }

    var localField = document.createElement('div');
    localField.className = 'field';
    var localLabel = document.createElement('label');
    localLabel.textContent = 'Local name';
    localField.appendChild(localLabel);
    var localInput = document.createElement('input');
    localInput.type = 'text';
    localInput.placeholder = 'e.g. Country';
    localField.appendChild(localInput);
    wrap.appendChild(localField);

    return {
      wrap: wrap,
      getNamespaceUri: function(){ return nsSelect.value === '__custom__' ? customInput.value.trim() : nsSelect.value; },
      getLocal: function(){ return localInput.value.trim(); },
      getIri: function(){
        var ns = this.getNamespaceUri();
        var local = this.getLocal();
        return (ns && local) ? (ns + local) : '';
      }
    };
  }

  // Computes the default IRI for a NEW named property shape under Kurt's
  // shape:{ClassName}_{propertyName} convention (SHAPE_NS_DEFAULT above).
  // Both classIri and pathIri are required to form an opinion -- with
  // either missing this returns '' and the caller falls back to the older
  // "mint from the property's own namespace" scheme (see
  // buildNewPropertyShapeForm's create handler), so a property shape can
  // still be created without picking a class up front.
  function defaultPropertyShapeIri(classIri, pathIri){
    if (!classIri || !pathIri) return '';
    var className = namespaceAndLocal(classIri).local;
    var propName = namespaceAndLocal(pathIri).local;
    if (!className || !propName) return '';
    return SHAPE_NS_DEFAULT + className + '_' + propName;
  }

  function numericLiteral(v){
    v = String(v).trim();
    // Best-effort typing: an integer-looking value is written as
    // xsd:integer, anything else (decimals, or a value meant for a
    // differently-typed property this editor doesn't know about) as
    // xsd:decimal. Good enough for the common numeric constraint fields;
    // a property whose own sh:datatype is neither can still be hand-edited
    // directly against the graph.
    if (/^-?\d+$/.test(v)) return '"' + v + '"^^<http://www.w3.org/2001/XMLSchema#integer>';
    return '"' + v + '"^^<http://www.w3.org/2001/XMLSchema#decimal>';
  }
  function boolLiteral(b){
    return '"' + (b ? 'true' : 'false') + '"^^<http://www.w3.org/2001/XMLSchema#boolean>';
  }
  // A value typed into an IRI-or-literal field (sh:hasValue, sh:in members):
  // written as an IRI when it looks like one (has a URI scheme, matching
  // every other full-IRI-entry field in this file), a plain literal
  // otherwise.
  function iriOrLiteralClause(v){
    v = String(v).trim();
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(v)) return '<' + v + '>';
    return turtleLiteral(v);
  }

  // Generic single-valued predicate replace: clears whatever `predicateIri`
  // currently holds on `subjectIri` and, only when `newValueClause` is
  // given (a ready-to-splice Turtle term -- a quoted literal or a
  // <bracketed> IRI), writes the new value. Exactly buildRenameSchemeSparql's
  // DELETE/INSERT/WHERE-with-OPTIONAL shape, generalised to any graph/
  // subject/predicate so every scalar node-shape and property-shape field
  // below can share one implementation instead of 20-odd near-duplicates.
  function buildReplaceFieldSparql(graphIri, subjectIri, predicateIri, newValueClause){
    var parts = [
      "DELETE { GRAPH <" + graphIri + "> { <" + subjectIri + "> <" + predicateIri + "> ?old } }"
    ];
    if (newValueClause){
      parts.push("INSERT { GRAPH <" + graphIri + "> { <" + subjectIri + "> <" + predicateIri + "> " + newValueClause + " } }");
    }
    parts.push("WHERE { OPTIONAL { GRAPH <" + graphIri + "> { <" + subjectIri + "> <" + predicateIri + "> ?old } } }");
    return parts.join("\n");
  }

  // sh:deactivated true/removed -- the SHACL-native way to disable a shape
  // without deleting it, so Node/Property Shapes get a Deactivate/
  // Reactivate toggle exactly like Taxonomies' Deprecate/Reactivate, just
  // spelled with SHACL's own vocabulary instead of holon:status.
  function buildSetDeactivatedSparql(shapeIri, deactivated){
    return buildReplaceFieldSparql(SHACL_GRAPH, shapeIri, SH_DEACTIVATED, deactivated ? boolLiteral(true) : null);
  }

  function buildAttachPropertyShapeSparql(nodeShapeIri, propShapeIri){
    return [
      "PREFIX sh: <http://www.w3.org/ns/shacl#>",
      "INSERT DATA { GRAPH <" + SHACL_GRAPH + "> { <" + nodeShapeIri + "> sh:property <" + propShapeIri + "> } }"
    ].join("\n");
  }
  function buildDetachPropertyShapeSparql(nodeShapeIri, propShapeIri){
    return [
      "PREFIX sh: <http://www.w3.org/ns/shacl#>",
      "DELETE DATA { GRAPH <" + SHACL_GRAPH + "> { <" + nodeShapeIri + "> sh:property <" + propShapeIri + "> } }"
    ].join("\n");
  }

  // A genuine, irreversible DELETE -- the one place in the Property Shapes
  // tab that doesn't follow this tool's usual "never delete, only
  // deactivate" convention. Added 2026-09-19 at Kurt's explicit request as
  // a deliberately temporary escape hatch for cleaning up spurious/
  // exploratory property shapes while the modeling is still being worked
  // out, alongside (not instead of) the existing Deactivate toggle. Removes
  // every triple with the shape as subject (its own path/constraints/name/
  // etc., whatever this editor did or didn't create) from SHACL_GRAPH, plus
  // the sh:property link from every node shape that currently attaches it
  // (usedByIris -- the exact same list already shown in the "Used by"
  // section, so nothing dangling is left behind pointing at a now-gone
  // resource). One request, semicolon-joined ops, so it lands as a single
  // atomic UPDATE the same way buildRewriteNamespaceSparql does; full IRIs
  // throughout rather than PREFIX'd names, since a SPARQL Update prologue
  // applies once to the whole request rather than per semicolon-separated
  // operation.
  function buildDeletePropertyShapeSparql(shapeIri, usedByIris){
    var parts = [
      "DELETE WHERE { GRAPH <" + SHACL_GRAPH + "> { <" + shapeIri + "> ?anyP ?anyO } }"
    ];
    usedByIris.forEach(function(nodeShapeIri){
      parts.push("DELETE DATA { GRAPH <" + SHACL_GRAPH + "> { <" + nodeShapeIri + "> <" + SH_PROPERTY + "> <" + shapeIri + "> } }");
    });
    return parts.join(";\n");
  }

  // Full replace of an rdf:list-valued predicate (sh:in, sh:languageIn,
  // sh:ignoredProperties): first deletes every triple of whatever list is
  // currently there by walking rdf:rest* so a list of any length is fully
  // cleared, not just its head node; buildInsertListSparql then -- only
  // when there's something to write -- inserts a fresh list using SPARQL
  // Update's own collection ( ... ) syntax, which mints its own blank
  // nodes. Two separate update strings, chained by the caller like every
  // other multi-step write in this file (buildConceptEditForm's chain,
  // buildAddChildForm's echo-property chain, ...), since a DELETE/WHERE
  // list-walk and an INSERT DATA collection can't combine into one string.
  function buildClearListSparql(graphIri, subjectIri, predicateIri){
    return [
      "PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>",
      "DELETE {",
      "  GRAPH <" + graphIri + "> {",
      "    <" + subjectIri + "> <" + predicateIri + "> ?head .",
      "    ?node rdf:first ?f ; rdf:rest ?r .",
      "  }",
      "}",
      "WHERE {",
      "  GRAPH <" + graphIri + "> {",
      "    <" + subjectIri + "> <" + predicateIri + "> ?head .",
      "    ?head rdf:rest* ?node .",
      "    ?node rdf:first ?f ; rdf:rest ?r .",
      "  }",
      "}"
    ].join("\n");
  }
  function buildInsertListSparql(graphIri, subjectIri, predicateIri, itemClauses){
    return [
      "INSERT DATA {",
      "  GRAPH <" + graphIri + "> {",
      "    <" + subjectIri + "> <" + predicateIri + "> ( " + itemClauses.join(" ") + " ) .",
      "  }",
      "}"
    ].join("\n");
  }

  function buildCreateNodeShapeTurtle(shapeIri, targetClassIri, label, comment, severityIri, closed, ignoredPreds){
    var lines = [
      "@prefix sh: <http://www.w3.org/ns/shacl#> .",
      "@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .",
      "",
      "<" + shapeIri + ">",
      "  a sh:NodeShape ;",
      "  sh:targetClass <" + targetClassIri + "> ;"
    ];
    if (label) lines.push("  rdfs:label " + langLiteral(label) + " ;");
    if (comment) lines.push("  rdfs:comment " + langLiteral(comment) + " ;");
    if (severityIri) lines.push("  sh:severity <" + severityIri + "> ;");
    if (closed){
      lines.push("  sh:closed true ;");
      if (ignoredPreds && ignoredPreds.length){
        lines.push("  sh:ignoredProperties ( " + ignoredPreds.map(function(p){ return "<" + p + ">"; }).join(" ") + " ) ;");
      }
    }
    // Every line above ends " ;" so any subset of the optional ones can be
    // included in any combination -- swap the LAST line's trailing " ;"
    // for " ." to close the Turtle statement correctly either way.
    var last = lines.pop();
    lines.push(last.replace(/ ;$/, ' .'));
    return lines.join("\n");
  }

  function buildCreatePropertyShapeTurtle(shapeIri, pathIri, name){
    var lines = [
      "@prefix sh: <http://www.w3.org/ns/shacl#> .",
      "",
      "<" + shapeIri + ">",
      "  a sh:PropertyShape ;",
      "  sh:path <" + pathIri + ">"
    ];
    if (name){
      lines[lines.length - 1] += " ;";
      lines.push("  sh:name " + langLiteral(name));
    }
    return lines.join("\n") + " .";
  }

  var NODE_SHAPES_LIST_QUERY = [
    "PREFIX sh: <http://www.w3.org/ns/shacl#>",
    "PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>",
    "SELECT ?shape ?targetClass ?label ?comment ?closed ?severity ?deactivated (COUNT(DISTINCT ?prop) AS ?propCount) WHERE {",
    "  ?shape a sh:NodeShape .",
    "  FILTER(isIRI(?shape))",
    "  OPTIONAL { ?shape sh:targetClass ?targetClass }",
    "  OPTIONAL { ?shape rdfs:label ?label }",
    "  OPTIONAL { ?shape rdfs:comment ?comment }",
    "  OPTIONAL { ?shape sh:closed ?closed }",
    "  OPTIONAL { ?shape sh:severity ?severity }",
    "  OPTIONAL { ?shape sh:deactivated ?deactivated }",
    "  OPTIONAL { ?shape sh:property ?prop }",
    "} GROUP BY ?shape ?targetClass ?label ?comment ?closed ?severity ?deactivated"
  ].join("\n");

  function nodeShapeDetailQuery(shapeIri){
    return [
      "PREFIX sh: <http://www.w3.org/ns/shacl#>",
      "SELECT ?prop ?path ?name WHERE {",
      "  <" + shapeIri + "> sh:property ?prop .",
      "  FILTER(isIRI(?prop))",
      "  OPTIONAL { ?prop sh:path ?path }",
      "  OPTIONAL { ?prop sh:name ?name }",
      "}"
    ].join("\n");
  }

  // classesRaw: every distinct target class of every node shape that
  // attaches this property shape via sh:property, "|"-joined -- lets the
  // rail row show WHICH class(es) a shape belongs to instead of just its
  // own path, which matters once the same path (e.g. hasCapital) has a
  // differently-scoped shape per class (Country vs FederatedState) and
  // "Capital" alone on every row would look like the same shape twice.
  // A property shape not yet attached to any node shape simply gets an
  // empty classesRaw -- buildPropertyShapeRow falls back to the path in
  // that case (see propertyShapeLabel/buildPropertyShapeRow below).
  var PROP_SHAPES_LIST_QUERY = [
    "PREFIX sh: <http://www.w3.org/ns/shacl#>",
    "SELECT ?shape ?path ?name ?severity ?deactivated",
    "  (GROUP_CONCAT(DISTINCT STR(?targetClass); separator=\"|\") AS ?classesRaw) WHERE {",
    "  ?shape a sh:PropertyShape ; sh:path ?path .",
    "  FILTER(isIRI(?shape))",
    "  OPTIONAL { ?shape sh:name ?name }",
    "  OPTIONAL { ?shape sh:severity ?severity }",
    "  OPTIONAL { ?shape sh:deactivated ?deactivated }",
    "  OPTIONAL { ?ns sh:property ?shape ; sh:targetClass ?targetClass }",
    "} GROUP BY ?shape ?path ?name ?severity ?deactivated"
  ].join("\n");

  function nodeShapesUsingPropertyQuery(propShapeIri){
    return [
      "PREFIX sh: <http://www.w3.org/ns/shacl#>",
      "PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>",
      "SELECT ?shape ?targetClass ?label WHERE {",
      "  ?shape sh:property <" + propShapeIri + "> .",
      "  OPTIONAL { ?shape sh:targetClass ?targetClass }",
      "  OPTIONAL { ?shape rdfs:label ?label }",
      "}"
    ].join("\n");
  }

  // Every SHACL 1.2 Core constraint this editor covers, keyed by field name
  // in the parsed row (see parsePropertyShapeRow) -- sh:in, sh:languageIn,
  // sh:uniqueLang and sh:hasValue are handled separately below since they
  // aren't plain scalar literal/IRI fields (two are lists, one is a
  // boolean checkbox, one can be either an IRI or a literal).
  function propertyShapeFullQuery(shapeIri){
    return [
      "PREFIX sh: <http://www.w3.org/ns/shacl#>",
      "PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>",
      "SELECT ?path ?name ?description ?order ?severity ?message ?deactivated",
      "  ?minCount ?maxCount ?datatype ?class ?nodeKind ?hasValue",
      "  ?pattern ?flags ?minLength ?maxLength ?uniqueLang",
      "  ?minInclusive ?maxInclusive ?minExclusive ?maxExclusive",
      "  ?equals ?disjoint ?lessThan ?lessThanOrEquals",
      "  (GROUP_CONCAT(DISTINCT STR(?inVal); separator=\"|\") AS ?inValues)",
      "  (GROUP_CONCAT(DISTINCT STR(?langVal); separator=\"|\") AS ?languageIn)",
      "WHERE {",
      "  <" + shapeIri + "> sh:path ?path .",
      "  OPTIONAL { <" + shapeIri + "> sh:name ?name }",
      "  OPTIONAL { <" + shapeIri + "> sh:description ?description }",
      "  OPTIONAL { <" + shapeIri + "> sh:order ?order }",
      "  OPTIONAL { <" + shapeIri + "> sh:severity ?severity }",
      "  OPTIONAL { <" + shapeIri + "> sh:message ?message }",
      "  OPTIONAL { <" + shapeIri + "> sh:deactivated ?deactivated }",
      "  OPTIONAL { <" + shapeIri + "> sh:minCount ?minCount }",
      "  OPTIONAL { <" + shapeIri + "> sh:maxCount ?maxCount }",
      "  OPTIONAL { <" + shapeIri + "> sh:datatype ?datatype }",
      "  OPTIONAL { <" + shapeIri + "> sh:class ?class }",
      "  OPTIONAL { <" + shapeIri + "> sh:nodeKind ?nodeKind }",
      "  OPTIONAL { <" + shapeIri + "> sh:hasValue ?hasValue }",
      "  OPTIONAL { <" + shapeIri + "> sh:pattern ?pattern }",
      "  OPTIONAL { <" + shapeIri + "> sh:flags ?flags }",
      "  OPTIONAL { <" + shapeIri + "> sh:minLength ?minLength }",
      "  OPTIONAL { <" + shapeIri + "> sh:maxLength ?maxLength }",
      "  OPTIONAL { <" + shapeIri + "> sh:uniqueLang ?uniqueLang }",
      "  OPTIONAL { <" + shapeIri + "> sh:minInclusive ?minInclusive }",
      "  OPTIONAL { <" + shapeIri + "> sh:maxInclusive ?maxInclusive }",
      "  OPTIONAL { <" + shapeIri + "> sh:minExclusive ?minExclusive }",
      "  OPTIONAL { <" + shapeIri + "> sh:maxExclusive ?maxExclusive }",
      "  OPTIONAL { <" + shapeIri + "> sh:equals ?equals }",
      "  OPTIONAL { <" + shapeIri + "> sh:disjoint ?disjoint }",
      "  OPTIONAL { <" + shapeIri + "> sh:lessThan ?lessThan }",
      "  OPTIONAL { <" + shapeIri + "> sh:lessThanOrEquals ?lessThanOrEquals }",
      "  OPTIONAL { <" + shapeIri + "> sh:in ?inList . ?inList rdf:rest*/rdf:first ?inVal }",
      "  OPTIONAL { <" + shapeIri + "> sh:languageIn ?langList . ?langList rdf:rest*/rdf:first ?langVal }",
      "} GROUP BY ?path ?name ?description ?order ?severity ?message ?deactivated",
      "  ?minCount ?maxCount ?datatype ?class ?nodeKind ?hasValue",
      "  ?pattern ?flags ?minLength ?maxLength ?uniqueLang",
      "  ?minInclusive ?maxInclusive ?minExclusive ?maxExclusive",
      "  ?equals ?disjoint ?lessThan ?lessThanOrEquals"
    ].join("\n");
  }

  var ALL_PROPERTIES_QUERY = [
    "PREFIX owl: <http://www.w3.org/2002/07/owl#>",
    "PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>",
    "SELECT DISTINCT ?p WHERE {",
    "  { ?p a owl:ObjectProperty } UNION { ?p a owl:DatatypeProperty } UNION { ?p a rdf:Property }",
    "}"
  ].join("\n");

  // Memoized like loadDeprecatedSet/loadShapeTargetClasses above -- reset to
  // null on a dataset switch (resetDatasetState) and on a manual refresh
  // while the Property Shapes tab is open (refreshAll), rather than
  // refetched on every "New Property Shape" click.
  function loadAllProperties(){
    if (!allPropertiesPromise){
      allPropertiesPromise = callTool(SERVER, 'sparql_select', {query: ALL_PROPERTIES_QUERY, graph: ONTOLOGY_GRAPH})
        .then(function(res){
          var bindings = (res.payload && res.payload.results && res.payload.results.bindings) || [];
          return bindings.map(function(b){ return b.p.value; })
            .sort(function(a, b){ return humanize(a).localeCompare(humanize(b)); });
        })
        .catch(function(){ return []; });
    }
    return allPropertiesPromise;
  }

  function nodeShapeLabel(s){
    if (s.label) return s.label;
    if (s.targetClass) return humanize(s.targetClass);
    return humanize(s.iri);
  }
  function propertyShapeLabel(ps){
    if (ps.name) return ps.name;
    if (ps.path) return humanize(ps.path);
    return humanize(ps.iri);
  }

  function loadNodeShapesData(){
    return callTool(SERVER, 'sparql_select', {query: NODE_SHAPES_LIST_QUERY, graph: SHACL_GRAPH})
      .then(function(res){
        var bindings = (res.payload && res.payload.results && res.payload.results.bindings) || [];
        nodeShapesData = bindings.map(function(b){
          return {
            iri: b.shape.value,
            targetClass: b.targetClass ? b.targetClass.value : null,
            label: b.label ? b.label.value : null,
            comment: b.comment ? b.comment.value : '',
            closed: !!(b.closed && b.closed.value === 'true'),
            severity: b.severity ? b.severity.value : null,
            deactivated: !!(b.deactivated && b.deactivated.value === 'true'),
            propCount: b.propCount ? parseInt(b.propCount.value, 10) : 0
          };
        }).sort(function(a, b){ return nodeShapeLabel(a).localeCompare(nodeShapeLabel(b)); });
        nodeShapesLoaded = true;
        return nodeShapesData;
      });
  }

  function loadNodeShapes(force){
    if (!mcp){
      $nodeShapes.innerHTML = '<div class="list-empty">No connector available.</div>';
      return Promise.resolve([]);
    }
    if (force || !nodeShapesLoaded){
      $nodeShapes.innerHTML = '';
      var loading = document.createElement('div');
      loading.className = 'list-empty';
      loading.textContent = 'Loading node shapes…';
      $nodeShapes.appendChild(loading);
    }
    return loadNodeShapesData()
      .then(function(){
        renderNodeShapes();
        if (selectedNodeShapeIri) selectNodeShape(selectedNodeShapeIri, true);
      })
      .catch(function(err){
        $nodeShapes.innerHTML = '';
        renderBanner($nodeShapes, err, function(){ loadNodeShapes(true); });
      });
  }

  // Cached like loadDeprecatedSet -- selectNodeShape's attach-a-property-
  // shape control needs this list on every node shape it opens, so it's
  // worth memoizing rather than refetching per selection; loadPropertyShapesTab
  // busts the cache with force=true, matching a manual Refresh.
  var propShapesDataPromise = null;
  function loadPropShapesData(force){
    if (force) propShapesDataPromise = null;
    if (!propShapesDataPromise){
      propShapesDataPromise = callTool(SERVER, 'sparql_select', {query: PROP_SHAPES_LIST_QUERY, graph: SHACL_GRAPH})
        .then(function(res){
          var bindings = (res.payload && res.payload.results && res.payload.results.bindings) || [];
          propShapesData = bindings.map(function(b){
            var classesRaw = (b.classesRaw && b.classesRaw.value) || '';
            return {
              iri: b.shape.value,
              path: b.path ? b.path.value : null,
              name: b.name ? b.name.value : null,
              severity: b.severity ? b.severity.value : null,
              deactivated: !!(b.deactivated && b.deactivated.value === 'true'),
              classes: classesRaw ? classesRaw.split('|').filter(Boolean) : []
            };
          });
          propShapesLoaded = true;
          return propShapesData;
        })
        .catch(function(err){ propShapesDataPromise = null; throw err; });
    }
    return propShapesDataPromise;
  }

  function loadPropertyShapesTab(force){
    if (!mcp){
      $propShapes.innerHTML = '<div class="list-empty">No connector available.</div>';
      return Promise.resolve([]);
    }
    if (force || !propShapesLoaded){
      $propShapes.innerHTML = '';
      var loading = document.createElement('div');
      loading.className = 'list-empty';
      loading.textContent = 'Loading property shapes…';
      $propShapes.appendChild(loading);
    }
    return loadPropShapesData(force)
      .then(function(){
        renderPropertyShapesTab();
        if (selectedPropShapeIri) selectPropertyShape(selectedPropShapeIri, true);
      })
      .catch(function(err){
        $propShapes.innerHTML = '';
        renderBanner($propShapes, err, function(){ loadPropertyShapesTab(true); });
      });
  }

  // ---- Node Shapes: rail ---------------------------------------------

  function buildNodeShapeRow(s){
    var row = document.createElement('button');
    row.className = 'row' + (s.iri === selectedNodeShapeIri ? ' active' : '');
    row.type = 'button';
    if (s.deactivated) row.style.opacity = '0.55';
    var lbl = document.createElement('span');
    lbl.className = 'row-label';
    lbl.textContent = nodeShapeLabel(s) + (s.deactivated ? ' (deactivated)' : '');
    row.appendChild(lbl);
    var tp = document.createElement('span');
    tp.className = 'row-type';
    tp.textContent = s.propCount + (s.propCount === 1 ? ' property' : ' properties');
    row.appendChild(tp);
    row.addEventListener('click', function(){ selectNodeShape(s.iri); });
    return row;
  }

  function renderNodeShapes(){
    $nodeShapes.innerHTML = '';
    var addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'btn';
    addBtn.textContent = '+ New Node Shape';
    addBtn.style.cssText = 'margin:8px 8px 10px; font-size:11.5px; padding:5px 10px;';
    addBtn.addEventListener('click', openNewNodeShapeForm);
    $nodeShapes.appendChild(addBtn);
    $nodeShapes.appendChild(buildShowDeprecatedToggle('nodeshapes', 'Show deactivated', renderNodeShapes));

    if (!nodeShapesData.length){
      var empty = document.createElement('div');
      empty.className = 'list-empty';
      empty.textContent = 'No SHACL node shapes yet.';
      $nodeShapes.appendChild(empty);
      return;
    }
    var visibleNodeShapes = filterByDeactivatedFlag(nodeShapesData, 'nodeshapes');
    if (!visibleNodeShapes.length){
      var allHiddenNS = document.createElement('div');
      allHiddenNS.className = 'list-empty';
      allHiddenNS.textContent = 'Every node shape is deactivated -- tick "Show deactivated" above to see them.';
      $nodeShapes.appendChild(allHiddenNS);
      return;
    }
    visibleNodeShapes.forEach(function(s){ $nodeShapes.appendChild(buildNodeShapeRow(s)); });
  }

  function jumpToPropertyShape(iri){
    currentView = 'propshapes';
    $viewSelect.value = 'propshapes';
    $list.hidden = true; $byType.hidden = true; $tree.hidden = true; $taxonomies.hidden = true;
    $nodeShapes.hidden = true; $propShapes.hidden = false; $classes.hidden = true; $properties.hidden = true; $namespaces.hidden = true;
    $searchWrap.hidden = true;
    if (!propShapesLoaded) loadPropertyShapesTab().then(function(){ selectPropertyShape(iri); });
    else selectPropertyShape(iri);
  }
  function jumpToNodeShape(iri){
    currentView = 'nodeshapes';
    $viewSelect.value = 'nodeshapes';
    $list.hidden = true; $byType.hidden = true; $tree.hidden = true; $taxonomies.hidden = true;
    $propShapes.hidden = true; $nodeShapes.hidden = false; $classes.hidden = true; $properties.hidden = true; $namespaces.hidden = true;
    $searchWrap.hidden = true;
    if (!nodeShapesLoaded) loadNodeShapes().then(function(){ selectNodeShape(iri); });
    else selectNodeShape(iri);
  }

  function selectNodeShape(shapeIri, skipRerenderRail){
    selectedNodeShapeIri = shapeIri;
    if (!skipRerenderRail) renderNodeShapes();
    renderDetailSkeleton();
    Promise.all([
      callTool(SERVER, 'sparql_select', {query: nodeShapeDetailQuery(shapeIri), graph: SHACL_GRAPH})
        .then(function(res){ return (res.payload && res.payload.results && res.payload.results.bindings) || []; }),
      loadPropShapesData()
    ]).then(function(results){
      var attached = results[0].map(function(b){
        return {iri: b.prop.value, path: b.path ? b.path.value : null, name: b.name ? b.name.value : null};
      });
      renderNodeShapeDetail(shapeIri, attached);
    }).catch(function(err){
      $detail.innerHTML = '';
      var inner = document.createElement('div');
      inner.className = 'detail-inner';
      $detail.appendChild(inner);
      renderBanner(inner, err, function(){ selectNodeShape(shapeIri); });
    });
  }

  function buildAttachPropertyShapeControl(nodeShapeIri, attachedProps){
    var attachedSet = {};
    attachedProps.forEach(function(ap){ attachedSet[ap.iri] = true; });
    var wrap = document.createElement('div');
    wrap.style.cssText = 'margin:0 0 12px; display:flex; gap:6px; flex-wrap:wrap; align-items:center;';
    var select = document.createElement('select');
    select.style.cssText = 'flex:1; min-width:160px; font:inherit; font-size:13px; padding:6px 9px; border:1px solid var(--line); border-radius:6px; background:var(--card); color:var(--ink);';
    var candidates = propShapesData.filter(function(ps){ return !attachedSet[ps.iri]; });
    if (!candidates.length){
      var none = document.createElement('option');
      none.value = '';
      none.textContent = propShapesData.length ? 'All property shapes already attached' : 'No property shapes exist yet -- create one on the Property Shapes tab';
      select.appendChild(none);
      select.disabled = true;
    } else {
      var blank = document.createElement('option');
      blank.value = ''; blank.textContent = '— attach an existing property shape —';
      select.appendChild(blank);
      candidates.slice().sort(function(a, b){ return propertyShapeLabel(a).localeCompare(propertyShapeLabel(b)); }).forEach(function(ps){
        var opt = document.createElement('option');
        opt.value = ps.iri;
        opt.textContent = propertyShapeLabel(ps) + (ps.path ? ' (' + humanize(ps.path) + ')' : '');
        select.appendChild(opt);
      });
    }
    var attachBtn = document.createElement('button');
    attachBtn.type = 'button'; attachBtn.className = 'btn'; attachBtn.textContent = 'Attach';
    attachBtn.style.cssText = 'font-size:11.5px; padding:6px 10px; flex:none;';
    attachBtn.addEventListener('click', function(){
      if (!select.value) return;
      attachBtn.disabled = true;
      callTool(SERVER, 'sparql_update', {update: buildAttachPropertyShapeSparql(nodeShapeIri, select.value)})
        .then(function(){ return mcp.invalidate(SERVER, 'sparql_select').catch(function(){}); })
        .then(function(){ return loadNodeShapesData(); })
        .then(function(){ selectNodeShape(nodeShapeIri, true); })
        .catch(function(err){ attachBtn.disabled = false; renderBanner(wrap, err); });
    });
    wrap.appendChild(select);
    wrap.appendChild(attachBtn);
    return wrap;
  }

  function renderNodeShapeDetail(shapeIri, attachedProps){
    var s = nodeShapesData.find(function(x){ return x.iri === shapeIri; }) || {iri: shapeIri, deactivated: false};
    var isEditing = nodeShapeEditOpenFor === shapeIri;
    var inner = document.createElement('div');
    inner.className = 'detail-inner';

    var badges = document.createElement('div');
    badges.className = 'badges';
    var p = document.createElement('span');
    p.className = 'pill type';
    p.textContent = 'SHACL Node Shape';
    badges.appendChild(p);
    if (s.deactivated){
      var dp = document.createElement('span');
      dp.className = 'pill status';
      dp.textContent = 'Deactivated';
      badges.appendChild(dp);
    }
    inner.appendChild(badges);

    if (!isEditing){
      var h2 = document.createElement('h2');
      h2.className = 'title';
      h2.textContent = nodeShapeLabel(s);
      inner.appendChild(h2);
    }

    var iriLine = document.createElement('div');
    iriLine.className = 'iri';
    iriLine.textContent = shapeIri;
    inner.appendChild(iriLine);

    if (s.targetClass){
      var tcLine = document.createElement('p');
      tcLine.className = 'hint';
      tcLine.style.margin = '-12px 0 18px';
      tcLine.textContent = 'Targets ' + humanize(s.targetClass) + '  (' + s.targetClass + ')';
      inner.appendChild(tcLine);
    }

    var actions = document.createElement('div');
    actions.className = 'actions';
    var editBtn = document.createElement('button');
    editBtn.type = 'button'; editBtn.className = 'btn';
    editBtn.textContent = isEditing ? 'Cancel Edit' : 'Edit';
    editBtn.addEventListener('click', function(){
      nodeShapeEditOpenFor = isEditing ? null : shapeIri;
      selectNodeShape(shapeIri, true);
    });
    actions.appendChild(editBtn);
    var toggleBtn = document.createElement('button');
    toggleBtn.type = 'button'; toggleBtn.className = 'btn';
    toggleBtn.textContent = s.deactivated ? 'Reactivate' : 'Deactivate';
    toggleBtn.addEventListener('click', function(){
      toggleBtn.disabled = true;
      callTool(SERVER, 'sparql_update', {update: buildSetDeactivatedSparql(shapeIri, !s.deactivated)})
        .then(function(){ return mcp.invalidate(SERVER, 'sparql_select').catch(function(){}); })
        .then(function(){ return loadNodeShapesData(); })
        .then(function(){ selectNodeShape(shapeIri, true); renderNodeShapes(); })
        .catch(function(err){ toggleBtn.disabled = false; renderBanner(inner, err); });
    });
    actions.appendChild(toggleBtn);
    inner.appendChild(actions);

    if (isEditing){
      inner.appendChild(buildNodeShapeEditForm(s));
    } else if (s.comment){
      var desc = document.createElement('div');
      desc.className = 'description';
      desc.textContent = s.comment;
      inner.appendChild(desc);
    }

    var secLabel = document.createElement('div');
    secLabel.className = 'section-label';
    secLabel.style.marginTop = '10px';
    secLabel.textContent = 'Property Shapes (' + attachedProps.length + ')';
    inner.appendChild(secLabel);

    inner.appendChild(buildAttachPropertyShapeControl(shapeIri, attachedProps));

    var kv = document.createElement('div');
    kv.className = 'kv';
    attachedProps.forEach(function(ap){
      var row = document.createElement('div');
      row.className = 'kv-row';
      var key = document.createElement('div');
      key.className = 'kv-key';
      key.textContent = ap.name || (ap.path ? humanize(ap.path) : humanize(ap.iri));
      row.appendChild(key);
      var val = document.createElement('div');
      val.className = 'kv-val';
      val.style.gap = '6px';
      var chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'chip';
      chip.innerHTML = '<span>' + (ap.path ? humanize(ap.path) : humanize(ap.iri)) + '</span><span class="arrow">&#8594;</span>';
      chip.title = 'Open this property shape';
      chip.addEventListener('click', function(){ jumpToPropertyShape(ap.iri); });
      val.appendChild(chip);
      var detachBtn = document.createElement('button');
      detachBtn.type = 'button'; detachBtn.className = 'btn'; detachBtn.textContent = 'Detach';
      detachBtn.style.cssText = 'font-size:11px; padding:3px 8px;';
      detachBtn.title = 'Removes it from this node shape only -- the property shape itself still exists and can be reattached, or attached elsewhere.';
      detachBtn.addEventListener('click', function(){
        detachBtn.disabled = true;
        callTool(SERVER, 'sparql_update', {update: buildDetachPropertyShapeSparql(shapeIri, ap.iri)})
          .then(function(){ return mcp.invalidate(SERVER, 'sparql_select').catch(function(){}); })
          .then(function(){ return loadNodeShapesData(); })
          .then(function(){ selectNodeShape(shapeIri, true); renderNodeShapes(); })
          .catch(function(err){ detachBtn.disabled = false; renderBanner(inner, err); });
      });
      val.appendChild(detachBtn);
      row.appendChild(val);
      kv.appendChild(row);
    });
    inner.appendChild(kv);

    $detail.innerHTML = '';
    $detail.appendChild(inner);
  }

  function buildNodeShapeEditForm(s){
    var card = document.createElement('div');
    card.className = 'addchild-form';
    var h3 = document.createElement('h3');
    h3.textContent = 'Edit node shape';
    card.appendChild(h3);
    var hint = document.createElement('p');
    hint.className = 'hint';
    hint.textContent = 'Target class (' + (s.targetClass ? humanize(s.targetClass) : '—') + ') can’t be changed here -- create a new node shape for a different class.';
    card.appendChild(hint);

    var errorBox = document.createElement('div');
    card.appendChild(errorBox);

    var labelField = document.createElement('div');
    labelField.className = 'field';
    var labelLabel = document.createElement('label');
    labelLabel.textContent = 'Label';
    labelField.appendChild(labelLabel);
    var labelInput = document.createElement('input');
    labelInput.type = 'text';
    labelInput.value = s.label || '';
    labelField.appendChild(labelInput);
    card.appendChild(labelField);

    var commentField = document.createElement('div');
    commentField.className = 'field';
    var commentLabel = document.createElement('label');
    commentLabel.textContent = 'Comment';
    commentField.appendChild(commentLabel);
    var commentArea = document.createElement('textarea');
    commentArea.value = s.comment || '';
    commentField.appendChild(commentArea);
    card.appendChild(commentField);

    var severityField = document.createElement('div');
    severityField.className = 'field';
    var severityLabel = document.createElement('label');
    severityLabel.textContent = 'Severity';
    severityField.appendChild(severityLabel);
    var severitySelect = document.createElement('select');
    var svBlank = document.createElement('option');
    svBlank.value = ''; svBlank.textContent = '— none —';
    severitySelect.appendChild(svBlank);
    SEVERITY_OPTIONS.forEach(function(o){
      var opt = document.createElement('option');
      opt.value = o.iri; opt.textContent = o.label;
      if (s.severity === o.iri) opt.selected = true;
      severitySelect.appendChild(opt);
    });
    severityField.appendChild(severitySelect);
    card.appendChild(severityField);

    var closedField = document.createElement('div');
    closedField.className = 'field';
    var closedLabel = document.createElement('label');
    closedLabel.style.cssText = 'display:flex; align-items:center; gap:7px; cursor:pointer;';
    var closedInput = document.createElement('input');
    closedInput.type = 'checkbox';
    closedInput.checked = !!s.closed;
    closedLabel.appendChild(closedInput);
    closedLabel.appendChild(document.createTextNode('Closed (sh:closed)'));
    closedField.appendChild(closedLabel);
    var closedHint = document.createElement('p');
    closedHint.className = 'hint';
    closedHint.style.margin = '4px 0 0';
    closedHint.textContent = 'Turning this on (from off) writes the usual metadata predicates (type, label, description, provenance) as sh:ignoredProperties so the shape doesn’t immediately reject them; turning it off clears that list.';
    closedField.appendChild(closedHint);
    card.appendChild(closedField);

    var actionsRow = document.createElement('div');
    actionsRow.className = 'form-actions';
    var saveBtn = document.createElement('button');
    saveBtn.type = 'button'; saveBtn.className = 'btn primary'; saveBtn.textContent = 'Save Changes';
    var cancelBtn = document.createElement('button');
    cancelBtn.type = 'button'; cancelBtn.className = 'btn'; cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', function(){
      nodeShapeEditOpenFor = null;
      selectNodeShape(s.iri, true);
    });
    saveBtn.addEventListener('click', function(){
      errorBox.innerHTML = '';
      saveBtn.disabled = true; cancelBtn.disabled = true; saveBtn.textContent = 'Saving…';
      var chain = Promise.resolve();

      var newLabel = labelInput.value.trim();
      if (newLabel !== (s.label || '')){
        var labelUpdate = buildReplaceFieldSparql(SHACL_GRAPH, s.iri, LABEL_PREDICATE, newLabel ? langLiteral(newLabel) : null);
        chain = chain.then(function(){ return callTool(SERVER, 'sparql_update', {update: labelUpdate}); });
      }
      var newComment = commentArea.value.trim();
      if (newComment !== (s.comment || '')){
        var commentUpdate = buildReplaceFieldSparql(SHACL_GRAPH, s.iri, RDFS_COMMENT_PRED, newComment ? langLiteral(newComment) : null);
        chain = chain.then(function(){ return callTool(SERVER, 'sparql_update', {update: commentUpdate}); });
      }
      var newSeverity = severitySelect.value;
      if (newSeverity !== (s.severity || '')){
        var sevUpdate = buildReplaceFieldSparql(SHACL_GRAPH, s.iri, SH_SEVERITY, newSeverity ? ('<' + newSeverity + '>') : null);
        chain = chain.then(function(){ return callTool(SERVER, 'sparql_update', {update: sevUpdate}); });
      }
      var newClosed = closedInput.checked;
      if (newClosed !== !!s.closed){
        var closedUpdate = buildReplaceFieldSparql(SHACL_GRAPH, s.iri, SH_CLOSED, newClosed ? boolLiteral(true) : null);
        chain = chain.then(function(){ return callTool(SERVER, 'sparql_update', {update: closedUpdate}); });
        if (newClosed){
          var defaultIgnored = [TYPE_PREDICATE, LABEL_PREDICATE, DESCRIPTION_PREDICATE].concat(Object.keys(META_PREDICATES));
          chain = chain.then(function(){
            return callTool(SERVER, 'sparql_update', {update: buildInsertListSparql(SHACL_GRAPH, s.iri, SH_IGNOREDPROPERTIES, defaultIgnored.map(function(p){ return '<' + p + '>'; }))});
          });
        } else {
          chain = chain.then(function(){ return callTool(SERVER, 'sparql_update', {update: buildClearListSparql(SHACL_GRAPH, s.iri, SH_IGNOREDPROPERTIES)}); });
        }
      }

      chain
        .then(function(){ return mcp.invalidate(SERVER, 'sparql_select').catch(function(){}); })
        .then(function(){
          nodeShapeEditOpenFor = null;
          return loadNodeShapesData();
        })
        .then(function(){ renderNodeShapes(); selectNodeShape(s.iri, true); })
        .catch(function(err){
          saveBtn.disabled = false; cancelBtn.disabled = false; saveBtn.textContent = 'Save Changes';
          renderBanner(errorBox, err);
        });
    });
    actionsRow.appendChild(saveBtn);
    actionsRow.appendChild(cancelBtn);
    card.appendChild(actionsRow);
    return card;
  }

  function buildNewNodeShapeForm(){
    var card = document.createElement('div');
    card.className = 'addchild-form';

    var hint = document.createElement('p');
    hint.className = 'hint';
    hint.textContent = 'Creates a sh:NodeShape targeting one class. Attach property shapes to it afterward from the shape’s own detail screen.';
    card.appendChild(hint);

    var errorBox = document.createElement('div');
    card.appendChild(errorBox);

    var classField = document.createElement('div');
    classField.className = 'field';
    var classLabel = document.createElement('label');
    classLabel.textContent = 'Target class';
    classField.appendChild(classLabel);
    var classSelect = document.createElement('select');
    var blank = document.createElement('option');
    blank.value = ''; blank.textContent = '— choose a class —';
    classSelect.appendChild(blank);
    computeAllTypes().sort(function(a, b){ return humanize(a).localeCompare(humanize(b)); }).forEach(function(t){
      var opt = document.createElement('option');
      opt.value = t; opt.textContent = humanize(t);
      classSelect.appendChild(opt);
    });
    var newClassOpt = document.createElement('option');
    newClassOpt.value = '__newclass__'; newClassOpt.textContent = '+ Create a new class…';
    classSelect.appendChild(newClassOpt);
    classField.appendChild(classSelect);
    var classHint = document.createElement('p');
    classHint.className = 'hint';
    classHint.style.margin = '-8px 0 12px';
    classHint.textContent = 'One node shape per class is the norm -- a second one targeting a class already covered adds an independent shape that SHACL ANDs together with the first, which is rarely what you want.';
    classField.appendChild(classHint);
    card.appendChild(classField);

    // Revealed only when "+ Create a new class..." is chosen above --
    // mints a brand-new owl:Class (via buildCreateClassTurtle) before the
    // node shape itself is created, so a shape can target a class that
    // doesn't exist yet instead of requiring one to be authored elsewhere
    // first. Namespace + local name via the same shared picker Property
    // Shapes' "+ Create a new property..." option uses below.
    var newClassPanel = document.createElement('div');
    newClassPanel.hidden = true;
    newClassPanel.style.cssText = 'margin:-6px 0 14px; padding:10px 12px; border:1px solid var(--line); border-radius:8px;';
    var newClassPicker = buildNamespaceLocalPicker();
    newClassPanel.appendChild(newClassPicker.wrap);
    var newClassLabelField = document.createElement('div');
    newClassLabelField.className = 'field';
    var newClassLabelLabel = document.createElement('label');
    newClassLabelLabel.textContent = 'Class label (optional)';
    newClassLabelField.appendChild(newClassLabelLabel);
    var newClassLabelInput = document.createElement('input');
    newClassLabelInput.type = 'text';
    newClassLabelInput.placeholder = 'Defaults to the local name';
    newClassLabelField.appendChild(newClassLabelInput);
    newClassPanel.appendChild(newClassLabelField);
    var newClassParentField = document.createElement('div');
    newClassParentField.className = 'field';
    var newClassParentLabel = document.createElement('label');
    newClassParentLabel.textContent = 'Parent class (optional, rdfs:subClassOf)';
    newClassParentField.appendChild(newClassParentLabel);
    var newClassParentSelect = document.createElement('select');
    var parentBlank = document.createElement('option');
    parentBlank.value = ''; parentBlank.textContent = '— none —';
    newClassParentSelect.appendChild(parentBlank);
    computeAllTypes().sort(function(a, b){ return humanize(a).localeCompare(humanize(b)); }).forEach(function(t){
      var opt = document.createElement('option');
      opt.value = t; opt.textContent = humanize(t);
      newClassParentSelect.appendChild(opt);
    });
    newClassParentField.appendChild(newClassParentSelect);
    newClassPanel.appendChild(newClassParentField);
    card.appendChild(newClassPanel);
    classSelect.addEventListener('change', function(){
      newClassPanel.hidden = classSelect.value !== '__newclass__';
    });

    var labelField = document.createElement('div');
    labelField.className = 'field';
    var labelLabel = document.createElement('label');
    labelLabel.textContent = 'Label (optional)';
    labelField.appendChild(labelLabel);
    var labelInput = document.createElement('input');
    labelInput.type = 'text';
    labelInput.placeholder = 'Defaults to the class’s own name';
    labelField.appendChild(labelInput);
    card.appendChild(labelField);

    var commentField = document.createElement('div');
    commentField.className = 'field';
    var commentLabel = document.createElement('label');
    commentLabel.textContent = 'Comment (optional)';
    commentField.appendChild(commentLabel);
    var commentArea = document.createElement('textarea');
    commentField.appendChild(commentArea);
    card.appendChild(commentField);

    var severityField = document.createElement('div');
    severityField.className = 'field';
    var severityLabel = document.createElement('label');
    severityLabel.textContent = 'Severity';
    severityField.appendChild(severityLabel);
    var severitySelect = document.createElement('select');
    SEVERITY_OPTIONS.forEach(function(o){
      var opt = document.createElement('option');
      opt.value = o.iri; opt.textContent = o.label;
      if (o.label === 'Violation') opt.selected = true;
      severitySelect.appendChild(opt);
    });
    severityField.appendChild(severitySelect);
    card.appendChild(severityField);

    var closedField = document.createElement('div');
    closedField.className = 'field';
    var closedLabel = document.createElement('label');
    closedLabel.style.cssText = 'display:flex; align-items:center; gap:7px; cursor:pointer;';
    var closedInput = document.createElement('input');
    closedInput.type = 'checkbox';
    closedLabel.appendChild(closedInput);
    closedLabel.appendChild(document.createTextNode('Closed (sh:closed) -- reject any property not explicitly declared'));
    closedField.appendChild(closedLabel);
    var ignoredWrap = document.createElement('div');
    ignoredWrap.hidden = true;
    ignoredWrap.style.cssText = 'margin-top:8px; padding-left:2px;';
    var ignoredHint = document.createElement('p');
    ignoredHint.className = 'hint';
    ignoredHint.style.margin = '0 0 6px';
    ignoredHint.textContent = 'Ignored properties (sh:ignoredProperties) -- always allowed even when closed:';
    ignoredWrap.appendChild(ignoredHint);
    var commonIgnored = [TYPE_PREDICATE, LABEL_PREDICATE, DESCRIPTION_PREDICATE].concat(Object.keys(META_PREDICATES));
    var ignoredChecks = commonIgnored.map(function(pred){
      var row = document.createElement('label');
      row.style.cssText = 'display:flex; align-items:center; gap:6px; font-weight:500; margin-bottom:3px; cursor:pointer;';
      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = true;
      cb.setAttribute('data-ignored-pred', pred);
      row.appendChild(cb);
      row.appendChild(document.createTextNode(humanize(pred)));
      ignoredWrap.appendChild(row);
      return cb;
    });
    closedField.appendChild(ignoredWrap);
    card.appendChild(closedField);
    closedInput.addEventListener('change', function(){ ignoredWrap.hidden = !closedInput.checked; });

    var actionsRow = document.createElement('div');
    actionsRow.className = 'form-actions';
    var createBtn = document.createElement('button');
    createBtn.type = 'button'; createBtn.className = 'btn primary'; createBtn.textContent = 'Create Node Shape';
    var cancelBtn = document.createElement('button');
    cancelBtn.type = 'button'; cancelBtn.className = 'btn'; cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', closeNewNodeShapeForm);
    createBtn.addEventListener('click', function(){
      errorBox.innerHTML = '';
      var warn;
      var creatingNewClass = classSelect.value === '__newclass__';
      var classIri = creatingNewClass ? '' : classSelect.value;
      var newClassNsUri = '', newClassLocal = '';
      if (creatingNewClass){
        newClassNsUri = newClassPicker.getNamespaceUri();
        newClassLocal = newClassPicker.getLocal();
        if (!newClassNsUri || !newClassLocal){
          warn = document.createElement('p');
          warn.className = 'warn';
          warn.textContent = 'Choose (or enter) a namespace and a local name for the new class.';
          errorBox.appendChild(warn);
          return;
        }
        classIri = newClassNsUri + newClassLocal;
      }
      if (!classIri){
        warn = document.createElement('p');
        warn.className = 'warn';
        warn.textContent = 'Choose a target class.';
        errorBox.appendChild(warn);
        return;
      }
      var closed = closedInput.checked;
      var ignored = closed ? ignoredChecks.filter(function(cb){ return cb.checked; }).map(function(cb){ return cb.getAttribute('data-ignored-pred'); }) : [];
      createBtn.disabled = true; createBtn.textContent = 'Creating…';
      // When minting a new class, its own creation (into ONTOLOGY_GRAPH) is
      // pushed and cache-invalidated FIRST, so uniqueShapeIri's shape-IRI
      // mint below and buildCreateNodeShapeTurtle's sh:targetClass both see
      // a classIri that already genuinely exists by the time the node
      // shape itself is written to SHACL_GRAPH.
      var chain = Promise.resolve();
      if (creatingNewClass){
        var classLabel = newClassLabelInput.value.trim() || newClassLocal;
        var classTurtle = buildCreateClassTurtle(classIri, classLabel, newClassParentSelect.value);
        chain = chain
          .then(function(){ return callTool(SERVER, 'push_turtle', {turtle: classTurtle, graph_iri: ONTOLOGY_GRAPH, mode: 'merge'}); })
          .then(function(){ return mcp.invalidate(SERVER, 'sparql_select').catch(function(){}); })
          .then(function(){ return loadClassHierarchy(); });
      }
      chain
        .then(function(){
          var ns = namespaceAndLocal(classIri);
          var newIri = uniqueShapeIri(ns.ns + ns.local + 'Shape', nodeShapesData);
          var turtle = buildCreateNodeShapeTurtle(newIri, classIri, labelInput.value.trim(), commentArea.value.trim(), severitySelect.value, closed, ignored);
          return callTool(SERVER, 'push_turtle', {turtle: turtle, graph_iri: SHACL_GRAPH, mode: 'merge'})
            .then(function(){ return mcp.invalidate(SERVER, 'sparql_select').catch(function(){}); })
            .then(function(){ return loadNodeShapesData(); })
            .then(function(){ renderNodeShapes(); selectNodeShape(newIri); });
        })
        .catch(function(err){
          createBtn.disabled = false; createBtn.textContent = 'Create Node Shape';
          renderBanner(errorBox, err);
        });
    });
    actionsRow.appendChild(createBtn);
    actionsRow.appendChild(cancelBtn);
    card.appendChild(actionsRow);
    return card;
  }

  function openNewNodeShapeForm(){
    selectedNodeShapeIri = null;
    renderNodeShapes();
    $detail.innerHTML = '';
    var inner = document.createElement('div');
    inner.className = 'detail-inner';
    var h2 = document.createElement('h2');
    h2.className = 'title';
    h2.textContent = 'New Node Shape';
    inner.appendChild(h2);
    inner.appendChild(buildNewNodeShapeForm());
    $detail.appendChild(inner);
  }
  function closeNewNodeShapeForm(){
    renderNodeShapes();
    if (selectedNodeShapeIri) selectNodeShape(selectedNodeShapeIri);
    else renderIdleDetail('Nothing selected');
  }

  // ---- Property Shapes: rail -------------------------------------------

  function buildPropertyShapeRow(ps){
    var row = document.createElement('button');
    row.className = 'row' + (ps.iri === selectedPropShapeIri ? ' active' : '');
    row.type = 'button';
    if (ps.deactivated) row.style.opacity = '0.55';
    var lbl = document.createElement('span');
    lbl.className = 'row-label';
    lbl.textContent = propertyShapeLabel(ps) + (ps.deactivated ? ' (deactivated)' : '');
    row.appendChild(lbl);
    var tp = document.createElement('span');
    tp.className = 'row-type';
    // The class(es) this shape is actually attached to, not its path --
    // two property shapes can share a humanized path (Country_capital and
    // FederatedState_capital both read "Capital" on the left) and this is
    // what tells them apart at a glance. Falls back to the path itself for
    // a shape that isn't attached to any node shape yet.
    var classText = ps.classes && ps.classes.length
      ? ps.classes.map(humanize).sort().join(', ')
      : (ps.path ? humanize(ps.path) : '');
    tp.textContent = classText;
    if (classText) tp.title = classText;
    row.appendChild(tp);
    row.addEventListener('click', function(){ selectPropertyShape(ps.iri); });
    return row;
  }

  function renderPropertyShapesTab(){
    $propShapes.innerHTML = '';
    var addBtn = document.createElement('button');
    addBtn.type = 'button'; addBtn.className = 'btn'; addBtn.textContent = '+ New Property Shape';
    addBtn.style.cssText = 'margin:8px 8px 10px; font-size:11.5px; padding:5px 10px;';
    addBtn.addEventListener('click', openNewPropertyShapeForm);
    $propShapes.appendChild(addBtn);
    $propShapes.appendChild(buildShowDeprecatedToggle('propshapes', 'Show deactivated', renderPropertyShapesTab));

    if (!propShapesData.length){
      var empty = document.createElement('div');
      empty.className = 'list-empty';
      empty.textContent = 'No SHACL property shapes yet.';
      $propShapes.appendChild(empty);
      return;
    }
    var visiblePropShapes = filterByDeactivatedFlag(propShapesData, 'propshapes');
    if (!visiblePropShapes.length){
      var allHiddenPS = document.createElement('div');
      allHiddenPS.className = 'list-empty';
      allHiddenPS.textContent = 'Every property shape is deactivated -- tick "Show deactivated" above to see them.';
      $propShapes.appendChild(allHiddenPS);
      return;
    }
    visiblePropShapes.slice().sort(function(a, b){ return propertyShapeLabel(a).localeCompare(propertyShapeLabel(b)); })
      .forEach(function(ps){ $propShapes.appendChild(buildPropertyShapeRow(ps)); });
  }

  function parsePropertyShapeRow(row){
    function v(key){ return (row[key] !== undefined && row[key] !== null) ? row[key].value : null; }
    return {
      path: v('path'),
      name: v('name'),
      description: v('description'),
      order: v('order'),
      severity: v('severity'),
      message: v('message'),
      deactivated: v('deactivated') === 'true',
      minCount: v('minCount'),
      maxCount: v('maxCount'),
      datatype: v('datatype'),
      class: v('class'),
      nodeKind: v('nodeKind'),
      hasValue: (row.hasValue !== undefined && row.hasValue !== null) ? {type: row.hasValue.type, value: row.hasValue.value} : null,
      pattern: v('pattern'),
      flags: v('flags'),
      minLength: v('minLength'),
      maxLength: v('maxLength'),
      uniqueLang: v('uniqueLang') === 'true',
      minInclusive: v('minInclusive'),
      maxInclusive: v('maxInclusive'),
      minExclusive: v('minExclusive'),
      maxExclusive: v('maxExclusive'),
      equals: v('equals'),
      disjoint: v('disjoint'),
      lessThan: v('lessThan'),
      lessThanOrEquals: v('lessThanOrEquals'),
      inValues: v('inValues') ? v('inValues').split('|').filter(Boolean) : [],
      languageIn: v('languageIn') ? v('languageIn').split('|').filter(Boolean) : []
    };
  }

  function selectPropertyShape(shapeIri, skipRerenderRail){
    selectedPropShapeIri = shapeIri;
    if (!skipRerenderRail) renderPropertyShapesTab();
    renderDetailSkeleton();
    Promise.all([
      callTool(SERVER, 'sparql_select', {query: propertyShapeFullQuery(shapeIri), graph: SHACL_GRAPH})
        .then(function(res){ return (res.payload && res.payload.results && res.payload.results.bindings) || []; }),
      callTool(SERVER, 'sparql_select', {query: nodeShapesUsingPropertyQuery(shapeIri), graph: SHACL_GRAPH})
        .then(function(res){ return (res.payload && res.payload.results && res.payload.results.bindings) || []; })
    ]).then(function(results){
      var row = results[0][0] || {};
      var usedBy = results[1].map(function(b){
        return {iri: b.shape.value, targetClass: b.targetClass ? b.targetClass.value : null, label: b.label ? b.label.value : null};
      });
      renderPropertyShapeDetail(shapeIri, row, usedBy);
    }).catch(function(err){
      $detail.innerHTML = '';
      var inner = document.createElement('div');
      inner.className = 'detail-inner';
      $detail.appendChild(inner);
      renderBanner(inner, err, function(){ selectPropertyShape(shapeIri); });
    });
  }

  function buildPropertyShapeSummary(meta){
    var wrap = document.createElement('div');
    var rows = [];
    if (meta.description) rows.push(['Description', meta.description]);
    if (meta.order != null) rows.push(['Order', meta.order]);
    if (meta.severity) rows.push(['Severity', humanize(meta.severity)]);
    if (meta.message) rows.push(['Message', meta.message]);
    if (meta.minCount != null || meta.maxCount != null) rows.push(['Cardinality', (meta.minCount || '0') + '..' + (meta.maxCount != null ? meta.maxCount : '*')]);
    if (meta.datatype) rows.push(['Datatype', humanize(meta.datatype)]);
    if (meta.class) rows.push(['Class', humanize(meta.class)]);
    if (meta.nodeKind) rows.push(['Node kind', humanize(meta.nodeKind)]);
    if (meta.hasValue) rows.push(['Has value', meta.hasValue.value]);
    if (meta.inValues.length) rows.push(['In (enum)', meta.inValues.map(function(v){ return /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(v) ? humanize(v) : v; }).join(', ')]);
    if (meta.pattern) rows.push(['Pattern', meta.pattern + (meta.flags ? '  (flags: ' + meta.flags + ')' : '')]);
    if (meta.minLength != null) rows.push(['Min length', meta.minLength]);
    if (meta.maxLength != null) rows.push(['Max length', meta.maxLength]);
    if (meta.languageIn.length) rows.push(['Language in', meta.languageIn.join(', ')]);
    if (meta.uniqueLang) rows.push(['Unique language', 'yes']);
    if (meta.minInclusive != null) rows.push(['Min (inclusive)', meta.minInclusive]);
    if (meta.maxInclusive != null) rows.push(['Max (inclusive)', meta.maxInclusive]);
    if (meta.minExclusive != null) rows.push(['Min (exclusive)', meta.minExclusive]);
    if (meta.maxExclusive != null) rows.push(['Max (exclusive)', meta.maxExclusive]);
    if (meta.equals) rows.push(['Equals', humanize(meta.equals)]);
    if (meta.disjoint) rows.push(['Disjoint', humanize(meta.disjoint)]);
    if (meta.lessThan) rows.push(['Less than', humanize(meta.lessThan)]);
    if (meta.lessThanOrEquals) rows.push(['Less than or equals', humanize(meta.lessThanOrEquals)]);
    if (!rows.length){
      var hint = document.createElement('p');
      hint.className = 'hint';
      hint.textContent = 'No constraints set beyond the path yet -- click Edit to add some.';
      wrap.appendChild(hint);
      return wrap;
    }
    var kv = document.createElement('div');
    kv.className = 'kv';
    rows.forEach(function(r){
      var row = document.createElement('div');
      row.className = 'kv-row';
      var key = document.createElement('div');
      key.className = 'kv-key';
      key.textContent = r[0];
      row.appendChild(key);
      var val = document.createElement('div');
      val.className = 'kv-val';
      var span = document.createElement('span');
      span.className = 'plain';
      span.textContent = r[1];
      val.appendChild(span);
      row.appendChild(val);
      kv.appendChild(row);
    });
    wrap.appendChild(kv);
    return wrap;
  }

  function renderPropertyShapeDetail(shapeIri, row, usedBy){
    var meta = parsePropertyShapeRow(row);
    var isEditing = propShapeEditOpenFor === shapeIri;

    var inner = document.createElement('div');
    inner.className = 'detail-inner';

    var badges = document.createElement('div');
    badges.className = 'badges';
    var p = document.createElement('span');
    p.className = 'pill type';
    p.textContent = 'SHACL Property Shape';
    badges.appendChild(p);
    if (meta.deactivated){
      var dp = document.createElement('span');
      dp.className = 'pill status';
      dp.textContent = 'Deactivated';
      badges.appendChild(dp);
    }
    inner.appendChild(badges);

    if (!isEditing){
      var h2 = document.createElement('h2');
      h2.className = 'title';
      h2.textContent = meta.name || (meta.path ? humanize(meta.path) : humanize(shapeIri));
      inner.appendChild(h2);
    }

    var iriLine = document.createElement('div');
    iriLine.className = 'iri';
    iriLine.textContent = shapeIri;
    inner.appendChild(iriLine);

    if (meta.path){
      var pathLine = document.createElement('p');
      pathLine.className = 'hint';
      pathLine.style.margin = '-12px 0 18px';
      pathLine.textContent = 'Path: ' + humanize(meta.path) + '  (' + meta.path + ')';
      inner.appendChild(pathLine);
    }

    var actions = document.createElement('div');
    actions.className = 'actions';
    var editBtn = document.createElement('button');
    editBtn.type = 'button'; editBtn.className = 'btn';
    editBtn.textContent = isEditing ? 'Cancel Edit' : 'Edit';
    editBtn.addEventListener('click', function(){
      propShapeEditOpenFor = isEditing ? null : shapeIri;
      selectPropertyShape(shapeIri, true);
    });
    actions.appendChild(editBtn);
    var toggleBtn = document.createElement('button');
    toggleBtn.type = 'button'; toggleBtn.className = 'btn';
    toggleBtn.textContent = meta.deactivated ? 'Reactivate' : 'Deactivate';
    toggleBtn.addEventListener('click', function(){
      toggleBtn.disabled = true;
      callTool(SERVER, 'sparql_update', {update: buildSetDeactivatedSparql(shapeIri, !meta.deactivated)})
        .then(function(){ return mcp.invalidate(SERVER, 'sparql_select').catch(function(){}); })
        .then(function(){ return loadPropShapesData(true); })
        .then(function(){ renderPropertyShapesTab(); selectPropertyShape(shapeIri, true); })
        .catch(function(err){ toggleBtn.disabled = false; renderBanner(inner, err); });
    });
    actions.appendChild(toggleBtn);

    // Temporary escape hatch alongside Deactivate (see
    // buildDeletePropertyShapeSparql's comment) -- armed on a first click,
    // executed on a second, so a stray click can't delete anything outright.
    var deleteBtn = document.createElement('button');
    deleteBtn.type = 'button'; deleteBtn.className = 'btn';
    deleteBtn.textContent = 'Delete';
    deleteBtn.style.cssText = 'border-color:var(--bad); color:var(--bad);';
    deleteBtn.addEventListener('click', function(){
      if (deleteBtn.getAttribute('data-armed') !== '1'){
        deleteBtn.setAttribute('data-armed', '1');
        deleteBtn.textContent = usedBy.length
          ? 'Confirm Delete (used by ' + usedBy.length + ')'
          : 'Confirm Delete?';
        deleteBtn.style.cssText = 'background:var(--bad); border-color:var(--bad); color:#fff;';
        return;
      }
      deleteBtn.disabled = true; toggleBtn.disabled = true; editBtn.disabled = true;
      deleteBtn.textContent = 'Deleting…';
      var usedByIris = usedBy.map(function(nb){ return nb.iri; });
      callTool(SERVER, 'sparql_update', {update: buildDeletePropertyShapeSparql(shapeIri, usedByIris)})
        .then(function(){ return mcp.invalidate(SERVER, 'sparql_select').catch(function(){}); })
        .then(function(){ selectedPropShapeIri = null; return loadPropShapesData(true); })
        .then(function(){ renderPropertyShapesTab(); renderIdleDetail('Property shape deleted'); })
        .catch(function(err){
          deleteBtn.disabled = false; toggleBtn.disabled = false; editBtn.disabled = false;
          deleteBtn.removeAttribute('data-armed');
          deleteBtn.textContent = 'Delete';
          deleteBtn.style.cssText = 'border-color:var(--bad); color:var(--bad);';
          renderBanner(inner, err);
        });
    });
    actions.appendChild(deleteBtn);
    inner.appendChild(actions);

    if (isEditing) inner.appendChild(buildPropertyShapeEditForm(shapeIri, meta));
    else inner.appendChild(buildPropertyShapeSummary(meta));

    if (usedBy.length){
      var secLabel = document.createElement('div');
      secLabel.className = 'section-label';
      secLabel.style.marginTop = '10px';
      secLabel.textContent = 'Used by (' + usedBy.length + ')';
      inner.appendChild(secLabel);
      var kv = document.createElement('div');
      kv.className = 'kv';
      usedBy.forEach(function(nb){
        var kvrow = document.createElement('div');
        kvrow.className = 'kv-row';
        var key = document.createElement('div');
        key.className = 'kv-key';
        key.textContent = nb.targetClass ? humanize(nb.targetClass) : '';
        kvrow.appendChild(key);
        var val = document.createElement('div');
        val.className = 'kv-val';
        var chip = document.createElement('button');
        chip.type = 'button'; chip.className = 'chip';
        chip.innerHTML = '<span>' + (nb.label || humanize(nb.iri)) + '</span><span class="arrow">&#8594;</span>';
        chip.addEventListener('click', function(){ jumpToNodeShape(nb.iri); });
        val.appendChild(chip);
        kvrow.appendChild(val);
        kv.appendChild(kvrow);
      });
      inner.appendChild(kv);
    }

    $detail.innerHTML = '';
    $detail.appendChild(inner);
  }

  // Every scalar (single literal-or-IRI) SHACL 1.2 Core constraint this
  // editor exposes, keyed by the field name parsePropertyShapeRow uses.
  // sh:hasValue, sh:in, sh:languageIn and sh:uniqueLang are handled
  // separately in buildPropertyShapeEditForm below -- two are RDF lists,
  // one mixes IRI-or-literal, one is a plain checkbox -- so they don't fit
  // this generic text/select/number shape.
  var SCALAR_FIELDS = [
    {key: 'name', predicate: SH_NAME, kind: 'text', label: 'Name'},
    {key: 'description', predicate: SH_DESCRIPTION2, kind: 'textarea', label: 'Description'},
    {key: 'order', predicate: SH_ORDER, kind: 'number', label: 'Order'},
    {key: 'severity', predicate: SH_SEVERITY, kind: 'select', label: 'Severity', options: SEVERITY_OPTIONS},
    {key: 'message', predicate: SH_MESSAGE, kind: 'textarea', label: 'Message'},
    {key: 'minCount', predicate: SH_MINCOUNT, kind: 'number', label: 'Min count'},
    {key: 'maxCount', predicate: SH_MAXCOUNT, kind: 'number', label: 'Max count'},
    {key: 'datatype', predicate: SH_DATATYPE, kind: 'select', label: 'Datatype', options: DATATYPE_OPTIONS},
    {key: 'class', predicate: SH_CLASS, kind: 'classselect', label: 'Class'},
    {key: 'nodeKind', predicate: SH_NODEKIND, kind: 'select', label: 'Node kind', options: NODEKIND_OPTIONS},
    {key: 'pattern', predicate: SH_PATTERN, kind: 'text', label: 'Pattern'},
    {key: 'flags', predicate: SH_FLAGS, kind: 'text', label: 'Pattern flags'},
    {key: 'minLength', predicate: SH_MINLENGTH, kind: 'number', label: 'Min length'},
    {key: 'maxLength', predicate: SH_MAXLENGTH, kind: 'number', label: 'Max length'},
    {key: 'minInclusive', predicate: SH_MININCLUSIVE, kind: 'number', label: 'Min (inclusive)'},
    {key: 'maxInclusive', predicate: SH_MAXINCLUSIVE, kind: 'number', label: 'Max (inclusive)'},
    {key: 'minExclusive', predicate: SH_MINEXCLUSIVE, kind: 'number', label: 'Min (exclusive)'},
    {key: 'maxExclusive', predicate: SH_MAXEXCLUSIVE, kind: 'number', label: 'Max (exclusive)'},
    {key: 'equals', predicate: SH_EQUALS, kind: 'text', label: 'Equals (path IRI)'},
    {key: 'disjoint', predicate: SH_DISJOINT, kind: 'text', label: 'Disjoint (path IRI)'},
    {key: 'lessThan', predicate: SH_LESSTHAN, kind: 'text', label: 'Less than (path IRI)'},
    {key: 'lessThanOrEquals', predicate: SH_LESSTHANOREQUALS, kind: 'text', label: 'Less than or equals (path IRI)'}
  ];

  function buildPropertyShapeEditForm(shapeIri, meta){
    var card = document.createElement('div');
    card.className = 'addchild-form';

    var h3 = document.createElement('h3');
    h3.textContent = 'Edit property shape';
    card.appendChild(h3);

    var hint = document.createElement('p');
    hint.className = 'hint';
    hint.textContent = 'Updates this shape’s SHACL 1.2 Core constraints live in the shapes graph. sh:path (' + (meta.path ? humanize(meta.path) : '—') + ') can’t be changed here -- create a new property shape for a different predicate. Only fields you actually change are written.';
    card.appendChild(hint);

    var errorBox = document.createElement('div');
    card.appendChild(errorBox);

    var controls = {};

    SCALAR_FIELDS.forEach(function(spec){
      var field = document.createElement('div');
      field.className = 'field';
      var label = document.createElement('label');
      label.textContent = spec.label;
      field.appendChild(label);
      var current = meta[spec.key];
      var input;
      if (spec.kind === 'textarea'){
        input = document.createElement('textarea');
        input.value = current || '';
      } else if (spec.kind === 'select' || spec.kind === 'classselect'){
        input = document.createElement('select');
        var blankOpt = document.createElement('option');
        blankOpt.value = ''; blankOpt.textContent = '— none —';
        input.appendChild(blankOpt);
        var opts = spec.kind === 'classselect'
          ? computeAllTypes().sort(function(a, b){ return humanize(a).localeCompare(humanize(b)); }).map(function(t){ return {iri: t, label: humanize(t)}; })
          : spec.options;
        opts.forEach(function(o){
          var opt = document.createElement('option');
          opt.value = o.iri;
          opt.textContent = o.label;
          if (current === o.iri) opt.selected = true;
          input.appendChild(opt);
        });
      } else {
        input = document.createElement('input');
        input.type = 'text';
        input.value = current != null ? current : '';
      }
      field.appendChild(input);
      card.appendChild(field);
      controls[spec.key] = {
        get: function(){ var v = ('value' in input) ? input.value : ''; return typeof v === 'string' ? v.trim() : v; },
        initial: current != null ? String(current) : ''
      };
    });

    // sh:hasValue -- can be an IRI or a plain literal, so it gets its own
    // text field (with iriOrLiteralClause deciding which on save) rather
    // than living in SCALAR_FIELDS.
    var hvField = document.createElement('div');
    hvField.className = 'field';
    var hvLabel = document.createElement('label');
    hvLabel.textContent = 'Has value';
    hvField.appendChild(hvLabel);
    var hvInput = document.createElement('input');
    hvInput.type = 'text';
    var hvInitial = meta.hasValue ? meta.hasValue.value : '';
    hvInput.value = hvInitial;
    hvInput.placeholder = 'A full IRI (http://…), or plain text -- blank to remove';
    hvField.appendChild(hvInput);
    card.appendChild(hvField);

    // uniqueLang: a plain checkbox -- boolLiteral() on save.
    var ulField = document.createElement('div');
    ulField.className = 'field';
    var ulLabel = document.createElement('label');
    ulLabel.style.cssText = 'display:flex; align-items:center; gap:7px; cursor:pointer;';
    var ulInput = document.createElement('input');
    ulInput.type = 'checkbox';
    ulInput.checked = !!meta.uniqueLang;
    ulLabel.appendChild(ulInput);
    ulLabel.appendChild(document.createTextNode('Unique language (sh:uniqueLang)'));
    ulField.appendChild(ulLabel);
    card.appendChild(ulField);

    // sh:in -- a closed enumeration, edited as a comma-separated list (each
    // value written as an IRI if it looks like one, a plain literal
    // otherwise -- same convention as Has Value). Full-list replace on save
    // via buildClearListSparql + buildInsertListSparql, matching how
    // buildAppendConceptToInSparql elsewhere already treats sh:in as a real
    // RDF list rather than something to patch value-by-value.
    var inField = document.createElement('div');
    inField.className = 'field';
    var inLabel = document.createElement('label');
    inLabel.textContent = 'In (enumeration, comma-separated)';
    inField.appendChild(inLabel);
    var inInput = document.createElement('input');
    inInput.type = 'text';
    inInput.value = meta.inValues.join(', ');
    inField.appendChild(inInput);
    card.appendChild(inField);

    // sh:languageIn -- comma-separated BCP47 tags, also a real RDF list.
    var langField = document.createElement('div');
    langField.className = 'field';
    var langLabel = document.createElement('label');
    langLabel.textContent = 'Language in (comma-separated, e.g. en, fr)';
    langField.appendChild(langLabel);
    var langInput = document.createElement('input');
    langInput.type = 'text';
    langInput.value = meta.languageIn.join(', ');
    langField.appendChild(langInput);
    card.appendChild(langField);

    var actionsRow = document.createElement('div');
    actionsRow.className = 'form-actions';
    var saveBtn = document.createElement('button');
    saveBtn.type = 'button'; saveBtn.className = 'btn primary'; saveBtn.textContent = 'Save Changes';
    var cancelBtn = document.createElement('button');
    cancelBtn.type = 'button'; cancelBtn.className = 'btn'; cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', function(){
      propShapeEditOpenFor = null;
      selectPropertyShape(shapeIri, true);
    });

    saveBtn.addEventListener('click', function(){
      errorBox.innerHTML = '';
      saveBtn.disabled = true; cancelBtn.disabled = true; saveBtn.textContent = 'Saving…';
      var chain = Promise.resolve();

      SCALAR_FIELDS.forEach(function(spec){
        var ctl = controls[spec.key];
        var newVal = ctl.get();
        if (newVal === (ctl.initial || '')) return;
        var clause = null;
        if (newVal){
          if (spec.kind === 'select' || spec.kind === 'classselect'){
            clause = '<' + newVal + '>';
          } else if (spec.kind === 'number'){
            clause = numericLiteral(newVal);
          } else if (/^(equals|disjoint|lessThan|lessThanOrEquals)$/.test(spec.key)){
            clause = '<' + newVal + '>';
          } else {
            clause = turtleLiteral(newVal);
          }
        }
        var update = buildReplaceFieldSparql(SHACL_GRAPH, shapeIri, spec.predicate, clause);
        chain = chain.then(function(){ return callTool(SERVER, 'sparql_update', {update: update}); });
      });

      var newHasValue = hvInput.value.trim();
      if (newHasValue !== hvInitial){
        var hvUpdate = buildReplaceFieldSparql(SHACL_GRAPH, shapeIri, SH_HASVALUE, newHasValue ? iriOrLiteralClause(newHasValue) : null);
        chain = chain.then(function(){ return callTool(SERVER, 'sparql_update', {update: hvUpdate}); });
      }

      var newUniqueLang = ulInput.checked;
      if (newUniqueLang !== !!meta.uniqueLang){
        var ulUpdate = buildReplaceFieldSparql(SHACL_GRAPH, shapeIri, SH_UNIQUELANG, newUniqueLang ? boolLiteral(true) : null);
        chain = chain.then(function(){ return callTool(SERVER, 'sparql_update', {update: ulUpdate}); });
      }

      var newIn = inInput.value.split(',').map(function(x){ return x.trim(); }).filter(Boolean);
      if (newIn.join('|') !== meta.inValues.join('|')){
        chain = chain.then(function(){ return callTool(SERVER, 'sparql_update', {update: buildClearListSparql(SHACL_GRAPH, shapeIri, SH_IN)}); });
        if (newIn.length){
          chain = chain.then(function(){ return callTool(SERVER, 'sparql_update', {update: buildInsertListSparql(SHACL_GRAPH, shapeIri, SH_IN, newIn.map(iriOrLiteralClause))}); });
        }
      }

      var newLangIn = langInput.value.split(',').map(function(x){ return x.trim(); }).filter(Boolean);
      if (newLangIn.join('|') !== meta.languageIn.join('|')){
        chain = chain.then(function(){ return callTool(SERVER, 'sparql_update', {update: buildClearListSparql(SHACL_GRAPH, shapeIri, SH_LANGUAGEIN)}); });
        if (newLangIn.length){
          chain = chain.then(function(){ return callTool(SERVER, 'sparql_update', {update: buildInsertListSparql(SHACL_GRAPH, shapeIri, SH_LANGUAGEIN, newLangIn.map(turtleLiteral))}); });
        }
      }

      chain
        .then(function(){ return mcp.invalidate(SERVER, 'sparql_select').catch(function(){}); })
        .then(function(){
          propShapeEditOpenFor = null;
          return loadPropShapesData(true);
        })
        .then(function(){ renderPropertyShapesTab(); selectPropertyShape(shapeIri, true); })
        .catch(function(err){
          saveBtn.disabled = false; cancelBtn.disabled = false; saveBtn.textContent = 'Save Changes';
          renderBanner(errorBox, err);
        });
    });

    actionsRow.appendChild(saveBtn);
    actionsRow.appendChild(cancelBtn);
    card.appendChild(actionsRow);
    return card;
  }

  function buildNewPropertyShapeForm(){
    var card = document.createElement('div');
    card.className = 'addchild-form';
    var hint = document.createElement('p');
    hint.className = 'hint';
    hint.textContent = 'Creates a named, reusable sh:PropertyShape -- attach it to one or more Node Shapes from either tab afterward. Every other SHACL 1.2 Core constraint (cardinality, datatype, pattern, ...) is added on the Edit screen once it exists.';
    card.appendChild(hint);

    var errorBox = document.createElement('div');
    card.appendChild(errorBox);

    var pathField = document.createElement('div');
    pathField.className = 'field';
    var pathLabel = document.createElement('label');
    pathLabel.textContent = 'Path (property)';
    pathField.appendChild(pathLabel);
    var pathSelect = document.createElement('select');
    var loadingOpt = document.createElement('option');
    loadingOpt.value = ''; loadingOpt.textContent = 'Loading properties…';
    pathSelect.appendChild(loadingOpt);
    pathField.appendChild(pathSelect);
    card.appendChild(pathField);

    var customWrap = document.createElement('div');
    customWrap.className = 'field';
    customWrap.hidden = true;
    var customLabel = document.createElement('label');
    customLabel.textContent = 'Property IRI';
    customWrap.appendChild(customLabel);
    var customInput = document.createElement('input');
    customInput.type = 'text';
    customInput.placeholder = 'https://…#somePredicate';
    customWrap.appendChild(customInput);
    card.appendChild(customWrap);

    // Revealed only when "+ Create a new property..." is chosen below --
    // mints a brand-new rdf:Property (via buildCreatePropertyTurtle) before
    // the property shape itself is created, exactly the way the New Node
    // Shape form's "+ Create a new class..." option mints a class first.
    // Distinct from "Other (enter an IRI)..." above: that one points
    // sh:path at whatever IRI is typed without asserting anything about
    // it; this one actually declares the predicate to exist.
    var newPropPanel = document.createElement('div');
    newPropPanel.hidden = true;
    newPropPanel.style.cssText = 'margin:-6px 0 14px; padding:10px 12px; border:1px solid var(--line); border-radius:8px;';
    var newPropPicker = buildNamespaceLocalPicker();
    newPropPanel.appendChild(newPropPicker.wrap);
    var newPropLabelField = document.createElement('div');
    newPropLabelField.className = 'field';
    var newPropLabelLabel = document.createElement('label');
    newPropLabelLabel.textContent = 'Property label (optional)';
    newPropLabelField.appendChild(newPropLabelLabel);
    var newPropLabelInput = document.createElement('input');
    newPropLabelInput.type = 'text';
    newPropLabelInput.placeholder = 'Defaults to the local name';
    newPropLabelField.appendChild(newPropLabelInput);
    newPropPanel.appendChild(newPropLabelField);
    card.appendChild(newPropPanel);

    // "Class (for shape naming)" -- purely a naming input, not a
    // constraint: it does NOT restrict which node shapes this property
    // shape can later be attached to (it's still a reusable, independently
    // attachable shape, same as always). It exists only to feed
    // defaultPropertyShapeIri's shape:{ClassName}_{propertyName} default
    // below, per Kurt's 2026-09-18 convention.
    var classField = document.createElement('div');
    classField.className = 'field';
    var classLabel = document.createElement('label');
    classLabel.textContent = 'Class (for shape naming)';
    classField.appendChild(classLabel);
    var classSelect = document.createElement('select');
    var classBlank = document.createElement('option');
    classBlank.value = ''; classBlank.textContent = '— none —';
    classSelect.appendChild(classBlank);
    computeAllTypes().sort(function(a, b){ return humanize(a).localeCompare(humanize(b)); }).forEach(function(t){
      var opt = document.createElement('option');
      opt.value = t; opt.textContent = humanize(t);
      classSelect.appendChild(opt);
    });
    classField.appendChild(classSelect);
    card.appendChild(classField);

    loadAllProperties().then(function(props){
      pathSelect.innerHTML = '';
      var blank = document.createElement('option');
      blank.value = ''; blank.textContent = '— choose a property —';
      pathSelect.appendChild(blank);
      props.forEach(function(p){
        var opt = document.createElement('option');
        opt.value = p; opt.textContent = humanize(p) + '  (' + p + ')';
        pathSelect.appendChild(opt);
      });
      var newPropOpt = document.createElement('option');
      newPropOpt.value = '__newprop__'; newPropOpt.textContent = '+ Create a new property…';
      pathSelect.appendChild(newPropOpt);
      var otherOpt = document.createElement('option');
      otherOpt.value = '__other__'; otherOpt.textContent = 'Other (enter an IRI)…';
      pathSelect.appendChild(otherOpt);
      refreshDefaultShapeIri();
    });
    pathSelect.addEventListener('change', function(){
      customWrap.hidden = pathSelect.value !== '__other__';
      newPropPanel.hidden = pathSelect.value !== '__newprop__';
      refreshDefaultShapeIri();
    });

    var nameField = document.createElement('div');
    nameField.className = 'field';
    var nameLabel = document.createElement('label');
    nameLabel.textContent = 'Name (optional)';
    nameField.appendChild(nameLabel);
    var nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.placeholder = 'Defaults to the property’s own name';
    nameField.appendChild(nameInput);
    card.appendChild(nameField);

    // Shape IRI -- always visible, always editable. Auto-filled with
    // shape:{ClassName}_{propertyName} (SHAPE_NS_DEFAULT) the moment both
    // a Class and a Path resolve to something, and re-filled every time
    // either changes -- UNTIL the admin types into this field directly, at
    // which point shapeIriDirty latches true and every future keystroke
    // here is treated as an explicit override the auto-fill must never
    // clobber. That's the literal implementation of "default until
    // explicitly overridden": the field IS the override mechanism.
    var shapeIriField = document.createElement('div');
    shapeIriField.className = 'field';
    var shapeIriLabel = document.createElement('label');
    shapeIriLabel.textContent = 'Shape IRI';
    shapeIriField.appendChild(shapeIriLabel);
    var shapeIriInput = document.createElement('input');
    shapeIriInput.type = 'text';
    shapeIriInput.placeholder = 'Choose a class and a path above to fill this in, or type your own';
    shapeIriField.appendChild(shapeIriInput);
    var shapeIriHint = document.createElement('p');
    shapeIriHint.className = 'hint';
    shapeIriHint.style.margin = '-8px 0 12px';
    shapeIriHint.textContent = 'Defaults to shape:{ClassName}_{propertyName} in https://w3-id.org/shape# once a class and path are chosen -- edit freely to use a different IRI instead.';
    shapeIriField.appendChild(shapeIriHint);
    card.appendChild(shapeIriField);

    var shapeIriDirty = false;
    shapeIriInput.addEventListener('input', function(){ shapeIriDirty = true; });

    function currentPathIriForNaming(){
      if (pathSelect.value === '__newprop__'){
        var nsUri = newPropPicker.getNamespaceUri();
        var local = newPropPicker.getLocal();
        return (nsUri && local) ? (nsUri + local) : '';
      }
      if (pathSelect.value === '__other__') return customInput.value.trim();
      return pathSelect.value;
    }
    function refreshDefaultShapeIri(){
      if (shapeIriDirty) return;
      shapeIriInput.value = defaultPropertyShapeIri(classSelect.value, currentPathIriForNaming());
    }
    classSelect.addEventListener('change', refreshDefaultShapeIri);
    customInput.addEventListener('input', refreshDefaultShapeIri);
    newPropPicker.wrap.addEventListener('change', refreshDefaultShapeIri);
    newPropPicker.wrap.addEventListener('input', refreshDefaultShapeIri);

    var actionsRow = document.createElement('div');
    actionsRow.className = 'form-actions';
    var createBtn = document.createElement('button');
    createBtn.type = 'button'; createBtn.className = 'btn primary'; createBtn.textContent = 'Create Property Shape';
    var cancelBtn = document.createElement('button');
    cancelBtn.type = 'button'; cancelBtn.className = 'btn'; cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', closeNewPropertyShapeForm);
    createBtn.addEventListener('click', function(){
      errorBox.innerHTML = '';
      var warn;
      var creatingNewProp = pathSelect.value === '__newprop__';
      var pathIri = creatingNewProp ? '' : (pathSelect.value === '__other__' ? customInput.value.trim() : pathSelect.value);
      var newPropNsUri = '', newPropLocal = '';
      if (creatingNewProp){
        newPropNsUri = newPropPicker.getNamespaceUri();
        newPropLocal = newPropPicker.getLocal();
        if (!newPropNsUri || !newPropLocal){
          warn = document.createElement('p');
          warn.className = 'warn';
          warn.textContent = 'Choose (or enter) a namespace and a local name for the new property.';
          errorBox.appendChild(warn);
          return;
        }
        pathIri = newPropNsUri + newPropLocal;
      }
      if (!pathIri){
        warn = document.createElement('p');
        warn.className = 'warn';
        warn.textContent = 'Choose or enter a property path.';
        errorBox.appendChild(warn);
        return;
      }
      var name = nameInput.value.trim();

      // Resolve the property shape's OWN iri. Three cases:
      //  1. The Shape IRI field has been explicitly edited (shapeIriDirty)
      //     -- respect it literally. A collision with an existing property
      //     shape is reported, not silently worked around, since typing an
      //     exact IRI is a deliberate act.
      //  2. It holds an auto-filled shape:{ClassName}_{propertyName}
      //     default (a class was chosen) -- dedupe it the same way every
      //     other auto-minted IRI in this file is deduped (uniqueShapeIri),
      //     so two shapes coined for the same class+property in the same
      //     session don't collide.
      //  3. It's empty (no class was chosen and nothing was typed) -- fall
      //     back to the pre-existing "mint from the property's own
      //     namespace" scheme, so this form still works without picking a
      //     class up front.
      var shapeIriValue = shapeIriInput.value.trim();
      var newIri;
      if (shapeIriValue && shapeIriDirty){
        if (propShapesData.some(function(p){ return p.iri === shapeIriValue; })){
          warn = document.createElement('p');
          warn.className = 'warn';
          warn.textContent = 'That Shape IRI is already used by another property shape -- choose a different one.';
          errorBox.appendChild(warn);
          return;
        }
        newIri = shapeIriValue;
      } else if (shapeIriValue){
        newIri = uniqueShapeIri(shapeIriValue, propShapesData);
      } else {
        var pathNs = namespaceAndLocal(pathIri);
        newIri = uniqueShapeIri(pathNs.ns + pathNs.local + 'PropertyShape', propShapesData);
      }

      createBtn.disabled = true; createBtn.textContent = 'Creating…';
      // As with the New Node Shape form's new-class path: when minting a
      // new property, its own creation (into ONTOLOGY_GRAPH) is pushed and
      // cache-invalidated FIRST, then loadAllProperties(true) refreshes the
      // memoized property list so it shows up immediately if this form (or
      // another instance of it) is opened again this session.
      var chain = Promise.resolve();
      if (creatingNewProp){
        var propLabel = newPropLabelInput.value.trim() || newPropLocal;
        var propTurtle = buildCreatePropertyTurtle(pathIri, propLabel);
        chain = chain
          .then(function(){ return callTool(SERVER, 'push_turtle', {turtle: propTurtle, graph_iri: ONTOLOGY_GRAPH, mode: 'merge'}); })
          .then(function(){ return mcp.invalidate(SERVER, 'sparql_select').catch(function(){}); })
          .then(function(){ allPropertiesPromise = null; return loadAllProperties(); });
      }
      chain
        .then(function(){
          return callTool(SERVER, 'push_turtle', {turtle: buildCreatePropertyShapeTurtle(newIri, pathIri, name), graph_iri: SHACL_GRAPH, mode: 'merge'})
            .then(function(){ return mcp.invalidate(SERVER, 'sparql_select').catch(function(){}); })
            .then(function(){ return loadPropShapesData(true); })
            .then(function(){ renderPropertyShapesTab(); selectPropertyShape(newIri); });
        })
        .catch(function(err){
          createBtn.disabled = false; createBtn.textContent = 'Create Property Shape';
          renderBanner(errorBox, err);
        });
    });
    actionsRow.appendChild(createBtn);
    actionsRow.appendChild(cancelBtn);
    card.appendChild(actionsRow);
    return card;
  }

  function openNewPropertyShapeForm(){
    selectedPropShapeIri = null;
    renderPropertyShapesTab();
    $detail.innerHTML = '';
    var inner = document.createElement('div');
    inner.className = 'detail-inner';
    var h2 = document.createElement('h2');
    h2.className = 'title';
    h2.textContent = 'New Property Shape';
    inner.appendChild(h2);
    inner.appendChild(buildNewPropertyShapeForm());
    $detail.appendChild(inner);
  }
  function closeNewPropertyShapeForm(){
    renderPropertyShapesTab();
    if (selectedPropShapeIri) selectPropertyShape(selectedPropShapeIri);
    else renderIdleDetail('Nothing selected');
  }

  // ======================================================================
  // Classes / Properties tabs -- browse the raw ontology vocabulary itself
  // (owl:Class / rdf:Property and friends), independent of the SHACL layer
  // built on top of it in Node Shapes / Property Shapes above. Most classes
  // and predicates in THIS dataset carry no explicit `a owl:Class` / `a
  // rdf:Property` triple at all -- they're only known from usage (a
  // holon's rdf:type, or a property shape's sh:path; see the comment on
  // buildCreateClassTurtle above) -- so both loaders merge ontology-graph
  // declarations with usage-derived vocabulary, exactly the way By Type's
  // computeAllTypes() already does for the holon list. Same rail/detail
  // shape as every other flat-list tab here (Taxonomies, Node Shapes,
  // Property Shapes, Namespaces): a loaded-once-per-dataset flag, the
  // currently selected IRI, and a separate "edit form open for" flag.
  // Deprecation reuses the SAME holon:status/holon:DeprecatedStatus
  // mechanism as Taxonomies/Namespaces (deprecatedSet/loadDeprecatedSet/
  // buildSetStatusSparql/buildClearStatusSparql) rather than SHACL's
  // sh:deactivated -- classes and properties aren't SHACL resources.
  // ======================================================================

  var CLASSES_LIST_QUERY = [
    "PREFIX owl: <http://www.w3.org/2002/07/owl#>",
    "PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>",
    "SELECT DISTINCT ?c ?label ?comment WHERE {",
    "  { ?c a owl:Class } UNION { ?c a rdfs:Class } UNION { ?c rdfs:subClassOf ?x1 } UNION { ?x2 rdfs:subClassOf ?c }",
    "  FILTER(isIRI(?c))",
    "  OPTIONAL { ?c rdfs:label ?label }",
    "  OPTIONAL { ?c rdfs:comment ?comment }",
    "}"
  ].join("\n");

  var PROPERTIES_LIST_QUERY = [
    "PREFIX owl: <http://www.w3.org/2002/07/owl#>",
    "PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>",
    "PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>",
    "SELECT ?p ?label ?comment",
    "  (GROUP_CONCAT(DISTINCT STR(?domain); separator=\"|\") AS ?domains)",
    "  (GROUP_CONCAT(DISTINCT STR(?range); separator=\"|\") AS ?ranges) WHERE {",
    "  { ?p a owl:ObjectProperty } UNION { ?p a owl:DatatypeProperty } UNION { ?p a owl:AnnotationProperty } UNION { ?p a rdf:Property }",
    "  FILTER(isIRI(?p))",
    "  OPTIONAL { ?p rdfs:label ?label }",
    "  OPTIONAL { ?p rdfs:comment ?comment }",
    "  OPTIONAL { ?p rdfs:domain ?domain }",
    "  OPTIONAL { ?p rdfs:range ?range }",
    "} GROUP BY ?p ?label ?comment"
  ].join("\n");

  // Instance counts per class, queried directly against HOLONS_GRAPH rather
  // than derived from the client-side `holons` array. `holons` is filled
  // asynchronously by loadList()'s live watchTool subscription (see
  // LIST_QUERY/loadList below) and loadClassesData() can run before that
  // first delivery lands -- e.g. the admin switches straight to the Classes
  // tab right after a dataset loads -- which would otherwise bake in a
  // permanent "0 instances" for every class the moment classesLoaded flips
  // true, since nothing re-triggers loadClassesData() afterward. A direct
  // COUNT query sidesteps that race (and stays correct even if the List
  // view is never opened at all this session).
  var CLASS_INSTANCE_COUNTS_QUERY = [
    "SELECT ?type (COUNT(DISTINCT ?holon) AS ?cnt) WHERE {",
    "  ?holon a ?type .",
    "  FILTER(isIRI(?type))",
    "} GROUP BY ?type"
  ].join("\n");

  // Same idea as CLASS_INSTANCE_COUNTS_QUERY, for properties: how many
  // triples in HOLONS_GRAPH actually use this predicate, independent of
  // whether any property shape references it. Feeds the Delete button's
  // "N triples will also be removed" gate/warning in renderPropertyDetail
  // below -- shape usage (p.shapes) is a schema-level concern shown
  // separately and doesn't affect whether a delete is "safe".
  var PROPERTY_USAGE_COUNTS_QUERY = [
    "SELECT ?p (COUNT(*) AS ?cnt) WHERE {",
    "  ?s ?p ?o .",
    "  FILTER(isIRI(?p))",
    "} GROUP BY ?p"
  ].join("\n");

  function classDisplayLabel(c){ return c.label || humanize(c.iri); }
  function propertyDisplayLabel(p){ return p.label || humanize(p.iri); }

  // Direct children of `iri` in the class hierarchy -- the reverse of
  // directSuper, computed on demand against whatever's currently in
  // classesData rather than a maintained index (this dataset's class
  // count is small enough that a linear scan per detail render is cheap).
  function subclassesOf(iri){
    return classesData.filter(function(c){ return (directSuper[c.iri] || []).indexOf(iri) !== -1; }).map(function(c){ return c.iri; });
  }

  // Writes rdfs:label/rdfs:comment on any ontology-graph resource -- shared
  // by the Classes and Properties edit forms below. Either argument may be
  // '' to clear that field entirely (delete-only, no re-insert), matching
  // buildSetStatusSparql/buildClearStatusSparql's own clear-vs-set split.
  function buildSetLabelCommentSparql(iri, label, comment){
    return [
      "PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>",
      "DELETE { GRAPH <" + ONTOLOGY_GRAPH + "> { <" + iri + "> rdfs:label ?l } }",
      (label ? "INSERT { GRAPH <" + ONTOLOGY_GRAPH + "> { <" + iri + "> rdfs:label " + langLiteral(label) + " } }" : ""),
      "WHERE { OPTIONAL { GRAPH <" + ONTOLOGY_GRAPH + "> { <" + iri + "> rdfs:label ?l } } } ;",
      "DELETE { GRAPH <" + ONTOLOGY_GRAPH + "> { <" + iri + "> rdfs:comment ?c } }",
      (comment ? "INSERT { GRAPH <" + ONTOLOGY_GRAPH + "> { <" + iri + "> rdfs:comment " + langLiteral(comment) + " } }" : ""),
      "WHERE { OPTIONAL { GRAPH <" + ONTOLOGY_GRAPH + "> { <" + iri + "> rdfs:comment ?c } } }"
    ].filter(Boolean).join("\n");
  }

  // A genuine, irreversible DELETE -- like buildDeletePropertyShapeSparql's
  // escape hatch above, but for a class. A class only "exists" in this tool
  // as something declared or instantiated (see the section comment on
  // CLASSES_LIST_QUERY/PROPERTIES_LIST_QUERY), so deleting one that still
  // has instances can't just remove its ontology-graph metadata and call it
  // done -- every holon still typed with it would be left behind, correctly
  // shown elsewhere as "of this type" while that type no longer means
  // anything. So when instanceCount > 0, this cascades: every triple that
  // points AT one of those holons is removed first (while `?holon a
  // <classIri>` still holds, since that's how they're found), then every
  // triple where one of those holons is itself the subject (which is what
  // actually deletes them, holon:isPartOf/type/everything else included),
  // and only then the class's own ontology-graph declaration. Order is load-
  // bearing: SPARQL Update runs each semicolon-separated operation against
  // whatever the graph looks like after the one before it, not a frozen
  // snapshot, so reversing steps 1 and 2 would mean the second DELETE's
  // WHERE no longer finds `?holon a <classIri>` to match against (the first
  // one already removed it). Callers must only reach this after the "N
  // instances will also be deleted, permanently" warning has been shown and
  // armed -- see renderClassDetail's Delete button below.
  function buildDeleteClassSparql(classIri){
    var parts = [
      [
        "DELETE { GRAPH <" + HOLONS_GRAPH + "> { ?referrer ?refPred ?holon } }",
        "WHERE { GRAPH <" + HOLONS_GRAPH + "> { ?holon a <" + classIri + "> . ?referrer ?refPred ?holon } }"
      ].join("\n"),
      [
        "DELETE { GRAPH <" + HOLONS_GRAPH + "> { ?holon ?p ?o } }",
        "WHERE { GRAPH <" + HOLONS_GRAPH + "> { ?holon a <" + classIri + "> ; ?p ?o } }"
      ].join("\n"),
      "DELETE WHERE { GRAPH <" + ONTOLOGY_GRAPH + "> { <" + classIri + "> ?anyP ?anyO } }"
    ];
    return parts.join(";\n");
  }

  // The property equivalent -- but unlike a class, a property isn't what
  // makes a holon "an instance" of anything, so deleting one never cascades
  // into deleting holons themselves. When usageCount > 0 this only strips
  // that predicate's triples wherever they're asserted, leaving the holons
  // that carried them (now just missing that one value) otherwise intact,
  // plus the property's own ontology-graph declaration (rdfs:label/comment/
  // domain/range/type, whatever this editor or anything else wrote about
  // it). Property shapes that reference it via sh:path are left alone --
  // shape usage is a separate, already-visible concern (see "Property
  // Shapes using this path" in renderPropertyDetail) and this tool never
  // deletes SHACL shapes as a side effect of an ontology-graph edit.
  function buildDeletePropertySparql(propIri){
    var parts = [
      "DELETE WHERE { GRAPH <" + HOLONS_GRAPH + "> { ?s <" + propIri + "> ?o } }",
      "DELETE WHERE { GRAPH <" + ONTOLOGY_GRAPH + "> { <" + propIri + "> ?anyP ?anyO } }"
    ];
    return parts.join(";\n");
  }

  // Shared label+comment edit form -- used by both the Classes and
  // Properties detail panes. onSave(label, comment) returns a Promise.
  function buildLabelCommentEditForm(currentLabel, currentComment, onSave, onCancel){
    var card = document.createElement('div');
    card.className = 'addchild-form';
    var labelField = document.createElement('div');
    labelField.className = 'field';
    var labelLabel = document.createElement('label');
    labelLabel.textContent = 'Label';
    labelField.appendChild(labelLabel);
    var labelInput = document.createElement('input');
    labelInput.type = 'text';
    labelInput.value = currentLabel || '';
    labelField.appendChild(labelInput);
    card.appendChild(labelField);

    var commentField = document.createElement('div');
    commentField.className = 'field';
    var commentLabel = document.createElement('label');
    commentLabel.textContent = 'Comment';
    commentField.appendChild(commentLabel);
    var commentArea = document.createElement('textarea');
    commentArea.value = currentComment || '';
    commentField.appendChild(commentArea);
    card.appendChild(commentField);

    var errorBox = document.createElement('div');
    card.appendChild(errorBox);

    var actionsRow = document.createElement('div');
    actionsRow.className = 'form-actions';
    var saveBtn = document.createElement('button');
    saveBtn.type = 'button'; saveBtn.className = 'btn primary'; saveBtn.textContent = 'Save';
    var cancelBtn = document.createElement('button');
    cancelBtn.type = 'button'; cancelBtn.className = 'btn'; cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', onCancel);
    saveBtn.addEventListener('click', function(){
      errorBox.innerHTML = '';
      saveBtn.disabled = true; cancelBtn.disabled = true; saveBtn.textContent = 'Saving…';
      onSave(labelInput.value.trim(), commentArea.value.trim()).catch(function(err){
        saveBtn.disabled = false; cancelBtn.disabled = false; saveBtn.textContent = 'Save';
        renderBanner(errorBox, err);
      });
    });
    actionsRow.appendChild(saveBtn);
    actionsRow.appendChild(cancelBtn);
    card.appendChild(actionsRow);
    return card;
  }

  // Reusable "chips linking elsewhere" section builder -- superclasses/
  // subclasses on a Class, domain/range on a Property, all just a list of
  // other IRIs with a jump handler.
  function buildDetailChipList(inner, label, iris, onClick){
    var secLabel = document.createElement('div');
    secLabel.className = 'section-label';
    secLabel.style.marginTop = '10px';
    secLabel.textContent = label + ' (' + iris.length + ')';
    inner.appendChild(secLabel);
    var wrap = document.createElement('div');
    wrap.style.cssText = 'display:flex; gap:6px; flex-wrap:wrap; margin:0 0 12px;';
    iris.forEach(function(iri){
      var chip = document.createElement('button');
      chip.type = 'button'; chip.className = 'chip';
      chip.innerHTML = '<span>' + humanize(iri) + '</span><span class="arrow">&#8594;</span>';
      chip.addEventListener('click', function(){ onClick(iri); });
      wrap.appendChild(chip);
    });
    inner.appendChild(wrap);
  }

  function loadClassesData(){
    return Promise.all([
      callTool(SERVER, 'sparql_select', {query: CLASSES_LIST_QUERY, graph: ONTOLOGY_GRAPH})
        .then(function(res){ return (res.payload && res.payload.results && res.payload.results.bindings) || []; }),
      loadNodeShapesData(),
      callTool(SERVER, 'sparql_select', {query: CLASS_INSTANCE_COUNTS_QUERY, graph: HOLONS_GRAPH})
        .then(function(res){ return (res.payload && res.payload.results && res.payload.results.bindings) || []; })
        .catch(function(){ return []; })
    ]).then(function(results){
      var bindings = results[0];
      var byIri = {};
      bindings.forEach(function(b){
        byIri[b.c.value] = {iri: b.c.value, label: b.label ? b.label.value : null, comment: b.comment ? b.comment.value : ''};
      });
      // Merge in every class discovered purely from usage -- see the
      // section comment above.
      computeAllTypes().forEach(function(t){
        if (!byIri[t]) byIri[t] = {iri: t, label: null, comment: ''};
      });
      var instanceCounts = {};
      results[2].forEach(function(b){ instanceCounts[b.type.value] = b.cnt ? parseInt(b.cnt.value, 10) || 0 : 0; });
      var shapesByClass = {};
      nodeShapesData.forEach(function(s){
        if (!s.targetClass) return;
        (shapesByClass[s.targetClass] = shapesByClass[s.targetClass] || []).push(s);
      });
      classesData = Object.keys(byIri).map(function(iri){
        var d = byIri[iri];
        return {
          iri: iri,
          label: d.label,
          comment: d.comment,
          superClasses: directSuper[iri] || [],
          instanceCount: instanceCounts[iri] || 0,
          shapes: shapesByClass[iri] || []
        };
      }).sort(function(a, b){ return classDisplayLabel(a).localeCompare(classDisplayLabel(b)); });
      classesLoaded = true;
      return classesData;
    });
  }

  function loadClassesTab(force){
    if (!mcp){
      $classes.innerHTML = '<div class="list-empty">No connector available.</div>';
      return Promise.resolve([]);
    }
    if (force || !classesLoaded){
      $classes.innerHTML = '';
      var loading = document.createElement('div');
      loading.className = 'list-empty';
      loading.textContent = 'Loading classes…';
      $classes.appendChild(loading);
    }
    return Promise.all([loadClassesData(), loadDeprecatedSet(force)])
      .then(function(){
        renderClassesTab();
        if (selectedClassIri) selectClass(selectedClassIri, true);
      })
      .catch(function(err){
        $classes.innerHTML = '';
        renderBanner($classes, err, function(){ loadClassesTab(true); });
      });
  }

  function loadPropertiesData(force){
    return Promise.all([
      callTool(SERVER, 'sparql_select', {query: PROPERTIES_LIST_QUERY, graph: ONTOLOGY_GRAPH})
        .then(function(res){ return (res.payload && res.payload.results && res.payload.results.bindings) || []; }),
      loadPropShapesData(force),
      callTool(SERVER, 'sparql_select', {query: PROPERTY_USAGE_COUNTS_QUERY, graph: HOLONS_GRAPH})
        .then(function(res){ return (res.payload && res.payload.results && res.payload.results.bindings) || []; })
        .catch(function(){ return []; })
    ]).then(function(results){
      var bindings = results[0];
      var byIri = {};
      bindings.forEach(function(b){
        byIri[b.p.value] = {
          iri: b.p.value,
          label: b.label ? b.label.value : null,
          comment: b.comment ? b.comment.value : '',
          domains: (b.domains && b.domains.value) ? b.domains.value.split('|').filter(Boolean) : [],
          ranges: (b.ranges && b.ranges.value) ? b.ranges.value.split('|').filter(Boolean) : []
        };
      });
      // Merge in every predicate discovered purely from SHACL usage
      // (sh:path) -- most properties in this dataset carry no explicit
      // rdf:Property/owl:...Property triple either, same gap as classes.
      var shapesByPath = {};
      propShapesData.forEach(function(ps){
        if (!ps.path) return;
        if (!byIri[ps.path]) byIri[ps.path] = {iri: ps.path, label: null, comment: '', domains: [], ranges: []};
        (shapesByPath[ps.path] = shapesByPath[ps.path] || []).push(ps);
      });
      var usageCounts = {};
      results[2].forEach(function(b){ usageCounts[b.p.value] = b.cnt ? parseInt(b.cnt.value, 10) || 0 : 0; });
      propertiesData = Object.keys(byIri).map(function(iri){
        var d = byIri[iri];
        return {
          iri: iri,
          label: d.label,
          comment: d.comment,
          domains: d.domains,
          ranges: d.ranges,
          shapes: shapesByPath[iri] || [],
          usageCount: usageCounts[iri] || 0
        };
      }).sort(function(a, b){ return propertyDisplayLabel(a).localeCompare(propertyDisplayLabel(b)); });
      propertiesLoaded = true;
      return propertiesData;
    });
  }

  function loadPropertiesTab(force){
    if (!mcp){
      $properties.innerHTML = '<div class="list-empty">No connector available.</div>';
      return Promise.resolve([]);
    }
    if (force || !propertiesLoaded){
      $properties.innerHTML = '';
      var loading = document.createElement('div');
      loading.className = 'list-empty';
      loading.textContent = 'Loading properties…';
      $properties.appendChild(loading);
    }
    return Promise.all([loadPropertiesData(force), loadDeprecatedSet(force)])
      .then(function(){
        renderPropertiesTab();
        if (selectedPropertyIri) selectProperty(selectedPropertyIri, true);
      })
      .catch(function(err){
        $properties.innerHTML = '';
        renderBanner($properties, err, function(){ loadPropertiesTab(true); });
      });
  }

  // ---- Classes: rail + detail --------------------------------------------

  function buildClassRow(c){
    var isDeprecated = !!deprecatedSet[c.iri];
    var row = document.createElement('button');
    row.className = 'row' + (c.iri === selectedClassIri ? ' active' : '');
    row.type = 'button';
    if (isDeprecated) row.style.opacity = '0.55';
    var lbl = document.createElement('span');
    lbl.className = 'row-label';
    lbl.textContent = classDisplayLabel(c) + (isDeprecated ? ' (deprecated)' : '');
    row.appendChild(lbl);
    var tp = document.createElement('span');
    tp.className = 'row-type';
    tp.textContent = c.instanceCount + (c.instanceCount === 1 ? ' instance' : ' instances');
    row.appendChild(tp);
    row.addEventListener('click', function(){ selectClass(c.iri); });
    return row;
  }

  function renderClassesTab(){
    $classes.innerHTML = '';
    var addBtn = document.createElement('button');
    addBtn.type = 'button'; addBtn.className = 'btn'; addBtn.textContent = '+ New Class';
    addBtn.style.cssText = 'margin:8px 8px 10px; font-size:11.5px; padding:5px 10px;';
    addBtn.addEventListener('click', openNewClassForm);
    $classes.appendChild(addBtn);
    $classes.appendChild(buildShowDeprecatedToggle('classes', 'Show deprecated', renderClassesTab));

    if (!classesData.length){
      var empty = document.createElement('div');
      empty.className = 'list-empty';
      empty.textContent = 'No classes found in this dataset yet.';
      $classes.appendChild(empty);
      return;
    }
    var visibleClasses = filterByDeprecatedSet(classesData, 'classes');
    if (!visibleClasses.length){
      var allHiddenCl = document.createElement('div');
      allHiddenCl.className = 'list-empty';
      allHiddenCl.textContent = 'Every class is deprecated -- tick "Show deprecated" above to see them.';
      $classes.appendChild(allHiddenCl);
      return;
    }
    visibleClasses.forEach(function(c){ $classes.appendChild(buildClassRow(c)); });
  }

  function jumpToClass(iri){
    currentView = 'classes';
    $viewSelect.value = 'classes';
    $list.hidden = true; $byType.hidden = true; $tree.hidden = true; $taxonomies.hidden = true;
    $nodeShapes.hidden = true; $propShapes.hidden = true; $properties.hidden = true; $namespaces.hidden = true;
    $classes.hidden = false;
    $searchWrap.hidden = true;
    if (!classesLoaded) loadClassesTab().then(function(){ selectClass(iri); });
    else selectClass(iri);
  }

  // Cross-navigation from a rail-only view (Classes) to a specific holon --
  // same "switch view, then select" pattern as jumpToClass/jumpToNodeShape/
  // jumpToPropertyShape above, just landing on the List view instead of
  // another rail-only tab. loadList() already runs unconditionally at
  // dataset-entry time, so holons is always populated by the time this can
  // be called from a class's Instances section.
  function jumpToHolon(iri){
    currentView = 'list';
    $viewSelect.value = 'list';
    $list.hidden = false; $byType.hidden = true; $tree.hidden = true; $taxonomies.hidden = true;
    $nodeShapes.hidden = true; $propShapes.hidden = true; $classes.hidden = true; $properties.hidden = true; $namespaces.hidden = true;
    $searchWrap.hidden = false;
    renderList();
    selectHolon(iri);
  }

  function selectClass(classIri, skipRerenderRail){
    selectedClassIri = classIri;
    if (!skipRerenderRail) renderClassesTab();
    renderDetailSkeleton();
    renderClassDetail(classIri);
  }

  function renderClassDetail(classIri){
    var c = classesData.find(function(x){ return x.iri === classIri; }) ||
      {iri: classIri, label: null, comment: '', superClasses: [], instanceCount: 0, shapes: []};
    var isDeprecated = !!deprecatedSet[classIri];
    var isEditing = classEditOpenFor === classIri;
    var inner = document.createElement('div');
    inner.className = 'detail-inner';

    var badges = document.createElement('div');
    badges.className = 'badges';
    var p = document.createElement('span');
    p.className = 'pill type';
    p.textContent = 'Class';
    badges.appendChild(p);
    if (isDeprecated){
      var dp = document.createElement('span');
      dp.className = 'pill status';
      dp.textContent = 'Deprecated';
      badges.appendChild(dp);
    }
    inner.appendChild(badges);

    if (!isEditing){
      var h2 = document.createElement('h2');
      h2.className = 'title';
      h2.textContent = classDisplayLabel(c);
      inner.appendChild(h2);
    }

    var iriLine = document.createElement('div');
    iriLine.className = 'iri';
    iriLine.textContent = classIri;
    inner.appendChild(iriLine);

    var actions = document.createElement('div');
    actions.className = 'actions';
    var editBtn = document.createElement('button');
    editBtn.type = 'button'; editBtn.className = 'btn';
    editBtn.textContent = isEditing ? 'Cancel Edit' : 'Edit';
    editBtn.addEventListener('click', function(){
      classEditOpenFor = isEditing ? null : classIri;
      selectClass(classIri, true);
    });
    actions.appendChild(editBtn);
    var toggleBtn = document.createElement('button');
    toggleBtn.type = 'button'; toggleBtn.className = 'btn';
    toggleBtn.textContent = isDeprecated ? 'Reactivate' : 'Deprecate';
    toggleBtn.addEventListener('click', function(){
      toggleBtn.disabled = true;
      var op = isDeprecated ? callTool(SERVER, 'sparql_update', {update: buildClearStatusSparql(classIri)})
                             : callTool(SERVER, 'sparql_update', {update: buildSetStatusSparql(classIri, DEPRECATED_STATUS_IRI)});
      op.then(function(){ return mcp.invalidate(SERVER, 'sparql_select').catch(function(){}); })
        .then(function(){ return loadDeprecatedSet(true); })
        .then(function(){ selectClass(classIri, true); renderClassesTab(); })
        .catch(function(err){ toggleBtn.disabled = false; renderBanner(inner, err); });
    });
    actions.appendChild(toggleBtn);

    // Delete: always offered, but what a click does depends entirely on
    // whether anything is actually typed with this class. With zero
    // instances it's a plain two-click confirm, same as Property Shapes'
    // Delete above. With instances, arming it also reveals deleteWarn below
    // -- the "connected content will be deleted too, and this can't be
    // undone" warning -- so the admin sees exactly what they're about to
    // lose before the second click commits to it.
    var deleteBtn = document.createElement('button');
    deleteBtn.type = 'button'; deleteBtn.className = 'btn'; deleteBtn.textContent = 'Delete';
    deleteBtn.style.cssText = 'border-color:var(--bad); color:var(--bad);';
    var deleteWarn = document.createElement('p');
    deleteWarn.className = 'warn';
    deleteWarn.hidden = true;
    deleteWarn.textContent = 'This class has ' + c.instanceCount + ' holon instance' + (c.instanceCount === 1 ? '' : 's') + '. Deleting it also permanently deletes ' +
      (c.instanceCount === 1 ? 'that instance' : 'all of them') + ' -- and every triple elsewhere that refers to ' + (c.instanceCount === 1 ? 'it' : 'them') + ' -- and this cannot be undone.';
    deleteBtn.addEventListener('click', function(){
      if (deleteBtn.getAttribute('data-armed') !== '1'){
        deleteBtn.setAttribute('data-armed', '1');
        deleteBtn.textContent = c.instanceCount
          ? 'Confirm Delete (also deletes ' + c.instanceCount + (c.instanceCount === 1 ? ' instance' : ' instances') + ')'
          : 'Confirm Delete?';
        deleteBtn.style.cssText = 'background:var(--bad); border-color:var(--bad); color:#fff;';
        if (c.instanceCount) deleteWarn.hidden = false;
        return;
      }
      deleteBtn.disabled = true; editBtn.disabled = true; toggleBtn.disabled = true;
      deleteBtn.textContent = 'Deleting…';
      callTool(SERVER, 'sparql_update', {update: buildDeleteClassSparql(classIri)})
        .then(function(){ return mcp.invalidate(SERVER, 'sparql_select').catch(function(){}); })
        .then(function(){ selectedClassIri = null; return Promise.all([loadClassHierarchy(), loadClassesData()]); })
        .then(function(){
          renderClassesTab();
          renderIdleDetail('Class deleted');
          // The class's instances (if any) are gone from HOLONS_GRAPH too --
          // refresh every holon-facing view so nothing stale lingers.
          loadList();
          if (currentView === 'tree'){ treeLoaded = false; treeNodes = {}; }
        })
        .catch(function(err){
          deleteBtn.disabled = false; editBtn.disabled = false; toggleBtn.disabled = false;
          deleteBtn.removeAttribute('data-armed');
          deleteBtn.textContent = 'Delete';
          deleteBtn.style.cssText = 'border-color:var(--bad); color:var(--bad);';
          renderBanner(inner, err);
        });
    });
    actions.appendChild(deleteBtn);
    inner.appendChild(actions);
    inner.appendChild(deleteWarn);

    if (isEditing){
      inner.appendChild(buildLabelCommentEditForm(c.label, c.comment, function(newLabel, newComment){
        return callTool(SERVER, 'sparql_update', {update: buildSetLabelCommentSparql(classIri, newLabel, newComment)})
          .then(function(){ return mcp.invalidate(SERVER, 'sparql_select').catch(function(){}); })
          .then(function(){ return loadClassesData(); })
          .then(function(){ classEditOpenFor = null; selectClass(classIri, true); renderClassesTab(); });
      }, function(){ classEditOpenFor = null; selectClass(classIri, true); }));
    } else if (c.comment){
      var desc = document.createElement('div');
      desc.className = 'description';
      desc.textContent = c.comment;
      inner.appendChild(desc);
    }

    if (c.superClasses.length) buildDetailChipList(inner, 'Superclasses', c.superClasses, jumpToClass);
    var subs = subclassesOf(classIri);
    if (subs.length) buildDetailChipList(inner, 'Subclasses', subs, jumpToClass);

    var shapeSecLabel = document.createElement('div');
    shapeSecLabel.className = 'section-label';
    shapeSecLabel.style.marginTop = '10px';
    shapeSecLabel.textContent = 'Node Shapes targeting this class (' + c.shapes.length + ')';
    inner.appendChild(shapeSecLabel);
    if (c.shapes.length){
      var kv = document.createElement('div');
      kv.className = 'kv';
      c.shapes.forEach(function(s){
        var row = document.createElement('div');
        row.className = 'kv-row';
        var val = document.createElement('div');
        val.className = 'kv-val';
        var chip = document.createElement('button');
        chip.type = 'button'; chip.className = 'chip';
        chip.innerHTML = '<span>' + nodeShapeLabel(s) + '</span><span class="arrow">&#8594;</span>';
        chip.addEventListener('click', function(){ jumpToNodeShape(s.iri); });
        val.appendChild(chip);
        row.appendChild(val);
        kv.appendChild(row);
      });
      inner.appendChild(kv);
    } else {
      var noShapes = document.createElement('p');
      noShapes.className = 'hint';
      noShapes.textContent = 'No node shape targets this class yet.';
      inner.appendChild(noShapes);
    }

    var instLine = document.createElement('p');
    instLine.className = 'hint';
    instLine.style.margin = '10px 0 0';
    instLine.textContent = c.instanceCount + (c.instanceCount === 1 ? ' holon instance' : ' holon instances') + ' currently in this dataset.';
    inner.appendChild(instLine);

    // Instances section: up to 25 instances shown as reference chips, with
    // a search box (filtering the already-fetched full list client-side) to
    // find any of the rest. Reuses loadClassInstances/classInstanceData --
    // the same cache the Add Connection picker already populates -- rather
    // than issuing a second, redundant SPARQL query for the same data.
    var instSecLabel = document.createElement('div');
    instSecLabel.className = 'section-label';
    instSecLabel.style.marginTop = '10px';
    instSecLabel.textContent = 'Instances';
    inner.appendChild(instSecLabel);

    var instBody = document.createElement('div');
    inner.appendChild(instBody);

    function paintInstances(list){
      instBody.innerHTML = '';
      if (!list.length){
        var none = document.createElement('p');
        none.className = 'hint';
        none.textContent = 'No holon instances of this class yet.';
        instBody.appendChild(none);
        return;
      }

      var searchField = document.createElement('div');
      searchField.className = 'field';
      searchField.style.margin = '0 0 8px';
      var searchInput = document.createElement('input');
      searchInput.type = 'text';
      searchInput.placeholder = 'Search all ' + list.length + ' instance' + (list.length === 1 ? '' : 's') + '…';
      searchField.appendChild(searchInput);
      instBody.appendChild(searchField);

      var chipsWrap = document.createElement('div');
      chipsWrap.style.cssText = 'display:flex; gap:6px; flex-wrap:wrap; margin:0 0 6px;';
      instBody.appendChild(chipsWrap);

      var countLine = document.createElement('p');
      countLine.className = 'hint';
      instBody.appendChild(countLine);

      // Only chipsWrap/countLine are rebuilt on each keystroke -- searchInput
      // itself is created once above, so it never loses focus while typing.
      function renderMatches(){
        var q = searchInput.value.trim().toLowerCase();
        var filtered = q
          ? list.filter(function(it){ return it.label.toLowerCase().indexOf(q) !== -1 || it.iri.toLowerCase().indexOf(q) !== -1; })
          : list;
        var shown = filtered.slice(0, 25);
        chipsWrap.innerHTML = '';
        shown.forEach(function(it){
          var chip = document.createElement('button');
          chip.type = 'button'; chip.className = 'chip';
          chip.innerHTML = '<span>' + it.label + '</span><span class="arrow">&#8594;</span>';
          chip.title = it.iri;
          chip.addEventListener('click', function(){ jumpToHolon(it.iri); });
          chipsWrap.appendChild(chip);
        });
        if (!shown.length){
          countLine.textContent = 'No instances match "' + searchInput.value.trim() + '".';
        } else if (filtered.length > shown.length){
          countLine.textContent = 'Showing ' + shown.length + ' of ' + filtered.length + ' matching instance' +
            (filtered.length === 1 ? '' : 's') + ' -- refine your search to narrow further.';
        } else if (q){
          countLine.textContent = filtered.length + ' matching instance' + (filtered.length === 1 ? '' : 's') + ' of ' + list.length + ' total.';
        } else {
          countLine.textContent = 'All ' + list.length + ' instance' + (list.length === 1 ? '' : 's') + ' shown.';
        }
      }

      searchInput.addEventListener('input', renderMatches);
      renderMatches();
    }

    if (classInstanceData[classIri]){
      paintInstances(classInstanceData[classIri]);
    } else {
      var instLoading = document.createElement('p');
      instLoading.className = 'hint';
      instLoading.textContent = 'Loading instances…';
      instBody.appendChild(instLoading);
      loadClassInstances(classIri).then(function(list){
        // Guard against a stale response landing after the user has since
        // selected a different class (or navigated away entirely).
        if (selectedClassIri === classIri) paintInstances(list);
      });
    }

    $detail.innerHTML = '';
    $detail.appendChild(inner);
  }

  function openNewClassForm(){
    selectedClassIri = null;
    renderClassesTab();
    $detail.innerHTML = '';
    var inner = document.createElement('div');
    inner.className = 'detail-inner';
    var h2 = document.createElement('h2');
    h2.className = 'title';
    h2.textContent = 'New Class';
    inner.appendChild(h2);
    inner.appendChild(buildNewClassForm());
    $detail.appendChild(inner);
  }
  function closeNewClassForm(){
    renderClassesTab();
    if (selectedClassIri) selectClass(selectedClassIri);
    else renderIdleDetail('Nothing selected');
  }

  function buildNewClassForm(){
    var card = document.createElement('div');
    card.className = 'addchild-form';
    var picker = buildNamespaceLocalPicker();
    card.appendChild(picker.wrap);

    var labelField = document.createElement('div');
    labelField.className = 'field';
    var labelLabel = document.createElement('label');
    labelLabel.textContent = 'Label (optional)';
    labelField.appendChild(labelLabel);
    var labelInput = document.createElement('input');
    labelInput.type = 'text';
    labelInput.placeholder = 'Defaults to the local name';
    labelField.appendChild(labelInput);
    card.appendChild(labelField);

    var commentField = document.createElement('div');
    commentField.className = 'field';
    var commentLabel = document.createElement('label');
    commentLabel.textContent = 'Comment (optional)';
    commentField.appendChild(commentLabel);
    var commentArea = document.createElement('textarea');
    commentField.appendChild(commentArea);
    card.appendChild(commentField);

    var parentField = document.createElement('div');
    parentField.className = 'field';
    var parentLabel = document.createElement('label');
    parentLabel.textContent = 'Parent class (optional, rdfs:subClassOf)';
    parentField.appendChild(parentLabel);
    var parentSelect = document.createElement('select');
    var parentBlank = document.createElement('option');
    parentBlank.value = ''; parentBlank.textContent = '— none —';
    parentSelect.appendChild(parentBlank);
    computeAllTypes().sort(function(a, b){ return humanize(a).localeCompare(humanize(b)); }).forEach(function(t){
      var opt = document.createElement('option');
      opt.value = t; opt.textContent = humanize(t);
      parentSelect.appendChild(opt);
    });
    parentField.appendChild(parentSelect);
    card.appendChild(parentField);

    var errorBox = document.createElement('div');
    card.appendChild(errorBox);

    var actionsRow = document.createElement('div');
    actionsRow.className = 'form-actions';
    var createBtn = document.createElement('button');
    createBtn.type = 'button'; createBtn.className = 'btn primary'; createBtn.textContent = 'Create Class';
    var cancelBtn = document.createElement('button');
    cancelBtn.type = 'button'; cancelBtn.className = 'btn'; cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', closeNewClassForm);
    createBtn.addEventListener('click', function(){
      errorBox.innerHTML = '';
      var nsUri = picker.getNamespaceUri();
      var local = picker.getLocal();
      if (!nsUri || !local){
        var warn = document.createElement('p');
        warn.className = 'warn';
        warn.textContent = 'Choose (or enter) a namespace and a local name.';
        errorBox.appendChild(warn);
        return;
      }
      var iri = nsUri + local;
      createBtn.disabled = true; createBtn.textContent = 'Creating…';
      var label = labelInput.value.trim() || local;
      var turtle = buildCreateClassTurtle(iri, label, parentSelect.value);
      callTool(SERVER, 'push_turtle', {turtle: turtle, graph_iri: ONTOLOGY_GRAPH, mode: 'merge'})
        .then(function(){ return mcp.invalidate(SERVER, 'sparql_select').catch(function(){}); })
        .then(function(){ return loadClassHierarchy(); })
        .then(function(){
          if (commentArea.value.trim()){
            return callTool(SERVER, 'sparql_update', {update: buildSetLabelCommentSparql(iri, label, commentArea.value.trim())})
              .then(function(){ return mcp.invalidate(SERVER, 'sparql_select').catch(function(){}); });
          }
        })
        .then(function(){ return loadClassesData(); })
        .then(function(){ renderClassesTab(); selectClass(iri); })
        .catch(function(err){
          createBtn.disabled = false; createBtn.textContent = 'Create Class';
          renderBanner(errorBox, err);
        });
    });
    actionsRow.appendChild(createBtn);
    actionsRow.appendChild(cancelBtn);
    card.appendChild(actionsRow);
    return card;
  }

  // ---- Properties: rail + detail ------------------------------------------

  function buildPropertyRow(p){
    var isDeprecated = !!deprecatedSet[p.iri];
    var row = document.createElement('button');
    row.className = 'row' + (p.iri === selectedPropertyIri ? ' active' : '');
    row.type = 'button';
    if (isDeprecated) row.style.opacity = '0.55';
    var lbl = document.createElement('span');
    lbl.className = 'row-label';
    lbl.textContent = propertyDisplayLabel(p) + (isDeprecated ? ' (deprecated)' : '');
    row.appendChild(lbl);
    var tp = document.createElement('span');
    tp.className = 'row-type';
    tp.textContent = p.shapes.length + (p.shapes.length === 1 ? ' shape' : ' shapes');
    row.appendChild(tp);
    row.addEventListener('click', function(){ selectProperty(p.iri); });
    return row;
  }

  function renderPropertiesTab(){
    $properties.innerHTML = '';
    var addBtn = document.createElement('button');
    addBtn.type = 'button'; addBtn.className = 'btn'; addBtn.textContent = '+ New Property';
    addBtn.style.cssText = 'margin:8px 8px 10px; font-size:11.5px; padding:5px 10px;';
    addBtn.addEventListener('click', openNewPropertyForm);
    $properties.appendChild(addBtn);
    $properties.appendChild(buildShowDeprecatedToggle('properties', 'Show deprecated', renderPropertiesTab));

    if (!propertiesData.length){
      var empty = document.createElement('div');
      empty.className = 'list-empty';
      empty.textContent = 'No properties found in this dataset yet.';
      $properties.appendChild(empty);
      return;
    }
    var visibleProperties = filterByDeprecatedSet(propertiesData, 'properties');
    if (!visibleProperties.length){
      var allHiddenPr = document.createElement('div');
      allHiddenPr.className = 'list-empty';
      allHiddenPr.textContent = 'Every property is deprecated -- tick "Show deprecated" above to see them.';
      $properties.appendChild(allHiddenPr);
      return;
    }
    visibleProperties.forEach(function(p){ $properties.appendChild(buildPropertyRow(p)); });
  }

  function jumpToProperty(iri){
    currentView = 'properties';
    $viewSelect.value = 'properties';
    $list.hidden = true; $byType.hidden = true; $tree.hidden = true; $taxonomies.hidden = true;
    $nodeShapes.hidden = true; $propShapes.hidden = true; $classes.hidden = true; $namespaces.hidden = true;
    $properties.hidden = false;
    $searchWrap.hidden = true;
    if (!propertiesLoaded) loadPropertiesTab().then(function(){ selectProperty(iri); });
    else selectProperty(iri);
  }

  function selectProperty(propIri, skipRerenderRail){
    selectedPropertyIri = propIri;
    if (!skipRerenderRail) renderPropertiesTab();
    renderDetailSkeleton();
    renderPropertyDetail(propIri);
  }

  function renderPropertyDetail(propIri){
    var p = propertiesData.find(function(x){ return x.iri === propIri; }) ||
      {iri: propIri, label: null, comment: '', domains: [], ranges: [], shapes: [], usageCount: 0};
    var isDeprecated = !!deprecatedSet[propIri];
    var isEditing = propertyEditOpenFor === propIri;
    var inner = document.createElement('div');
    inner.className = 'detail-inner';

    var badges = document.createElement('div');
    badges.className = 'badges';
    var pill = document.createElement('span');
    pill.className = 'pill type';
    pill.textContent = 'Property';
    badges.appendChild(pill);
    if (isDeprecated){
      var dp = document.createElement('span');
      dp.className = 'pill status';
      dp.textContent = 'Deprecated';
      badges.appendChild(dp);
    }
    inner.appendChild(badges);

    if (!isEditing){
      var h2 = document.createElement('h2');
      h2.className = 'title';
      h2.textContent = propertyDisplayLabel(p);
      inner.appendChild(h2);
    }

    var iriLine = document.createElement('div');
    iriLine.className = 'iri';
    iriLine.textContent = propIri;
    inner.appendChild(iriLine);

    var actions = document.createElement('div');
    actions.className = 'actions';
    var editBtn = document.createElement('button');
    editBtn.type = 'button'; editBtn.className = 'btn';
    editBtn.textContent = isEditing ? 'Cancel Edit' : 'Edit';
    editBtn.addEventListener('click', function(){
      propertyEditOpenFor = isEditing ? null : propIri;
      selectProperty(propIri, true);
    });
    actions.appendChild(editBtn);
    var toggleBtn = document.createElement('button');
    toggleBtn.type = 'button'; toggleBtn.className = 'btn';
    toggleBtn.textContent = isDeprecated ? 'Reactivate' : 'Deprecate';
    toggleBtn.addEventListener('click', function(){
      toggleBtn.disabled = true;
      var op = isDeprecated ? callTool(SERVER, 'sparql_update', {update: buildClearStatusSparql(propIri)})
                             : callTool(SERVER, 'sparql_update', {update: buildSetStatusSparql(propIri, DEPRECATED_STATUS_IRI)});
      op.then(function(){ return mcp.invalidate(SERVER, 'sparql_select').catch(function(){}); })
        .then(function(){ return loadDeprecatedSet(true); })
        .then(function(){ selectProperty(propIri, true); renderPropertiesTab(); })
        .catch(function(err){ toggleBtn.disabled = false; renderBanner(inner, err); });
    });
    actions.appendChild(toggleBtn);

    // Delete: unlike a class, deleting a property never removes any holon --
    // it only strips this predicate's triples wherever it's used (if it's
    // used at all) plus the property's own ontology-graph declaration. Same
    // two-click arm pattern as Classes' Delete above, with the warning
    // reflecting what actually happens here (values removed, not holons).
    var deleteBtn = document.createElement('button');
    deleteBtn.type = 'button'; deleteBtn.className = 'btn'; deleteBtn.textContent = 'Delete';
    deleteBtn.style.cssText = 'border-color:var(--bad); color:var(--bad);';
    var deleteWarn = document.createElement('p');
    deleteWarn.className = 'warn';
    deleteWarn.hidden = true;
    deleteWarn.textContent = 'This property is used in ' + p.usageCount + ' triple' + (p.usageCount === 1 ? '' : 's') + '. Deleting it removes ' +
      (p.usageCount === 1 ? 'that value' : 'all of those values') + ' from whichever holon(s) carry ' + (p.usageCount === 1 ? 'it' : 'them') + ' -- the holons themselves are not deleted -- and this cannot be undone.';
    deleteBtn.addEventListener('click', function(){
      if (deleteBtn.getAttribute('data-armed') !== '1'){
        deleteBtn.setAttribute('data-armed', '1');
        deleteBtn.textContent = p.usageCount
          ? 'Confirm Delete (removes ' + p.usageCount + (p.usageCount === 1 ? ' value' : ' values') + ')'
          : 'Confirm Delete?';
        deleteBtn.style.cssText = 'background:var(--bad); border-color:var(--bad); color:#fff;';
        if (p.usageCount) deleteWarn.hidden = false;
        return;
      }
      deleteBtn.disabled = true; editBtn.disabled = true; toggleBtn.disabled = true;
      deleteBtn.textContent = 'Deleting…';
      callTool(SERVER, 'sparql_update', {update: buildDeletePropertySparql(propIri)})
        .then(function(){ return mcp.invalidate(SERVER, 'sparql_select').catch(function(){}); })
        .then(function(){ selectedPropertyIri = null; return loadPropertiesData(true); })
        .then(function(){
          renderPropertiesTab();
          renderIdleDetail('Property deleted');
          // Any holon that carried this property's value now reads
          // differently -- refresh the holon-facing views too.
          loadList();
          if (selectedIri) selectHolon(selectedIri);
        })
        .catch(function(err){
          deleteBtn.disabled = false; editBtn.disabled = false; toggleBtn.disabled = false;
          deleteBtn.removeAttribute('data-armed');
          deleteBtn.textContent = 'Delete';
          deleteBtn.style.cssText = 'border-color:var(--bad); color:var(--bad);';
          renderBanner(inner, err);
        });
    });
    actions.appendChild(deleteBtn);
    inner.appendChild(actions);
    inner.appendChild(deleteWarn);

    if (isEditing){
      inner.appendChild(buildLabelCommentEditForm(p.label, p.comment, function(newLabel, newComment){
        return callTool(SERVER, 'sparql_update', {update: buildSetLabelCommentSparql(propIri, newLabel, newComment)})
          .then(function(){ return mcp.invalidate(SERVER, 'sparql_select').catch(function(){}); })
          .then(function(){ return loadPropertiesData(); })
          .then(function(){ propertyEditOpenFor = null; selectProperty(propIri, true); renderPropertiesTab(); });
      }, function(){ propertyEditOpenFor = null; selectProperty(propIri, true); }));
    } else if (p.comment){
      var desc = document.createElement('div');
      desc.className = 'description';
      desc.textContent = p.comment;
      inner.appendChild(desc);
    }

    if (p.domains.length) buildDetailChipList(inner, 'Domain', p.domains, jumpToClass);
    if (p.ranges.length) buildDetailChipList(inner, 'Range', p.ranges, jumpToClass);

    var shapeSecLabel = document.createElement('div');
    shapeSecLabel.className = 'section-label';
    shapeSecLabel.style.marginTop = '10px';
    shapeSecLabel.textContent = 'Property Shapes using this path (' + p.shapes.length + ')';
    inner.appendChild(shapeSecLabel);
    if (p.shapes.length){
      var kv = document.createElement('div');
      kv.className = 'kv';
      p.shapes.forEach(function(ps){
        var row = document.createElement('div');
        row.className = 'kv-row';
        var val = document.createElement('div');
        val.className = 'kv-val';
        var chip = document.createElement('button');
        chip.type = 'button'; chip.className = 'chip';
        chip.innerHTML = '<span>' + propertyShapeLabel(ps) + '</span><span class="arrow">&#8594;</span>';
        chip.addEventListener('click', function(){ jumpToPropertyShape(ps.iri); });
        val.appendChild(chip);
        row.appendChild(val);
        kv.appendChild(row);
      });
      inner.appendChild(kv);
    } else {
      var noShapes = document.createElement('p');
      noShapes.className = 'hint';
      noShapes.textContent = 'No property shape uses this path yet.';
      inner.appendChild(noShapes);
    }

    var usageLine = document.createElement('p');
    usageLine.className = 'hint';
    usageLine.style.margin = '10px 0 0';
    usageLine.textContent = p.usageCount + (p.usageCount === 1 ? ' triple' : ' triples') + ' currently use this property in this dataset.';
    inner.appendChild(usageLine);

    $detail.innerHTML = '';
    $detail.appendChild(inner);
  }

  function openNewPropertyForm(){
    selectedPropertyIri = null;
    renderPropertiesTab();
    $detail.innerHTML = '';
    var inner = document.createElement('div');
    inner.className = 'detail-inner';
    var h2 = document.createElement('h2');
    h2.className = 'title';
    h2.textContent = 'New Property';
    inner.appendChild(h2);
    inner.appendChild(buildNewPropertyForm());
    $detail.appendChild(inner);
  }
  function closeNewPropertyForm(){
    renderPropertiesTab();
    if (selectedPropertyIri) selectProperty(selectedPropertyIri);
    else renderIdleDetail('Nothing selected');
  }

  function buildNewPropertyForm(){
    var card = document.createElement('div');
    card.className = 'addchild-form';
    var picker = buildNamespaceLocalPicker();
    card.appendChild(picker.wrap);

    var labelField = document.createElement('div');
    labelField.className = 'field';
    var labelLabel = document.createElement('label');
    labelLabel.textContent = 'Label (optional)';
    labelField.appendChild(labelLabel);
    var labelInput = document.createElement('input');
    labelInput.type = 'text';
    labelInput.placeholder = 'Defaults to the local name';
    labelField.appendChild(labelInput);
    card.appendChild(labelField);

    var commentField = document.createElement('div');
    commentField.className = 'field';
    var commentLabel = document.createElement('label');
    commentLabel.textContent = 'Comment (optional)';
    commentField.appendChild(commentLabel);
    var commentArea = document.createElement('textarea');
    commentField.appendChild(commentArea);
    card.appendChild(commentField);

    var errorBox = document.createElement('div');
    card.appendChild(errorBox);

    var actionsRow = document.createElement('div');
    actionsRow.className = 'form-actions';
    var createBtn = document.createElement('button');
    createBtn.type = 'button'; createBtn.className = 'btn primary'; createBtn.textContent = 'Create Property';
    var cancelBtn = document.createElement('button');
    cancelBtn.type = 'button'; cancelBtn.className = 'btn'; cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', closeNewPropertyForm);
    createBtn.addEventListener('click', function(){
      errorBox.innerHTML = '';
      var nsUri = picker.getNamespaceUri();
      var local = picker.getLocal();
      if (!nsUri || !local){
        var warn = document.createElement('p');
        warn.className = 'warn';
        warn.textContent = 'Choose (or enter) a namespace and a local name.';
        errorBox.appendChild(warn);
        return;
      }
      var iri = nsUri + local;
      createBtn.disabled = true; createBtn.textContent = 'Creating…';
      var label = labelInput.value.trim() || local;
      var turtle = buildCreatePropertyTurtle(iri, label);
      callTool(SERVER, 'push_turtle', {turtle: turtle, graph_iri: ONTOLOGY_GRAPH, mode: 'merge'})
        .then(function(){ return mcp.invalidate(SERVER, 'sparql_select').catch(function(){}); })
        .then(function(){ allPropertiesPromise = null; return loadAllProperties(); })
        .then(function(){
          if (commentArea.value.trim()){
            return callTool(SERVER, 'sparql_update', {update: buildSetLabelCommentSparql(iri, label, commentArea.value.trim())})
              .then(function(){ return mcp.invalidate(SERVER, 'sparql_select').catch(function(){}); });
          }
        })
        .then(function(){ return loadPropertiesData(); })
        .then(function(){ renderPropertiesTab(); selectProperty(iri); })
        .catch(function(err){
          createBtn.disabled = false; createBtn.textContent = 'Create Property';
          renderBanner(errorBox, err);
        });
    });
    actionsRow.appendChild(createBtn);
    actionsRow.appendChild(cancelBtn);
    card.appendChild(actionsRow);
    return card;
  }

  // ======================================================================
  // Namespaces tab -- a small registry of prefix/URI pairs, now described
  // with SHACL's own sh:declare/sh:PrefixDeclaration structure (sh:prefix,
  // sh:namespace, sh:name, sh:description) rather than the VANN vocabulary
  // this tab originally used. The registry entry is the OBJECT of an
  // `<ONTOLOGY_GRAPH> sh:declare <entry>` triple -- the ontology graph's own
  // IRI stands in for "the ontology that declares these prefixes", the same
  // convention SHACL itself documents (an ontology/shapes-graph resource
  // declaring the prefixes it uses) -- and the entry itself is typed
  // sh:PrefixDeclaration and carries sh:prefix/sh:namespace plus the same
  // sh:name/sh:description predicates the Property Shapes form already uses
  // for human-readable labels (SH_NAME/SH_DESCRIPTION2, declared above).
  //
  // Backward compatibility: NAMESPACE_LIST_QUERY below still reads any
  // pre-existing VANN-style entries (vann:preferredNamespacePrefix/
  // vann:preferredNamespaceUri) via a UNION, tagging each row with a
  // ?scheme binding ("shacl" or "vann") so the UI can tell which structure
  // a given entry currently uses. New entries are always minted in the
  // SHACL structure (buildCreateNamespaceTurtle). A legacy VANN entry is
  // upgraded in place, atomically, the next time it's edited and saved
  // (buildUpgradeNamespaceToShaclSparql, wired into buildNamespaceEditForm's
  // save handler) -- there's no separate "upgrade" button, editing is
  // upgrading.
  //
  // Deprecation deliberately REUSES the exact same holon:status/
  // holon:DeprecatedStatus machinery Taxonomies already uses (deprecatedSet/
  // loadDeprecatedSet/buildSetStatusSparql/buildClearStatusSparql, all
  // defined once near the top of the file) rather than inventing a third
  // "never delete" mechanism alongside that one and Node/Property Shapes'
  // sh:deactivated -- one flat deprecatedSet already spans every ontology-
  // graph resource (concepts, schemes, and now namespaces), which is
  // exactly why that set isn't scoped to just skos:Concept/skos:ConceptScheme.
  // This is unaffected by the VANN->SHACL structure change above: deprecation
  // is orthogonal metadata on the entry's own IRI, independent of which
  // prefix/namespace predicates that IRI happens to carry.
  // ======================================================================

  // No GRAPH clause baked in -- called with graph: ONTOLOGY_GRAPH at
  // request time (see loadNamespacesData below), exactly like
  // NODE_SHAPES_LIST_QUERY/PROP_SHAPES_LIST_QUERY, so a dataset switch that
  // reassigns ONTOLOGY_GRAPH after this string was built can never leave it
  // silently pointed at the old graph (see SCHEME_LIST_QUERY's comment
  // elsewhere in this file for the pre-existing bug this pattern avoids).
  //
  // UNION of the new SHACL structure and the legacy VANN structure so both
  // read side by side; FILTER NOT EXISTS on the VANN arm guards against
  // double-counting an entry that (mid-migration, or written by some other
  // tool) happens to carry both sets of predicates at once.
  var NAMESPACE_LIST_QUERY = [
    "PREFIX sh: <http://www.w3.org/ns/shacl#>",
    "PREFIX vann: <http://purl.org/vocab/vann/>",
    "PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>",
    "SELECT ?entry ?prefix ?uri ?label ?comment ?scheme WHERE {",
    "  {",
    "    ?owner sh:declare ?entry .",
    "    ?entry sh:prefix ?prefix ; sh:namespace ?uriTyped .",
    "    BIND(STR(?uriTyped) AS ?uri)",
    "    OPTIONAL { ?entry sh:name ?label }",
    "    OPTIONAL { ?entry sh:description ?comment }",
    "    BIND(\"shacl\" AS ?scheme)",
    "  } UNION {",
    "    ?entry vann:preferredNamespacePrefix ?prefix ; vann:preferredNamespaceUri ?uri .",
    "    FILTER NOT EXISTS { ?entry sh:prefix ?anyPrefix }",
    "    OPTIONAL { ?entry rdfs:label ?label }",
    "    OPTIONAL { ?entry rdfs:comment ?comment }",
    "    BIND(\"vann\" AS ?scheme)",
    "  }",
    "}"
  ].join("\n");

  // Base IRI for a freshly minted registry entry's own identity (NOT the
  // namespace URI it describes) -- derived from an existing entry's IRI via
  // namespaceAndLocal when one exists, else a fixed fallback. The entry's
  // IRI is namespaceRegistryBase() + prefix (the prefix itself as local
  // name), which keeps every registry entry's own IRI stable and readable
  // even though what it DESCRIBES (ns.uri) is a completely separate string.
  function namespaceRegistryBase(){
    if (namespacesData.length){
      var parts = namespaceAndLocal(namespacesData[0].iri);
      if (parts.ns) return parts.ns;
    }
    return "https://w3id.org/data/ontology/namespaces#";
  }

  // Mints a namespace registry entry in the current, SHACL-native structure:
  // <ONTOLOGY_GRAPH> sh:declare <iri> -- the ontology graph asserting it
  // declares this prefix -- plus <iri> itself typed sh:PrefixDeclaration
  // with sh:prefix/sh:namespace (sh:namespace is xsd:anyURI-typed, per the
  // SHACL vocabulary) and optional sh:name/sh:description.
  function buildCreateNamespaceTurtle(iri, prefix, uri, label, comment){
    var lines = [
      "@prefix sh: <http://www.w3.org/ns/shacl#> .",
      "@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .",
      "",
      "<" + ONTOLOGY_GRAPH + "> sh:declare <" + iri + "> .",
      "",
      "<" + iri + ">",
      "  a sh:PrefixDeclaration ;",
      "  sh:prefix " + turtleLiteral(prefix) + " ;",
      "  sh:namespace " + turtleLiteral(uri) + "^^xsd:anyURI ;"
    ];
    if (label) lines.push("  sh:name " + langLiteral(label) + " ;");
    if (comment) lines.push("  sh:description " + langLiteral(comment) + " ;");
    // Same "swap the last ' ;' for ' .'" close used by
    // buildCreateNodeShapeTurtle/buildCreatePropertyShapeTurtle above.
    var last = lines.pop();
    lines.push(last.replace(/ ;$/, ' .'));
    return lines.join("\n");
  }

  // Migrates one legacy VANN entry to the SHACL structure in a single
  // atomic UPDATE, carrying over whatever the admin just edited in the same
  // save (prefix/uri/label/comment reflect the NEW values, not the old
  // ones) -- called from buildNamespaceEditForm's save handler whenever
  // ns.scheme === 'vann'. There's no separate "upgrade" affordance; editing
  // a legacy entry IS how it gets upgraded.
  function buildUpgradeNamespaceToShaclSparql(entryIri, prefix, uri, label, comment){
    var insertLines = [
      "  <" + ONTOLOGY_GRAPH + "> sh:declare <" + entryIri + "> .",
      "  <" + entryIri + "> a sh:PrefixDeclaration ;",
      "    sh:prefix " + turtleLiteral(prefix) + " ;",
      "    sh:namespace " + turtleLiteral(uri) + "^^xsd:anyURI" + (label || comment ? " ;" : " .")
    ];
    if (label) insertLines.push("    sh:name " + langLiteral(label) + (comment ? " ;" : " ."));
    if (comment) insertLines.push("    sh:description " + langLiteral(comment) + " .");
    return [
      "PREFIX vann: <http://purl.org/vocab/vann/>",
      "PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>",
      "PREFIX sh: <http://www.w3.org/ns/shacl#>",
      "PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>",
      "DELETE {",
      "  GRAPH <" + ONTOLOGY_GRAPH + "> {",
      "    <" + entryIri + "> vann:preferredNamespacePrefix ?p0 ;",
      "                       vann:preferredNamespaceUri ?u0 ;",
      "                       rdfs:label ?l0 ;",
      "                       rdfs:comment ?c0 .",
      "  }",
      "}",
      "INSERT {",
      "  GRAPH <" + ONTOLOGY_GRAPH + "> {",
      insertLines.join("\n"),
      "  }",
      "}",
      "WHERE {",
      "  GRAPH <" + ONTOLOGY_GRAPH + "> {",
      "    OPTIONAL { <" + entryIri + "> vann:preferredNamespacePrefix ?p0 }",
      "    OPTIONAL { <" + entryIri + "> vann:preferredNamespaceUri ?u0 }",
      "    OPTIONAL { <" + entryIri + "> rdfs:label ?l0 }",
      "    OPTIONAL { <" + entryIri + "> rdfs:comment ?c0 }",
      "  }",
      "}"
    ].join("\n");
  }

  function loadNamespacesData(){
    return Promise.all([
      callTool(SERVER, 'sparql_select', {query: NAMESPACE_LIST_QUERY, graph: ONTOLOGY_GRAPH})
        .then(function(res){ return (res.payload && res.payload.results && res.payload.results.bindings) || []; }),
      loadDeprecatedSet()
    ]).then(function(results){
      var bindings = results[0];
      namespacesData = bindings.map(function(b){
        return {
          iri: b.entry.value,
          prefix: b.prefix.value,
          uri: b.uri.value,
          label: b.label ? b.label.value : '',
          comment: b.comment ? b.comment.value : '',
          scheme: b.scheme ? b.scheme.value : 'shacl'
        };
      }).sort(function(a, b){ return a.prefix.localeCompare(b.prefix); });
      namespacesLoaded = true;
      return namespacesData;
    });
  }

  function loadNamespaces(force){
    if (force) namespacesLoaded = false;
    return loadNamespacesData()
      .then(function(){
        renderNamespaces();
        if (selectedNamespaceIri) selectNamespace(selectedNamespaceIri, true);
      })
      .catch(function(err){
        $namespaces.innerHTML = '';
        renderBanner($namespaces, err, function(){ loadNamespaces(true); });
      });
  }

  function buildNamespaceRow(ns){
    var row = document.createElement('button');
    var isDeprecated = !!deprecatedSet[ns.iri];
    row.className = 'row' + (ns.iri === selectedNamespaceIri ? ' active' : '');
    row.type = 'button';
    if (isDeprecated) row.style.opacity = '0.55';
    var lbl = document.createElement('span');
    lbl.className = 'row-label';
    // ns.label falls back to ns.prefix, NOT humanize(ns.uri) -- a namespace
    // URI conventionally ends in '#' (or '/'), and humanize() splits on the
    // LAST such separator, so humanize() on a bare namespace URI usually
    // yields an empty string. The prefix is always meaningful; humanize on
    // the entry's OWN iri (namespaceRegistryBase()+prefix) is the last
    // resort, used only in renderNamespaceDetail's title, not here.
    lbl.textContent = (ns.label || ns.prefix) + (isDeprecated ? ' (deprecated)' : '');
    row.appendChild(lbl);
    var tp = document.createElement('span');
    tp.className = 'row-type';
    tp.textContent = ns.prefix + ':';
    row.appendChild(tp);
    row.addEventListener('click', function(){ selectNamespace(ns.iri); });
    return row;
  }

  function renderNamespaces(){
    $namespaces.innerHTML = '';
    var btnRow = document.createElement('div');
    btnRow.style.cssText = 'display:flex; flex-wrap:wrap; gap:6px; margin:8px 8px 10px;';
    var addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'btn';
    addBtn.textContent = '+ New Namespace';
    addBtn.style.cssText = 'font-size:11.5px; padding:5px 10px;';
    addBtn.addEventListener('click', openNewNamespaceForm);
    btnRow.appendChild(addBtn);
    var discoverBtn = document.createElement('button');
    discoverBtn.type = 'button';
    discoverBtn.className = 'btn';
    discoverBtn.textContent = 'Read Namespaces From Dataset';
    discoverBtn.style.cssText = 'font-size:11.5px; padding:5px 10px;';
    discoverBtn.addEventListener('click', openDiscoverNamespacesForm);
    btnRow.appendChild(discoverBtn);
    $namespaces.appendChild(btnRow);
    $namespaces.appendChild(buildShowDeprecatedToggle('namespaces', 'Show deprecated', renderNamespaces));

    if (!namespacesData.length){
      var empty = document.createElement('div');
      empty.className = 'list-empty';
      empty.textContent = 'No namespaces registered yet.';
      $namespaces.appendChild(empty);
      return;
    }
    var visibleNamespaces = filterByDeprecatedSet(namespacesData, 'namespaces');
    if (!visibleNamespaces.length){
      var allHiddenNs = document.createElement('div');
      allHiddenNs.className = 'list-empty';
      allHiddenNs.textContent = 'Every namespace is deprecated -- tick "Show deprecated" above to see them.';
      $namespaces.appendChild(allHiddenNs);
      return;
    }
    visibleNamespaces.forEach(function(ns){ $namespaces.appendChild(buildNamespaceRow(ns)); });
  }

  // Unlike selectScheme/selectNodeShape, there's no separate per-item
  // fetch here -- loadNamespacesData() already pulled every field this tab
  // shows, so selecting one is a synchronous lookup into namespacesData.
  function selectNamespace(nsIri, skipRerenderRail){
    selectedNamespaceIri = nsIri;
    if (!skipRerenderRail) renderNamespaces();
    var ns = namespacesData.find(function(x){ return x.iri === nsIri; });
    renderNamespaceDetail(nsIri, ns);
  }

  function renderNamespaceDetail(nsIri, ns){
    ns = ns || {iri: nsIri, prefix: '', uri: '', label: '', comment: ''};
    var isDeprecated = !!deprecatedSet[nsIri];
    var isEditing = namespaceEditOpenFor === nsIri;
    var inner = document.createElement('div');
    inner.className = 'detail-inner';

    var badges = document.createElement('div');
    badges.className = 'badges';
    var p = document.createElement('span');
    p.className = 'pill type';
    p.textContent = 'Namespace';
    badges.appendChild(p);
    if (isDeprecated){
      var dp = document.createElement('span');
      dp.className = 'pill status';
      dp.textContent = 'Deprecated';
      badges.appendChild(dp);
    }
    inner.appendChild(badges);

    if (!isEditing){
      var h2 = document.createElement('h2');
      h2.className = 'title';
      h2.textContent = ns.label || ns.prefix || humanize(nsIri);
      inner.appendChild(h2);
    }

    var iriLine = document.createElement('div');
    iriLine.className = 'iri';
    iriLine.textContent = nsIri;
    inner.appendChild(iriLine);

    var prefixLine = document.createElement('p');
    prefixLine.className = 'hint';
    prefixLine.style.margin = '-12px 0 18px';
    prefixLine.textContent = (ns.prefix || '—') + ':  →  ' + (ns.uri || '—');
    inner.appendChild(prefixLine);

    var actions = document.createElement('div');
    actions.className = 'actions';
    var editBtn = document.createElement('button');
    editBtn.type = 'button'; editBtn.className = 'btn';
    editBtn.textContent = isEditing ? 'Cancel Edit' : 'Edit';
    editBtn.addEventListener('click', function(){
      namespaceEditOpenFor = isEditing ? null : nsIri;
      selectNamespace(nsIri, true);
    });
    actions.appendChild(editBtn);
    var toggleBtn = document.createElement('button');
    toggleBtn.type = 'button'; toggleBtn.className = 'btn';
    toggleBtn.textContent = isDeprecated ? 'Reactivate' : 'Deprecate';
    toggleBtn.addEventListener('click', function(){
      toggleBtn.disabled = true;
      var op = isDeprecated ? callTool(SERVER, 'sparql_update', {update: buildClearStatusSparql(nsIri)})
                             : callTool(SERVER, 'sparql_update', {update: buildSetStatusSparql(nsIri, DEPRECATED_STATUS_IRI)});
      op.then(function(){ return mcp.invalidate(SERVER, 'sparql_select').catch(function(){}); })
        .then(function(){ return loadDeprecatedSet(true); })
        .then(function(){ selectNamespace(nsIri, true); renderNamespaces(); })
        .catch(function(err){ toggleBtn.disabled = false; renderBanner(inner, err); });
    });
    actions.appendChild(toggleBtn);
    inner.appendChild(actions);

    if (isEditing){
      inner.appendChild(buildNamespaceEditForm(ns));
    } else if (ns.comment){
      var desc = document.createElement('div');
      desc.className = 'description';
      desc.textContent = ns.comment;
      inner.appendChild(desc);
    } else {
      var hint = document.createElement('p');
      hint.className = 'hint';
      hint.style.margin = '18px 0 0';
      hint.textContent = isDeprecated
        ? 'This namespace is deprecated -- it stays valid for anything already using it but is no longer offered when minting a new class or property IRI elsewhere in this tool.'
        : 'Registered prefix/URI pair, offered wherever a new class or property IRI is minted (Node Shapes’ target class, Property Shapes’ path).';
      inner.appendChild(hint);
      if (ns.scheme === 'vann'){
        var legacyHint = document.createElement('p');
        legacyHint.className = 'hint';
        legacyHint.style.margin = '6px 0 0';
        legacyHint.textContent = 'Declared with the legacy VANN vocabulary -- editing and saving this entry upgrades it in place to SHACL’s sh:declare/sh:PrefixDeclaration structure.';
        inner.appendChild(legacyHint);
      }
    }

    $detail.innerHTML = '';
    $detail.appendChild(inner);
  }

  function buildNamespaceEditForm(ns){
    var card = document.createElement('div');
    card.className = 'addchild-form';
    var h3 = document.createElement('h3');
    h3.textContent = 'Edit namespace';
    card.appendChild(h3);

    var errorBox = document.createElement('div');
    card.appendChild(errorBox);

    var prefixField = document.createElement('div');
    prefixField.className = 'field';
    var prefixLabel = document.createElement('label');
    prefixLabel.textContent = 'Prefix';
    prefixField.appendChild(prefixLabel);
    var prefixInput = document.createElement('input');
    prefixInput.type = 'text';
    prefixInput.value = ns.prefix || '';
    prefixField.appendChild(prefixInput);
    card.appendChild(prefixField);

    var uriField = document.createElement('div');
    uriField.className = 'field';
    var uriLabel = document.createElement('label');
    uriLabel.textContent = 'Namespace URI';
    uriField.appendChild(uriLabel);
    var uriInput = document.createElement('input');
    uriInput.type = 'text';
    uriInput.value = ns.uri || '';
    uriField.appendChild(uriInput);
    card.appendChild(uriField);

    // Propagation only ever matters for the URI, never the prefix -- a
    // prefix is a purely local display label for this tool and is never
    // itself stored in any triple (only the fully-expanded IRI is), so
    // renaming it can never need to touch existing data. Renaming the URI
    // is the one case where "items in this namespace" (every IRI already
    // minted under it, anywhere in the dataset) could need to follow --
    // hence this checkbox is scoped to, and only acted on when, the URI
    // field actually changes at save time (see the save handler below).
    var propagateField = document.createElement('div');
    propagateField.className = 'field';
    propagateField.style.cssText = 'display:flex; align-items:flex-start; gap:8px;';
    var propagateCheckbox = document.createElement('input');
    propagateCheckbox.type = 'checkbox';
    propagateCheckbox.id = 'nsPropagateCheck';
    propagateCheckbox.style.marginTop = '3px';
    propagateField.appendChild(propagateCheckbox);
    var propagateLabelWrap = document.createElement('div');
    var propagateLabel = document.createElement('label');
    propagateLabel.setAttribute('for', 'nsPropagateCheck');
    propagateLabel.textContent = 'Propagate to items already using this namespace';
    propagateLabel.style.cssText = 'display:block; cursor:pointer;';
    propagateLabelWrap.appendChild(propagateLabel);
    var propagateHint = document.createElement('p');
    propagateHint.className = 'hint';
    propagateHint.style.margin = '2px 0 0';
    propagateHint.textContent = 'Only applies if you change the namespace URI above. On save you’ll see how many existing resources use the old URI and choose how to carry the change to them.';
    propagateLabelWrap.appendChild(propagateHint);
    propagateField.appendChild(propagateLabelWrap);
    card.appendChild(propagateField);

    var labelField = document.createElement('div');
    labelField.className = 'field';
    var labelLabel = document.createElement('label');
    labelLabel.textContent = 'Label (optional)';
    labelField.appendChild(labelLabel);
    var labelInput = document.createElement('input');
    labelInput.type = 'text';
    labelInput.value = ns.label || '';
    labelField.appendChild(labelInput);
    card.appendChild(labelField);

    var commentField = document.createElement('div');
    commentField.className = 'field';
    var commentLabel = document.createElement('label');
    commentLabel.textContent = 'Comment (optional)';
    commentField.appendChild(commentLabel);
    var commentArea = document.createElement('textarea');
    commentArea.value = ns.comment || '';
    commentField.appendChild(commentArea);
    card.appendChild(commentField);

    var actionsRow = document.createElement('div');
    actionsRow.className = 'form-actions';
    var saveBtn = document.createElement('button');
    saveBtn.type = 'button'; saveBtn.className = 'btn primary'; saveBtn.textContent = 'Save Changes';
    var cancelBtn = document.createElement('button');
    cancelBtn.type = 'button'; cancelBtn.className = 'btn'; cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', function(){
      namespaceEditOpenFor = null;
      selectNamespace(ns.iri, true);
    });
    saveBtn.addEventListener('click', function(){
      errorBox.innerHTML = '';
      var newPrefix = prefixInput.value.trim();
      var newUri = uriInput.value.trim();
      if (!newPrefix || !newUri){
        var warn = document.createElement('p');
        warn.className = 'warn';
        warn.textContent = 'Both prefix and namespace URI are required.';
        errorBox.appendChild(warn);
        return;
      }
      var clash = namespacesData.find(function(x){
        return x.iri !== ns.iri && (x.prefix === newPrefix || x.uri === newUri);
      });
      if (clash){
        var warn2 = document.createElement('p');
        warn2.className = 'warn';
        warn2.textContent = 'Another namespace already uses that ' + (clash.prefix === newPrefix ? 'prefix' : 'URI') + ' (' + (clash.label || clash.prefix) + ').';
        errorBox.appendChild(warn2);
        return;
      }
      var newLabel = labelInput.value.trim();
      var newComment = commentArea.value.trim();
      var uriChanged = newUri !== (ns.uri || '');
      var oldUri = ns.uri;

      // Applies just the registry entry's OWN fields (prefix/uri/label/
      // comment) -- shared by the plain-save path and by both propagation
      // choices below, so the entry's bookkeeping is always updated exactly
      // once, the same way, regardless of what (if anything) also happens
      // to the resources that use this namespace.
      function commitFieldEdits(){
        if (ns.scheme === 'vann'){
          // One atomic upgrade: legacy VANN triples -> sh:declare/
          // sh:PrefixDeclaration, carrying over whatever was just edited.
          return callTool(SERVER, 'sparql_update', {
            update: buildUpgradeNamespaceToShaclSparql(ns.iri, newPrefix, newUri, newLabel, newComment)
          });
        }
        var chain = Promise.resolve();
        if (newPrefix !== (ns.prefix || '')){
          var prefixUpdate = buildReplaceFieldSparql(ONTOLOGY_GRAPH, ns.iri, SH_PREFIX_PRED, turtleLiteral(newPrefix));
          chain = chain.then(function(){ return callTool(SERVER, 'sparql_update', {update: prefixUpdate}); });
        }
        if (uriChanged){
          var uriUpdate = buildReplaceFieldSparql(ONTOLOGY_GRAPH, ns.iri, SH_NAMESPACE_PRED, turtleLiteral(newUri) + '^^<' + XSD_ANYURI_IRI + '>');
          chain = chain.then(function(){ return callTool(SERVER, 'sparql_update', {update: uriUpdate}); });
        }
        if (newLabel !== (ns.label || '')){
          var labelUpdate = buildReplaceFieldSparql(ONTOLOGY_GRAPH, ns.iri, SH_NAME, newLabel ? langLiteral(newLabel) : null);
          chain = chain.then(function(){ return callTool(SERVER, 'sparql_update', {update: labelUpdate}); });
        }
        if (newComment !== (ns.comment || '')){
          var commentUpdate = buildReplaceFieldSparql(ONTOLOGY_GRAPH, ns.iri, SH_DESCRIPTION2, newComment ? langLiteral(newComment) : null);
          chain = chain.then(function(){ return callTool(SERVER, 'sparql_update', {update: commentUpdate}); });
        }
        return chain;
      }

      function finishSave(){
        return commitFieldEdits()
          .then(function(){ return mcp.invalidate(SERVER, 'sparql_select').catch(function(){}); })
          .then(function(){ namespaceEditOpenFor = null; return loadNamespacesData(); })
          .then(function(){ renderNamespaces(); selectNamespace(ns.iri, true); });
      }

      if (!propagateCheckbox.checked || !uriChanged){
        saveBtn.disabled = true; cancelBtn.disabled = true; saveBtn.textContent = 'Saving…';
        finishSave().catch(function(err){
          saveBtn.disabled = false; cancelBtn.disabled = false; saveBtn.textContent = 'Save Changes';
          renderBanner(errorBox, err);
        });
        return;
      }

      // Propagation was requested and the URI is actually changing --
      // find what's affected BEFORE committing anything, so the admin
      // chooses a strategy with real numbers in front of them rather than
      // blind. Nothing is written until one of the two choices is picked.
      saveBtn.disabled = true; cancelBtn.disabled = true; saveBtn.textContent = 'Checking affected items…';
      callTool(SERVER, 'sparql_select', {query: namespaceAffectedResourcesQuery(oldUri)})
        .then(function(res){
          var bindings = (res.payload && res.payload.results && res.payload.results.bindings) || [];
          var affected = bindings.map(function(b){ return b.iri.value; });
          saveBtn.style.display = 'none';
          errorBox.innerHTML = '';
          errorBox.appendChild(buildPropagationChoice(affected, oldUri, newUri, finishSave, function(){
            saveBtn.style.display = '';
            saveBtn.disabled = false; cancelBtn.disabled = false; saveBtn.textContent = 'Save Changes';
          }));
        })
        .catch(function(err){
          saveBtn.disabled = false; cancelBtn.disabled = false; saveBtn.textContent = 'Save Changes';
          renderBanner(errorBox, err);
        });
    });
    actionsRow.appendChild(saveBtn);
    actionsRow.appendChild(cancelBtn);
    card.appendChild(actionsRow);
    return card;
  }

  // Shown after "Propagate" is checked, the URI is changed, and Save is
  // clicked: lists what's affected and offers the two strategies discussed
  // with the admin ahead of building this -- a destructive rewrite (the one
  // place in this tool that deletes existing triples outright rather than
  // deprecating) or a non-destructive owl:sameAs migration (mints new IRIs
  // under the new namespace and links them to the old ones; nothing
  // existing is touched). Nothing is committed until one is chosen, or
  // Cancel returns to the edit form untouched.
  function buildPropagationChoice(affected, oldNs, newNs, finishSave, onCancel){
    var box = document.createElement('div');
    box.className = 'addchild-form';
    var h4 = document.createElement('h4');
    h4.textContent = affected.length + ' resource(s) currently use this namespace';
    box.appendChild(h4);

    if (affected.length){
      var sample = document.createElement('div');
      sample.className = 'hint';
      sample.style.cssText = 'font-family:monospace; font-size:11px; max-height:120px; overflow:auto; margin:6px 0 10px; white-space:pre-wrap;';
      sample.textContent = affected.slice(0, 12).join('\n') + (affected.length > 12 ? '\n… and ' + (affected.length - 12) + ' more' : '');
      box.appendChild(sample);
    }

    var explain = document.createElement('p');
    explain.className = 'hint';
    explain.textContent = 'Choose how to carry the namespace change to these resources:';
    box.appendChild(explain);

    var actionsRow2 = document.createElement('div');
    actionsRow2.className = 'form-actions';
    actionsRow2.style.flexWrap = 'wrap';

    var rewriteBtn = document.createElement('button');
    rewriteBtn.type = 'button'; rewriteBtn.className = 'btn primary';
    var rewriteLabel = 'Rewrite In Place (' + affected.length + ')';
    rewriteBtn.textContent = rewriteLabel;
    rewriteBtn.title = 'Renames every affected IRI to the new namespace, across the holons/ontology/shacl graphs, preserving local names. This deletes and replaces the old triples -- the one operation in this tool that does not preserve existing IRIs.';

    var sameAsBtn = document.createElement('button');
    sameAsBtn.type = 'button'; sameAsBtn.className = 'btn';
    var sameAsLabel = 'Additive sameAs Migration (' + affected.length + ')';
    sameAsBtn.textContent = sameAsLabel;
    sameAsBtn.title = 'Mints a new IRI under the new namespace for each affected resource and links it to the old one with owl:sameAs. Nothing existing is touched or deleted.';

    var cancelBtn2 = document.createElement('button');
    cancelBtn2.type = 'button'; cancelBtn2.className = 'btn';
    cancelBtn2.textContent = 'Cancel';
    cancelBtn2.addEventListener('click', function(){
      box.remove();
      onCancel();
    });

    function run(propagationOpFactory, busyBtn, busyLabel){
      rewriteBtn.disabled = true; sameAsBtn.disabled = true; cancelBtn2.disabled = true;
      busyBtn.textContent = 'Working…';
      propagationOpFactory()
        .then(function(){ return finishSave(); })
        .catch(function(err){
          rewriteBtn.disabled = false; sameAsBtn.disabled = false; cancelBtn2.disabled = false;
          busyBtn.textContent = busyLabel;
          renderBanner(box, err);
        });
    }

    rewriteBtn.addEventListener('click', function(){
      run(function(){
        return callTool(SERVER, 'sparql_update', {update: buildRewriteNamespaceSparql(oldNs, newNs)});
      }, rewriteBtn, rewriteLabel);
    });
    sameAsBtn.addEventListener('click', function(){
      run(function(){
        if (!affected.length) return Promise.resolve();
        return callTool(SERVER, 'push_turtle', {
          turtle: buildSameAsMigrationTurtle(oldNs, newNs, affected),
          graph_iri: ONTOLOGY_GRAPH,
          mode: 'merge'
        });
      }, sameAsBtn, sameAsLabel);
    });

    actionsRow2.appendChild(rewriteBtn);
    actionsRow2.appendChild(sameAsBtn);
    actionsRow2.appendChild(cancelBtn2);
    box.appendChild(actionsRow2);
    return box;
  }

  // Built fresh on every call (see discoverNamespacesQuery's comment above
  // for why) -- every IRI, anywhere in the holons/ontology/shacl graphs,
  // that starts with the namespace being renamed. Used both to size the
  // "N resource(s) use this namespace" preview and, for the additive path,
  // as the exact list to mint owl:sameAs links for.
  function namespaceAffectedResourcesQuery(oldNs){
    var lit = turtleLiteral(oldNs);
    return [
      "SELECT DISTINCT ?iri WHERE {",
      "  { GRAPH <" + HOLONS_GRAPH + "> { ?iri ?hp1 ?ho1 } }",
      "  UNION { GRAPH <" + HOLONS_GRAPH + "> { ?hs1 ?iri ?ho2 } }",
      "  UNION { GRAPH <" + HOLONS_GRAPH + "> { ?hs2 ?hp2 ?iri } }",
      "  UNION { GRAPH <" + ONTOLOGY_GRAPH + "> { ?iri ?op1 ?oo1 } }",
      "  UNION { GRAPH <" + ONTOLOGY_GRAPH + "> { ?os1 ?iri ?oo2 } }",
      "  UNION { GRAPH <" + ONTOLOGY_GRAPH + "> { ?os2 ?op2 ?iri } }",
      "  UNION { GRAPH <" + SHACL_GRAPH + "> { ?iri ?sp1 ?so1 } }",
      "  UNION { GRAPH <" + SHACL_GRAPH + "> { ?ss1 ?iri ?so2 } }",
      "  UNION { GRAPH <" + SHACL_GRAPH + "> { ?ss2 ?sp2 ?iri } }",
      "  FILTER(isIRI(?iri) && STRSTARTS(STR(?iri), " + lit + "))",
      "}",
      "ORDER BY ?iri"
    ].join("\n");
  }

  // Rewrites every IRI under oldNs to newNs, preserving local names, across
  // all three graphs in one combined UPDATE request (three DELETE/INSERT/
  // WHERE operations, semicolon-joined -- Fuseki/Jena runs a single POSTed
  // Update request as one transaction). Each graph's WHERE scans every
  // triple but the FILTER only matches ones touching the old namespace in
  // subject, predicate, OR object position; the BIND/IF pairs leave any
  // term that ISN'T under the old namespace unchanged, so an unaffected
  // triple never actually appears in the DELETE/INSERT at all. This is the
  // one operation in this tool that deletes existing triples outright
  // rather than deprecating them -- by design, per the choice offered
  // alongside the non-destructive owl:sameAs alternative above.
  function buildRewriteNamespaceSparql(oldNs, newNs){
    var oldLit = turtleLiteral(oldNs);
    var newLit = turtleLiteral(newNs);
    function blockForGraph(g){
      return [
        "DELETE { GRAPH <" + g + "> { ?s ?p ?o } }",
        "INSERT { GRAPH <" + g + "> { ?sNew ?pNew ?oNew } }",
        "WHERE {",
        "  GRAPH <" + g + "> {",
        "    ?s ?p ?o .",
        "    FILTER(",
        "      (isIRI(?s) && STRSTARTS(STR(?s), " + oldLit + ")) ||",
        "      (isIRI(?p) && STRSTARTS(STR(?p), " + oldLit + ")) ||",
        "      (isIRI(?o) && STRSTARTS(STR(?o), " + oldLit + "))",
        "    )",
        "  }",
        "  BIND(IF(isIRI(?s) && STRSTARTS(STR(?s), " + oldLit + "), IRI(CONCAT(" + newLit + ", STRAFTER(STR(?s), " + oldLit + "))), ?s) AS ?sNew)",
        "  BIND(IF(isIRI(?p) && STRSTARTS(STR(?p), " + oldLit + "), IRI(CONCAT(" + newLit + ", STRAFTER(STR(?p), " + oldLit + "))), ?p) AS ?pNew)",
        "  BIND(IF(isIRI(?o) && STRSTARTS(STR(?o), " + oldLit + "), IRI(CONCAT(" + newLit + ", STRAFTER(STR(?o), " + oldLit + "))), ?o) AS ?oNew)",
        "}"
      ].join("\n");
    }
    return [HOLONS_GRAPH, ONTOLOGY_GRAPH, SHACL_GRAPH].map(blockForGraph).join(";\n\n");
  }

  // Non-destructive alternative: mints <newNs+local> owl:sameAs <oldIri>
  // for every affected resource, in ONTOLOGY_GRAPH. Nothing about the old
  // resource is touched -- consumers that follow owl:sameAs can resolve
  // either IRI, and new authoring can target the new namespace going
  // forward, while every existing triple stays exactly as it was.
  function buildSameAsMigrationTurtle(oldNs, newNs, affectedIris){
    var lines = ["@prefix owl: <http://www.w3.org/2002/07/owl#> ."];
    affectedIris.forEach(function(oldIri){
      var local = oldIri.slice(oldNs.length);
      var newIri = newNs + local;
      lines.push("<" + newIri + "> owl:sameAs <" + oldIri + "> .");
    });
    return lines.join("\n");
  }

  // A namespace prefix follows the same rule as an XML/Turtle NCName-ish
  // prefix in practice: a letter or underscore, then letters/digits/"_"/
  // "-"/".". Enforced client-side only -- nothing stops a hand-authored
  // prefix elsewhere in the graph from breaking this, same as every other
  // soft validation in this file.
  var NAMESPACE_PREFIX_RE = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

  function buildNewNamespaceForm(){
    var card = document.createElement('div');
    card.className = 'addchild-form';
    var hint = document.createElement('p');
    hint.className = 'hint';
    hint.textContent = 'Registers a prefix/URI pair as a SHACL sh:declare / sh:PrefixDeclaration entry that the class- and property-minting forms in Node Shapes and Property Shapes can offer.';
    card.appendChild(hint);

    var errorBox = document.createElement('div');
    card.appendChild(errorBox);

    var prefixField = document.createElement('div');
    prefixField.className = 'field';
    var prefixLabel = document.createElement('label');
    prefixLabel.textContent = 'Prefix';
    prefixField.appendChild(prefixLabel);
    var prefixInput = document.createElement('input');
    prefixInput.type = 'text';
    prefixInput.placeholder = 'e.g. geo';
    prefixField.appendChild(prefixInput);
    card.appendChild(prefixField);

    var uriField = document.createElement('div');
    uriField.className = 'field';
    var uriLabel = document.createElement('label');
    uriLabel.textContent = 'Namespace URI';
    uriField.appendChild(uriLabel);
    var uriInput = document.createElement('input');
    uriInput.type = 'text';
    uriInput.placeholder = 'https://example.org/ns/geography#';
    uriField.appendChild(uriInput);
    var uriHint = document.createElement('p');
    uriHint.className = 'hint';
    uriHint.style.margin = '-8px 0 12px';
    uriHint.textContent = 'Conventionally ends in "#" or "/" so a local name can be appended directly.';
    uriField.appendChild(uriHint);
    card.appendChild(uriField);

    var labelField = document.createElement('div');
    labelField.className = 'field';
    var labelLabel = document.createElement('label');
    labelLabel.textContent = 'Label (optional)';
    labelField.appendChild(labelLabel);
    var labelInput = document.createElement('input');
    labelInput.type = 'text';
    labelInput.placeholder = 'Defaults to the prefix itself';
    labelField.appendChild(labelInput);
    card.appendChild(labelField);

    var commentField = document.createElement('div');
    commentField.className = 'field';
    var commentLabel = document.createElement('label');
    commentLabel.textContent = 'Comment (optional)';
    commentField.appendChild(commentLabel);
    var commentArea = document.createElement('textarea');
    commentField.appendChild(commentArea);
    card.appendChild(commentField);

    var actionsRow = document.createElement('div');
    actionsRow.className = 'form-actions';
    var createBtn = document.createElement('button');
    createBtn.type = 'button'; createBtn.className = 'btn primary'; createBtn.textContent = 'Create Namespace';
    var cancelBtn = document.createElement('button');
    cancelBtn.type = 'button'; cancelBtn.className = 'btn'; cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', closeNewNamespaceForm);
    createBtn.addEventListener('click', function(){
      errorBox.innerHTML = '';
      var prefix = prefixInput.value.trim();
      var uri = uriInput.value.trim();
      if (!prefix || !NAMESPACE_PREFIX_RE.test(prefix)){
        var warn = document.createElement('p');
        warn.className = 'warn';
        warn.textContent = 'Enter a prefix starting with a letter or underscore (letters, digits, "_", "-", "." only).';
        errorBox.appendChild(warn);
        return;
      }
      if (!uri){
        var warn2 = document.createElement('p');
        warn2.className = 'warn';
        warn2.textContent = 'Enter the namespace URI.';
        errorBox.appendChild(warn2);
        return;
      }
      var clash = namespacesData.find(function(x){ return x.prefix === prefix || x.uri === uri; });
      if (clash){
        var warn3 = document.createElement('p');
        warn3.className = 'warn';
        warn3.textContent = 'That ' + (clash.prefix === prefix ? 'prefix' : 'URI') + ' is already registered (' + (clash.label || clash.prefix) + ').';
        errorBox.appendChild(warn3);
        return;
      }
      var newIri = uniqueShapeIri(namespaceRegistryBase() + prefix, namespacesData);
      createBtn.disabled = true; createBtn.textContent = 'Creating…';
      var turtle = buildCreateNamespaceTurtle(newIri, prefix, uri, labelInput.value.trim(), commentArea.value.trim());
      callTool(SERVER, 'push_turtle', {turtle: turtle, graph_iri: ONTOLOGY_GRAPH, mode: 'merge'})
        .then(function(){ return mcp.invalidate(SERVER, 'sparql_select').catch(function(){}); })
        .then(function(){ return loadNamespacesData(); })
        .then(function(){ renderNamespaces(); selectNamespace(newIri); })
        .catch(function(err){
          createBtn.disabled = false; createBtn.textContent = 'Create Namespace';
          renderBanner(errorBox, err);
        });
    });
    actionsRow.appendChild(createBtn);
    actionsRow.appendChild(cancelBtn);
    card.appendChild(actionsRow);
    return card;
  }

  function openNewNamespaceForm(){
    selectedNamespaceIri = null;
    renderNamespaces();
    $detail.innerHTML = '';
    var inner = document.createElement('div');
    inner.className = 'detail-inner';
    var h2 = document.createElement('h2');
    h2.className = 'title';
    h2.textContent = 'New Namespace';
    inner.appendChild(h2);
    inner.appendChild(buildNewNamespaceForm());
    $detail.appendChild(inner);
  }
  function closeNewNamespaceForm(){
    renderNamespaces();
    if (selectedNamespaceIri) selectNamespace(selectedNamespaceIri);
    else renderIdleDetail('Nothing selected');
  }

  // Every namespace registry entry (used as options in the class/property
  // "New ..." forms' namespace picker) sorted the way a human reads a
  // prefix list -- alphabetically, deprecated entries last so the "live"
  // choices sort to the top without disappearing entirely.
  function activeNamespaceOptions(){
    return namespacesData.slice().sort(function(a, b){
      var da = !!deprecatedSet[a.iri], db = !!deprecatedSet[b.iri];
      if (da !== db) return da ? 1 : -1;
      return a.prefix.localeCompare(b.prefix);
    });
  }

  // ----------------------------------------------------------------------
  // "Read Namespaces From Dataset" -- scans HOLONS_GRAPH/ONTOLOGY_GRAPH/
  // SHACL_GRAPH for every namespace actually IN USE (as a subject, predicate,
  // or IRI object) and offers to register whichever ones aren't already a
  // Namespaces-tab entry, so the registry can be bootstrapped from real data
  // instead of hand-typed one at a time.
  // ----------------------------------------------------------------------

  // Built fresh on every call (a function, not a top-level joined string) so
  // it always embeds whatever HOLONS_GRAPH/ONTOLOGY_GRAPH/SHACL_GRAPH
  // currently are -- the same staleness guard used throughout this file for
  // any query that embeds a GRAPH clause directly rather than taking one as
  // a graph: parameter (this one spans three graphs at once, so it can't use
  // that parameter form).
  function discoverNamespacesQuery(){
    return [
      "SELECT ?ns (SAMPLE(?iri) AS ?example) (COUNT(?iri) AS ?usageCount) WHERE {",
      "  {",
      "    SELECT DISTINCT ?iri WHERE {",
      "      { GRAPH <" + HOLONS_GRAPH + "> { ?iri ?hp1 ?ho1 } }",
      "      UNION { GRAPH <" + HOLONS_GRAPH + "> { ?hs1 ?iri ?ho2 } }",
      "      UNION { GRAPH <" + HOLONS_GRAPH + "> { ?hs2 ?hp2 ?iri } }",
      "      UNION { GRAPH <" + ONTOLOGY_GRAPH + "> { ?iri ?op1 ?oo1 } }",
      "      UNION { GRAPH <" + ONTOLOGY_GRAPH + "> { ?os1 ?iri ?oo2 } }",
      "      UNION { GRAPH <" + ONTOLOGY_GRAPH + "> { ?os2 ?op2 ?iri } }",
      "      UNION { GRAPH <" + SHACL_GRAPH + "> { ?iri ?sp1 ?so1 } }",
      "      UNION { GRAPH <" + SHACL_GRAPH + "> { ?ss1 ?iri ?so2 } }",
      "      UNION { GRAPH <" + SHACL_GRAPH + "> { ?ss2 ?sp2 ?iri } }",
      "      FILTER(isIRI(?iri))",
      "    }",
      "  }",
      "  BIND(REPLACE(STR(?iri), \"^(.*[/#])[^/#]*$\", \"$1\") AS ?ns)",
      // Excludes both the no-separator case (ns falls back to the whole
      // IRI) and the bare-domain case (e.g. a plain "https://example.com"
      // IRI with no path reduces to the degenerate "namespace" "https://"),
      // neither of which is a real, offerable namespace.
      "  FILTER(?ns != \"\" && ?ns != STR(?iri) && !REGEX(?ns, \"^[a-zA-Z][a-zA-Z0-9+.-]*://$\"))",
      "}",
      "GROUP BY ?ns",
      "ORDER BY DESC(?usageCount)"
    ].join("\n");
  }

  // Structural RDF/SHACL vocabularies -- always excluded from discovery
  // results, since offering to "register" rdf:/rdfs:/owl:/xsd:/sh: as a
  // namespace choice for minting new classes or properties would just be
  // noise every admin would decline every time.
  var CORE_VOCAB_NAMESPACES = {
    "http://www.w3.org/1999/02/22-rdf-syntax-ns#": true,
    "http://www.w3.org/2000/01/rdf-schema#": true,
    "http://www.w3.org/2002/07/owl#": true,
    "http://www.w3.org/2001/XMLSchema#": true,
    "http://www.w3.org/ns/shacl#": true
  };

  // Heuristic only, always shown as an editable field before registering --
  // takes the last alphanumeric run before a trailing "#"/"/" (or, failing
  // that, the first label of the hostname) as a short, lowercase guess.
  function suggestPrefixForNamespace(ns){
    var trimmed = ns.replace(/[#\/]+$/, '');
    var m = trimmed.match(/([A-Za-z][A-Za-z0-9]*)$/);
    var candidate = m ? m[1].toLowerCase() : '';
    if (!candidate){
      var hostMatch = ns.match(/^[a-z]+:\/\/(?:www\.)?([^.\/]+)/i);
      candidate = hostMatch ? hostMatch[1].toLowerCase() : 'ns';
    }
    return candidate.slice(0, 16);
  }

  function openDiscoverNamespacesForm(){
    selectedNamespaceIri = null;
    renderNamespaces();
    $detail.innerHTML = '';
    var inner = document.createElement('div');
    inner.className = 'detail-inner';
    var h2 = document.createElement('h2');
    h2.className = 'title';
    h2.textContent = 'Read Namespaces From Dataset';
    inner.appendChild(h2);
    var loading = document.createElement('p');
    loading.className = 'hint';
    loading.textContent = 'Scanning the dataset for namespaces in use…';
    inner.appendChild(loading);
    $detail.appendChild(inner);

    callTool(SERVER, 'sparql_select', {query: discoverNamespacesQuery()})
      .then(function(res){
        var bindings = (res.payload && res.payload.results && res.payload.results.bindings) || [];
        var registered = {};
        namespacesData.forEach(function(n){ registered[n.uri] = true; });
        var candidates = bindings
          .map(function(b){
            return {
              ns: b.ns.value,
              example: b.example ? b.example.value : '',
              usageCount: b.usageCount ? parseInt(b.usageCount.value, 10) || 0 : 0
            };
          })
          .filter(function(c){ return !registered[c.ns] && !CORE_VOCAB_NAMESPACES[c.ns]; });
        inner.removeChild(loading);
        if (!candidates.length){
          var none = document.createElement('p');
          none.className = 'hint';
          none.textContent = 'No unregistered namespaces found -- everything currently in use in this dataset already has a Namespaces entry.';
          inner.appendChild(none);
          var backBtn = document.createElement('button');
          backBtn.type = 'button'; backBtn.className = 'btn';
          backBtn.textContent = 'Back to Namespaces';
          backBtn.style.marginTop = '10px';
          backBtn.addEventListener('click', closeNewNamespaceForm);
          inner.appendChild(backBtn);
          return;
        }
        inner.appendChild(buildDiscoveredNamespacesReview(candidates));
      })
      .catch(function(err){
        inner.removeChild(loading);
        renderBanner(inner, err, function(){ openDiscoverNamespacesForm(); });
      });
  }

  function buildDiscoveredNamespacesReview(candidates){
    var card = document.createElement('div');
    card.className = 'addchild-form';
    var hint = document.createElement('p');
    hint.className = 'hint';
    hint.textContent = 'Found ' + candidates.length + ' namespace(s) in use that aren’t formally declared yet. Adjust the suggested prefixes as needed, uncheck any you don’t want, then register the rest as sh:declare / sh:PrefixDeclaration entries.';
    card.appendChild(hint);

    var errorBox = document.createElement('div');
    card.appendChild(errorBox);

    var usedPrefixes = {};
    namespacesData.forEach(function(n){ usedPrefixes[n.prefix] = true; });

    var rowsList = document.createElement('div');
    var entries = candidates.map(function(c){
      var base = suggestPrefixForNamespace(c.ns) || 'ns';
      var candidatePrefix = base, i = 2;
      while (usedPrefixes[candidatePrefix]){ candidatePrefix = base + i; i++; }
      usedPrefixes[candidatePrefix] = true;

      var row = document.createElement('div');
      row.style.cssText = 'display:flex; align-items:flex-start; gap:8px; border-bottom:1px solid rgba(128,128,128,0.25); padding:8px 0;';

      var check = document.createElement('input');
      check.type = 'checkbox';
      check.checked = true;
      check.style.marginTop = '5px';
      row.appendChild(check);

      var prefixInput = document.createElement('input');
      prefixInput.type = 'text';
      prefixInput.value = candidatePrefix;
      prefixInput.style.cssText = 'width:76px; flex:0 0 auto;';
      row.appendChild(prefixInput);

      var info = document.createElement('div');
      info.style.cssText = 'flex:1 1 auto; min-width:0;';
      var nsLine = document.createElement('div');
      nsLine.textContent = c.ns;
      nsLine.style.cssText = 'font-family:monospace; font-size:11.5px; overflow-wrap:anywhere;';
      info.appendChild(nsLine);
      var metaLine = document.createElement('div');
      metaLine.className = 'hint';
      metaLine.style.margin = '2px 0 0';
      metaLine.textContent = 'used ' + c.usageCount + '× -- e.g. ' + (c.example || c.ns);
      info.appendChild(metaLine);
      row.appendChild(info);

      rowsList.appendChild(row);
      return {ns: c.ns, check: check, prefixInput: prefixInput};
    });
    card.appendChild(rowsList);

    var actionsRow = document.createElement('div');
    actionsRow.className = 'form-actions';
    var registerBtn = document.createElement('button');
    registerBtn.type = 'button'; registerBtn.className = 'btn primary'; registerBtn.textContent = 'Register Selected';
    var cancelBtn = document.createElement('button');
    cancelBtn.type = 'button'; cancelBtn.className = 'btn'; cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', closeNewNamespaceForm);

    registerBtn.addEventListener('click', function(){
      errorBox.innerHTML = '';
      var selected = entries.filter(function(e){ return e.check.checked; });
      if (!selected.length){
        var warn0 = document.createElement('p');
        warn0.className = 'warn';
        warn0.textContent = 'Select at least one namespace to register.';
        errorBox.appendChild(warn0);
        return;
      }
      var seenPrefixes = {};
      for (var i = 0; i < selected.length; i++){
        var pfx = selected[i].prefixInput.value.trim();
        if (!pfx || !NAMESPACE_PREFIX_RE.test(pfx)){
          var warn1 = document.createElement('p');
          warn1.className = 'warn';
          warn1.textContent = 'Enter a valid prefix for ' + selected[i].ns + ' (letters/digits/"_"/"-"/"." only, starting with a letter or underscore).';
          errorBox.appendChild(warn1);
          return;
        }
        if (namespacesData.some(function(n){ return n.prefix === pfx; }) || seenPrefixes[pfx]){
          var warn2 = document.createElement('p');
          warn2.className = 'warn';
          warn2.textContent = 'Prefix "' + pfx + '" is already used -- choose a different prefix for ' + selected[i].ns + '.';
          errorBox.appendChild(warn2);
          return;
        }
        seenPrefixes[pfx] = true;
      }
      registerBtn.disabled = true; cancelBtn.disabled = true; registerBtn.textContent = 'Registering…';
      var newEntries = selected.map(function(e){
        var pfx = e.prefixInput.value.trim();
        return {
          iri: uniqueShapeIri(namespaceRegistryBase() + pfx, namespacesData),
          prefix: pfx,
          uri: e.ns
        };
      });
      var turtle = newEntries.map(function(e){
        return buildCreateNamespaceTurtle(e.iri, e.prefix, e.uri, '', '');
      }).join('\n\n');
      callTool(SERVER, 'push_turtle', {turtle: turtle, graph_iri: ONTOLOGY_GRAPH, mode: 'merge'})
        .then(function(){ return mcp.invalidate(SERVER, 'sparql_select').catch(function(){}); })
        .then(function(){ return loadNamespacesData(); })
        .then(function(){
          renderNamespaces();
          if (newEntries.length === 1) selectNamespace(newEntries[0].iri);
          else renderIdleDetail(newEntries.length + ' namespaces registered.');
        })
        .catch(function(err){
          registerBtn.disabled = false; cancelBtn.disabled = false; registerBtn.textContent = 'Register Selected';
          renderBanner(errorBox, err);
        });
    });
    actionsRow.appendChild(registerBtn);
    actionsRow.appendChild(cancelBtn);
    card.appendChild(actionsRow);
    return card;
  }

  function bindingsToRows(bindings){
    var byPred = {};
    var order = [];
    bindings.forEach(function(b){
      var p = b.p.value;
      if (!byPred[p]){ byPred[p] = []; order.push(p); }
      byPred[p].push(b.o);
    });
    return {byPred: byPred, order: order};
  }

  function valueNode(o){
    if (o.type === 'uri'){
      var known = iriToLabel[o.value];
      if (known){
        var chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'chip';
        chip.innerHTML = '<span>' + known + '</span><span class="arrow">&#8594;</span>';
        chip.addEventListener('click', function(){ selectHolon(o.value); });
        return chip;
      }
      var ext = document.createElement('span');
      ext.className = 'ext';
      var label = labelCache[o.value] || humanize(o.value);
      // A concept value already set on this holon stays displayed even once
      // deprecated -- deprecation only hides it from future pickers, per the
      // "never delete, only deprecate" rule -- but it's tagged here so it's
      // clear the taxonomy has moved on.
      ext.textContent = label + (deprecatedSet[o.value] ? ' (deprecated)' : '');
      ext.title = o.value;
      return ext;
    }
    var num = formatNumber(o.value, o.datatype);
    var span = document.createElement('span');
    if (num !== null){
      span.className = 'num';
      span.textContent = num;
    } else if (o.datatype && /date/i.test(o.datatype)){
      span.className = 'plain';
      span.textContent = formatDate(o.value);
    } else {
      span.className = 'plain';
      span.textContent = o.value;
    }
    return span;
  }

  function renderDetailSkeleton(){
    var inner = document.createElement('div');
    inner.className = 'detail-inner';
    for (var i=0;i<5;i++){
      var sk = document.createElement('div');
      sk.className = 'skeleton';
      sk.style.width = (40 + Math.random()*50) + '%';
      sk.style.height = i===0 ? '30px' : '14px';
      inner.appendChild(sk);
    }
    $detail.innerHTML = '';
    $detail.appendChild(inner);
  }

  function renderDetail(iri, bindings, cache){
    var rows = bindingsToRows(bindings);
    var ownLabel = (rows.byPred[LABEL_PREDICATE] || [])[0];
    var label = ownLabel ? ownLabel.value : (iriToLabel[iri] || humanize(iri));
    var types = (rows.byPred[TYPE_PREDICATE] || [])
      .map(function(o){ return o.value; })
      .filter(function(t){ return t !== HOLON_CLASS; });
    var description = (rows.byPred[DESCRIPTION_PREDICATE] || [])[0];
    var status = (rows.byPred[STATUS_PREDICATE] || [])[0];

    var inner = document.createElement('div');
    inner.className = 'detail-inner';

    var badges = document.createElement('div');
    badges.className = 'badges';
    var specificTypes = mostSpecificTypes(types);
    var orderedTypes = specificTypes.concat(types.filter(function(t){ return specificTypes.indexOf(t) === -1; }));
    orderedTypes.forEach(function(t){
      var p = document.createElement('span');
      p.className = 'pill type';
      p.textContent = humanize(t);
      badges.appendChild(p);
    });
    if (status){
      var sp = document.createElement('span');
      sp.className = 'pill status';
      sp.textContent = humanize(status.value).replace(/\s*Status$/, '');
      badges.appendChild(sp);
    }
    inner.appendChild(badges);

    var isEditing = editOpenFor === iri;

    if (!isEditing){
      var h2 = document.createElement('h2');
      h2.className = 'title';
      h2.textContent = label;
      inner.appendChild(h2);
    }

    var iriLine = document.createElement('div');
    iriLine.className = 'iri';
    iriLine.textContent = iri;
    inner.appendChild(iriLine);

    var actions = document.createElement('div');
    actions.className = 'actions';
    var editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.className = 'btn';
    editBtn.textContent = isEditing ? 'Cancel Edit' : 'Edit';
    editBtn.addEventListener('click', function(){
      editOpenFor = isEditing ? null : iri;
      if (editOpenFor){ addChildOpenFor = null; addConnOpenFor = null; }
      rerenderDetail();
    });
    actions.appendChild(editBtn);
    var addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'btn';
    addBtn.textContent = (addChildOpenFor === iri) ? 'Cancel' : '+ Add Child Holon';
    addBtn.addEventListener('click', function(){
      addChildOpenFor = (addChildOpenFor === iri) ? null : iri;
      if (addChildOpenFor){ editOpenFor = null; addConnOpenFor = null; }
      rerenderDetail();
    });
    actions.appendChild(addBtn);
    var connBtn = document.createElement('button');
    connBtn.type = 'button';
    connBtn.className = 'btn';
    connBtn.textContent = (addConnOpenFor === iri) ? 'Cancel' : '+ Add Connection';
    connBtn.addEventListener('click', function(){
      addConnOpenFor = (addConnOpenFor === iri) ? null : iri;
      if (addConnOpenFor){ editOpenFor = null; addChildOpenFor = null; }
      rerenderDetail();
    });
    actions.appendChild(connBtn);

    var isConfirmingDelete = deleteConfirmFor === iri;
    var deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className = 'btn';
    deleteBtn.textContent = isConfirmingDelete ? 'Confirm Delete' : 'Delete';
    if (isConfirmingDelete){
      deleteBtn.style.borderColor = 'var(--bad)';
      deleteBtn.style.color = 'var(--bad)';
    }
    deleteBtn.addEventListener('click', function(){
      if (!isConfirmingDelete){
        deleteConfirmFor = iri;
        editOpenFor = null;
        addChildOpenFor = null;
        addConnOpenFor = null;
        rerenderDetail();
        return;
      }
      performDelete(iri, label);
    });
    actions.appendChild(deleteBtn);
    if (isConfirmingDelete){
      var cancelDeleteBtn = document.createElement('button');
      cancelDeleteBtn.type = 'button';
      cancelDeleteBtn.className = 'btn';
      cancelDeleteBtn.textContent = 'Cancel';
      cancelDeleteBtn.addEventListener('click', function(){
        deleteConfirmFor = null;
        rerenderDetail();
      });
      actions.appendChild(cancelDeleteBtn);
    }
    inner.appendChild(actions);

    if (isConfirmingDelete){
      var deleteWarn = document.createElement('p');
      deleteWarn.className = 'warn';
      deleteWarn.style.margin = '-14px 0 22px';
      deleteWarn.textContent = 'This permanently removes ' + label + ' and every triple that names it, including links from other holons -- e.g. children whose parent is this one. This can’t be undone from here.';
      inner.appendChild(deleteWarn);
    }

    if (isEditing){
      inner.appendChild(buildEditForm(iri, label, types, description ? description.value : '', rows));
    }

    if (addChildOpenFor === iri){
      inner.appendChild(buildAddChildForm(iri, label, types));
    }

    if (addConnOpenFor === iri){
      inner.appendChild(buildAddConnectionForm(iri, label, types, rows));
    }

    if (description && !isEditing){
      var desc = document.createElement('div');
      desc.className = 'description';
      desc.innerHTML = markdownToHtml(description.value);
      inner.appendChild(desc);
    }

    var metaBits = [];
    Object.keys(META_PREDICATES).forEach(function(p){
      var v = (rows.byPred[p] || [])[0];
      if (!v) return;
      var text = v.type === 'uri' ? humanize(v.value) : formatDate(v.value);
      metaBits.push(META_PREDICATES[p] + ' ' + text);
    });
    if (metaBits.length){
      var prov = document.createElement('p');
      prov.className = 'provenance';
      prov.textContent = metaBits.join('  ·  ');
      inner.appendChild(prov);
    }

    var propOrder = rows.order.filter(function(p){
      return !SKIP_PREDICATES[p] && !META_PREDICATES[p] && p !== STATUS_PREDICATE;
    });
    if (propOrder.length){
      var secLabel = document.createElement('div');
      secLabel.className = 'section-label';
      secLabel.textContent = 'Properties';
      inner.appendChild(secLabel);

      var kv = document.createElement('div');
      kv.className = 'kv';
      propOrder.forEach(function(p){
        var row = document.createElement('div');
        row.className = 'kv-row';
        var key = document.createElement('div');
        key.className = 'kv-key';
        key.textContent = humanize(p);
        key.setAttribute('data-prop-path', p);
        row.appendChild(key);
        var val = document.createElement('div');
        val.className = 'kv-val';
        rows.byPred[p].forEach(function(o){ val.appendChild(valueNode(o)); });
        row.appendChild(val);
        kv.appendChild(row);
      });
      inner.appendChild(kv);
      if (types.length) applyShapeTooltips(inner, types);
    }

    if (!isEditing){
      var refsHolder = document.createElement('div');
      inner.appendChild(refsHolder);
      loadReferences(refsHolder, iri);
    }

    if (cache && cache.storedAt){
      var stale = document.createElement('p');
      stale.className = 'provenance';
      stale.style.marginTop = '18px';
      stale.textContent = 'Live from Holonbridge-Workbench · as of ' + new Date(cache.storedAt).toLocaleTimeString('en-GB', {hour:'2-digit', minute:'2-digit'});
      inner.appendChild(stale);
    }

    $detail.innerHTML = '';
    $detail.appendChild(inner);
  }

  function rerenderDetail(){
    if (lastDetailBindings) renderDetail(selectedIri, lastDetailBindings, lastDetailCache);
  }

  function buildAddChildForm(parentIri, parentLabel, parentTypes){
    // Two modes share one card: 'create' (the original behaviour -- mint a
    // brand-new holon) and 'attach' (link an EXISTING holon in as a child
    // by writing holon:isPartOf on it, nothing minted). Attach reuses
    // relationInsertData exactly as the Holon Relationships section's
    // Child Holons field does lower on this same page -- direction 'in'
    // writes "<selected> holon:isPartOf <parentIri>" as a grounded
    // INSERT DATA, so this never disturbs any parent link the selected
    // holon already has (a holon can carry more than one isPartOf, same
    // as that field already allows).
    var mode = 'create';

    // null means this parent's own type(s) declare no isPartOf child
    // constraint anywhere in the SHACL -- stay fully open, today's
    // behaviour. A non-null array (StellarSystem -> [Star], Star ->
    // [Planet], Planet -> [Moon], ...) restricts both the New Holon type
    // choices and the Existing Holon candidate pool to exactly those
    // classes, so a Moon can't be offered as a direct child of a Stellar
    // System even though nothing stops it being created elsewhere.
    var permitted = permittedChildTypesFor(parentTypes);
    if (permitted && !permitted.length) permitted = null;

    var card = document.createElement('div');
    card.className = 'addchild-form';

    var h3 = document.createElement('h3');
    card.appendChild(h3);

    var hint = document.createElement('p');
    hint.className = 'hint';
    card.appendChild(hint);

    var modeRow = document.createElement('div');
    modeRow.style.cssText = 'display:flex; gap:6px; margin:-4px 0 16px;';
    var createModeBtn = document.createElement('button');
    createModeBtn.type = 'button'; createModeBtn.className = 'btn';
    createModeBtn.style.cssText = 'font-size:12px; padding:5px 10px;';
    createModeBtn.textContent = 'New Holon';
    var attachModeBtn = document.createElement('button');
    attachModeBtn.type = 'button'; attachModeBtn.className = 'btn';
    attachModeBtn.style.cssText = 'font-size:12px; padding:5px 10px;';
    attachModeBtn.textContent = 'Existing Holon';
    modeRow.appendChild(createModeBtn);
    modeRow.appendChild(attachModeBtn);
    card.appendChild(modeRow);

    var errorBox = document.createElement('div');
    card.appendChild(errorBox);

    var createWrap = document.createElement('div');
    card.appendChild(createWrap);

    var nameField = document.createElement('div');
    nameField.className = 'field';
    var nameLabel = document.createElement('label');
    nameLabel.textContent = 'Name';
    nameLabel.htmlFor = 'newHolonName';
    nameField.appendChild(nameLabel);
    var nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.id = 'newHolonName';
    nameInput.placeholder = 'e.g. Port Moresby';
    nameField.appendChild(nameInput);
    createWrap.appendChild(nameField);

    var typeField = document.createElement('div');
    typeField.className = 'field';
    var typeLabel = document.createElement('label');
    typeLabel.textContent = permitted ? 'Type' : 'Type (optional)';
    typeLabel.htmlFor = 'newHolonType';
    typeField.appendChild(typeLabel);
    var typeSelect = document.createElement('select');
    typeSelect.id = 'newHolonType';
    if (permitted){
      // Restricted: only the SHACL-permitted classes are offered, and
      // there's no "no specific type" option -- an untyped child here
      // wouldn't satisfy the sh:class constraint that got it restricted
      // in the first place, so the choice is which permitted type, not
      // whether to have one.
      permitted.slice().sort(function(a, b){ return humanize(a).localeCompare(humanize(b)); }).forEach(function(t){
        var opt = document.createElement('option');
        opt.value = t;
        opt.textContent = humanize(t);
        typeSelect.appendChild(opt);
      });
    } else {
      var noneOpt = document.createElement('option');
      noneOpt.value = '';
      noneOpt.textContent = 'No specific type (holon:Holon only)';
      typeSelect.appendChild(noneOpt);
      var seen = {};
      holons.forEach(function(h){ h.types.forEach(function(t){ seen[t] = true; }); });
      Object.keys(seen).sort(function(a, b){ return humanize(a).localeCompare(humanize(b)); }).forEach(function(t){
        var opt = document.createElement('option');
        opt.value = t;
        opt.textContent = humanize(t);
        typeSelect.appendChild(opt);
      });
    }
    typeField.appendChild(typeSelect);
    createWrap.appendChild(typeField);
    if (permitted){
      var typeRestrictHint = document.createElement('p');
      typeRestrictHint.className = 'hint';
      typeRestrictHint.style.margin = '-8px 0 12px';
      typeRestrictHint.textContent = 'Restricted to ' + permitted.map(humanize).join(' or ') + ' here, per this holon’s SHACL shape.';
      typeField.appendChild(typeRestrictHint);
    }

    var descField = document.createElement('div');
    descField.className = 'field';
    var descLabel = document.createElement('label');
    descLabel.textContent = 'Description';
    descLabel.htmlFor = 'newHolonDesc';
    descField.appendChild(descLabel);
    var descArea = document.createElement('textarea');
    descArea.id = 'newHolonDesc';
    descArea.placeholder = 'A sentence or two describing this holon — becomes its holon:description.';
    descField.appendChild(descArea);
    createWrap.appendChild(descField);

    // Attach mode: pick any other existing holon and link it in as a child
    // of this one, writing holon:isPartOf on the SELECTED holon -- nothing
    // is minted. Plain sorted <select>, matching the convention every other
    // holon-picker in this file already uses (buildRelationField's Parent/
    // Child Holon(s) fields, the Add-of-type class dropdown) rather than a
    // new autocomplete widget.
    var attachWrap = document.createElement('div');
    attachWrap.hidden = true;
    var attachField = document.createElement('div');
    attachField.className = 'field';
    var attachLabel = document.createElement('label');
    attachLabel.textContent = 'Holon';
    attachLabel.htmlFor = 'attachHolonSelect';
    attachField.appendChild(attachLabel);
    var attachSelect = document.createElement('select');
    attachSelect.id = 'attachHolonSelect';
    var attachBlank = document.createElement('option');
    attachBlank.value = '';
    attachBlank.textContent = '— choose an existing holon —';
    attachSelect.appendChild(attachBlank);
    holons
      .filter(function(h){ return h.iri !== parentIri; })
      .filter(function(h){ return !permitted || h.types.some(function(t){ return permitted.indexOf(t) !== -1; }); })
      .slice()
      .sort(function(a, b){ return a.label.localeCompare(b.label); })
      .forEach(function(h){
        var opt = document.createElement('option');
        opt.value = h.iri;
        var t = primaryType(h.types);
        opt.textContent = h.label + (t ? ' (' + humanize(t) + ')' : '');
        attachSelect.appendChild(opt);
      });
    attachField.appendChild(attachSelect);
    attachWrap.appendChild(attachField);
    card.appendChild(attachWrap);

    // "Also set on the child": the child's own shape properties that echo
    // holon:isPartOf (sh:class = one of this parent's types -- sol:orbits
    // for a Moon under a Planet). Shown in both modes, recomputed whenever
    // the chosen type (create) or chosen holon (attach) changes, each one
    // ticked by default so the child ends up fully linked rather than
    // isPartOf-only. Empty -- and hidden -- for the many types whose shape
    // points nothing at the parent's class.
    var echoWrap = document.createElement('div');
    echoWrap.className = 'field';
    echoWrap.hidden = true;
    card.appendChild(echoWrap);
    var echoToken = 0;
    function childTypesForEcho(){
      if (mode === 'create') return typeSelect.value ? [typeSelect.value] : [];
      var h = holons.find(function(x){ return x.iri === attachSelect.value; });
      return h ? h.types : [];
    }
    function refreshEcho(){
      var token = ++echoToken;
      echoWrap.hidden = true;
      echoWrap.innerHTML = '';
      echoPropertiesFor(childTypesForEcho(), parentTypes).then(function(list){
        if (token !== echoToken || !list.length) return;
        var lbl = document.createElement('label');
        lbl.textContent = 'Also set on the child';
        echoWrap.appendChild(lbl);
        var note = document.createElement('p');
        note.className = 'hint';
        note.style.margin = '-2px 0 6px';
        note.textContent = 'Properties on the child’s own shape whose class is this holon’s type -- each one is written pointing at ' + parentLabel + ', alongside holon:isPartOf.';
        echoWrap.appendChild(note);
        list.forEach(function(p){
          var row = document.createElement('label');
          row.style.cssText = 'display:flex; align-items:center; gap:7px; font-weight:500; margin-bottom:4px; cursor:pointer;';
          var cb = document.createElement('input');
          cb.type = 'checkbox';
          cb.checked = true;
          cb.setAttribute('data-echo-path', p.path);
          cb.setAttribute('data-echo-single', p.maxCount === 1 ? '1' : '0');
          row.appendChild(cb);
          var txt = document.createElement('span');
          txt.textContent = p.name + ' → ' + parentLabel;
          row.appendChild(txt);
          echoWrap.appendChild(row);
        });
        echoWrap.hidden = false;
      });
    }
    function selectedEchoes(){
      return Array.prototype.slice.call(echoWrap.querySelectorAll('input[data-echo-path]'))
        .filter(function(cb){ return cb.checked; })
        .map(function(cb){ return {path: cb.getAttribute('data-echo-path'), single: cb.getAttribute('data-echo-single') === '1'}; });
    }
    typeSelect.addEventListener('change', refreshEcho);
    attachSelect.addEventListener('change', refreshEcho);

    var actionsRow = document.createElement('div');
    actionsRow.className = 'form-actions';
    var submitBtn = document.createElement('button');
    submitBtn.type = 'button';
    submitBtn.className = 'btn primary';
    var cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'btn';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', function(){
      addChildOpenFor = null;
      rerenderDetail();
    });

    function setMode(m){
      mode = m;
      createWrap.hidden = (m !== 'create');
      attachWrap.hidden = (m !== 'attach');
      createModeBtn.classList.toggle('primary', m === 'create');
      attachModeBtn.classList.toggle('primary', m === 'attach');
      h3.textContent = m === 'create' ? ('New child of ' + parentLabel) : ('Attach an existing holon to ' + parentLabel);
      var restrictSuffix = permitted ? (' Only ' + permitted.map(humanize).join(' or ') + ' can be linked here, per this holon’s SHACL shape.') : '';
      hint.textContent = m === 'create'
        ? 'Writes a new holon live to Holonbridge-Workbench, linked to this one by containment (geo:administrativePartOf for geography admin places like Country/City, holon:isPartOf otherwise).'
        : ('Links an already-existing holon to this one by containment (geo:administrativePartOf for geography admin places like Country/City, holon:isPartOf otherwise). Nothing new is created, and any parent link the holon already has is left alone.' + restrictSuffix);
      submitBtn.textContent = m === 'create' ? 'Create Holon' : 'Attach Holon';
      errorBox.innerHTML = '';
      refreshEcho();
    }
    createModeBtn.addEventListener('click', function(){ setMode('create'); });
    attachModeBtn.addEventListener('click', function(){ setMode('attach'); });

    submitBtn.addEventListener('click', function(){
      errorBox.innerHTML = '';
      if (mode === 'attach'){
        var selectedIri = attachSelect.value;
        if (!selectedIri){
          var warnA = document.createElement('p');
          warnA.className = 'warn';
          warnA.textContent = 'Choose a holon to attach.';
          errorBox.appendChild(warnA);
          return;
        }
        var attachPred = containmentPredicateFor(parentTypes, typesOfIri(selectedIri));
        var update = relationInsertData(parentIri, [{predicate: attachPred, newIri: selectedIri}], 'in');
        var echoes = selectedEchoes();
        submitBtn.disabled = true;
        submitBtn.textContent = 'Attaching…';
        var chain = callTool(SERVER, 'sparql_update', {update: update});
        // Echo properties go one update each, after isPartOf -- a
        // single-valued one (orbits) replaces whatever the holon had.
        echoes.forEach(function(e){
          chain = chain.then(function(){
            return callTool(SERVER, 'sparql_update', {update: buildEchoPropertySparql(selectedIri, e.path, parentIri, e.single)});
          });
        });
        chain
          .then(function(){
            addChildOpenFor = null;
            return mcp.invalidate(SERVER, 'sparql_select').catch(function(){});
          })
          .then(function(){
            loadList();
            var parentNode = treeNodes[parentIri];
            if (parentNode){
              parentNode.hasChildren = true;
              parentNode.expanded = true;
              parentNode.children = null;
              loadChildren(parentIri);
            }
            selectHolon(selectedIri);
          })
          .catch(function(err){
            submitBtn.disabled = false;
            submitBtn.textContent = 'Attach Holon';
            renderBanner(errorBox, err);
          });
        return;
      }
      var name = nameInput.value.trim();
      if (!name){
        var warn = document.createElement('p');
        warn.className = 'warn';
        warn.textContent = 'Name is required.';
        errorBox.appendChild(warn);
        return;
      }
      var newIri = 'https://w3id.org/data/holons/' + uniqueSlug(slugify(name));
      var turtle = buildCreateTurtle(parentIri, newIri, name, typeSelect.value || null, descArea.value.trim(), creatorIri,
        selectedEchoes().map(function(e){ return e.path; }));
      submitBtn.disabled = true;
      submitBtn.textContent = 'Creating…';
      callTool(SERVER, 'push_turtle', {turtle: turtle, graph_iri: HOLONS_GRAPH, mode: 'merge'})
        .then(function(){
          addChildOpenFor = null;
          mcp.invalidate(SERVER, 'sparql_select').catch(function(){});
          loadList();
          var parentNode = treeNodes[parentIri];
          if (parentNode){
            parentNode.hasChildren = true;
            parentNode.expanded = true;
            parentNode.children = null;
            loadChildren(parentIri);
          }
          selectHolon(newIri);
        })
        .catch(function(err){
          submitBtn.disabled = false;
          submitBtn.textContent = 'Create Holon';
          renderBanner(errorBox, err);
        });
    });
    actionsRow.appendChild(submitBtn);
    actionsRow.appendChild(cancelBtn);
    card.appendChild(actionsRow);

    setMode('create');
    return card;
  }

  // "+ Add Connection": the sibling of buildAddChildForm for every OTHER
  // holon-to-holon link this holon's own SHACL shape permits -- each
  // sh:class-bearing property on its NodeShape(s) (sol:hasCentralBody ->
  // Star, sol:orbits -> Star/Planet, holon:affiliation -> Organization,
  // ...), excluding the containment predicates Add Child already owns.
  // Pick the property, then either mint a new holon of that property's
  // class (a subclass may be chosen; both types are written explicitly,
  // no entailment) or pick an existing instance of it, and the link is
  // written on THIS holon: <this> <property> <target>. A single-valued
  // property (sh:maxCount 1) is replaced rather than added to, and the
  // form shows what it currently holds so the replacement is visible.
  // Echoes work the same way as Add Child but in the other direction --
  // properties on the TARGET's shape whose sh:class is this holon's type
  // are offered as "Also set on the target", pointing back here.
  function buildAddConnectionForm(sourceIri, sourceLabel, sourceTypes, rows){
    var mode = 'attach';
    var props = [];           // [{path, name, class, maxCount, description}]
    var current = null;       // the chosen prop meta

    var card = document.createElement('div');
    card.className = 'addchild-form';

    var h3 = document.createElement('h3');
    h3.textContent = 'New connection from ' + sourceLabel;
    card.appendChild(h3);

    var hint = document.createElement('p');
    hint.className = 'hint';
    hint.textContent = 'Links this holon to another one via a property its SHACL shape declares. Only what you choose here is written.';
    card.appendChild(hint);

    var errorBox = document.createElement('div');
    card.appendChild(errorBox);

    var propField = document.createElement('div');
    propField.className = 'field';
    var propLabel = document.createElement('label');
    propLabel.textContent = 'Property';
    propLabel.htmlFor = 'connPropSelect';
    propField.appendChild(propLabel);
    var propSelect = document.createElement('select');
    propSelect.id = 'connPropSelect';
    propField.appendChild(propSelect);
    var propHint = document.createElement('p');
    propHint.className = 'hint';
    propHint.style.margin = '-8px 0 12px';
    propField.appendChild(propHint);
    card.appendChild(propField);

    var body = document.createElement('div');
    body.hidden = true;
    card.appendChild(body);

    var modeRow = document.createElement('div');
    modeRow.style.cssText = 'display:flex; gap:6px; margin:0 0 14px;';
    var attachModeBtn = document.createElement('button');
    attachModeBtn.type = 'button'; attachModeBtn.className = 'btn';
    attachModeBtn.style.cssText = 'font-size:12px; padding:5px 10px;';
    attachModeBtn.textContent = 'Existing Holon';
    var createModeBtn = document.createElement('button');
    createModeBtn.type = 'button'; createModeBtn.className = 'btn';
    createModeBtn.style.cssText = 'font-size:12px; padding:5px 10px;';
    createModeBtn.textContent = 'New Holon';
    modeRow.appendChild(attachModeBtn);
    modeRow.appendChild(createModeBtn);
    body.appendChild(modeRow);

    // ---- Existing target ----
    var attachWrap = document.createElement('div');
    body.appendChild(attachWrap);
    var attachField = document.createElement('div');
    attachField.className = 'field';
    var attachLabel = document.createElement('label');
    attachLabel.textContent = 'Holon';
    attachLabel.htmlFor = 'connTargetSelect';
    attachField.appendChild(attachLabel);
    var attachSelect = document.createElement('select');
    attachSelect.id = 'connTargetSelect';
    attachField.appendChild(attachSelect);
    attachWrap.appendChild(attachField);

    // ---- New target ----
    var createWrap = document.createElement('div');
    createWrap.hidden = true;
    body.appendChild(createWrap);
    var nameField = document.createElement('div');
    nameField.className = 'field';
    var nameLabel = document.createElement('label');
    nameLabel.textContent = 'Name';
    nameLabel.htmlFor = 'connNewName';
    nameField.appendChild(nameLabel);
    var nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.id = 'connNewName';
    nameField.appendChild(nameInput);
    createWrap.appendChild(nameField);

    var typeField = document.createElement('div');
    typeField.className = 'field';
    var typeLabel = document.createElement('label');
    typeLabel.textContent = 'Type';
    typeLabel.htmlFor = 'connNewType';
    typeField.appendChild(typeLabel);
    var typeSelect = document.createElement('select');
    typeSelect.id = 'connNewType';
    typeField.appendChild(typeSelect);
    var typeHint = document.createElement('p');
    typeHint.className = 'hint';
    typeHint.style.margin = '-8px 0 12px';
    typeField.appendChild(typeHint);
    createWrap.appendChild(typeField);

    var parentField = document.createElement('div');
    parentField.className = 'field';
    var parentLabel = document.createElement('label');
    parentLabel.textContent = 'Part of';
    parentLabel.htmlFor = 'connNewParent';
    parentField.appendChild(parentLabel);
    var parentSelect = document.createElement('select');
    parentSelect.id = 'connNewParent';
    parentField.appendChild(parentSelect);
    var parentHint = document.createElement('p');
    parentHint.className = 'hint';
    parentHint.style.margin = '-8px 0 12px';
    parentHint.textContent = 'Where the new holon sits in the containment tree (holon:isPartOf). Defaults to this holon; "none" leaves it out of the tree.';
    parentField.appendChild(parentHint);
    createWrap.appendChild(parentField);

    var descField = document.createElement('div');
    descField.className = 'field';
    var descLabel = document.createElement('label');
    descLabel.textContent = 'Description';
    descLabel.htmlFor = 'connNewDesc';
    descField.appendChild(descLabel);
    var descArea = document.createElement('textarea');
    descArea.id = 'connNewDesc';
    descArea.placeholder = 'Optional — becomes its holon:description.';
    descField.appendChild(descArea);
    createWrap.appendChild(descField);

    // ---- Echoes back to this holon, from the target's shape ----
    var echoWrap = document.createElement('div');
    echoWrap.className = 'field';
    echoWrap.hidden = true;
    body.appendChild(echoWrap);
    var echoToken = 0;
    function targetTypesForEcho(){
      if (mode === 'create'){
        var chosen = typeSelect.value;
        if (!chosen) return [];
        // Mirror the type list the create path actually writes: the pick,
        // plus whichever of the property's target classes it descends from.
        var list = [chosen];
        ((current && current.classes) || []).forEach(function(c){
          if (chosen !== c && ancestorsOf(chosen)[c] && list.indexOf(c) === -1) list.push(c);
        });
        return list;
      }
      var h = holons.find(function(x){ return x.iri === attachSelect.value; });
      return h ? h.types : [];
    }
    function refreshEcho(){
      var token = ++echoToken;
      echoWrap.hidden = true;
      echoWrap.innerHTML = '';
      echoPropertiesFor(targetTypesForEcho(), sourceTypes).then(function(list){
        if (token !== echoToken || !list.length) return;
        var lbl = document.createElement('label');
        lbl.textContent = 'Also set on the target';
        echoWrap.appendChild(lbl);
        var note = document.createElement('p');
        note.className = 'hint';
        note.style.margin = '-2px 0 6px';
        note.textContent = 'Properties on the target’s own shape whose class is this holon’s type -- each one is written on the target, pointing back at ' + sourceLabel + '.';
        echoWrap.appendChild(note);
        list.forEach(function(p){
          var row = document.createElement('label');
          row.style.cssText = 'display:flex; align-items:center; gap:7px; font-weight:500; margin-bottom:4px; cursor:pointer;';
          var cb = document.createElement('input');
          cb.type = 'checkbox';
          cb.checked = true;
          cb.setAttribute('data-echo-path', p.path);
          cb.setAttribute('data-echo-single', p.maxCount === 1 ? '1' : '0');
          row.appendChild(cb);
          var txt = document.createElement('span');
          txt.textContent = p.name + ' → ' + sourceLabel;
          row.appendChild(txt);
          echoWrap.appendChild(row);
        });
        echoWrap.hidden = false;
      });
    }
    function selectedEchoes(){
      return Array.prototype.slice.call(echoWrap.querySelectorAll('input[data-echo-path]'))
        .filter(function(cb){ return cb.checked; })
        .map(function(cb){ return {path: cb.getAttribute('data-echo-path'), single: cb.getAttribute('data-echo-single') === '1'}; });
    }

    var actionsRow = document.createElement('div');
    actionsRow.className = 'form-actions';
    var submitBtn = document.createElement('button');
    submitBtn.type = 'button';
    submitBtn.className = 'btn primary';
    var cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'btn';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', function(){
      addConnOpenFor = null;
      rerenderDetail();
    });
    actionsRow.appendChild(submitBtn);
    actionsRow.appendChild(cancelBtn);
    body.appendChild(actionsRow);

    function setMode(m){
      mode = m;
      attachWrap.hidden = (m !== 'attach');
      createWrap.hidden = (m !== 'create');
      attachModeBtn.classList.toggle('primary', m === 'attach');
      createModeBtn.classList.toggle('primary', m === 'create');
      submitBtn.textContent = m === 'attach' ? 'Connect' : 'Create & Connect';
      errorBox.innerHTML = '';
      refreshEcho();
    }
    attachModeBtn.addEventListener('click', function(){ setMode('attach'); });
    createModeBtn.addEventListener('click', function(){ setMode('create'); });
    typeSelect.addEventListener('change', refreshEcho);
    attachSelect.addEventListener('change', refreshEcho);

    // Fills the target pool and the new-holon type list for the chosen
    // property: with one or more target classes (a plain sh:class, or every
    // alternative of an sh:or union like geo:strait's Ocean-or-Sea),
    // instances of ALL of those classes pooled together (the same
    // classInstancesQuery pool the Edit form's dropdown uses) and those
    // classes plus any known subclass; without any (sh:nodeKind IRI only),
    // every holon and every type.
    function applyProperty(p){
      current = p;
      var classes = (p && p.classes && p.classes.length) ? p.classes : [];
      var cls = classes.length === 1 ? classes[0] : null;
      var classesLabel = classes.map(humanize).join(' or ');
      var currentVals = (p && rows && rows.byPred[p.path]) ? rows.byPred[p.path].filter(function(o){ return o.type === 'uri'; }) : [];
      var bits = [];
      if (p && p.description) bits.push(p.description);
      bits.push(classes.length ? ('Target must be a ' + classesLabel + '.') : 'Any holon.');
      if (p && p.maxCount === 1){
        bits.push(currentVals.length
          ? ('Single-valued -- currently ' + (iriToLabel[currentVals[0].value] || labelCache[currentVals[0].value] || humanize(currentVals[0].value)) + ', which this will replace.')
          : 'Single-valued.');
      } else if (currentVals.length){
        bits.push('Currently ' + currentVals.length + ' value' + (currentVals.length === 1 ? '' : 's') + '; this adds another.');
      }
      propHint.textContent = bits.join(' ');

      attachSelect.innerHTML = '';
      var blank = document.createElement('option');
      blank.value = '';
      blank.textContent = '— choose a holon —';
      attachSelect.appendChild(blank);
      var alreadyLinked = {};
      currentVals.forEach(function(o){ alreadyLinked[o.value] = true; });
      function fillPool(list){
        list.filter(function(h){ return h.iri !== sourceIri && !alreadyLinked[h.iri]; })
          .slice().sort(function(a, b){ return a.label.localeCompare(b.label); })
          .forEach(function(h){
            var opt = document.createElement('option');
            opt.value = h.iri;
            opt.textContent = h.label;
            attachSelect.appendChild(opt);
          });
      }
      if (classes.length){
        Promise.all(classes.map(loadClassInstances)).then(function(lists){
          if (current !== p) return;
          var seen = {}, pooled = [];
          lists.forEach(function(list){
            list.forEach(function(x){
              if (!seen[x.iri]){ seen[x.iri] = true; pooled.push({iri: x.iri, label: x.label}); }
            });
          });
          fillPool(pooled);
        });
      } else {
        fillPool(holons);
      }

      typeSelect.innerHTML = '';
      var typeChoices;
      if (classes.length){
        typeChoices = classes.slice();
        computeAllTypes().forEach(function(t){
          if (typeChoices.indexOf(t) !== -1) return;
          if (classes.some(function(c){ return ancestorsOf(t)[c]; })) typeChoices.push(t);
        });
        typeHint.textContent = typeChoices.length > classes.length
          ? ('Restricted to ' + classesLabel + ' or a subclass; a subclass pick is written with both types.')
          : ('Restricted to ' + classesLabel + ', per this property’s shape.');
      } else {
        typeChoices = [''].concat(computeAllTypes());
        typeHint.textContent = '';
      }
      typeChoices.forEach(function(t){
        var opt = document.createElement('option');
        opt.value = t;
        opt.textContent = t ? humanize(t) : 'No specific type (holon:Holon only)';
        typeSelect.appendChild(opt);
      });

      parentSelect.innerHTML = '';
      var self = document.createElement('option');
      self.value = sourceIri;
      self.textContent = sourceLabel + ' (this holon)';
      parentSelect.appendChild(self);
      var noneOpt = document.createElement('option');
      noneOpt.value = '';
      noneOpt.textContent = 'none — not in the containment tree';
      parentSelect.appendChild(noneOpt);
      holons.filter(function(h){ return h.iri !== sourceIri; })
        .slice().sort(function(a, b){ return a.label.localeCompare(b.label); })
        .forEach(function(h){
          var opt = document.createElement('option');
          opt.value = h.iri;
          opt.textContent = h.label;
          parentSelect.appendChild(opt);
        });

      body.hidden = !p;
      if (p) setMode(mode);
    }

    propSelect.addEventListener('change', function(){
      var p = props.find(function(x){ return x.path === propSelect.value; }) || null;
      applyProperty(p);
    });

    submitBtn.addEventListener('click', function(){
      errorBox.innerHTML = '';
      if (!current) return;
      var single = current.maxCount === 1;
      var echoes = selectedEchoes();

      function finish(targetIri){
        // The connection itself is written on THIS holon; echoes on the
        // target, pointing back. invalidate before the re-read, as every
        // write path here does.
        var chain = callTool(SERVER, 'sparql_update', {update: buildEchoPropertySparql(sourceIri, current.path, targetIri, single)});
        echoes.forEach(function(e){
          chain = chain.then(function(){
            return callTool(SERVER, 'sparql_update', {update: buildEchoPropertySparql(targetIri, e.path, sourceIri, e.single)});
          });
        });
        return chain
          .then(function(){
            addConnOpenFor = null;
            return mcp.invalidate(SERVER, 'sparql_select').catch(function(){});
          })
          .then(function(){
            loadList();
            if (mode === 'create'){
              var parentIri = parentSelect.value;
              var parentNode = parentIri ? treeNodes[parentIri] : null;
              if (parentNode){
                parentNode.hasChildren = true;
                parentNode.expanded = true;
                parentNode.children = null;
                loadChildren(parentIri);
              }
            }
            selectHolon(sourceIri);
          });
      }

      if (mode === 'attach'){
        var targetIri = attachSelect.value;
        if (!targetIri){
          var warnA = document.createElement('p');
          warnA.className = 'warn';
          warnA.textContent = 'Choose a holon to connect to.';
          errorBox.appendChild(warnA);
          return;
        }
        submitBtn.disabled = true;
        submitBtn.textContent = 'Connecting…';
        finish(targetIri).catch(function(err){
          submitBtn.disabled = false;
          submitBtn.textContent = 'Connect';
          renderBanner(errorBox, err);
        });
        return;
      }

      var name = nameInput.value.trim();
      if (!name){
        var warn = document.createElement('p');
        warn.className = 'warn';
        warn.textContent = 'Name is required.';
        errorBox.appendChild(warn);
        return;
      }
      var newIri = 'https://w3id.org/data/holons/' + uniqueSlug(slugify(name));
      var chosenType = typeSelect.value || null;
      var typeList = [];
      if (chosenType) typeList.push(chosenType);
      // A subclass pick is written with the property's target class too --
      // the ONE of its classes the pick descends from (geo:strait offers
      // Ocean-or-Sea; picking a Sea subclass must add Sea, not Ocean).
      (current.classes || []).forEach(function(c){
        if (chosenType && chosenType !== c && ancestorsOf(chosenType)[c] && typeList.indexOf(c) === -1) typeList.push(c);
      });
      var turtle = buildCreateTurtle(parentSelect.value || null, newIri, name, typeList, descArea.value.trim(), creatorIri);
      submitBtn.disabled = true;
      submitBtn.textContent = 'Creating…';
      callTool(SERVER, 'push_turtle', {turtle: turtle, graph_iri: HOLONS_GRAPH, mode: 'merge'})
        .then(function(){ return finish(newIri); })
        .catch(function(err){
          submitBtn.disabled = false;
          submitBtn.textContent = 'Create & Connect';
          renderBanner(errorBox, err);
        });
    });

    // Property list: this holon's shape-declared object properties, minus
    // the containment ones. Loaded once per open, like the Edit form.
    var loadingOpt = document.createElement('option');
    loadingOpt.value = '';
    loadingOpt.textContent = 'Loading properties…';
    propSelect.appendChild(loadingOpt);
    propSelect.disabled = true;
    loadPropertyShapes(sourceTypes || []).then(function(all){
      props = all.filter(function(p){
        if (p.path === ISPARTOF_PREDICATE || p.path === ADMIN_PARTOF_PREDICATE) return false;
        if (p.classes && p.classes.length){
          if (p.classes.indexOf('http://www.w3.org/2004/02/skos/core#Concept') !== -1) return false;
          if (isContainmentEchoProperty(sourceTypes, p.classes)) return false;
          return true;
        }
        return !!(p.nodeKind && /IRI$/.test(p.nodeKind)) && !(p.inValues && p.inValues.length);
      });
      propSelect.innerHTML = '';
      propSelect.disabled = false;
      if (!props.length){
        var none = document.createElement('option');
        none.value = '';
        none.textContent = 'No holon-to-holon properties on this shape';
        propSelect.appendChild(none);
        propSelect.disabled = true;
        propHint.textContent = (sourceTypes && sourceTypes.length)
          ? 'This holon’s SHACL shape declares no property whose value is another holon. Containment links live under + Add Child Holon.'
          : 'This holon has no domain type, so no shape applies.';
        return;
      }
      var choose = document.createElement('option');
      choose.value = '';
      choose.textContent = '— choose a property —';
      propSelect.appendChild(choose);
      props.slice().sort(function(a, b){ return a.name.localeCompare(b.name); }).forEach(function(p){
        var opt = document.createElement('option');
        opt.value = p.path;
        opt.textContent = p.name + ((p.classes && p.classes.length) ? ' → ' + p.classes.map(humanize).join(' / ') : '');
        propSelect.appendChild(opt);
      });
      applyProperty(null);
    }).catch(function(err){
      propSelect.innerHTML = '';
      renderBanner(errorBox, err);
    });

    return card;
  }

  function buildEditForm(iri, currentName, currentTypes, currentDescription, currentRows){
    currentTypes = currentTypes || [];
    var card = document.createElement('div');
    card.className = 'addchild-form';

    var h3 = document.createElement('h3');
    h3.textContent = 'Edit holon';
    card.appendChild(h3);

    var hint = document.createElement('p');
    hint.className = 'hint';
    hint.textContent = 'Updates label, type, and description live on Holonbridge-Workbench. The IRI itself never changes.';
    card.appendChild(hint);

    var errorBox = document.createElement('div');
    card.appendChild(errorBox);

    var nameField = document.createElement('div');
    nameField.className = 'field';
    var nameLabel = document.createElement('label');
    nameLabel.textContent = 'Name';
    nameLabel.htmlFor = 'editHolonName';
    nameField.appendChild(nameLabel);
    var nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.id = 'editHolonName';
    nameInput.value = currentName;
    nameField.appendChild(nameInput);
    card.appendChild(nameField);

    var typeField = document.createElement('div');
    typeField.className = 'field';
    var typeLabel = document.createElement('label');
    typeLabel.textContent = 'Type(s)';
    typeLabel.htmlFor = 'editHolonType';
    typeField.appendChild(typeLabel);
    var typeHint = document.createElement('p');
    typeHint.className = 'hint';
    typeHint.style.margin = '-2px 0 6px';
    typeHint.textContent = 'A holon can carry more than one type (e.g. Geo Feature + River) — Ctrl/Cmd-click to select several, or none for holon:Holon only.';
    typeField.appendChild(typeHint);
    var typeSelect = document.createElement('select');
    typeSelect.id = 'editHolonType';
    typeSelect.multiple = true;
    var seen = {};
    holons.forEach(function(h){ h.types.forEach(function(t){ seen[t] = true; }); });
    currentTypes.forEach(function(t){ seen[t] = true; });
    var typeIris = Object.keys(seen).sort(function(a, b){ return humanize(a).localeCompare(humanize(b)); });
    typeSelect.size = Math.max(3, Math.min(8, typeIris.length));
    typeIris.forEach(function(t){
      var opt = document.createElement('option');
      opt.value = t;
      opt.textContent = typeLabelWithNamespace(t);
      opt.title = t;
      opt.selected = currentTypes.indexOf(t) !== -1;
      typeSelect.appendChild(opt);
    });
    typeField.appendChild(typeSelect);
    card.appendChild(typeField);

    var descField = document.createElement('div');
    descField.className = 'field';
    var descLabel = document.createElement('label');
    descLabel.textContent = 'Description';
    descLabel.htmlFor = 'editHolonDesc';
    descField.appendChild(descLabel);
    var descArea = document.createElement('textarea');
    descArea.id = 'editHolonDesc';
    descArea.value = currentDescription;
    descArea.placeholder = 'A sentence or two describing this holon — becomes its holon:description.';
    descField.appendChild(descArea);
    card.appendChild(descField);

    var shapeWrap = document.createElement('div');
    card.appendChild(shapeWrap);
    var shapeState = null;
    if (currentRows){
      loadPropertyShapeSection(shapeWrap, iri, currentTypes, currentRows, {name: currentName, description: currentDescription, descArea: descArea}, function(state){ shapeState = state; });
    }

    var relWrap = document.createElement('div');
    card.appendChild(relWrap);
    var relState = null;
    if (currentRows){
      loadRelationshipsSection(relWrap, iri, currentTypes, currentRows, function(state){ relState = state; });
    }

    var actionsRow = document.createElement('div');
    actionsRow.className = 'form-actions';
    var saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.className = 'btn primary';
    saveBtn.textContent = 'Save Changes';
    var cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'btn';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', function(){
      editOpenFor = null;
      rerenderDetail();
    });
    saveBtn.addEventListener('click', function(){
      var name = nameInput.value.trim();
      errorBox.innerHTML = '';
      if (!name){
        var warn = document.createElement('p');
        warn.className = 'warn';
        warn.textContent = 'Name is required.';
        errorBox.appendChild(warn);
        return;
      }
      var selectedTypes = Array.prototype.filter.call(typeSelect.options, function(o){ return o.selected; })
        .map(function(o){ return o.value; });
      var update = buildUpdateSparql(iri, name, selectedTypes, descArea.value.trim());
      var shapeUpdate = shapeState && shapeState.buildUpdate ? shapeState.buildUpdate() : null;
      var parentChanges = relState ? relState.getParentChanges() : [];
      var childChanges = relState ? relState.getChildChanges() : [];
      var connChanges = relState ? relState.getConnectionChanges() : [];
      var relationshipsTouched = !!(parentChanges.length || childChanges.length || connChanges.length);
      saveBtn.disabled = true;
      saveBtn.textContent = 'Saving…';
      function chainIfPresent(promise, updateStr){
        if (!updateStr) return promise;
        return promise.then(function(){ return callTool(SERVER, 'sparql_update', {update: updateStr}); });
      }
      var chain = callTool(SERVER, 'sparql_update', {update: update});
      if (shapeUpdate){
        chain = chain.then(function(){ return callTool(SERVER, 'sparql_update', {update: shapeUpdate}); });
      }
      chain = chainIfPresent(chain, relationDeleteData(iri, parentChanges, 'out'));
      chain = chainIfPresent(chain, relationInsertData(iri, parentChanges, 'out'));
      chain = chainIfPresent(chain, relationDeleteData(iri, childChanges, 'in'));
      chain = chainIfPresent(chain, relationInsertData(iri, childChanges, 'in'));
      chain = chainIfPresent(chain, relationDeleteData(iri, connChanges, 'out'));
      chain = chainIfPresent(chain, relationInsertData(iri, connChanges, 'out'));
      chain
        .then(function(){
          editOpenFor = null;
          mcp.invalidate(SERVER, 'sparql_select').catch(function(){});
          loadList();
          if (relationshipsTouched){
            // Parent/child edits can reshape the tree well beyond this one
            // node (a moved child, a newly linked parent elsewhere in the
            // tree), so rebuild it from the root rather than patching one
            // cached node in place.
            treeLoaded = false;
            treeNodes = {};
            if (currentView === 'tree') loadTreeRoot();
          } else {
            var node = treeNodes[iri];
            if (node){
              node.label = name;
              node.types = selectedTypes;
              renderTree();
            }
          }
          selectHolon(iri);
        })
        .catch(function(err){
          saveBtn.disabled = false;
          saveBtn.textContent = 'Save Changes';
          renderBanner(errorBox, err);
        });
    });
    actionsRow.appendChild(saveBtn);
    actionsRow.appendChild(cancelBtn);
    card.appendChild(actionsRow);

    return card;
  }

  // A neutral "nothing selected" screen for the detail pane -- used after
  // a delete, and as the fallback when Cancelling out of the "new <Type>"
  // form with no holon currently selected.
  function renderIdleDetail(heading){
    $detail.innerHTML = '';
    var inner = document.createElement('div');
    inner.className = 'detail-inner';
    var state = document.createElement('div');
    state.className = 'state';
    var h2 = document.createElement('h2');
    h2.textContent = heading;
    var p = document.createElement('p');
    p.textContent = 'Select a holon from the list, tree, or By Type view to see its details.';
    state.appendChild(h2);
    state.appendChild(p);
    inner.appendChild(state);
    $detail.appendChild(inner);
  }

  // Removes a holon entirely: every triple where it's the subject, then
  // every triple where it's the object (so nothing -- another holon's
  // isPartOf, an owns/controls/affiliation link, a Connections entry --
  // is left pointing at an IRI that no longer resolves to anything). Two
  // separate GRAPH-wrapped DELETE/WHERE calls, matching the house pattern
  // used everywhere else in this file rather than SPARQL's DELETE WHERE
  // shorthand.
  function buildDeleteOwnTriplesSparql(iri){
    return [
      'DELETE {',
      '  GRAPH <' + HOLONS_GRAPH + '> { <' + iri + '> ?p ?o }',
      '}',
      'WHERE {',
      '  GRAPH <' + HOLONS_GRAPH + '> { <' + iri + '> ?p ?o }',
      '}'
    ].join('\n');
  }

  function buildDeleteIncomingTriplesSparql(iri){
    return [
      'DELETE {',
      '  GRAPH <' + HOLONS_GRAPH + '> { ?s ?p <' + iri + '> }',
      '}',
      'WHERE {',
      '  GRAPH <' + HOLONS_GRAPH + '> { ?s ?p <' + iri + '> }',
      '}'
    ].join('\n');
  }

  function performDelete(iri, label){
    callTool(SERVER, 'sparql_update', {update: buildDeleteOwnTriplesSparql(iri)})
      .then(function(){ return callTool(SERVER, 'sparql_update', {update: buildDeleteIncomingTriplesSparql(iri)}); })
      .then(function(){
        deleteConfirmFor = null;
        if (detailUnsub){ detailUnsub(); detailUnsub = null; }
        lastDetailBindings = null;
        lastDetailCache = null;
        if (selectedIri === iri) selectedIri = null;
        delete treeNodes[iri];
        // A deleted node can vanish from anywhere in the tree, not just
        // wherever it happened to be expanded -- rebuild from the root
        // rather than trying to patch every cached parent in place.
        treeLoaded = false;
        treeNodes = {};
        mcp.invalidate(SERVER, 'sparql_select').catch(function(){});
        loadList();
        if (currentView === 'tree') loadTreeRoot();
        renderIdleDetail('Deleted ' + label + '.');
      })
      .catch(function(err){
        $detail.innerHTML = '';
        var inner = document.createElement('div');
        inner.className = 'detail-inner';
        $detail.appendChild(inner);
        renderBanner(inner, err, function(){ performDelete(iri, label); });
      });
  }

  // Opens the "create a new <Type>" screen in the detail pane -- reached
  // from a By Type group header's Add button, including an empty group's,
  // which is how a brand-new type gets its first instance. Unlike "Add
  // Child Holon" (fixed parent, chosen type), here the type is fixed and
  // the parent is chosen, defaulting to Home.
  function openAddTypeForm(typeIri, typeLabel){
    addTypeFor = typeIri;
    addTypeLabelText = typeLabel;
    $detail.innerHTML = '';
    var inner = document.createElement('div');
    inner.className = 'detail-inner';
    var h2 = document.createElement('h2');
    h2.className = 'title';
    h2.textContent = 'New ' + typeLabel;
    inner.appendChild(h2);
    inner.appendChild(buildCreateOfTypeForm(typeIri, typeLabel));
    $detail.appendChild(inner);
  }

  function closeAddTypeForm(){
    addTypeFor = null;
    addTypeLabelText = null;
    if (selectedIri) selectHolon(selectedIri);
    else renderIdleDetail('Nothing selected');
  }

  function buildCreateOfTypeForm(typeIri, typeLabel){
    var card = document.createElement('div');
    card.className = 'addchild-form';

    var hint = document.createElement('p');
    hint.className = 'hint';
    hint.textContent = 'Writes a new ' + typeLabel + ' holon live to Holonbridge-Workbench.';
    card.appendChild(hint);

    var errorBox = document.createElement('div');
    card.appendChild(errorBox);

    var nameField = document.createElement('div');
    nameField.className = 'field';
    var nameLabel = document.createElement('label');
    nameLabel.textContent = 'Name';
    nameField.appendChild(nameLabel);
    var nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.placeholder = 'e.g. ' + typeLabel;
    nameField.appendChild(nameInput);
    card.appendChild(nameField);

    var parentField = document.createElement('div');
    parentField.className = 'field';
    var parentLabel = document.createElement('label');
    parentLabel.textContent = 'Parent Holon';
    parentField.appendChild(parentLabel);
    var parentSelect = document.createElement('select');
    holons.slice().sort(function(a, b){ return a.label.localeCompare(b.label); }).forEach(function(h){
      var opt = document.createElement('option');
      opt.value = h.iri;
      opt.textContent = h.label;
      if (h.iri === HOME_IRI) opt.selected = true;
      parentSelect.appendChild(opt);
    });
    parentField.appendChild(parentSelect);
    card.appendChild(parentField);

    var descField = document.createElement('div');
    descField.className = 'field';
    var descLabel = document.createElement('label');
    descLabel.textContent = 'Description';
    descField.appendChild(descLabel);
    var descArea = document.createElement('textarea');
    descArea.placeholder = 'A sentence or two describing this holon — becomes its holon:description.';
    descField.appendChild(descArea);
    card.appendChild(descField);

    var actionsRow = document.createElement('div');
    actionsRow.className = 'form-actions';
    var createBtn = document.createElement('button');
    createBtn.type = 'button';
    createBtn.className = 'btn primary';
    createBtn.textContent = 'Create Holon';
    var cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'btn';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', closeAddTypeForm);
    createBtn.addEventListener('click', function(){
      var name = nameInput.value.trim();
      errorBox.innerHTML = '';
      if (!name){
        var warn = document.createElement('p');
        warn.className = 'warn';
        warn.textContent = 'Name is required.';
        errorBox.appendChild(warn);
        return;
      }
      var parentIri = parentSelect.value || HOME_IRI;
      var newIri = 'https://w3id.org/data/holons/' + uniqueSlug(slugify(name));
      var turtle = buildCreateTurtle(parentIri, newIri, name, typeIri, descArea.value.trim(), creatorIri);
      createBtn.disabled = true;
      createBtn.textContent = 'Creating…';
      callTool(SERVER, 'push_turtle', {turtle: turtle, graph_iri: HOLONS_GRAPH, mode: 'merge'})
        .then(function(){
          addTypeFor = null;
          addTypeLabelText = null;
          mcp.invalidate(SERVER, 'sparql_select').catch(function(){});
          loadList();
          var parentNode = treeNodes[parentIri];
          if (parentNode){
            parentNode.hasChildren = true;
            parentNode.expanded = true;
            parentNode.children = null;
            loadChildren(parentIri);
          }
          selectHolon(newIri);
        })
        .catch(function(err){
          createBtn.disabled = false;
          createBtn.textContent = 'Create Holon';
          renderBanner(errorBox, err);
        });
    });
    actionsRow.appendChild(createBtn);
    actionsRow.appendChild(cancelBtn);
    card.appendChild(actionsRow);

    return card;
  }

  function selectHolon(iri){
    selectedIri = iri;
    addChildOpenFor = null;
    addConnOpenFor = null;
    editOpenFor = null;
    lastDetailBindings = null;
    lastDetailCache = null;
    renderList();
    if (treeLoaded) renderTree();
    renderDetailSkeleton();
    if (detailUnsub){ detailUnsub(); detailUnsub = null; }
    var myGen = datasetGeneration;
    detailUnsub = mcp.watchTool(SERVER, 'sparql_select', {query: detailQuery(iri), graph: HOLONS_GRAPH}, function(ev){
      if (myGen !== datasetGeneration) return;
      if (ev.type === 'error'){
        $detail.innerHTML = '';
        var inner = document.createElement('div');
        inner.className = 'detail-inner';
        $detail.appendChild(inner);
        renderBanner(inner, ev.error, function(){ selectHolon(iri); });
        return;
      }
      var bindings = (ev.result.payload && ev.result.payload.results && ev.result.payload.results.bindings) || [];
      lastDetailBindings = bindings;
      lastDetailCache = ev.result.cache;
      renderDetail(iri, bindings, ev.result.cache);
    });
  }

  function loadList(){
    renderListSkeleton();
    // Captured so the watch callback below can tell whether a dataset
    // switch has happened since this watch was registered -- watchTool has
    // no explicit unsubscribe for this call site (unlike selectHolon's
    // detailUnsub), so an in-flight watch on the OLD dataset's LIST_QUERY
    // is still technically live when enterDataset() moves on; without this
    // guard a slow response from the previous dataset could land after the
    // new one has already started rendering and silently overwrite it.
    var myGen = datasetGeneration;
    mcp.watchTool(SERVER, 'sparql_select', {query: LIST_QUERY, graph: HOLONS_GRAPH}, function(ev){
      if (myGen !== datasetGeneration) return;
      if (ev.type === 'error'){
        $list.innerHTML = '';
        renderBanner($list, ev.error, function(){ loadList(); });
        setConn('bad', 'query failed');
        return;
      }
      var bindings = (ev.result.payload && ev.result.payload.results && ev.result.payload.results.bindings) || [];
      holons = bindings.map(function(b){
        return {
          iri: b.holon.value,
          label: b.label.value,
          types: b.types ? b.types.value.split('|').filter(Boolean) : []
        };
      }).sort(function(a, b){ return a.label.localeCompare(b.label, undefined, {sensitivity: 'base'}); });
      iriToLabel = {};
      holons.forEach(function(h){ iriToLabel[h.iri] = h.label; });
      listCacheInfo = ev.result.cache || {storedAt: Date.now()};
      renderUpdated();
      renderList();
      renderByType();
      setConn('ok', DATASET + ' <b>&middot;</b> ' + SERVER);
      if (!selectedIri){
        var withType = holons.find(function(h){ return h.types.length; }) || holons[0];
        if (withType) selectHolon(withType.iri);
      }
    });
  }

  function showWaitingScreen(bankName, datasetName){
    $detail.innerHTML = '';
    var waiting = document.createElement('div');
    waiting.className = 'detail-inner';
    waiting.innerHTML = '<div class="state"><h2>Reaching ' + SERVER + '&hellip;</h2>' +
      '<p>Switching to the <code>' + bankName + '</code> bank and <code>' + datasetName + '</code> dataset, then loading the holon registry.</p></div>';
    $detail.appendChild(waiting);
  }

  // Clears every piece of per-dataset state before switching -- one dataset
  // has nothing to do with another's class hierarchy, SHACL shapes, holon
  // list, current selection, or open forms, so all of it starts genuinely
  // fresh rather than carrying stale entries from whatever was active
  // before. Added 2026-09-15 alongside the Bank/Dataset pickers -- before
  // this, a page load only ever set this state up ONCE, so nothing needed
  // to tear it back down.
  function resetDatasetState(){
    if (detailUnsub){ detailUnsub(); detailUnsub = null; }
    shapeCache = {};
    classInstanceCache = {};
    classInstanceData = {};
    labelCache = {};
    directSuper = {};
    ancestorCache = {};
    shapeTargetClasses = [];
    childTypeConstraints = {};
    inverseNamesPromise = null;
    enumSchemesPromise = null;
    deprecatedSetPromise = null;
    deprecatedSet = {};
    partOfPredicatesPromise = null;
    holons = [];
    iriToLabel = {};
    selectedIri = null;
    lastDetailBindings = null;
    lastDetailCache = null;
    listCacheInfo = null;
    treeLoaded = false;
    treeNodes = {};
    taxonomiesLoaded = false;
    schemesData = [];
    nodeShapesLoaded = false;
    nodeShapesData = [];
    selectedNodeShapeIri = null;
    nodeShapeEditOpenFor = null;
    propShapesLoaded = false;
    propShapesData = [];
    selectedPropShapeIri = null;
    propShapeEditOpenFor = null;
    allPropertiesPromise = null;
    classesLoaded = false;
    classesData = [];
    selectedClassIri = null;
    classEditOpenFor = null;
    propertiesLoaded = false;
    propertiesData = [];
    selectedPropertyIri = null;
    propertyEditOpenFor = null;
    namespacesLoaded = false;
    namespacesData = [];
    selectedNamespaceIri = null;
    namespaceEditOpenFor = null;
    addChildOpenFor = null;
    addConnOpenFor = null;
    editOpenFor = null;
    if ($search) $search.value = '';
    // Reset the rail back to the List tab -- a Containment Tree or
    // Taxonomies view mid-render for the OLD dataset makes no sense once
    // the new one's data starts arriving.
    currentView = 'list';
    $viewSelect.value = 'list';
    $list.hidden = false;
    $byType.hidden = true;
    $tree.hidden = true;
    $taxonomies.hidden = true;
    $nodeShapes.hidden = true;
    $propShapes.hidden = true;
    $classes.hidden = true;
    $properties.hidden = true;
    $namespaces.hidden = true;
    $searchWrap.hidden = false;
  }

  // The whoami + class-hierarchy + shapes + list chain every successful
  // boot needs, whether that's the very first page load or a later switch
  // into a dataset that already has (or was just given) a holon:Home.
  // Split out of enterDataset() so renderUnboundState()'s "Create Root
  // Holon" button can re-enter this exact same path the moment a Home
  // exists, without repeating switch_dataset/get_endpoint/homeQuery.
  function loadDatasetContent(myGen){
    return callTool(SERVER, 'whoami', {}).catch(function(){ return null; })
      .then(function(res){
        if (myGen !== datasetGeneration) return;
        creatorIri = (res && res.payload && res.payload.person) || null;
        return Promise.all([loadClassHierarchy(), loadShapeTargetClasses(), loadDeprecatedSet(), loadChildTypeConstraints()]);
      })
      .then(function(){
        if (myGen !== datasetGeneration) return;
        loadList();
        setPickersEnabled(true);
      });
  }

  // Renders the "this dataset has nothing holon-shaped in it yet" state in
  // place of the normal list/detail UI, with a small form to mint the one
  // thing every other view here assumes exists: a holon:Home. See
  // homeQuery/homeIriFor/buildRootHolonTurtle above for how "unbound" is
  // detected and what gets written.
  function renderUnboundState(datasetName, graphIri, myGen){
    setConn(null, datasetName + ' <b>&middot;</b> unbound');
    $list.innerHTML = '<div class="list-empty">No holon:Home yet in this dataset — create one to get started.</div>';
    $byType.innerHTML = '';
    $count.textContent = '';
    $updated.textContent = '';
    $detail.innerHTML = '';
    var inner = document.createElement('div');
    inner.className = 'detail-inner';
    $detail.appendChild(inner);

    var state = document.createElement('div');
    state.className = 'state';
    state.innerHTML = '<h2>“' + datasetName + '” isn’t holon-configured yet</h2>' +
      '<p>This dataset exists on the bridge, but its holons graph (<code>' + graphIri + '</code>) has no <code>holon:Home</code> instance — the canonical landing point every other view here assumes is there. Give it one to bootstrap the dataset; nothing else is written.</p>';
    inner.appendChild(state);

    var form = document.createElement('div');
    form.className = 'addchild-form';
    form.style.maxWidth = '480px';

    var labelField = document.createElement('div');
    labelField.className = 'field';
    var labelLabel = document.createElement('label');
    labelLabel.textContent = 'Label';
    labelField.appendChild(labelLabel);
    var labelInput = document.createElement('input');
    labelInput.type = 'text';
    labelInput.value = humanize(datasetName) + ' Home';
    labelField.appendChild(labelInput);
    form.appendChild(labelField);

    var descField = document.createElement('div');
    descField.className = 'field';
    var descLabel = document.createElement('label');
    descLabel.textContent = 'Description (optional)';
    descField.appendChild(descLabel);
    var descArea = document.createElement('textarea');
    descArea.placeholder = 'Canonical landing point for the ' + datasetName + ' dataset.';
    descField.appendChild(descArea);
    form.appendChild(descField);

    var errorBox = document.createElement('div');
    form.appendChild(errorBox);

    var actionsRow = document.createElement('div');
    actionsRow.className = 'form-actions';
    var createBtn = document.createElement('button');
    createBtn.type = 'button';
    createBtn.className = 'btn primary';
    createBtn.textContent = 'Create Root Holon';
    createBtn.addEventListener('click', function(){
      errorBox.innerHTML = '';
      var homeIri = homeIriFor(graphIri);
      var turtle = buildRootHolonTurtle(homeIri, labelInput.value.trim() || (humanize(datasetName) + ' Home'), descArea.value.trim());
      createBtn.disabled = true;
      createBtn.textContent = 'Creating…';
      callTool(SERVER, 'push_turtle', {turtle: turtle, graph_iri: graphIri, mode: 'merge'})
        .then(function(){
          if (myGen !== datasetGeneration) return;
          HOME_IRI = homeIri;
          // Every other write-then-read path in this file invalidates the
          // sparql_select cache before its next read (see the comment on
          // the scheme-deprecate toggle) -- this one didn't, so the very
          // first LIST_QUERY fetch for a freshly-unbound dataset kept
          // serving the pre-write "empty dataset" result forever: holons
          // stayed [], nothing matched loadList()'s auto-select, and
          // $detail was never replaced -- the button just sat on
          // "Creating…" even though the write itself had already
          // succeeded. Found 2026-09-16 against a genuinely-empty
          // CS-HB-MCP4/acmeco dataset (the first time this path had
          // ever actually run against data with nothing cached from
          // before).
          return mcp.invalidate(SERVER, 'sparql_select').catch(function(){});
        })
        .then(function(){
          if (myGen !== datasetGeneration) return;
          return loadDatasetContent(myGen);
        })
        .catch(function(err){
          createBtn.disabled = false;
          createBtn.textContent = 'Create Root Holon';
          renderBanner(errorBox, err);
        });
    });
    actionsRow.appendChild(createBtn);
    form.appendChild(actionsRow);
    inner.appendChild(form);
    setPickersEnabled(true);
  }

  function setPickersEnabled(enabled){
    $serverSelect.disabled = !enabled;
    $bankSelect.disabled = !enabled;
    $datasetSelect.disabled = !enabled;
  }

  // The single entry point for "make THIS dataset (on the currently active
  // bank) the one the whole app shows" -- the initial boot, a Dataset
  // picker change, and a Bank picker change (which first repoints the bank,
  // then calls this for whichever dataset it settles on) all funnel through
  // here. datasetGeneration is bumped up front so any async work still
  // in flight from a PREVIOUS call (a slow query, a live watch) recognises
  // itself as stale and no-ops instead of clobbering whatever this call
  // ends up rendering -- see the comment on datasetGeneration's declaration.
  function enterDataset(name){
    datasetGeneration++;
    var myGen = datasetGeneration;
    resetDatasetState();
    DATASET = name;
    if ($datasetSelect.value !== name) $datasetSelect.value = name;
    setPickersEnabled(false);
    setConn(null, 'switching…');
    showWaitingScreen(BANK, name);

    callTool(SERVER, 'switch_dataset', {name: name})
      .then(function(){ return callTool(SERVER, 'get_endpoint', {}); })
      .then(function(res){
        if (myGen !== datasetGeneration) return;
        var graphs = (res && res.payload && res.payload.graphs) || {};
        // Fall back to the one pattern every bank observed so far follows
        // (urn:holongraph:{dataset}:{key}) if get_endpoint ever omits a key
        // -- better to guess consistently than to leave a graph IRI pointed
        // at the PREVIOUS dataset.
        HOLONS_GRAPH = graphs.holons || ("urn:holongraph:" + name + ":holons");
        ONTOLOGY_GRAPH = graphs.ontology || ("urn:holongraph:" + name + ":ontology");
        SHACL_GRAPH = graphs.shacl || ("urn:holongraph:" + name + ":shacl");
        return callTool(SERVER, 'sparql_select', {query: homeQuery(HOLONS_GRAPH)});
      })
      .then(function(res){
        if (myGen !== datasetGeneration) return;
        var bindings = (res && res.payload && res.payload.results && res.payload.results.bindings) || [];
        if (bindings.length){
          HOME_IRI = bindings[0].home.value;
          return loadDatasetContent(myGen);
        }
        renderUnboundState(name, HOLONS_GRAPH, myGen);
      })
      .catch(function(err){
        if (myGen !== datasetGeneration) return;
        setConn('bad', 'setup failed');
        $detail.innerHTML = '';
        var inner2 = document.createElement('div');
        inner2.className = 'detail-inner';
        $detail.appendChild(inner2);
        var hdr = document.createElement('div');
        hdr.className = 'state';
        hdr.innerHTML = '<h2>Couldn’t set up the “' + name + '” dataset</h2><p>The dataset switch failed before any holon could load.</p>';
        inner2.appendChild(hdr);
        renderBanner(inner2, err, function(){ enterDataset(name); });
        setPickersEnabled(true);
      });
  }

  // Populates the Bank/Dataset <select>s from list_banks/list_datasets.
  // Called once at boot; the Dataset one is also repopulated after every
  // bank switch, since the set of datasets a bank's server actually hosts
  // (list_datasets, the true universe) has nothing to do with whichever
  // OTHER bank was active a moment ago.
  function populateSelect(select, items, activeValue){
    select.innerHTML = '';
    items.forEach(function(item){
      var opt = document.createElement('option');
      opt.value = item.value;
      opt.textContent = item.label;
      if (item.value === activeValue) opt.selected = true;
      select.appendChild(opt);
    });
  }

  function loadDatasetOptions(activeName){
    return callTool(SERVER, 'list_datasets', {}).then(function(res){
      var list = (res && res.payload && res.payload.datasets) || [];
      populateSelect($datasetSelect, list.map(function(d){ return {value: d.name, label: d.name}; }), activeName);
      return list;
    });
  }

  // Picks which dataset a freshly-switched-to bank should open by default:
  // its own curated bankScopedDatasets first entry if it has one (that's
  // the bank's "known good" shortlist), else its nominal `dataset` field if
  // the server actually hosts it, else just the first dataset the server
  // reports -- always SOMETHING, since list_datasets always returns the
  // true universe even when bankScopedDatasets is empty (as "local" and
  // "secondary" both currently are).
  function defaultDatasetFor(bank, hostedList){
    var hostedNames = hostedList.map(function(d){ return d.name; });
    if (bank.bankScopedDatasets && bank.bankScopedDatasets.length && hostedNames.indexOf(bank.bankScopedDatasets[0]) !== -1){
      return bank.bankScopedDatasets[0];
    }
    if (bank.dataset && hostedNames.indexOf(bank.dataset) !== -1) return bank.dataset;
    return hostedNames[0] || null;
  }

  function onBankChange(){
    var name = $bankSelect.value;
    if (!name || name === BANK) return;
    setPickersEnabled(false);
    setConn(null, 'switching bank…');
    showWaitingScreen(name, '…');
    callTool(SERVER, 'switch_bank', {name: name})
      .then(function(){ return callTool(SERVER, 'list_banks', {}); })
      .then(function(res){
        var banks = (res && res.payload && res.payload.banks) || [];
        var bank = banks.filter(function(b){ return b.name === name; })[0] || {name: name};
        BANK = name;
        return loadDatasetOptions(null).then(function(hostedList){
          var target = defaultDatasetFor(bank, hostedList);
          if (!target){
            setPickersEnabled(true);
            setConn('bad', 'no datasets on this bank');
            return;
          }
          enterDataset(target);
        });
      })
      .catch(function(err){
        setPickersEnabled(true);
        setConn('bad', 'bank switch failed');
        $detail.innerHTML = '';
        var inner = document.createElement('div');
        inner.className = 'detail-inner';
        $detail.appendChild(inner);
        renderBanner(inner, err, function(){ onBankChange(); });
      });
  }

  function onDatasetChange(){
    var name = $datasetSelect.value;
    if (!name || name === DATASET) return;
    enterDataset(name);
  }

  // The switch_bank -> list_banks -> (repopulate Bank select) ->
  // loadDatasetOptions -> enterDataset chain every connect needs, whether
  // that's the very first page load (init(), once claude.use('mcp') has
  // resolved) or a later switch to a different connector (onServerChange()
  // -- the same acquired `mcp` namespace calls straight into it, just with
  // SERVER/BANK/DATASET already repointed, since a single `mcp` capability
  // can address any connector by name; no need to re-acquire it per switch).
  function connectToServer(){
    setPickersEnabled(false);
    setConn(null, 'switching…');
    showWaitingScreen(BANK, DATASET);
    callTool(SERVER, 'switch_bank', {name: BANK})
      .then(function(){ return callTool(SERVER, 'list_banks', {}); })
      .then(function(res){
        var banks = (res && res.payload && res.payload.banks) || [];
        populateSelect($bankSelect, banks.map(function(b){ return {value: b.name, label: b.name}; }), BANK);
        return loadDatasetOptions(DATASET);
      })
      .then(function(){
        setPickersEnabled(true);
        enterDataset(DATASET);
      })
      .catch(function(err){
        setConn('bad', 'setup failed');
        $detail.innerHTML = '';
        var inner2 = document.createElement('div');
        inner2.className = 'detail-inner';
        $detail.appendChild(inner2);
        var hdr = document.createElement('div');
        hdr.className = 'state';
        hdr.innerHTML = '<h2>Couldn’t reach the bridge</h2><p>Listing banks/datasets failed before any holon could load.</p>';
        inner2.appendChild(hdr);
        renderBanner(inner2, err, connectToServer);
        setPickersEnabled(true);
      });
  }

  // Fires when the Connector picker changes. Resets BANK/DATASET to that
  // connector's own defaults (see CONNECTORS above) rather than carrying
  // over whichever Bank/Dataset happened to be active on the PREVIOUS
  // connector -- those names are meaningless on a different bridge.
  function onServerChange(){
    var name = $serverSelect.value;
    if (!name || name === SERVER) return;
    var defaults = CONNECTORS[name] || {bank: BANK, dataset: DATASET};
    SERVER = name;
    BANK = defaults.bank;
    DATASET = defaults.dataset;
    connectToServer();
  }

  function init(){
    setConn(null, 'connecting…');
    showWaitingScreen(BANK, DATASET);

    claude.use('mcp').then(function(ns){
      if (!ns){
        setConn('bad', 'unavailable');
        $detail.innerHTML = '';
        var inner = document.createElement('div');
        inner.className = 'detail-inner';
        inner.innerHTML = '<div class="state"><h2>Live data isn’t available in this view</h2>' +
          '<p>This copy of the page can’t call your connectors — open it directly from claude.ai with Holonbridge&#8209;Workbench connected.</p></div>';
        $detail.appendChild(inner);
        $list.innerHTML = '<div class="list-empty">No connector available.</div>';
        return;
      }
      mcp = ns;
      populateSelect($serverSelect, Object.keys(CONNECTORS).map(function(k){ return {value: k, label: k}; }), SERVER);
      connectToServer();
    });
  }

  // Discards every cached sparql_select result (list, tree, detail — all
  // of it) and re-queries live, so edits made directly against the graph
  // outside this page (SPARQL UPDATE, push_turtle, another session) show
  // up here without a full page reload. Both refresh buttons share this.
  function refreshAll(){
    if (!mcp) return;
    shapeCache = {};
    classInstanceCache = {};
    classInstanceData = {};
    labelCache = {};
    var buttons = [$refresh, $refreshTop];
    buttons.forEach(function(b){ b.disabled = true; b.textContent = b === $refreshTop ? '↻ Refreshing…' : 'Refreshing…'; });
    mcp.invalidate(SERVER, 'sparql_select').catch(function(){})
      // Re-pull the class hierarchy and shape target classes too -- picks up
      // any ontology/SHACL edit made directly against the graph (a new Kind,
      // a new shape) so By Type's group list stays current, not just the
      // holon data inside those groups.
      .then(function(){ return Promise.all([loadClassHierarchy(), loadShapeTargetClasses(), loadDeprecatedSet(true), loadChildTypeConstraints()]); })
      .then(function(){
        buttons.forEach(function(b){ b.disabled = false; b.textContent = b === $refreshTop ? '↻ Refresh' : 'Refresh'; });
        loadList();
        if (selectedIri) selectHolon(selectedIri);
        if (currentView === 'tree'){
          treeLoaded = false;
          treeNodes = {};
          loadTreeRoot();
        }
        if (currentView === 'taxonomies'){
          loadTaxonomies(true);
        }
        if (currentView === 'nodeshapes'){
          loadNodeShapes(true);
        }
        if (currentView === 'propshapes'){
          allPropertiesPromise = null;
          loadPropertyShapesTab(true);
        }
        if (currentView === 'classes'){
          loadClassesTab(true);
        }
        if (currentView === 'properties'){
          loadPropertiesTab(true);
        }
        if (currentView === 'namespaces'){
          loadNamespaces(true);
        }
      });
  }

  // Draggable divider between the rail (selection: All Holons / By Type /
  // Containment Tree / Taxonomies) and the detail pane (display/edit).
  // Width lives as an inline style on #rail -- simplest thing that beats
  // the CSS var-with-fallback rule in the stylesheet -- and is echoed to
  // localStorage so it survives a reload/republish for this viewer, in
  // this browser (best-effort: wrapped in try/catch, since a private
  // window or blocked site data can make either call throw or no-op).
  (function initRailResizer(){
    var STORAGE_KEY = 'worldtest-viewer:rail-width';
    var DEFAULT_WIDTH = 320;
    var MIN_WIDTH = 220;

    function maxWidth(){
      var layoutW = $layout.getBoundingClientRect().width;
      // Leave the detail pane at least 320px, however wide the window is.
      return Math.max(MIN_WIDTH, Math.min(640, layoutW - 320));
    }
    function clampWidth(w){
      return Math.max(MIN_WIDTH, Math.min(maxWidth(), w));
    }
    function applyWidth(w, persist){
      w = clampWidth(w);
      $rail.style.width = w + 'px';
      $railResizer.setAttribute('aria-valuemin', String(MIN_WIDTH));
      $railResizer.setAttribute('aria-valuemax', String(maxWidth()));
      $railResizer.setAttribute('aria-valuenow', String(Math.round(w)));
      if (persist){
        try { localStorage.setItem(STORAGE_KEY, String(Math.round(w))); } catch(e){}
      }
      return w;
    }

    var restored = DEFAULT_WIDTH;
    try {
      var saved = localStorage.getItem(STORAGE_KEY);
      if (saved && !isNaN(Number(saved))) restored = Number(saved);
    } catch(e){}
    applyWidth(restored, false);
    // Re-clamp on window resize so a saved wide rail doesn't crowd out the
    // detail pane if the window (or the artifact frame) gets narrower.
    window.addEventListener('resize', function(){
      applyWidth(parseFloat($rail.style.width) || DEFAULT_WIDTH, false);
    });

    var dragging = false, startX = 0, startWidth = 0;

    function onMove(clientX){
      applyWidth(startWidth + (clientX - startX), false);
    }
    function stopDrag(finalWidth){
      if (!dragging) return;
      dragging = false;
      $layout.classList.remove('resizing');
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      document.removeEventListener('touchmove', onTouchMove);
      document.removeEventListener('touchend', onTouchEnd);
      applyWidth(finalWidth != null ? finalWidth : parseFloat($rail.style.width), true);
    }
    function onMouseMove(e){ onMove(e.clientX); }
    function onMouseUp(e){ stopDrag(e.clientX != null ? startWidth + (e.clientX - startX) : null); }
    function onTouchMove(e){
      if (e.touches && e.touches.length) { onMove(e.touches[0].clientX); e.preventDefault(); }
    }
    function onTouchEnd(){ stopDrag(null); }

    function startDrag(clientX){
      dragging = true;
      startX = clientX;
      startWidth = $rail.getBoundingClientRect().width;
      $layout.classList.add('resizing');
    }

    $railResizer.addEventListener('mousedown', function(e){
      if (e.button !== 0) return;
      e.preventDefault();
      startDrag(e.clientX);
      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    });
    $railResizer.addEventListener('touchstart', function(e){
      if (!e.touches || !e.touches.length) return;
      startDrag(e.touches[0].clientX);
      document.addEventListener('touchmove', onTouchMove, {passive:false});
      document.addEventListener('touchend', onTouchEnd);
    }, {passive:true});
    $railResizer.addEventListener('dblclick', function(){
      applyWidth(DEFAULT_WIDTH, true);
    });
    $railResizer.addEventListener('keydown', function(e){
      var step = e.shiftKey ? 40 : 16;
      var current = parseFloat($rail.style.width) || DEFAULT_WIDTH;
      if (e.key === 'ArrowLeft'){ applyWidth(current - step, true); e.preventDefault(); }
      else if (e.key === 'ArrowRight'){ applyWidth(current + step, true); e.preventDefault(); }
      else if (e.key === 'Home'){ applyWidth(MIN_WIDTH, true); e.preventDefault(); }
      else if (e.key === 'End'){ applyWidth(maxWidth(), true); e.preventDefault(); }
      else if (e.key === 'Enter' || e.key === ' '){ applyWidth(DEFAULT_WIDTH, true); e.preventDefault(); }
    });
  })();

  $search.addEventListener('input', function(){
    renderList();
    renderByType();
  });
  $refresh.addEventListener('click', refreshAll);
  $refreshTop.addEventListener('click', refreshAll);

  // Views whose rail is a flat resource list with no relationship to the
  // currently selected HOLON (Taxonomies, Node Shapes, Property Shapes) --
  // switching AWAY from one of these back to a holon view (List/By Type/
  // Tree) needs to restore whatever holon was selected before, exactly as
  // leavingTaxonomies used to handle alone.
  var RAIL_ONLY_VIEWS = {taxonomies: true, classes: true, properties: true, nodeshapes: true, propshapes: true, namespaces: true};

  $viewSelect.addEventListener('change', function(){
    var view = $viewSelect.value;
    if (view === currentView) return;
    var leavingRailOnly = RAIL_ONLY_VIEWS[currentView] && !RAIL_ONLY_VIEWS[view];
    currentView = view;
    $list.hidden = view !== 'list';
    $byType.hidden = view !== 'type';
    $tree.hidden = view !== 'tree';
    $taxonomies.hidden = view !== 'taxonomies';
    $classes.hidden = view !== 'classes';
    $properties.hidden = view !== 'properties';
    $nodeShapes.hidden = view !== 'nodeshapes';
    $propShapes.hidden = view !== 'propshapes';
    $namespaces.hidden = view !== 'namespaces';
    $searchWrap.hidden = (view === 'tree' || RAIL_ONLY_VIEWS[view]);
    if (view === 'tree' && !treeLoaded) loadTreeRoot();
    if (view === 'type') renderByType();
    if (view === 'taxonomies') { if (!taxonomiesLoaded) loadTaxonomies(); else renderTaxonomies(); }
    if (view === 'classes') { if (!classesLoaded) loadClassesTab(); else renderClassesTab(); }
    if (view === 'properties') { if (!propertiesLoaded) loadPropertiesTab(); else renderPropertiesTab(); }
    if (view === 'nodeshapes') { if (!nodeShapesLoaded) loadNodeShapes(); else renderNodeShapes(); }
    if (view === 'propshapes') { if (!propShapesLoaded) loadPropertyShapesTab(); else renderPropertyShapesTab(); }
    if (view === 'namespaces') { if (!namespacesLoaded) loadNamespaces(); else renderNamespaces(); }
    if (leavingRailOnly){
      if (selectedIri && lastDetailBindings) rerenderDetail();
      else if (!selectedIri) renderIdleDetail('Nothing selected');
    }
  });

  $serverSelect.addEventListener('change', onServerChange);
  $bankSelect.addEventListener('change', onBankChange);
  $datasetSelect.addEventListener('change', onDatasetChange);

  init();
})();
