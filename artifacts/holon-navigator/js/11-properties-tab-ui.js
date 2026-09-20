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
