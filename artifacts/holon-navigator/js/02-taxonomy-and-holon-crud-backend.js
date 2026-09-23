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

