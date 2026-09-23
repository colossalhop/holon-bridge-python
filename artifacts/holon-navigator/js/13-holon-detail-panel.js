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
