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

