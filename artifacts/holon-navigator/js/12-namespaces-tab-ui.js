
  // Base IRI for a freshly minted registry entry's own identity (NOT the
  // namespace URI it describes) -- derived from an existing entry's IRI via
  // namespaceAndLocal when one exists, else a fixed fallback. The entry's
  // IRI is namespaceRegistryBase() + prefix (the prefix itself as local
  // name), which keeps every registry entry's own IRI stable and readable
  // even though what it DESCRIBES (ns.uri) is a completely separate string.
  function namespaceRegistryBase(){
    if (namespacesData.length){
      var parts = namespaceAndLocal(namespacesData[0].iri);
      if (parts.ns) return parts.ns;
    }
    return "https://w3id.org/data/ontology/namespaces#";
  }

  // Mints a namespace registry entry in the current, SHACL-native structure:
  // <ONTOLOGY_GRAPH> sh:declare <iri> -- the ontology graph asserting it
  // declares this prefix -- plus <iri> itself typed sh:PrefixDeclaration
  // with sh:prefix/sh:namespace (sh:namespace is xsd:anyURI-typed, per the
  // SHACL vocabulary) and optional sh:name/sh:description.
  function buildCreateNamespaceTurtle(iri, prefix, uri, label, comment){
    var lines = [
      "@prefix sh: <http://www.w3.org/ns/shacl#> .",
      "@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .",
      "",
      "<" + ONTOLOGY_GRAPH + "> sh:declare <" + iri + "> .",
      "",
      "<" + iri + ">",
      "  a sh:PrefixDeclaration ;",
      "  sh:prefix " + turtleLiteral(prefix) + " ;",
      "  sh:namespace " + turtleLiteral(uri) + "^^xsd:anyURI ;"
    ];
    if (label) lines.push("  sh:name " + langLiteral(label) + " ;");
    if (comment) lines.push("  sh:description " + langLiteral(comment) + " ;");
    // Same "swap the last ' ;' for ' .'" close used by
    // buildCreateNodeShapeTurtle/buildCreatePropertyShapeTurtle above.
    var last = lines.pop();
    lines.push(last.replace(/ ;$/, ' .'));
    return lines.join("\n");
  }

  // Migrates one legacy VANN entry to the SHACL structure in a single
  // atomic UPDATE, carrying over whatever the admin just edited in the same
  // save (prefix/uri/label/comment reflect the NEW values, not the old
  // ones) -- called from buildNamespaceEditForm's save handler whenever
  // ns.scheme === 'vann'. There's no separate "upgrade" affordance; editing
  // a legacy entry IS how it gets upgraded.
  function buildUpgradeNamespaceToShaclSparql(entryIri, prefix, uri, label, comment){
    var insertLines = [
      "  <" + ONTOLOGY_GRAPH + "> sh:declare <" + entryIri + "> .",
      "  <" + entryIri + "> a sh:PrefixDeclaration ;",
      "    sh:prefix " + turtleLiteral(prefix) + " ;",
      "    sh:namespace " + turtleLiteral(uri) + "^^xsd:anyURI" + (label || comment ? " ;" : " .")
    ];
    if (label) insertLines.push("    sh:name " + langLiteral(label) + (comment ? " ;" : " ."));
    if (comment) insertLines.push("    sh:description " + langLiteral(comment) + " .");
    return [
      "PREFIX vann: <http://purl.org/vocab/vann/>",
      "PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>",
      "PREFIX sh: <http://www.w3.org/ns/shacl#>",
      "PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>",
      "DELETE {",
      "  GRAPH <" + ONTOLOGY_GRAPH + "> {",
      "    <" + entryIri + "> vann:preferredNamespacePrefix ?p0 ;",
      "                       vann:preferredNamespaceUri ?u0 ;",
      "                       rdfs:label ?l0 ;",
      "                       rdfs:comment ?c0 .",
      "  }",
      "}",
      "INSERT {",
      "  GRAPH <" + ONTOLOGY_GRAPH + "> {",
      insertLines.join("\n"),
      "  }",
      "}",
      "WHERE {",
      "  GRAPH <" + ONTOLOGY_GRAPH + "> {",
      "    OPTIONAL { <" + entryIri + "> vann:preferredNamespacePrefix ?p0 }",
      "    OPTIONAL { <" + entryIri + "> vann:preferredNamespaceUri ?u0 }",
      "    OPTIONAL { <" + entryIri + "> rdfs:label ?l0 }",
      "    OPTIONAL { <" + entryIri + "> rdfs:comment ?c0 }",
      "  }",
      "}"
    ].join("\n");
  }

  function loadNamespacesData(){
    return Promise.all([
      callTool(SERVER, 'sparql_select', {query: NAMESPACE_LIST_QUERY, graph: ONTOLOGY_GRAPH})
        .then(function(res){ return (res.payload && res.payload.results && res.payload.results.bindings) || []; }),
      loadDeprecatedSet()
    ]).then(function(results){
      var bindings = results[0];
      namespacesData = bindings.map(function(b){
        return {
          iri: b.entry.value,
          prefix: b.prefix.value,
          uri: b.uri.value,
          label: b.label ? b.label.value : '',
          comment: b.comment ? b.comment.value : '',
          scheme: b.scheme ? b.scheme.value : 'shacl'
        };
      }).sort(function(a, b){ return a.prefix.localeCompare(b.prefix); });
      namespacesLoaded = true;
      return namespacesData;
    });
  }

  function loadNamespaces(force){
    if (force) namespacesLoaded = false;
    return loadNamespacesData()
      .then(function(){
        renderNamespaces();
        if (selectedNamespaceIri) selectNamespace(selectedNamespaceIri, true);
      })
      .catch(function(err){
        $namespaces.innerHTML = '';
        renderBanner($namespaces, err, function(){ loadNamespaces(true); });
      });
  }

  function buildNamespaceRow(ns){
    var row = document.createElement('button');
    var isDeprecated = !!deprecatedSet[ns.iri];
    row.className = 'row' + (ns.iri === selectedNamespaceIri ? ' active' : '');
    row.type = 'button';
    if (isDeprecated) row.style.opacity = '0.55';
    var lbl = document.createElement('span');
    lbl.className = 'row-label';
    // ns.label falls back to ns.prefix, NOT humanize(ns.uri) -- a namespace
    // URI conventionally ends in '#' (or '/'), and humanize() splits on the
    // LAST such separator, so humanize() on a bare namespace URI usually
    // yields an empty string. The prefix is always meaningful; humanize on
    // the entry's OWN iri (namespaceRegistryBase()+prefix) is the last
    // resort, used only in renderNamespaceDetail's title, not here.
    lbl.textContent = (ns.label || ns.prefix) + (isDeprecated ? ' (deprecated)' : '');
    row.appendChild(lbl);
    var tp = document.createElement('span');
    tp.className = 'row-type';
    tp.textContent = ns.prefix + ':';
    row.appendChild(tp);
    row.addEventListener('click', function(){ selectNamespace(ns.iri); });
    return row;
  }

  function renderNamespaces(){
    $namespaces.innerHTML = '';
    var btnRow = document.createElement('div');
    btnRow.style.cssText = 'display:flex; flex-wrap:wrap; gap:6px; margin:8px 8px 10px;';
    var addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'btn';
    addBtn.textContent = '+ New Namespace';
    addBtn.style.cssText = 'font-size:11.5px; padding:5px 10px;';
    addBtn.addEventListener('click', openNewNamespaceForm);
    btnRow.appendChild(addBtn);
    var discoverBtn = document.createElement('button');
    discoverBtn.type = 'button';
    discoverBtn.className = 'btn';
    discoverBtn.textContent = 'Read Namespaces From Dataset';
    discoverBtn.style.cssText = 'font-size:11.5px; padding:5px 10px;';
    discoverBtn.addEventListener('click', openDiscoverNamespacesForm);
    btnRow.appendChild(discoverBtn);
    $namespaces.appendChild(btnRow);
    $namespaces.appendChild(buildShowDeprecatedToggle('namespaces', 'Show deprecated', renderNamespaces));

    if (!namespacesData.length){
      var empty = document.createElement('div');
      empty.className = 'list-empty';
      empty.textContent = 'No namespaces registered yet.';
      $namespaces.appendChild(empty);
      return;
    }
    var visibleNamespaces = filterByDeprecatedSet(namespacesData, 'namespaces');
    if (!visibleNamespaces.length){
      var allHiddenNs = document.createElement('div');
      allHiddenNs.className = 'list-empty';
      allHiddenNs.textContent = 'Every namespace is deprecated -- tick "Show deprecated" above to see them.';
      $namespaces.appendChild(allHiddenNs);
      return;
    }
    visibleNamespaces.forEach(function(ns){ $namespaces.appendChild(buildNamespaceRow(ns)); });
  }

  // Unlike selectScheme/selectNodeShape, there's no separate per-item
  // fetch here -- loadNamespacesData() already pulled every field this tab
  // shows, so selecting one is a synchronous lookup into namespacesData.
  function selectNamespace(nsIri, skipRerenderRail){
    selectedNamespaceIri = nsIri;
    if (!skipRerenderRail) renderNamespaces();
    var ns = namespacesData.find(function(x){ return x.iri === nsIri; });
    renderNamespaceDetail(nsIri, ns);
  }

  function renderNamespaceDetail(nsIri, ns){
    ns = ns || {iri: nsIri, prefix: '', uri: '', label: '', comment: ''};
    var isDeprecated = !!deprecatedSet[nsIri];
    var isEditing = namespaceEditOpenFor === nsIri;
    var inner = document.createElement('div');
    inner.className = 'detail-inner';

    var badges = document.createElement('div');
    badges.className = 'badges';
    var p = document.createElement('span');
    p.className = 'pill type';
    p.textContent = 'Namespace';
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
      h2.textContent = ns.label || ns.prefix || humanize(nsIri);
      inner.appendChild(h2);
    }

    var iriLine = document.createElement('div');
    iriLine.className = 'iri';
    iriLine.textContent = nsIri;
    inner.appendChild(iriLine);

    var prefixLine = document.createElement('p');
    prefixLine.className = 'hint';
    prefixLine.style.margin = '-12px 0 18px';
    prefixLine.textContent = (ns.prefix || '—') + ':  →  ' + (ns.uri || '—');
    inner.appendChild(prefixLine);

    var actions = document.createElement('div');
    actions.className = 'actions';
    var editBtn = document.createElement('button');
    editBtn.type = 'button'; editBtn.className = 'btn';
    editBtn.textContent = isEditing ? 'Cancel Edit' : 'Edit';
    editBtn.addEventListener('click', function(){
      namespaceEditOpenFor = isEditing ? null : nsIri;
      selectNamespace(nsIri, true);
    });
    actions.appendChild(editBtn);
    var toggleBtn = document.createElement('button');
    toggleBtn.type = 'button'; toggleBtn.className = 'btn';
    toggleBtn.textContent = isDeprecated ? 'Reactivate' : 'Deprecate';
    toggleBtn.addEventListener('click', function(){
      toggleBtn.disabled = true;
      var op = isDeprecated ? callTool(SERVER, 'sparql_update', {update: buildClearStatusSparql(nsIri)})
                             : callTool(SERVER, 'sparql_update', {update: buildSetStatusSparql(nsIri, DEPRECATED_STATUS_IRI)});
      op.then(function(){ return mcp.invalidate(SERVER, 'sparql_select').catch(function(){}); })
        .then(function(){ return loadDeprecatedSet(true); })
        .then(function(){ selectNamespace(nsIri, true); renderNamespaces(); })
        .catch(function(err){ toggleBtn.disabled = false; renderBanner(inner, err); });
    });
    actions.appendChild(toggleBtn);
    inner.appendChild(actions);

    if (isEditing){
      inner.appendChild(buildNamespaceEditForm(ns));
    } else if (ns.comment){
      var desc = document.createElement('div');
      desc.className = 'description';
      desc.textContent = ns.comment;
      inner.appendChild(desc);
    } else {
      var hint = document.createElement('p');
      hint.className = 'hint';
      hint.style.margin = '18px 0 0';
      hint.textContent = isDeprecated
        ? 'This namespace is deprecated -- it stays valid for anything already using it but is no longer offered when minting a new class or property IRI elsewhere in this tool.'
        : 'Registered prefix/URI pair, offered wherever a new class or property IRI is minted (Node Shapes’ target class, Property Shapes’ path).';
      inner.appendChild(hint);
      if (ns.scheme === 'vann'){
        var legacyHint = document.createElement('p');
        legacyHint.className = 'hint';
        legacyHint.style.margin = '6px 0 0';
        legacyHint.textContent = 'Declared with the legacy VANN vocabulary -- editing and saving this entry upgrades it in place to SHACL’s sh:declare/sh:PrefixDeclaration structure.';
        inner.appendChild(legacyHint);
      }
    }

    $detail.innerHTML = '';
    $detail.appendChild(inner);
  }

  function buildNamespaceEditForm(ns){
    var card = document.createElement('div');
    card.className = 'addchild-form';
    var h3 = document.createElement('h3');
    h3.textContent = 'Edit namespace';
    card.appendChild(h3);

    var errorBox = document.createElement('div');
    card.appendChild(errorBox);

    var prefixField = document.createElement('div');
    prefixField.className = 'field';
    var prefixLabel = document.createElement('label');
    prefixLabel.textContent = 'Prefix';
    prefixField.appendChild(prefixLabel);
    var prefixInput = document.createElement('input');
    prefixInput.type = 'text';
    prefixInput.value = ns.prefix || '';
    prefixField.appendChild(prefixInput);
    card.appendChild(prefixField);

    var uriField = document.createElement('div');
    uriField.className = 'field';
    var uriLabel = document.createElement('label');
    uriLabel.textContent = 'Namespace URI';
    uriField.appendChild(uriLabel);
    var uriInput = document.createElement('input');
    uriInput.type = 'text';
    uriInput.value = ns.uri || '';
    uriField.appendChild(uriInput);
    card.appendChild(uriField);

    // Propagation only ever matters for the URI, never the prefix -- a
    // prefix is a purely local display label for this tool and is never
    // itself stored in any triple (only the fully-expanded IRI is), so
    // renaming it can never need to touch existing data. Renaming the URI
    // is the one case where "items in this namespace" (every IRI already
    // minted under it, anywhere in the dataset) could need to follow --
    // hence this checkbox is scoped to, and only acted on when, the URI
    // field actually changes at save time (see the save handler below).
    var propagateField = document.createElement('div');
    propagateField.className = 'field';
    propagateField.style.cssText = 'display:flex; align-items:flex-start; gap:8px;';
    var propagateCheckbox = document.createElement('input');
    propagateCheckbox.type = 'checkbox';
    propagateCheckbox.id = 'nsPropagateCheck';
    propagateCheckbox.style.marginTop = '3px';
    propagateField.appendChild(propagateCheckbox);
    var propagateLabelWrap = document.createElement('div');
    var propagateLabel = document.createElement('label');
    propagateLabel.setAttribute('for', 'nsPropagateCheck');
    propagateLabel.textContent = 'Propagate to items already using this namespace';
    propagateLabel.style.cssText = 'display:block; cursor:pointer;';
    propagateLabelWrap.appendChild(propagateLabel);
    var propagateHint = document.createElement('p');
    propagateHint.className = 'hint';
    propagateHint.style.margin = '2px 0 0';
    propagateHint.textContent = 'Only applies if you change the namespace URI above. On save you’ll see how many existing resources use the old URI and choose how to carry the change to them.';
    propagateLabelWrap.appendChild(propagateHint);
    propagateField.appendChild(propagateLabelWrap);
    card.appendChild(propagateField);

    var labelField = document.createElement('div');
    labelField.className = 'field';
    var labelLabel = document.createElement('label');
    labelLabel.textContent = 'Label (optional)';
    labelField.appendChild(labelLabel);
    var labelInput = document.createElement('input');
    labelInput.type = 'text';
    labelInput.value = ns.label || '';
    labelField.appendChild(labelInput);
    card.appendChild(labelField);

    var commentField = document.createElement('div');
    commentField.className = 'field';
    var commentLabel = document.createElement('label');
    commentLabel.textContent = 'Comment (optional)';
    commentField.appendChild(commentLabel);
    var commentArea = document.createElement('textarea');
    commentArea.value = ns.comment || '';
    commentField.appendChild(commentArea);
    card.appendChild(commentField);

    var actionsRow = document.createElement('div');
    actionsRow.className = 'form-actions';
    var saveBtn = document.createElement('button');
    saveBtn.type = 'button'; saveBtn.className = 'btn primary'; saveBtn.textContent = 'Save Changes';
    var cancelBtn = document.createElement('button');
    cancelBtn.type = 'button'; cancelBtn.className = 'btn'; cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', function(){
      namespaceEditOpenFor = null;
      selectNamespace(ns.iri, true);
    });
    saveBtn.addEventListener('click', function(){
      errorBox.innerHTML = '';
      var newPrefix = prefixInput.value.trim();
      var newUri = uriInput.value.trim();
      if (!newPrefix || !newUri){
        var warn = document.createElement('p');
        warn.className = 'warn';
        warn.textContent = 'Both prefix and namespace URI are required.';
        errorBox.appendChild(warn);
        return;
      }
      var clash = namespacesData.find(function(x){
        return x.iri !== ns.iri && (x.prefix === newPrefix || x.uri === newUri);
      });
      if (clash){
        var warn2 = document.createElement('p');
        warn2.className = 'warn';
        warn2.textContent = 'Another namespace already uses that ' + (clash.prefix === newPrefix ? 'prefix' : 'URI') + ' (' + (clash.label || clash.prefix) + ').';
        errorBox.appendChild(warn2);
        return;
      }
      var newLabel = labelInput.value.trim();
      var newComment = commentArea.value.trim();
      var uriChanged = newUri !== (ns.uri || '');
      var oldUri = ns.uri;

      // Applies just the registry entry's OWN fields (prefix/uri/label/
      // comment) -- shared by the plain-save path and by both propagation
      // choices below, so the entry's bookkeeping is always updated exactly
      // once, the same way, regardless of what (if anything) also happens
      // to the resources that use this namespace.
      function commitFieldEdits(){
        if (ns.scheme === 'vann'){
          // One atomic upgrade: legacy VANN triples -> sh:declare/
          // sh:PrefixDeclaration, carrying over whatever was just edited.
          return callTool(SERVER, 'sparql_update', {
            update: buildUpgradeNamespaceToShaclSparql(ns.iri, newPrefix, newUri, newLabel, newComment)
          });
        }
        var chain = Promise.resolve();
        if (newPrefix !== (ns.prefix || '')){
          var prefixUpdate = buildReplaceFieldSparql(ONTOLOGY_GRAPH, ns.iri, SH_PREFIX_PRED, turtleLiteral(newPrefix));
          chain = chain.then(function(){ return callTool(SERVER, 'sparql_update', {update: prefixUpdate}); });
        }
        if (uriChanged){
          var uriUpdate = buildReplaceFieldSparql(ONTOLOGY_GRAPH, ns.iri, SH_NAMESPACE_PRED, turtleLiteral(newUri) + '^^<' + XSD_ANYURI_IRI + '>');
          chain = chain.then(function(){ return callTool(SERVER, 'sparql_update', {update: uriUpdate}); });
        }
        if (newLabel !== (ns.label || '')){
          var labelUpdate = buildReplaceFieldSparql(ONTOLOGY_GRAPH, ns.iri, SH_NAME, newLabel ? langLiteral(newLabel) : null);
          chain = chain.then(function(){ return callTool(SERVER, 'sparql_update', {update: labelUpdate}); });
        }
        if (newComment !== (ns.comment || '')){
          var commentUpdate = buildReplaceFieldSparql(ONTOLOGY_GRAPH, ns.iri, SH_DESCRIPTION2, newComment ? langLiteral(newComment) : null);
          chain = chain.then(function(){ return callTool(SERVER, 'sparql_update', {update: commentUpdate}); });
        }
        return chain;
      }

      function finishSave(){
        return commitFieldEdits()
          .then(function(){ return mcp.invalidate(SERVER, 'sparql_select').catch(function(){}); })
          .then(function(){ namespaceEditOpenFor = null; return loadNamespacesData(); })
          .then(function(){ renderNamespaces(); selectNamespace(ns.iri, true); });
      }

      if (!propagateCheckbox.checked || !uriChanged){
        saveBtn.disabled = true; cancelBtn.disabled = true; saveBtn.textContent = 'Saving…';
        finishSave().catch(function(err){
          saveBtn.disabled = false; cancelBtn.disabled = false; saveBtn.textContent = 'Save Changes';
          renderBanner(errorBox, err);
        });
        return;
      }

      // Propagation was requested and the URI is actually changing --
      // find what's affected BEFORE committing anything, so the admin
      // chooses a strategy with real numbers in front of them rather than
      // blind. Nothing is written until one of the two choices is picked.
      saveBtn.disabled = true; cancelBtn.disabled = true; saveBtn.textContent = 'Checking affected items…';
      callTool(SERVER, 'sparql_select', {query: namespaceAffectedResourcesQuery(oldUri)})
        .then(function(res){
          var bindings = (res.payload && res.payload.results && res.payload.results.bindings) || [];
          var affected = bindings.map(function(b){ return b.iri.value; });
          saveBtn.style.display = 'none';
          errorBox.innerHTML = '';
          errorBox.appendChild(buildPropagationChoice(affected, oldUri, newUri, finishSave, function(){
            saveBtn.style.display = '';
            saveBtn.disabled = false; cancelBtn.disabled = false; saveBtn.textContent = 'Save Changes';
          }));
        })
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

  // Shown after "Propagate" is checked, the URI is changed, and Save is
  // clicked: lists what's affected and offers the two strategies discussed
  // with the admin ahead of building this -- a destructive rewrite (the one
  // place in this tool that deletes existing triples outright rather than
  // deprecating) or a non-destructive owl:sameAs migration (mints new IRIs
  // under the new namespace and links them to the old ones; nothing
  // existing is touched). Nothing is committed until one is chosen, or
  // Cancel returns to the edit form untouched.
  function buildPropagationChoice(affected, oldNs, newNs, finishSave, onCancel){
    var box = document.createElement('div');
    box.className = 'addchild-form';
    var h4 = document.createElement('h4');
    h4.textContent = affected.length + ' resource(s) currently use this namespace';
    box.appendChild(h4);

    if (affected.length){
      var sample = document.createElement('div');
      sample.className = 'hint';
      sample.style.cssText = 'font-family:monospace; font-size:11px; max-height:120px; overflow:auto; margin:6px 0 10px; white-space:pre-wrap;';
      sample.textContent = affected.slice(0, 12).join('\n') + (affected.length > 12 ? '\n… and ' + (affected.length - 12) + ' more' : '');
      box.appendChild(sample);
    }

    var explain = document.createElement('p');
    explain.className = 'hint';
    explain.textContent = 'Choose how to carry the namespace change to these resources:';
    box.appendChild(explain);

    var actionsRow2 = document.createElement('div');
    actionsRow2.className = 'form-actions';
    actionsRow2.style.flexWrap = 'wrap';

    var rewriteBtn = document.createElement('button');
    rewriteBtn.type = 'button'; rewriteBtn.className = 'btn primary';
    var rewriteLabel = 'Rewrite In Place (' + affected.length + ')';
    rewriteBtn.textContent = rewriteLabel;
    rewriteBtn.title = 'Renames every affected IRI to the new namespace, across the holons/ontology/shacl graphs, preserving local names. This deletes and replaces the old triples -- the one operation in this tool that does not preserve existing IRIs.';

    var sameAsBtn = document.createElement('button');
    sameAsBtn.type = 'button'; sameAsBtn.className = 'btn';
    var sameAsLabel = 'Additive sameAs Migration (' + affected.length + ')';
    sameAsBtn.textContent = sameAsLabel;
    sameAsBtn.title = 'Mints a new IRI under the new namespace for each affected resource and links it to the old one with owl:sameAs. Nothing existing is touched or deleted.';

    var cancelBtn2 = document.createElement('button');
    cancelBtn2.type = 'button'; cancelBtn2.className = 'btn';
    cancelBtn2.textContent = 'Cancel';
    cancelBtn2.addEventListener('click', function(){
      box.remove();
      onCancel();
    });

    function run(propagationOpFactory, busyBtn, busyLabel){
      rewriteBtn.disabled = true; sameAsBtn.disabled = true; cancelBtn2.disabled = true;
      busyBtn.textContent = 'Working…';
      propagationOpFactory()
        .then(function(){ return finishSave(); })
        .catch(function(err){
          rewriteBtn.disabled = false; sameAsBtn.disabled = false; cancelBtn2.disabled = false;
          busyBtn.textContent = busyLabel;
          renderBanner(box, err);
        });
    }

    rewriteBtn.addEventListener('click', function(){
      run(function(){
        return callTool(SERVER, 'sparql_update', {update: buildRewriteNamespaceSparql(oldNs, newNs)});
      }, rewriteBtn, rewriteLabel);
    });
    sameAsBtn.addEventListener('click', function(){
      run(function(){
        if (!affected.length) return Promise.resolve();
        return callTool(SERVER, 'push_turtle', {
          turtle: buildSameAsMigrationTurtle(oldNs, newNs, affected),
          graph_iri: ONTOLOGY_GRAPH,
          mode: 'merge'
        });
      }, sameAsBtn, sameAsLabel);
    });

    actionsRow2.appendChild(rewriteBtn);
    actionsRow2.appendChild(sameAsBtn);
    actionsRow2.appendChild(cancelBtn2);
    box.appendChild(actionsRow2);
    return box;
  }

  // Built fresh on every call (see discoverNamespacesQuery's comment above
  // for why) -- every IRI, anywhere in the holons/ontology/shacl graphs,
  // that starts with the namespace being renamed. Used both to size the
  // "N resource(s) use this namespace" preview and, for the additive path,
  // as the exact list to mint owl:sameAs links for.
  function namespaceAffectedResourcesQuery(oldNs){
    var lit = turtleLiteral(oldNs);
    return [
      "SELECT DISTINCT ?iri WHERE {",
      "  { GRAPH <" + HOLONS_GRAPH + "> { ?iri ?hp1 ?ho1 } }",
      "  UNION { GRAPH <" + HOLONS_GRAPH + "> { ?hs1 ?iri ?ho2 } }",
      "  UNION { GRAPH <" + HOLONS_GRAPH + "> { ?hs2 ?hp2 ?iri } }",
      "  UNION { GRAPH <" + ONTOLOGY_GRAPH + "> { ?iri ?op1 ?oo1 } }",
      "  UNION { GRAPH <" + ONTOLOGY_GRAPH + "> { ?os1 ?iri ?oo2 } }",
      "  UNION { GRAPH <" + ONTOLOGY_GRAPH + "> { ?os2 ?op2 ?iri } }",
      "  UNION { GRAPH <" + SHACL_GRAPH + "> { ?iri ?sp1 ?so1 } }",
      "  UNION { GRAPH <" + SHACL_GRAPH + "> { ?ss1 ?iri ?so2 } }",
      "  UNION { GRAPH <" + SHACL_GRAPH + "> { ?ss2 ?sp2 ?iri } }",
      "  FILTER(isIRI(?iri) && STRSTARTS(STR(?iri), " + lit + "))",
      "}",
      "ORDER BY ?iri"
    ].join("\n");
  }

  // Rewrites every IRI under oldNs to newNs, preserving local names, across
  // all three graphs in one combined UPDATE request (three DELETE/INSERT/
  // WHERE operations, semicolon-joined -- Fuseki/Jena runs a single POSTed
  // Update request as one transaction). Each graph's WHERE scans every
  // triple but the FILTER only matches ones touching the old namespace in
  // subject, predicate, OR object position; the BIND/IF pairs leave any
  // term that ISN'T under the old namespace unchanged, so an unaffected
  // triple never actually appears in the DELETE/INSERT at all. This is the
  // one operation in this tool that deletes existing triples outright
  // rather than deprecating them -- by design, per the choice offered
  // alongside the non-destructive owl:sameAs alternative above.
  function buildRewriteNamespaceSparql(oldNs, newNs){
    var oldLit = turtleLiteral(oldNs);
    var newLit = turtleLiteral(newNs);
    function blockForGraph(g){
      return [
        "DELETE { GRAPH <" + g + "> { ?s ?p ?o } }",
        "INSERT { GRAPH <" + g + "> { ?sNew ?pNew ?oNew } }",
        "WHERE {",
        "  GRAPH <" + g + "> {",
        "    ?s ?p ?o .",
        "    FILTER(",
        "      (isIRI(?s) && STRSTARTS(STR(?s), " + oldLit + ")) ||",
        "      (isIRI(?p) && STRSTARTS(STR(?p), " + oldLit + ")) ||",
        "      (isIRI(?o) && STRSTARTS(STR(?o), " + oldLit + "))",
        "    )",
        "  }",
        "  BIND(IF(isIRI(?s) && STRSTARTS(STR(?s), " + oldLit + "), IRI(CONCAT(" + newLit + ", STRAFTER(STR(?s), " + oldLit + "))), ?s) AS ?sNew)",
        "  BIND(IF(isIRI(?p) && STRSTARTS(STR(?p), " + oldLit + "), IRI(CONCAT(" + newLit + ", STRAFTER(STR(?p), " + oldLit + "))), ?p) AS ?pNew)",
        "  BIND(IF(isIRI(?o) && STRSTARTS(STR(?o), " + oldLit + "), IRI(CONCAT(" + newLit + ", STRAFTER(STR(?o), " + oldLit + "))), ?o) AS ?oNew)",
        "}"
      ].join("\n");
    }
    return [HOLONS_GRAPH, ONTOLOGY_GRAPH, SHACL_GRAPH].map(blockForGraph).join(";\n\n");
  }

  // Non-destructive alternative: mints <newNs+local> owl:sameAs <oldIri>
  // for every affected resource, in ONTOLOGY_GRAPH. Nothing about the old
  // resource is touched -- consumers that follow owl:sameAs can resolve
  // either IRI, and new authoring can target the new namespace going
  // forward, while every existing triple stays exactly as it was.
  function buildSameAsMigrationTurtle(oldNs, newNs, affectedIris){
    var lines = ["@prefix owl: <http://www.w3.org/2002/07/owl#> ."];
    affectedIris.forEach(function(oldIri){
      var local = oldIri.slice(oldNs.length);
      var newIri = newNs + local;
      lines.push("<" + newIri + "> owl:sameAs <" + oldIri + "> .");
    });
    return lines.join("\n");
  }

  // A namespace prefix follows the same rule as an XML/Turtle NCName-ish
  // prefix in practice: a letter or underscore, then letters/digits/"_"/
  // "-"/".". Enforced client-side only -- nothing stops a hand-authored
  // prefix elsewhere in the graph from breaking this, same as every other
  // soft validation in this file.
  var NAMESPACE_PREFIX_RE = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

  function buildNewNamespaceForm(){
    var card = document.createElement('div');
    card.className = 'addchild-form';
    var hint = document.createElement('p');
    hint.className = 'hint';
    hint.textContent = 'Registers a prefix/URI pair as a SHACL sh:declare / sh:PrefixDeclaration entry that the class- and property-minting forms in Node Shapes and Property Shapes can offer.';
    card.appendChild(hint);

    var errorBox = document.createElement('div');
    card.appendChild(errorBox);

    var prefixField = document.createElement('div');
    prefixField.className = 'field';
    var prefixLabel = document.createElement('label');
    prefixLabel.textContent = 'Prefix';
    prefixField.appendChild(prefixLabel);
    var prefixInput = document.createElement('input');
    prefixInput.type = 'text';
    prefixInput.placeholder = 'e.g. geo';
    prefixField.appendChild(prefixInput);
    card.appendChild(prefixField);

    var uriField = document.createElement('div');
    uriField.className = 'field';
    var uriLabel = document.createElement('label');
    uriLabel.textContent = 'Namespace URI';
    uriField.appendChild(uriLabel);
    var uriInput = document.createElement('input');
    uriInput.type = 'text';
    uriInput.placeholder = 'https://example.org/ns/geography#';
    uriField.appendChild(uriInput);
    var uriHint = document.createElement('p');
    uriHint.className = 'hint';
    uriHint.style.margin = '-8px 0 12px';
    uriHint.textContent = 'Conventionally ends in "#" or "/" so a local name can be appended directly.';
    uriField.appendChild(uriHint);
    card.appendChild(uriField);

    var labelField = document.createElement('div');
    labelField.className = 'field';
    var labelLabel = document.createElement('label');
    labelLabel.textContent = 'Label (optional)';
    labelField.appendChild(labelLabel);
    var labelInput = document.createElement('input');
    labelInput.type = 'text';
    labelInput.placeholder = 'Defaults to the prefix itself';
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

    var actionsRow = document.createElement('div');
    actionsRow.className = 'form-actions';
    var createBtn = document.createElement('button');
    createBtn.type = 'button'; createBtn.className = 'btn primary'; createBtn.textContent = 'Create Namespace';
    var cancelBtn = document.createElement('button');
    cancelBtn.type = 'button'; cancelBtn.className = 'btn'; cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', closeNewNamespaceForm);
    createBtn.addEventListener('click', function(){
      errorBox.innerHTML = '';
      var prefix = prefixInput.value.trim();
      var uri = uriInput.value.trim();
      if (!prefix || !NAMESPACE_PREFIX_RE.test(prefix)){
        var warn = document.createElement('p');
        warn.className = 'warn';
        warn.textContent = 'Enter a prefix starting with a letter or underscore (letters, digits, "_", "-", "." only).';
        errorBox.appendChild(warn);
        return;
      }
      if (!uri){
        var warn2 = document.createElement('p');
        warn2.className = 'warn';
        warn2.textContent = 'Enter the namespace URI.';
        errorBox.appendChild(warn2);
        return;
      }
      var clash = namespacesData.find(function(x){ return x.prefix === prefix || x.uri === uri; });
      if (clash){
        var warn3 = document.createElement('p');
        warn3.className = 'warn';
        warn3.textContent = 'That ' + (clash.prefix === prefix ? 'prefix' : 'URI') + ' is already registered (' + (clash.label || clash.prefix) + ').';
        errorBox.appendChild(warn3);
        return;
      }
      var newIri = uniqueShapeIri(namespaceRegistryBase() + prefix, namespacesData);
      createBtn.disabled = true; createBtn.textContent = 'Creating…';
      var turtle = buildCreateNamespaceTurtle(newIri, prefix, uri, labelInput.value.trim(), commentArea.value.trim());
      callTool(SERVER, 'push_turtle', {turtle: turtle, graph_iri: ONTOLOGY_GRAPH, mode: 'merge'})
        .then(function(){ return mcp.invalidate(SERVER, 'sparql_select').catch(function(){}); })
        .then(function(){ return loadNamespacesData(); })
        .then(function(){ renderNamespaces(); selectNamespace(newIri); })
        .catch(function(err){
          createBtn.disabled = false; createBtn.textContent = 'Create Namespace';
          renderBanner(errorBox, err);
        });
    });
    actionsRow.appendChild(createBtn);
    actionsRow.appendChild(cancelBtn);
    card.appendChild(actionsRow);
    return card;
  }

  function openNewNamespaceForm(){
    selectedNamespaceIri = null;
    renderNamespaces();
    $detail.innerHTML = '';
    var inner = document.createElement('div');
    inner.className = 'detail-inner';
    var h2 = document.createElement('h2');
    h2.className = 'title';
    h2.textContent = 'New Namespace';
    inner.appendChild(h2);
    inner.appendChild(buildNewNamespaceForm());
    $detail.appendChild(inner);
  }
  function closeNewNamespaceForm(){
    renderNamespaces();
    if (selectedNamespaceIri) selectNamespace(selectedNamespaceIri);
    else renderIdleDetail('Nothing selected');
  }

  // Every namespace registry entry (used as options in the class/property
  // "New ..." forms' namespace picker) sorted the way a human reads a
  // prefix list -- alphabetically, deprecated entries last so the "live"
  // choices sort to the top without disappearing entirely.
  function activeNamespaceOptions(){
    return namespacesData.slice().sort(function(a, b){
      var da = !!deprecatedSet[a.iri], db = !!deprecatedSet[b.iri];
      if (da !== db) return da ? 1 : -1;
      return a.prefix.localeCompare(b.prefix);
    });
  }

