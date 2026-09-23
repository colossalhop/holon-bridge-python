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

