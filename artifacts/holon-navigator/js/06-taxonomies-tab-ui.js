  // ---- Taxonomies tab: rendering ----------------------------------------

  function loadTaxonomies(force){
    if (!mcp){
      $taxonomies.innerHTML = '<div class="list-empty">No connector available.</div>';
      return;
    }
    $taxonomies.innerHTML = '';
    var loading = document.createElement('div');
    loading.className = 'list-empty';
    loading.textContent = 'Loading taxonomies…';
    $taxonomies.appendChild(loading);
    Promise.all([
      callTool(SERVER, 'sparql_select', {query: SCHEME_LIST_QUERY})
        .then(function(res){ return (res.payload && res.payload.results && res.payload.results.bindings) || []; }),
      loadDeprecatedSet(force)
    ]).then(function(results){
      var bindings = results[0];
      schemesData = bindings.map(function(b){
        return {
          iri: b.scheme.value,
          label: b.labelOut ? b.labelOut.value : humanize(b.scheme.value),
          count: b.n ? parseInt(b.n.value, 10) : 0
        };
      }).sort(function(a, b){ return a.label.localeCompare(b.label); });
      taxonomiesLoaded = true;
      renderTaxonomies();
      if (selectedSchemeIri) selectScheme(selectedSchemeIri, true);
    }).catch(function(err){
      $taxonomies.innerHTML = '';
      renderBanner($taxonomies, err, function(){ loadTaxonomies(true); });
    });
  }

  function buildSchemeRow(s){
    var row = document.createElement('button');
    var isDeprecated = !!deprecatedSet[s.iri];
    row.className = 'row' + (s.iri === selectedSchemeIri ? ' active' : '');
    row.type = 'button';
    if (isDeprecated) row.style.opacity = '0.55';
    var lbl = document.createElement('span');
    lbl.className = 'row-label';
    lbl.textContent = s.label + (isDeprecated ? ' (deprecated)' : '');
    row.appendChild(lbl);
    var tp = document.createElement('span');
    tp.className = 'row-type';
    tp.textContent = s.count + (s.count === 1 ? ' concept' : ' concepts');
    row.appendChild(tp);
    row.addEventListener('click', function(){ selectScheme(s.iri); });
    return row;
  }

  function renderTaxonomies(){
    $taxonomies.innerHTML = '';
    var addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'btn';
    addBtn.textContent = '+ New Scheme';
    addBtn.style.cssText = 'margin:8px 8px 10px; font-size:11.5px; padding:5px 10px;';
    addBtn.addEventListener('click', openNewSchemeForm);
    $taxonomies.appendChild(addBtn);
    $taxonomies.appendChild(buildShowDeprecatedToggle('taxonomies', 'Show deprecated', renderTaxonomies));

    if (!schemesData.length){
      var empty = document.createElement('div');
      empty.className = 'list-empty';
      empty.textContent = 'No concept schemes yet.';
      $taxonomies.appendChild(empty);
      return;
    }
    var visibleSchemes = filterByDeprecatedSet(schemesData, 'taxonomies');
    if (!visibleSchemes.length){
      var allHidden = document.createElement('div');
      allHidden.className = 'list-empty';
      allHidden.textContent = 'Every scheme is deprecated -- tick "Show deprecated" above to see them.';
      $taxonomies.appendChild(allHidden);
      return;
    }
    visibleSchemes.forEach(function(s){ $taxonomies.appendChild(buildSchemeRow(s)); });
  }

  function selectScheme(schemeIri, skipRerenderRail){
    selectedSchemeIri = schemeIri;
    if (!skipRerenderRail) renderTaxonomies();
    renderDetailSkeleton();
    Promise.all([
      callTool(SERVER, 'sparql_select', {query: schemeConceptsQuery(schemeIri)})
        .then(function(res){ return (res.payload && res.payload.results && res.payload.results.bindings) || []; }),
      loadDeprecatedSet()
    ]).then(function(results){
      var bindings = results[0];
      var concepts = bindings.map(function(b){
        return {
          iri: b.concept.value,
          label: b.labelOut ? b.labelOut.value : humanize(b.concept.value),
          definition: b.definitionOut ? b.definitionOut.value : '',
          altLabels: b.altLabels && b.altLabels.value ? b.altLabels.value.split('|').filter(Boolean) : []
        };
      }).sort(function(a, b){ return a.label.localeCompare(b.label); });
      renderSchemeDetail(schemeIri, concepts);
    }).catch(function(err){
      $detail.innerHTML = '';
      var inner = document.createElement('div');
      inner.className = 'detail-inner';
      $detail.appendChild(inner);
      renderBanner(inner, err, function(){ selectScheme(schemeIri); });
    });
  }

  function renderSchemeDetail(schemeIri, concepts){
    var scheme = schemesData.find(function(s){ return s.iri === schemeIri; });
    var isDeprecated = !!deprecatedSet[schemeIri];
    var inner = document.createElement('div');
    inner.className = 'detail-inner';

    var badges = document.createElement('div');
    badges.className = 'badges';
    var p = document.createElement('span');
    p.className = 'pill type';
    p.textContent = 'Concept Scheme';
    badges.appendChild(p);
    if (isDeprecated){
      var dp = document.createElement('span');
      dp.className = 'pill status';
      dp.textContent = 'Deprecated';
      badges.appendChild(dp);
    }
    inner.appendChild(badges);

    var h2 = document.createElement('h2');
    h2.className = 'title';
    h2.textContent = scheme ? scheme.label : humanize(schemeIri);
    inner.appendChild(h2);

    var iriLine = document.createElement('div');
    iriLine.className = 'iri';
    iriLine.textContent = schemeIri;
    inner.appendChild(iriLine);

    var actions = document.createElement('div');
    actions.className = 'actions';
    var renameBtn = document.createElement('button');
    renameBtn.type = 'button'; renameBtn.className = 'btn'; renameBtn.textContent = 'Rename';
    var toggleBtn = document.createElement('button');
    toggleBtn.type = 'button'; toggleBtn.className = 'btn';
    toggleBtn.textContent = isDeprecated ? 'Reactivate' : 'Deprecate';
    actions.appendChild(renameBtn);
    actions.appendChild(toggleBtn);
    inner.appendChild(actions);

    var renameBox = document.createElement('div');
    inner.appendChild(renameBox);
    renameBtn.addEventListener('click', function(){
      renameBox.innerHTML = '';
      renameBox.appendChild(buildInlineRenameForm(scheme ? scheme.label : '', function(newLabel){
        return callTool(SERVER, 'sparql_update', {update: buildRenameSchemeSparql(schemeIri, newLabel)})
          .then(function(){ return mcp.invalidate(SERVER, 'sparql_select').catch(function(){}); })
          .then(function(){ loadTaxonomies(true); });
      }, function(){ renameBox.innerHTML = ''; }));
    });

    // sparql_select results are cached (the same reason every other write
    // path in this file -- buildEditForm's save, performDelete, refreshAll
    // -- calls mcp.invalidate before its next read): without invalidating
    // here, the re-read right after this toggle can come back from the
    // pre-write cache, so the button's SPARQL succeeds but the screen never
    // shows the change -- which is exactly what looks like "the button
    // doesn't work."
    toggleBtn.addEventListener('click', function(){
      toggleBtn.disabled = true;
      var op = isDeprecated ? callTool(SERVER, 'sparql_update', {update: buildClearStatusSparql(schemeIri)})
                             : callTool(SERVER, 'sparql_update', {update: buildSetStatusSparql(schemeIri, DEPRECATED_STATUS_IRI)});
      op.then(function(){ return mcp.invalidate(SERVER, 'sparql_select').catch(function(){}); })
        .then(function(){ return loadDeprecatedSet(true); })
        .then(function(){ selectScheme(schemeIri); renderTaxonomies(); })
        .catch(function(err){ toggleBtn.disabled = false; renderBanner(inner, err); });
    });

    var hint = document.createElement('p');
    hint.className = 'hint';
    hint.style.margin = '18px 0 10px';
    hint.textContent = isDeprecated
      ? 'This scheme is deprecated -- its concepts stay visible everywhere but are no longer offered as new choices.'
      : 'Concepts in this taxonomy. Deprecating one keeps it in the system (and on any holon already using it) but removes it from the picker.';
    inner.appendChild(hint);

    var secLabel = document.createElement('div');
    secLabel.className = 'section-label';
    secLabel.style.marginTop = '10px';
    secLabel.textContent = 'Concepts (' + concepts.length + ')';
    inner.appendChild(secLabel);

    // Reuses the already-fetched `concepts` array on toggle rather than
    // re-running selectScheme()'s live query -- this is purely a display
    // filter, so there's nothing to re-fetch.
    inner.appendChild(buildShowDeprecatedToggle('concepts', 'Show deprecated concepts', function(){
      renderSchemeDetail(schemeIri, concepts);
    }));

    var addConceptWrap = document.createElement('div');
    inner.appendChild(addConceptWrap);
    addConceptWrap.appendChild(buildAddConceptControl(schemeIri, concepts));

    var kv = document.createElement('div');
    kv.className = 'kv';
    var visibleConcepts = filterByDeprecatedSet(concepts, 'concepts');
    if (concepts.length && !visibleConcepts.length){
      var allHiddenC = document.createElement('p');
      allHiddenC.className = 'hint';
      allHiddenC.textContent = 'Every concept here is deprecated -- tick "Show deprecated concepts" above to see them.';
      inner.appendChild(allHiddenC);
    }
    visibleConcepts.forEach(function(c){
      kv.appendChild(buildConceptRow(schemeIri, c));
    });
    inner.appendChild(kv);

    $detail.innerHTML = '';
    $detail.appendChild(inner);
  }

  function buildConceptRow(schemeIri, c){
    var isDeprecated = !!deprecatedSet[c.iri];
    var row = document.createElement('div');
    row.className = 'kv-row';
    if (isDeprecated) row.style.opacity = '0.55';

    var key = document.createElement('div');
    key.className = 'kv-key';
    key.textContent = c.label + (isDeprecated ? ' (deprecated)' : '');
    row.appendChild(key);

    var val = document.createElement('div');
    val.className = 'kv-val';
    val.style.gap = '6px';

    // Alt labels are now directly editable (see buildConceptEditForm), so
    // they're shown as visible tags here rather than tucked into a hover
    // tooltip -- each one uses the same small-tag look as a row's type
    // badge (row-type), just repurposed for a plain text value.
    c.altLabels.forEach(function(al){
      var tag = document.createElement('span');
      tag.className = 'row-type';
      tag.style.cssText = 'max-width:none;';
      tag.textContent = al;
      val.appendChild(tag);
    });

    var editBtn = document.createElement('button');
    editBtn.type = 'button'; editBtn.className = 'btn'; editBtn.textContent = 'Edit';
    editBtn.style.cssText = 'font-size:11px; padding:3px 8px;';
    val.appendChild(editBtn);

    var toggleBtn = document.createElement('button');
    toggleBtn.type = 'button'; toggleBtn.className = 'btn';
    toggleBtn.textContent = isDeprecated ? 'Reactivate' : 'Deprecate';
    toggleBtn.style.cssText = 'font-size:11px; padding:3px 8px;';
    val.appendChild(toggleBtn);

    if (c.definition){
      var defP = document.createElement('div');
      defP.style.cssText = 'width:100%; font-size:12.5px; color:var(--ink-soft); margin-top:4px; line-height:1.4;';
      defP.textContent = c.definition;
      val.appendChild(defP);
    }

    row.appendChild(val);

    var editRow = document.createElement('div');
    editRow.style.cssText = 'grid-column:1 / -1;';
    row.appendChild(editRow);

    editBtn.addEventListener('click', function(){
      editRow.innerHTML = '';
      editRow.appendChild(buildConceptEditForm(schemeIri, c, function(){ editRow.innerHTML = ''; }));
    });

    // See the scheme-level toggle's comment above -- the invalidate is
    // required here too, or a successful deprecate/reactivate write can be
    // masked by a stale cached read right after it.
    toggleBtn.addEventListener('click', function(){
      toggleBtn.disabled = true;
      var op = isDeprecated ? callTool(SERVER, 'sparql_update', {update: buildClearStatusSparql(c.iri)})
                             : callTool(SERVER, 'sparql_update', {update: buildSetStatusSparql(c.iri, DEPRECATED_STATUS_IRI)});
      op.then(function(){ return mcp.invalidate(SERVER, 'sparql_select').catch(function(){}); })
        .then(function(){ return loadDeprecatedSet(true); })
        .then(function(){ selectScheme(schemeIri); })
        .catch(function(){ toggleBtn.disabled = false; });
    });

    return row;
  }

  // Builds the sample.json() prompt for a concept's "Populate with AI" --
  // same spirit as buildPopulatePrompt for holons (own knowledge only, null
  // over a guess, no live internet access), scoped to the two fields this
  // editor actually has room for: a one-sentence skos:definition, and a
  // short list of skos:altLabel synonyms not already present. Only asks for
  // a definition when the field is currently empty -- Populate never
  // overwrites a value that's already there.
  function buildConceptPopulatePrompt(schemeLabel, currentLabel, needDefinition, existingAltLabels){
    var lines = [
      'You are helping fill in missing structured data for one entry in a controlled vocabulary (a SKOS concept scheme) inside a worldbuilding knowledge graph called "Worldtest".',
      'Concept scheme: ' + schemeLabel,
      'Concept preferred label: ' + currentLabel
    ];
    if (existingAltLabels.length) lines.push('Existing alternate labels: ' + existingAltLabels.join(', '));
    lines.push(
      '',
      'You have no live internet access and no memory beyond this message. Answer from your own general knowledge only; use null (or an empty array) for anything you are not reasonably confident about rather than guessing.',
      ''
    );
    var keys = [];
    if (needDefinition){
      keys.push('"definition": a single clear sentence defining this concept, or null');
    }
    keys.push('"altLabels": an array of 0 to 3 short alternate labels or synonyms for this concept that are NOT already listed above (an empty array if none come to mind)');
    lines.push('Respond with ONLY a JSON object with these keys: ' + keys.join('; ') + '. No other text, no markdown fences.');
    return lines.join('\n');
  }

  // The concept editor: preferred label, skos:definition (0:1), and
  // skos:altLabel (0:infinity) all in one form, plus a "Populate with AI"
  // shortcut that proposes a definition and/or extra alt labels the same
  // way the holon editor's AI button does (see loadPropertyShapeSection).
  // Saving only issues an update per field that actually changed --
  // untouched fields never generate a write, same discipline as the
  // holon-side shape editor and buildShapePropsUpdate.
  function buildConceptEditForm(schemeIri, c, onDone){
    var scheme = schemesData.find(function(s){ return s.iri === schemeIri; });
    var schemeLabel = scheme ? scheme.label : humanize(schemeIri);

    var wrap = document.createElement('div');
    wrap.style.cssText = 'margin-top:8px; padding:12px 14px; border:1px solid var(--line); border-radius:8px; background:var(--paper);';

    var aiBar = document.createElement('div');
    aiBar.style.cssText = 'display:flex; align-items:center; gap:10px; flex-wrap:wrap; margin:0 0 12px;';
    var populateBtn = document.createElement('button');
    populateBtn.type = 'button';
    populateBtn.className = 'btn';
    populateBtn.textContent = '✨ Populate with AI';
    populateBtn.title = 'Ask Claude to propose a definition and alternate labels from its own trained knowledge — this page has no live internet access, so this isn’t a web lookup.';
    populateBtn.style.cssText = 'font-size:11.5px; padding:5px 10px;';
    aiBar.appendChild(populateBtn);
    var populateStatus = document.createElement('span');
    populateStatus.className = 'hint';
    populateStatus.style.margin = '0';
    aiBar.appendChild(populateStatus);
    wrap.appendChild(aiBar);

    var labelField = document.createElement('div');
    labelField.style.cssText = 'margin-bottom:10px;';
    var labelLbl = document.createElement('label');
    labelLbl.style.cssText = 'display:block; font-size:11.5px; font-weight:600; color:var(--ink-soft); margin-bottom:4px;';
    labelLbl.textContent = 'Preferred label';
    labelField.appendChild(labelLbl);
    var labelInput = document.createElement('input');
    labelInput.type = 'text';
    labelInput.value = c.label;
    labelInput.style.cssText = 'width:100%; font:inherit; font-size:13px; padding:5px 8px; border:1px solid var(--line); border-radius:6px; background:var(--card); color:var(--ink);';
    labelField.appendChild(labelInput);
    wrap.appendChild(labelField);

    var defField = document.createElement('div');
    defField.style.cssText = 'margin-bottom:10px;';
    var defLbl = document.createElement('label');
    defLbl.style.cssText = 'display:block; font-size:11.5px; font-weight:600; color:var(--ink-soft); margin-bottom:4px;';
    defLbl.textContent = 'Definition';
    defField.appendChild(defLbl);
    var defArea = document.createElement('textarea');
    defArea.rows = 2;
    defArea.value = c.definition || '';
    defArea.placeholder = 'A short definition for this concept (skos:definition) — optional.';
    defArea.style.cssText = 'width:100%; font:inherit; font-size:13px; padding:5px 8px; border:1px solid var(--line); border-radius:6px; background:var(--card); color:var(--ink); resize:vertical;';
    defField.appendChild(defArea);
    wrap.appendChild(defField);

    var altField = document.createElement('div');
    altField.style.cssText = 'margin-bottom:12px;';
    var altLbl = document.createElement('label');
    altLbl.style.cssText = 'display:block; font-size:11.5px; font-weight:600; color:var(--ink-soft); margin-bottom:4px;';
    altLbl.textContent = 'Alternate labels';
    altField.appendChild(altLbl);
    var altRows = document.createElement('div');
    altField.appendChild(altRows);
    var altState = c.altLabels.slice(); // working copy -- diffed against c.altLabels on Save

    function renderAltRows(){
      altRows.innerHTML = '';
      altState.forEach(function(al, idx){
        var r = document.createElement('div');
        r.style.cssText = 'display:flex; gap:6px; align-items:center; margin-bottom:4px;';
        var span = document.createElement('span');
        span.textContent = al;
        span.style.cssText = 'flex:1; font-size:12.8px;';
        r.appendChild(span);
        var rm = document.createElement('button');
        rm.type = 'button'; rm.className = 'btn'; rm.textContent = '✕';
        rm.title = 'Remove this alternate label';
        rm.style.cssText = 'font-size:11px; padding:2px 7px; flex:none;';
        rm.addEventListener('click', function(){ altState.splice(idx, 1); renderAltRows(); });
        r.appendChild(rm);
        altRows.appendChild(r);
      });
    }
    renderAltRows();

    var addAltRow = document.createElement('div');
    addAltRow.style.cssText = 'display:flex; gap:6px; margin-top:4px;';
    var addAltInput = document.createElement('input');
    addAltInput.type = 'text';
    addAltInput.placeholder = 'Add an alternate label…';
    addAltInput.style.cssText = 'flex:1; font:inherit; font-size:12.8px; padding:4px 8px; border:1px solid var(--line); border-radius:6px; background:var(--card); color:var(--ink);';
    var addAltBtn = document.createElement('button');
    addAltBtn.type = 'button'; addAltBtn.className = 'btn'; addAltBtn.textContent = '+ Add';
    addAltBtn.style.cssText = 'font-size:11px; padding:4px 9px; flex:none;';
    function tryAddAlt(){
      var v = addAltInput.value.trim();
      if (!v || altState.indexOf(v) !== -1){ addAltInput.value = ''; return; }
      altState.push(v);
      addAltInput.value = '';
      renderAltRows();
    }
    addAltBtn.addEventListener('click', tryAddAlt);
    addAltInput.addEventListener('keydown', function(ev){
      if (ev.key === 'Enter'){ ev.preventDefault(); tryAddAlt(); }
    });
    addAltRow.appendChild(addAltInput);
    addAltRow.appendChild(addAltBtn);
    altField.appendChild(addAltRow);
    wrap.appendChild(altField);

    populateBtn.addEventListener('click', function(){
      populateStatus.textContent = '';
      var needDefinition = !defArea.value.trim();
      var existingAlts = altState.slice();
      populateBtn.disabled = true;
      populateBtn.textContent = 'Thinking…';
      getSample()
        .then(function(sample){
          if (!sample){
            sampleHidden = true;
            populateBtn.hidden = true;
            return null;
          }
          var prompt = buildConceptPopulatePrompt(schemeLabel, labelInput.value.trim() || c.label, needDefinition, existingAlts);
          return sample.json(prompt, {modelTier: 'default'});
        })
        .then(function(data){
          if (!data || typeof data !== 'object') return;
          var filled = 0;
          if (needDefinition && data.definition && String(data.definition).trim()){
            defArea.value = String(data.definition).trim();
            filled++;
          }
          if (Array.isArray(data.altLabels)){
            data.altLabels.forEach(function(al){
              var v = String(al || '').trim();
              if (v && altState.indexOf(v) === -1){ altState.push(v); filled++; }
            });
            renderAltRows();
          }
          populateStatus.textContent = filled
            ? ('Filled in ' + filled + ' suggestion' + (filled === 1 ? '' : 's') + ' from Claude’s own knowledge — review before saving.')
            : 'Claude didn’t have a confident suggestion this time.';
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
            prompt_too_large: 'Too much context to ask about at once — try again.',
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

    var warn = document.createElement('p');
    warn.style.cssText = 'display:none; margin:0 0 8px; font-size:12px; color:var(--bad);';
    wrap.appendChild(warn);

    var actions = document.createElement('div');
    actions.style.cssText = 'display:flex; gap:6px;';
    var saveBtn = document.createElement('button');
    saveBtn.type = 'button'; saveBtn.className = 'btn primary'; saveBtn.textContent = 'Save';
    saveBtn.style.cssText = 'font-size:11.5px; padding:5px 10px;';
    var cancelBtn = document.createElement('button');
    cancelBtn.type = 'button'; cancelBtn.className = 'btn'; cancelBtn.textContent = 'Cancel';
    cancelBtn.style.cssText = 'font-size:11.5px; padding:5px 10px;';
    cancelBtn.addEventListener('click', onDone);
    actions.appendChild(saveBtn);
    actions.appendChild(cancelBtn);
    wrap.appendChild(actions);

    saveBtn.addEventListener('click', function(){
      var newLabel = labelInput.value.trim();
      warn.style.display = 'none';
      if (!newLabel){
        warn.textContent = 'A label is required.';
        warn.style.display = 'block';
        return;
      }
      var newDef = defArea.value.trim();
      var oldDef = c.definition || '';
      var removedAlts = c.altLabels.filter(function(a){ return altState.indexOf(a) === -1; });
      var addedAlts = altState.filter(function(a){ return c.altLabels.indexOf(a) === -1; });

      saveBtn.disabled = true; cancelBtn.disabled = true; saveBtn.textContent = 'Saving…';
      var chain = Promise.resolve();
      if (newLabel !== c.label){
        chain = chain.then(function(){ return callTool(SERVER, 'sparql_update', {update: buildRenameConceptSparql(c.iri, newLabel)}); });
      }
      if (newDef !== oldDef){
        chain = chain.then(function(){ return callTool(SERVER, 'sparql_update', {update: buildSetConceptDefinitionSparql(c.iri, newDef)}); });
      }
      removedAlts.forEach(function(a){
        chain = chain.then(function(){ return callTool(SERVER, 'sparql_update', {update: buildRemoveAltLabelSparql(c.iri, a)}); });
      });
      addedAlts.forEach(function(a){
        chain = chain.then(function(){ return callTool(SERVER, 'sparql_update', {update: buildAddAltLabelSparql(c.iri, a)}); });
      });
      // Invalidate before the re-read, same as every write path in this
      // file -- sparql_select results are cached, so skipping this would
      // let the writes above succeed while the re-render right after them
      // shows stale (pre-save) data.
      chain
        .then(function(){ return mcp.invalidate(SERVER, 'sparql_select').catch(function(){}); })
        .then(function(){
          if (newLabel !== c.label) labelCache[c.iri] = newLabel;
          onDone();
          selectScheme(schemeIri);
        })
        .catch(function(err){
          warn.textContent = 'Couldn’t save — try again.';
          warn.style.display = 'block';
          saveBtn.disabled = false; cancelBtn.disabled = false; saveBtn.textContent = 'Save';
        });
    });

    return wrap;
  }

  function buildInlineRenameForm(currentValue, onSave, onCancel){
    var wrap = document.createElement('div');
    wrap.style.cssText = 'display:flex; gap:6px; align-items:center; margin-top:6px; flex-wrap:wrap;';
    var input = document.createElement('input');
    input.type = 'text';
    input.value = currentValue;
    input.style.cssText = 'flex:1; min-width:120px; font:inherit; font-size:13px; padding:5px 8px; border:1px solid var(--line); border-radius:6px; background:var(--card); color:var(--ink);';
    var saveBtn = document.createElement('button');
    saveBtn.type = 'button'; saveBtn.className = 'btn'; saveBtn.textContent = 'Save';
    saveBtn.style.cssText = 'font-size:11px; padding:4px 9px; flex:none;';
    var cancelBtn = document.createElement('button');
    cancelBtn.type = 'button'; cancelBtn.className = 'btn'; cancelBtn.textContent = 'Cancel';
    cancelBtn.style.cssText = 'font-size:11px; padding:4px 9px; flex:none;';
    var warn = document.createElement('p');
    warn.style.cssText = 'display:none; margin:2px 0 0; width:100%; font-size:12px; color:var(--bad);';
    wrap.appendChild(input);
    wrap.appendChild(saveBtn);
    wrap.appendChild(cancelBtn);
    wrap.appendChild(warn);
    cancelBtn.addEventListener('click', onCancel);
    input.addEventListener('keydown', function(ev){
      if (ev.key === 'Enter'){ ev.preventDefault(); saveBtn.click(); }
      else if (ev.key === 'Escape'){ ev.preventDefault(); onCancel(); }
    });
    saveBtn.addEventListener('click', function(){
      var v = input.value.trim();
      if (!v){ warn.textContent = 'A label is required.'; warn.style.display = 'block'; return; }
      saveBtn.disabled = true; cancelBtn.disabled = true; saveBtn.textContent = 'Saving…';
      onSave(v).catch(function(){
        warn.textContent = 'Couldn’t save — try again.';
        warn.style.display = 'block';
        saveBtn.disabled = false; cancelBtn.disabled = false; saveBtn.textContent = 'Save';
      });
    });
    input.focus();
    return wrap;
  }

  function buildAddConceptControl(schemeIri, existingConcepts){
    var wrap = document.createElement('div');
    wrap.style.cssText = 'margin:0 0 12px;';
    var addBtn = document.createElement('button');
    addBtn.type = 'button'; addBtn.className = 'btn'; addBtn.textContent = '+ New Concept';
    addBtn.style.cssText = 'font-size:11.5px; padding:5px 10px;';
    wrap.appendChild(addBtn);

    var form = document.createElement('div');
    form.style.cssText = 'display:none; flex-wrap:wrap; gap:6px; align-items:center; margin-top:8px;';
    var input = document.createElement('input');
    input.type = 'text';
    input.placeholder = 'New concept label…';
    input.style.cssText = 'flex:1; min-width:140px; font:inherit; font-size:13px; padding:6px 9px; border:1px solid var(--line); border-radius:6px; background:var(--card); color:var(--ink);';
    var saveBtn = document.createElement('button');
    saveBtn.type = 'button'; saveBtn.className = 'btn'; saveBtn.textContent = 'Add';
    saveBtn.style.cssText = 'flex:none; font-size:11.5px; padding:5px 10px;';
    var cancelBtn = document.createElement('button');
    cancelBtn.type = 'button'; cancelBtn.className = 'btn'; cancelBtn.textContent = 'Cancel';
    cancelBtn.style.cssText = 'flex:none; font-size:11.5px; padding:5px 10px;';
    var warn = document.createElement('p');
    warn.style.cssText = 'display:none; margin:4px 0 0; width:100%; font-size:12px; color:var(--bad);';
    form.appendChild(input); form.appendChild(saveBtn); form.appendChild(cancelBtn); form.appendChild(warn);
    wrap.appendChild(form);

    function close(){ form.style.display = 'none'; addBtn.hidden = false; }
    addBtn.addEventListener('click', function(){
      input.value = ''; warn.style.display = 'none';
      form.style.display = 'flex'; addBtn.hidden = true; input.focus();
    });
    cancelBtn.addEventListener('click', close);
    input.addEventListener('keydown', function(ev){
      if (ev.key === 'Enter'){ ev.preventDefault(); saveBtn.click(); }
      else if (ev.key === 'Escape'){ ev.preventDefault(); close(); }
    });
    saveBtn.addEventListener('click', function(){
      var label = input.value.trim();
      warn.style.display = 'none';
      if (!label){ warn.textContent = 'A label is required.'; warn.style.display = 'block'; return; }
      var ns = existingConcepts.length ? conceptNamespaceFor(existingConcepts[0].iri) : newSchemeConceptNamespace(schemeIri);
      var newIri = ns + pascalSlug(label);
      if (existingConcepts.some(function(c){ return c.iri === newIri; })){
        warn.textContent = 'A concept with that name already exists.';
        warn.style.display = 'block';
        return;
      }
      saveBtn.disabled = true; cancelBtn.disabled = true; saveBtn.textContent = 'Adding…';
      callTool(SERVER, 'sparql_update', {update: buildCreateConceptSparql(newIri, label, schemeIri)})
        .then(function(){ return pathsForScheme(schemeIri); })
        .then(function(paths){
          return paths.reduce(function(chain, path){
            return chain.then(function(){ return callTool(SERVER, 'sparql_update', {update: buildAppendConceptToInSparql(path, newIri)}); });
          }, Promise.resolve());
        })
        .then(function(){ return mcp.invalidate(SERVER, 'sparql_select').catch(function(){}); })
        .then(function(){
          labelCache[newIri] = label;
          loadTaxonomies(true);
          selectScheme(schemeIri);
        })
        .catch(function(){
          warn.textContent = 'Couldn’t create that concept — try again.';
          warn.style.display = 'block';
          saveBtn.disabled = false; cancelBtn.disabled = false; saveBtn.textContent = 'Add';
        });
    });
    return wrap;
  }

  function buildNewSchemeForm(){
    var card = document.createElement('div');
    card.className = 'addchild-form';
    var hint = document.createElement('p');
    hint.className = 'hint';
    hint.textContent = 'Creates an empty skos:ConceptScheme. It won’t appear as a choice anywhere until a SHACL property shape’s sh:in list is wired to draw from it — a separate step.';
    card.appendChild(hint);
    var errorBox = document.createElement('div');
    card.appendChild(errorBox);
    var nameField = document.createElement('div');
    nameField.className = 'field';
    var nameLabel = document.createElement('label');
    nameLabel.textContent = 'Scheme name';
    nameField.appendChild(nameLabel);
    var nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.placeholder = 'e.g. Mood';
    nameField.appendChild(nameInput);
    card.appendChild(nameField);

    var actionsRow = document.createElement('div');
    actionsRow.className = 'form-actions';
    var createBtn = document.createElement('button');
    createBtn.type = 'button'; createBtn.className = 'btn primary'; createBtn.textContent = 'Create Scheme';
    var cancelBtn = document.createElement('button');
    cancelBtn.type = 'button'; cancelBtn.className = 'btn'; cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', closeNewSchemeForm);
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
      var taxonomyNs = schemesData.length ? conceptNamespaceFor(schemesData[0].iri) : 'https://w3id.org/holon/worldtest/taxonomy/';
      var newIri = taxonomyNs + pascalSlug(name) + 'Scheme';
      if (schemesData.some(function(s){ return s.iri === newIri; })){
        var warn2 = document.createElement('p');
        warn2.className = 'warn';
        warn2.textContent = 'A scheme with that name already exists.';
        errorBox.appendChild(warn2);
        return;
      }
      createBtn.disabled = true; createBtn.textContent = 'Creating…';
      callTool(SERVER, 'sparql_update', {update: buildCreateSchemeSparql(newIri, name)})
        .then(function(){ return mcp.invalidate(SERVER, 'sparql_select').catch(function(){}); })
        .then(function(){ return loadTaxonomies(true); })
        .then(function(){ selectScheme(newIri); })
        .catch(function(err){
          createBtn.disabled = false; createBtn.textContent = 'Create Scheme';
          renderBanner(errorBox, err);
        });
    });
    actionsRow.appendChild(createBtn);
    actionsRow.appendChild(cancelBtn);
    card.appendChild(actionsRow);
    return card;
  }

  function openNewSchemeForm(){
    selectedSchemeIri = null;
    renderTaxonomies();
    $detail.innerHTML = '';
    var inner = document.createElement('div');
    inner.className = 'detail-inner';
    var h2 = document.createElement('h2');
    h2.className = 'title';
    h2.textContent = 'New Concept Scheme';
    inner.appendChild(h2);
    inner.appendChild(buildNewSchemeForm());
    $detail.appendChild(inner);
  }

  function closeNewSchemeForm(){
    renderTaxonomies();
    if (selectedSchemeIri) selectScheme(selectedSchemeIri);
    else renderIdleDetail('Nothing selected');
  }

