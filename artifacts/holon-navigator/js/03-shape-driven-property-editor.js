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

