
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

