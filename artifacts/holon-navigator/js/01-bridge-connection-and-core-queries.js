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

