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

