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

