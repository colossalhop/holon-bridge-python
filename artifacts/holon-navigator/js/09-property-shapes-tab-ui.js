  // ---- Property Shapes: rail -------------------------------------------

  function buildPropertyShapeRow(ps){
    var row = document.createElement('button');
    row.className = 'row' + (ps.iri === selectedPropShapeIri ? ' active' : '');
    row.type = 'button';
    if (ps.deactivated) row.style.opacity = '0.55';
    var lbl = document.createElement('span');
    lbl.className = 'row-label';
    lbl.textContent = propertyShapeLabel(ps) + (ps.deactivated ? ' (deactivated)' : '');
    row.appendChild(lbl);
    var tp = document.createElement('span');
    tp.className = 'row-type';
    // The class(es) this shape is actually attached to, not its path --
    // two property shapes can share a humanized path (Country_capital and
    // FederatedState_capital both read "Capital" on the left) and this is
    // what tells them apart at a glance. Falls back to the path itself for
    // a shape that isn't attached to any node shape yet.
    var classText = ps.classes && ps.classes.length
      ? ps.classes.map(humanize).sort().join(', ')
      : (ps.path ? humanize(ps.path) : '');
    tp.textContent = classText;
    if (classText) tp.title = classText;
    row.appendChild(tp);
    row.addEventListener('click', function(){ selectPropertyShape(ps.iri); });
    return row;
  }

  function renderPropertyShapesTab(){
    $propShapes.innerHTML = '';
    var addBtn = document.createElement('button');
    addBtn.type = 'button'; addBtn.className = 'btn'; addBtn.textContent = '+ New Property Shape';
    addBtn.style.cssText = 'margin:8px 8px 10px; font-size:11.5px; padding:5px 10px;';
    addBtn.addEventListener('click', openNewPropertyShapeForm);
    $propShapes.appendChild(addBtn);
    $propShapes.appendChild(buildShowDeprecatedToggle('propshapes', 'Show deactivated', renderPropertyShapesTab));

    if (!propShapesData.length){
      var empty = document.createElement('div');
      empty.className = 'list-empty';
      empty.textContent = 'No SHACL property shapes yet.';
      $propShapes.appendChild(empty);
      return;
    }
    var visiblePropShapes = filterByDeactivatedFlag(propShapesData, 'propshapes');
    if (!visiblePropShapes.length){
      var allHiddenPS = document.createElement('div');
      allHiddenPS.className = 'list-empty';
      allHiddenPS.textContent = 'Every property shape is deactivated -- tick "Show deactivated" above to see them.';
      $propShapes.appendChild(allHiddenPS);
      return;
    }
    visiblePropShapes.slice().sort(function(a, b){ return propertyShapeLabel(a).localeCompare(propertyShapeLabel(b)); })
      .forEach(function(ps){ $propShapes.appendChild(buildPropertyShapeRow(ps)); });
  }

  function parsePropertyShapeRow(row){
    function v(key){ return (row[key] !== undefined && row[key] !== null) ? row[key].value : null; }
    return {
      path: v('path'),
      name: v('name'),
      description: v('description'),
      order: v('order'),
      severity: v('severity'),
      message: v('message'),
      deactivated: v('deactivated') === 'true',
      minCount: v('minCount'),
      maxCount: v('maxCount'),
      datatype: v('datatype'),
      class: v('class'),
      nodeKind: v('nodeKind'),
      hasValue: (row.hasValue !== undefined && row.hasValue !== null) ? {type: row.hasValue.type, value: row.hasValue.value} : null,
      pattern: v('pattern'),
      flags: v('flags'),
      minLength: v('minLength'),
      maxLength: v('maxLength'),
      uniqueLang: v('uniqueLang') === 'true',
      minInclusive: v('minInclusive'),
      maxInclusive: v('maxInclusive'),
      minExclusive: v('minExclusive'),
      maxExclusive: v('maxExclusive'),
      equals: v('equals'),
      disjoint: v('disjoint'),
      lessThan: v('lessThan'),
      lessThanOrEquals: v('lessThanOrEquals'),
      inValues: v('inValues') ? v('inValues').split('|').filter(Boolean) : [],
      languageIn: v('languageIn') ? v('languageIn').split('|').filter(Boolean) : []
    };
  }

  function selectPropertyShape(shapeIri, skipRerenderRail){
    selectedPropShapeIri = shapeIri;
    if (!skipRerenderRail) renderPropertyShapesTab();
    renderDetailSkeleton();
    Promise.all([
      callTool(SERVER, 'sparql_select', {query: propertyShapeFullQuery(shapeIri), graph: SHACL_GRAPH})
        .then(function(res){ return (res.payload && res.payload.results && res.payload.results.bindings) || []; }),
      callTool(SERVER, 'sparql_select', {query: nodeShapesUsingPropertyQuery(shapeIri), graph: SHACL_GRAPH})
        .then(function(res){ return (res.payload && res.payload.results && res.payload.results.bindings) || []; })
    ]).then(function(results){
      var row = results[0][0] || {};
      var usedBy = results[1].map(function(b){
        return {iri: b.shape.value, targetClass: b.targetClass ? b.targetClass.value : null, label: b.label ? b.label.value : null};
      });
      renderPropertyShapeDetail(shapeIri, row, usedBy);
    }).catch(function(err){
      $detail.innerHTML = '';
      var inner = document.createElement('div');
      inner.className = 'detail-inner';
      $detail.appendChild(inner);
      renderBanner(inner, err, function(){ selectPropertyShape(shapeIri); });
    });
  }

  function buildPropertyShapeSummary(meta){
    var wrap = document.createElement('div');
    var rows = [];
    if (meta.description) rows.push(['Description', meta.description]);
    if (meta.order != null) rows.push(['Order', meta.order]);
    if (meta.severity) rows.push(['Severity', humanize(meta.severity)]);
    if (meta.message) rows.push(['Message', meta.message]);
    if (meta.minCount != null || meta.maxCount != null) rows.push(['Cardinality', (meta.minCount || '0') + '..' + (meta.maxCount != null ? meta.maxCount : '*')]);
    if (meta.datatype) rows.push(['Datatype', humanize(meta.datatype)]);
    if (meta.class) rows.push(['Class', humanize(meta.class)]);
    if (meta.nodeKind) rows.push(['Node kind', humanize(meta.nodeKind)]);
    if (meta.hasValue) rows.push(['Has value', meta.hasValue.value]);
    if (meta.inValues.length) rows.push(['In (enum)', meta.inValues.map(function(v){ return /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(v) ? humanize(v) : v; }).join(', ')]);
    if (meta.pattern) rows.push(['Pattern', meta.pattern + (meta.flags ? '  (flags: ' + meta.flags + ')' : '')]);
    if (meta.minLength != null) rows.push(['Min length', meta.minLength]);
    if (meta.maxLength != null) rows.push(['Max length', meta.maxLength]);
    if (meta.languageIn.length) rows.push(['Language in', meta.languageIn.join(', ')]);
    if (meta.uniqueLang) rows.push(['Unique language', 'yes']);
    if (meta.minInclusive != null) rows.push(['Min (inclusive)', meta.minInclusive]);
    if (meta.maxInclusive != null) rows.push(['Max (inclusive)', meta.maxInclusive]);
    if (meta.minExclusive != null) rows.push(['Min (exclusive)', meta.minExclusive]);
    if (meta.maxExclusive != null) rows.push(['Max (exclusive)', meta.maxExclusive]);
    if (meta.equals) rows.push(['Equals', humanize(meta.equals)]);
    if (meta.disjoint) rows.push(['Disjoint', humanize(meta.disjoint)]);
    if (meta.lessThan) rows.push(['Less than', humanize(meta.lessThan)]);
    if (meta.lessThanOrEquals) rows.push(['Less than or equals', humanize(meta.lessThanOrEquals)]);
    if (!rows.length){
      var hint = document.createElement('p');
      hint.className = 'hint';
      hint.textContent = 'No constraints set beyond the path yet -- click Edit to add some.';
      wrap.appendChild(hint);
      return wrap;
    }
    var kv = document.createElement('div');
    kv.className = 'kv';
    rows.forEach(function(r){
      var row = document.createElement('div');
      row.className = 'kv-row';
      var key = document.createElement('div');
      key.className = 'kv-key';
      key.textContent = r[0];
      row.appendChild(key);
      var val = document.createElement('div');
      val.className = 'kv-val';
      var span = document.createElement('span');
      span.className = 'plain';
      span.textContent = r[1];
      val.appendChild(span);
      row.appendChild(val);
      kv.appendChild(row);
    });
    wrap.appendChild(kv);
    return wrap;
  }

  function renderPropertyShapeDetail(shapeIri, row, usedBy){
    var meta = parsePropertyShapeRow(row);
    var isEditing = propShapeEditOpenFor === shapeIri;

    var inner = document.createElement('div');
    inner.className = 'detail-inner';

    var badges = document.createElement('div');
    badges.className = 'badges';
    var p = document.createElement('span');
    p.className = 'pill type';
    p.textContent = 'SHACL Property Shape';
    badges.appendChild(p);
    if (meta.deactivated){
      var dp = document.createElement('span');
      dp.className = 'pill status';
      dp.textContent = 'Deactivated';
      badges.appendChild(dp);
    }
    inner.appendChild(badges);

    if (!isEditing){
      var h2 = document.createElement('h2');
      h2.className = 'title';
      h2.textContent = meta.name || (meta.path ? humanize(meta.path) : humanize(shapeIri));
      inner.appendChild(h2);
    }

    var iriLine = document.createElement('div');
    iriLine.className = 'iri';
    iriLine.textContent = shapeIri;
    inner.appendChild(iriLine);

    if (meta.path){
      var pathLine = document.createElement('p');
      pathLine.className = 'hint';
      pathLine.style.margin = '-12px 0 18px';
      pathLine.textContent = 'Path: ' + humanize(meta.path) + '  (' + meta.path + ')';
      inner.appendChild(pathLine);
    }

    var actions = document.createElement('div');
    actions.className = 'actions';
    var editBtn = document.createElement('button');
    editBtn.type = 'button'; editBtn.className = 'btn';
    editBtn.textContent = isEditing ? 'Cancel Edit' : 'Edit';
    editBtn.addEventListener('click', function(){
      propShapeEditOpenFor = isEditing ? null : shapeIri;
      selectPropertyShape(shapeIri, true);
    });
    actions.appendChild(editBtn);
    var toggleBtn = document.createElement('button');
    toggleBtn.type = 'button'; toggleBtn.className = 'btn';
    toggleBtn.textContent = meta.deactivated ? 'Reactivate' : 'Deactivate';
    toggleBtn.addEventListener('click', function(){
      toggleBtn.disabled = true;
      callTool(SERVER, 'sparql_update', {update: buildSetDeactivatedSparql(shapeIri, !meta.deactivated)})
        .then(function(){ return mcp.invalidate(SERVER, 'sparql_select').catch(function(){}); })
        .then(function(){ return loadPropShapesData(true); })
        .then(function(){ renderPropertyShapesTab(); selectPropertyShape(shapeIri, true); })
        .catch(function(err){ toggleBtn.disabled = false; renderBanner(inner, err); });
    });
    actions.appendChild(toggleBtn);

    // Temporary escape hatch alongside Deactivate (see
    // buildDeletePropertyShapeSparql's comment) -- armed on a first click,
    // executed on a second, so a stray click can't delete anything outright.
    var deleteBtn = document.createElement('button');
    deleteBtn.type = 'button'; deleteBtn.className = 'btn';
    deleteBtn.textContent = 'Delete';
    deleteBtn.style.cssText = 'border-color:var(--bad); color:var(--bad);';
    deleteBtn.addEventListener('click', function(){
      if (deleteBtn.getAttribute('data-armed') !== '1'){
        deleteBtn.setAttribute('data-armed', '1');
        deleteBtn.textContent = usedBy.length
          ? 'Confirm Delete (used by ' + usedBy.length + ')'
          : 'Confirm Delete?';
        deleteBtn.style.cssText = 'background:var(--bad); border-color:var(--bad); color:#fff;';
        return;
      }
      deleteBtn.disabled = true; toggleBtn.disabled = true; editBtn.disabled = true;
      deleteBtn.textContent = 'Deleting…';
      var usedByIris = usedBy.map(function(nb){ return nb.iri; });
      callTool(SERVER, 'sparql_update', {update: buildDeletePropertyShapeSparql(shapeIri, usedByIris)})
        .then(function(){ return mcp.invalidate(SERVER, 'sparql_select').catch(function(){}); })
        .then(function(){ selectedPropShapeIri = null; return loadPropShapesData(true); })
        .then(function(){ renderPropertyShapesTab(); renderIdleDetail('Property shape deleted'); })
        .catch(function(err){
          deleteBtn.disabled = false; toggleBtn.disabled = false; editBtn.disabled = false;
          deleteBtn.removeAttribute('data-armed');
          deleteBtn.textContent = 'Delete';
          deleteBtn.style.cssText = 'border-color:var(--bad); color:var(--bad);';
          renderBanner(inner, err);
        });
    });
    actions.appendChild(deleteBtn);
    inner.appendChild(actions);

    if (isEditing) inner.appendChild(buildPropertyShapeEditForm(shapeIri, meta));
    else inner.appendChild(buildPropertyShapeSummary(meta));

    if (usedBy.length){
      var secLabel = document.createElement('div');
      secLabel.className = 'section-label';
      secLabel.style.marginTop = '10px';
      secLabel.textContent = 'Used by (' + usedBy.length + ')';
      inner.appendChild(secLabel);
      var kv = document.createElement('div');
      kv.className = 'kv';
      usedBy.forEach(function(nb){
        var kvrow = document.createElement('div');
        kvrow.className = 'kv-row';
        var key = document.createElement('div');
        key.className = 'kv-key';
        key.textContent = nb.targetClass ? humanize(nb.targetClass) : '';
        kvrow.appendChild(key);
        var val = document.createElement('div');
        val.className = 'kv-val';
        var chip = document.createElement('button');
        chip.type = 'button'; chip.className = 'chip';
        chip.innerHTML = '<span>' + (nb.label || humanize(nb.iri)) + '</span><span class="arrow">&#8594;</span>';
        chip.addEventListener('click', function(){ jumpToNodeShape(nb.iri); });
        val.appendChild(chip);
        kvrow.appendChild(val);
        kv.appendChild(kvrow);
      });
      inner.appendChild(kv);
    }

    $detail.innerHTML = '';
    $detail.appendChild(inner);
  }

  // Every scalar (single literal-or-IRI) SHACL 1.2 Core constraint this
  // editor exposes, keyed by the field name parsePropertyShapeRow uses.
  // sh:hasValue, sh:in, sh:languageIn and sh:uniqueLang are handled
  // separately in buildPropertyShapeEditForm below -- two are RDF lists,
  // one mixes IRI-or-literal, one is a plain checkbox -- so they don't fit
  // this generic text/select/number shape.
  var SCALAR_FIELDS = [
    {key: 'name', predicate: SH_NAME, kind: 'text', label: 'Name'},
    {key: 'description', predicate: SH_DESCRIPTION2, kind: 'textarea', label: 'Description'},
    {key: 'order', predicate: SH_ORDER, kind: 'number', label: 'Order'},
    {key: 'severity', predicate: SH_SEVERITY, kind: 'select', label: 'Severity', options: SEVERITY_OPTIONS},
    {key: 'message', predicate: SH_MESSAGE, kind: 'textarea', label: 'Message'},
    {key: 'minCount', predicate: SH_MINCOUNT, kind: 'number', label: 'Min count'},
    {key: 'maxCount', predicate: SH_MAXCOUNT, kind: 'number', label: 'Max count'},
    {key: 'datatype', predicate: SH_DATATYPE, kind: 'select', label: 'Datatype', options: DATATYPE_OPTIONS},
    {key: 'class', predicate: SH_CLASS, kind: 'classselect', label: 'Class'},
    {key: 'nodeKind', predicate: SH_NODEKIND, kind: 'select', label: 'Node kind', options: NODEKIND_OPTIONS},
    {key: 'pattern', predicate: SH_PATTERN, kind: 'text', label: 'Pattern'},
    {key: 'flags', predicate: SH_FLAGS, kind: 'text', label: 'Pattern flags'},
    {key: 'minLength', predicate: SH_MINLENGTH, kind: 'number', label: 'Min length'},
    {key: 'maxLength', predicate: SH_MAXLENGTH, kind: 'number', label: 'Max length'},
    {key: 'minInclusive', predicate: SH_MININCLUSIVE, kind: 'number', label: 'Min (inclusive)'},
    {key: 'maxInclusive', predicate: SH_MAXINCLUSIVE, kind: 'number', label: 'Max (inclusive)'},
    {key: 'minExclusive', predicate: SH_MINEXCLUSIVE, kind: 'number', label: 'Min (exclusive)'},
    {key: 'maxExclusive', predicate: SH_MAXEXCLUSIVE, kind: 'number', label: 'Max (exclusive)'},
    {key: 'equals', predicate: SH_EQUALS, kind: 'text', label: 'Equals (path IRI)'},
    {key: 'disjoint', predicate: SH_DISJOINT, kind: 'text', label: 'Disjoint (path IRI)'},
    {key: 'lessThan', predicate: SH_LESSTHAN, kind: 'text', label: 'Less than (path IRI)'},
    {key: 'lessThanOrEquals', predicate: SH_LESSTHANOREQUALS, kind: 'text', label: 'Less than or equals (path IRI)'}
  ];

  function buildPropertyShapeEditForm(shapeIri, meta){
    var card = document.createElement('div');
    card.className = 'addchild-form';

    var h3 = document.createElement('h3');
    h3.textContent = 'Edit property shape';
    card.appendChild(h3);

    var hint = document.createElement('p');
    hint.className = 'hint';
    hint.textContent = 'Updates this shape’s SHACL 1.2 Core constraints live in the shapes graph. sh:path (' + (meta.path ? humanize(meta.path) : '—') + ') can’t be changed here -- create a new property shape for a different predicate. Only fields you actually change are written.';
    card.appendChild(hint);

    var errorBox = document.createElement('div');
    card.appendChild(errorBox);

    var controls = {};

    SCALAR_FIELDS.forEach(function(spec){
      var field = document.createElement('div');
      field.className = 'field';
      var label = document.createElement('label');
      label.textContent = spec.label;
      field.appendChild(label);
      var current = meta[spec.key];
      var input;
      if (spec.kind === 'textarea'){
        input = document.createElement('textarea');
        input.value = current || '';
      } else if (spec.kind === 'select' || spec.kind === 'classselect'){
        input = document.createElement('select');
        var blankOpt = document.createElement('option');
        blankOpt.value = ''; blankOpt.textContent = '— none —';
        input.appendChild(blankOpt);
        var opts = spec.kind === 'classselect'
          ? computeAllTypes().sort(function(a, b){ return humanize(a).localeCompare(humanize(b)); }).map(function(t){ return {iri: t, label: humanize(t)}; })
          : spec.options;
        opts.forEach(function(o){
          var opt = document.createElement('option');
          opt.value = o.iri;
          opt.textContent = o.label;
          if (current === o.iri) opt.selected = true;
          input.appendChild(opt);
        });
      } else {
        input = document.createElement('input');
        input.type = 'text';
        input.value = current != null ? current : '';
      }
      field.appendChild(input);
      card.appendChild(field);
      controls[spec.key] = {
        get: function(){ var v = ('value' in input) ? input.value : ''; return typeof v === 'string' ? v.trim() : v; },
        initial: current != null ? String(current) : ''
      };
    });

    // sh:hasValue -- can be an IRI or a plain literal, so it gets its own
    // text field (with iriOrLiteralClause deciding which on save) rather
    // than living in SCALAR_FIELDS.
    var hvField = document.createElement('div');
    hvField.className = 'field';
    var hvLabel = document.createElement('label');
    hvLabel.textContent = 'Has value';
    hvField.appendChild(hvLabel);
    var hvInput = document.createElement('input');
    hvInput.type = 'text';
    var hvInitial = meta.hasValue ? meta.hasValue.value : '';
    hvInput.value = hvInitial;
    hvInput.placeholder = 'A full IRI (http://…), or plain text -- blank to remove';
    hvField.appendChild(hvInput);
    card.appendChild(hvField);

    // uniqueLang: a plain checkbox -- boolLiteral() on save.
    var ulField = document.createElement('div');
    ulField.className = 'field';
    var ulLabel = document.createElement('label');
    ulLabel.style.cssText = 'display:flex; align-items:center; gap:7px; cursor:pointer;';
    var ulInput = document.createElement('input');
    ulInput.type = 'checkbox';
    ulInput.checked = !!meta.uniqueLang;
    ulLabel.appendChild(ulInput);
    ulLabel.appendChild(document.createTextNode('Unique language (sh:uniqueLang)'));
    ulField.appendChild(ulLabel);
    card.appendChild(ulField);

    // sh:in -- a closed enumeration, edited as a comma-separated list (each
    // value written as an IRI if it looks like one, a plain literal
    // otherwise -- same convention as Has Value). Full-list replace on save
    // via buildClearListSparql + buildInsertListSparql, matching how
    // buildAppendConceptToInSparql elsewhere already treats sh:in as a real
    // RDF list rather than something to patch value-by-value.
    var inField = document.createElement('div');
    inField.className = 'field';
    var inLabel = document.createElement('label');
    inLabel.textContent = 'In (enumeration, comma-separated)';
    inField.appendChild(inLabel);
    var inInput = document.createElement('input');
    inInput.type = 'text';
    inInput.value = meta.inValues.join(', ');
    inField.appendChild(inInput);
    card.appendChild(inField);

    // sh:languageIn -- comma-separated BCP47 tags, also a real RDF list.
    var langField = document.createElement('div');
    langField.className = 'field';
    var langLabel = document.createElement('label');
    langLabel.textContent = 'Language in (comma-separated, e.g. en, fr)';
    langField.appendChild(langLabel);
    var langInput = document.createElement('input');
    langInput.type = 'text';
    langInput.value = meta.languageIn.join(', ');
    langField.appendChild(langInput);
    card.appendChild(langField);

    var actionsRow = document.createElement('div');
    actionsRow.className = 'form-actions';
    var saveBtn = document.createElement('button');
    saveBtn.type = 'button'; saveBtn.className = 'btn primary'; saveBtn.textContent = 'Save Changes';
    var cancelBtn = document.createElement('button');
    cancelBtn.type = 'button'; cancelBtn.className = 'btn'; cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', function(){
      propShapeEditOpenFor = null;
      selectPropertyShape(shapeIri, true);
    });

    saveBtn.addEventListener('click', function(){
      errorBox.innerHTML = '';
      saveBtn.disabled = true; cancelBtn.disabled = true; saveBtn.textContent = 'Saving…';
      var chain = Promise.resolve();

      SCALAR_FIELDS.forEach(function(spec){
        var ctl = controls[spec.key];
        var newVal = ctl.get();
        if (newVal === (ctl.initial || '')) return;
        var clause = null;
        if (newVal){
          if (spec.kind === 'select' || spec.kind === 'classselect'){
            clause = '<' + newVal + '>';
          } else if (spec.kind === 'number'){
            clause = numericLiteral(newVal);
          } else if (/^(equals|disjoint|lessThan|lessThanOrEquals)$/.test(spec.key)){
            clause = '<' + newVal + '>';
          } else {
            clause = turtleLiteral(newVal);
          }
        }
        var update = buildReplaceFieldSparql(SHACL_GRAPH, shapeIri, spec.predicate, clause);
        chain = chain.then(function(){ return callTool(SERVER, 'sparql_update', {update: update}); });
      });

      var newHasValue = hvInput.value.trim();
      if (newHasValue !== hvInitial){
        var hvUpdate = buildReplaceFieldSparql(SHACL_GRAPH, shapeIri, SH_HASVALUE, newHasValue ? iriOrLiteralClause(newHasValue) : null);
        chain = chain.then(function(){ return callTool(SERVER, 'sparql_update', {update: hvUpdate}); });
      }

      var newUniqueLang = ulInput.checked;
      if (newUniqueLang !== !!meta.uniqueLang){
        var ulUpdate = buildReplaceFieldSparql(SHACL_GRAPH, shapeIri, SH_UNIQUELANG, newUniqueLang ? boolLiteral(true) : null);
        chain = chain.then(function(){ return callTool(SERVER, 'sparql_update', {update: ulUpdate}); });
      }

      var newIn = inInput.value.split(',').map(function(x){ return x.trim(); }).filter(Boolean);
      if (newIn.join('|') !== meta.inValues.join('|')){
        chain = chain.then(function(){ return callTool(SERVER, 'sparql_update', {update: buildClearListSparql(SHACL_GRAPH, shapeIri, SH_IN)}); });
        if (newIn.length){
          chain = chain.then(function(){ return callTool(SERVER, 'sparql_update', {update: buildInsertListSparql(SHACL_GRAPH, shapeIri, SH_IN, newIn.map(iriOrLiteralClause))}); });
        }
      }

      var newLangIn = langInput.value.split(',').map(function(x){ return x.trim(); }).filter(Boolean);
      if (newLangIn.join('|') !== meta.languageIn.join('|')){
        chain = chain.then(function(){ return callTool(SERVER, 'sparql_update', {update: buildClearListSparql(SHACL_GRAPH, shapeIri, SH_LANGUAGEIN)}); });
        if (newLangIn.length){
          chain = chain.then(function(){ return callTool(SERVER, 'sparql_update', {update: buildInsertListSparql(SHACL_GRAPH, shapeIri, SH_LANGUAGEIN, newLangIn.map(turtleLiteral))}); });
        }
      }

      chain
        .then(function(){ return mcp.invalidate(SERVER, 'sparql_select').catch(function(){}); })
        .then(function(){
          propShapeEditOpenFor = null;
          return loadPropShapesData(true);
        })
        .then(function(){ renderPropertyShapesTab(); selectPropertyShape(shapeIri, true); })
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

  function buildNewPropertyShapeForm(){
    var card = document.createElement('div');
    card.className = 'addchild-form';
    var hint = document.createElement('p');
    hint.className = 'hint';
    hint.textContent = 'Creates a named, reusable sh:PropertyShape -- attach it to one or more Node Shapes from either tab afterward. Every other SHACL 1.2 Core constraint (cardinality, datatype, pattern, ...) is added on the Edit screen once it exists.';
    card.appendChild(hint);

    var errorBox = document.createElement('div');
    card.appendChild(errorBox);

    var pathField = document.createElement('div');
    pathField.className = 'field';
    var pathLabel = document.createElement('label');
    pathLabel.textContent = 'Path (property)';
    pathField.appendChild(pathLabel);
    var pathSelect = document.createElement('select');
    var loadingOpt = document.createElement('option');
    loadingOpt.value = ''; loadingOpt.textContent = 'Loading properties…';
    pathSelect.appendChild(loadingOpt);
    pathField.appendChild(pathSelect);
    card.appendChild(pathField);

    var customWrap = document.createElement('div');
    customWrap.className = 'field';
    customWrap.hidden = true;
    var customLabel = document.createElement('label');
    customLabel.textContent = 'Property IRI';
    customWrap.appendChild(customLabel);
    var customInput = document.createElement('input');
    customInput.type = 'text';
    customInput.placeholder = 'https://…#somePredicate';
    customWrap.appendChild(customInput);
    card.appendChild(customWrap);

    // Revealed only when "+ Create a new property..." is chosen below --
    // mints a brand-new rdf:Property (via buildCreatePropertyTurtle) before
    // the property shape itself is created, exactly the way the New Node
    // Shape form's "+ Create a new class..." option mints a class first.
    // Distinct from "Other (enter an IRI)..." above: that one points
    // sh:path at whatever IRI is typed without asserting anything about
    // it; this one actually declares the predicate to exist.
    var newPropPanel = document.createElement('div');
    newPropPanel.hidden = true;
    newPropPanel.style.cssText = 'margin:-6px 0 14px; padding:10px 12px; border:1px solid var(--line); border-radius:8px;';
    var newPropPicker = buildNamespaceLocalPicker();
    newPropPanel.appendChild(newPropPicker.wrap);
    var newPropLabelField = document.createElement('div');
    newPropLabelField.className = 'field';
    var newPropLabelLabel = document.createElement('label');
    newPropLabelLabel.textContent = 'Property label (optional)';
    newPropLabelField.appendChild(newPropLabelLabel);
    var newPropLabelInput = document.createElement('input');
    newPropLabelInput.type = 'text';
    newPropLabelInput.placeholder = 'Defaults to the local name';
    newPropLabelField.appendChild(newPropLabelInput);
    newPropPanel.appendChild(newPropLabelField);
    card.appendChild(newPropPanel);

    // "Class (for shape naming)" -- purely a naming input, not a
    // constraint: it does NOT restrict which node shapes this property
    // shape can later be attached to (it's still a reusable, independently
    // attachable shape, same as always). It exists only to feed
    // defaultPropertyShapeIri's shape:{ClassName}_{propertyName} default
    // below, per Kurt's 2026-09-18 convention.
    var classField = document.createElement('div');
    classField.className = 'field';
    var classLabel = document.createElement('label');
    classLabel.textContent = 'Class (for shape naming)';
    classField.appendChild(classLabel);
    var classSelect = document.createElement('select');
    var classBlank = document.createElement('option');
    classBlank.value = ''; classBlank.textContent = '— none —';
    classSelect.appendChild(classBlank);
    computeAllTypes().sort(function(a, b){ return humanize(a).localeCompare(humanize(b)); }).forEach(function(t){
      var opt = document.createElement('option');
      opt.value = t; opt.textContent = humanize(t);
      classSelect.appendChild(opt);
    });
    classField.appendChild(classSelect);
    card.appendChild(classField);

    loadAllProperties().then(function(props){
      pathSelect.innerHTML = '';
      var blank = document.createElement('option');
      blank.value = ''; blank.textContent = '— choose a property —';
      pathSelect.appendChild(blank);
      props.forEach(function(p){
        var opt = document.createElement('option');
        opt.value = p; opt.textContent = humanize(p) + '  (' + p + ')';
        pathSelect.appendChild(opt);
      });
      var newPropOpt = document.createElement('option');
      newPropOpt.value = '__newprop__'; newPropOpt.textContent = '+ Create a new property…';
      pathSelect.appendChild(newPropOpt);
      var otherOpt = document.createElement('option');
      otherOpt.value = '__other__'; otherOpt.textContent = 'Other (enter an IRI)…';
      pathSelect.appendChild(otherOpt);
      refreshDefaultShapeIri();
    });
    pathSelect.addEventListener('change', function(){
      customWrap.hidden = pathSelect.value !== '__other__';
      newPropPanel.hidden = pathSelect.value !== '__newprop__';
      refreshDefaultShapeIri();
    });

    var nameField = document.createElement('div');
    nameField.className = 'field';
    var nameLabel = document.createElement('label');
    nameLabel.textContent = 'Name (optional)';
    nameField.appendChild(nameLabel);
    var nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.placeholder = 'Defaults to the property’s own name';
    nameField.appendChild(nameInput);
    card.appendChild(nameField);

    // Shape IRI -- always visible, always editable. Auto-filled with
    // shape:{ClassName}_{propertyName} (SHAPE_NS_DEFAULT) the moment both
    // a Class and a Path resolve to something, and re-filled every time
    // either changes -- UNTIL the admin types into this field directly, at
    // which point shapeIriDirty latches true and every future keystroke
    // here is treated as an explicit override the auto-fill must never
    // clobber. That's the literal implementation of "default until
    // explicitly overridden": the field IS the override mechanism.
    var shapeIriField = document.createElement('div');
    shapeIriField.className = 'field';
    var shapeIriLabel = document.createElement('label');
    shapeIriLabel.textContent = 'Shape IRI';
    shapeIriField.appendChild(shapeIriLabel);
    var shapeIriInput = document.createElement('input');
    shapeIriInput.type = 'text';
    shapeIriInput.placeholder = 'Choose a class and a path above to fill this in, or type your own';
    shapeIriField.appendChild(shapeIriInput);
    var shapeIriHint = document.createElement('p');
    shapeIriHint.className = 'hint';
    shapeIriHint.style.margin = '-8px 0 12px';
    shapeIriHint.textContent = 'Defaults to shape:{ClassName}_{propertyName} in https://w3-id.org/shape# once a class and path are chosen -- edit freely to use a different IRI instead.';
    shapeIriField.appendChild(shapeIriHint);
    card.appendChild(shapeIriField);

    var shapeIriDirty = false;
    shapeIriInput.addEventListener('input', function(){ shapeIriDirty = true; });

    function currentPathIriForNaming(){
      if (pathSelect.value === '__newprop__'){
        var nsUri = newPropPicker.getNamespaceUri();
        var local = newPropPicker.getLocal();
        return (nsUri && local) ? (nsUri + local) : '';
      }
      if (pathSelect.value === '__other__') return customInput.value.trim();
      return pathSelect.value;
    }
    function refreshDefaultShapeIri(){
      if (shapeIriDirty) return;
      shapeIriInput.value = defaultPropertyShapeIri(classSelect.value, currentPathIriForNaming());
    }
    classSelect.addEventListener('change', refreshDefaultShapeIri);
    customInput.addEventListener('input', refreshDefaultShapeIri);
    newPropPicker.wrap.addEventListener('change', refreshDefaultShapeIri);
    newPropPicker.wrap.addEventListener('input', refreshDefaultShapeIri);

    var actionsRow = document.createElement('div');
    actionsRow.className = 'form-actions';
    var createBtn = document.createElement('button');
    createBtn.type = 'button'; createBtn.className = 'btn primary'; createBtn.textContent = 'Create Property Shape';
    var cancelBtn = document.createElement('button');
    cancelBtn.type = 'button'; cancelBtn.className = 'btn'; cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', closeNewPropertyShapeForm);
    createBtn.addEventListener('click', function(){
      errorBox.innerHTML = '';
      var warn;
      var creatingNewProp = pathSelect.value === '__newprop__';
      var pathIri = creatingNewProp ? '' : (pathSelect.value === '__other__' ? customInput.value.trim() : pathSelect.value);
      var newPropNsUri = '', newPropLocal = '';
      if (creatingNewProp){
        newPropNsUri = newPropPicker.getNamespaceUri();
        newPropLocal = newPropPicker.getLocal();
        if (!newPropNsUri || !newPropLocal){
          warn = document.createElement('p');
          warn.className = 'warn';
          warn.textContent = 'Choose (or enter) a namespace and a local name for the new property.';
          errorBox.appendChild(warn);
          return;
        }
        pathIri = newPropNsUri + newPropLocal;
      }
      if (!pathIri){
        warn = document.createElement('p');
        warn.className = 'warn';
        warn.textContent = 'Choose or enter a property path.';
        errorBox.appendChild(warn);
        return;
      }
      var name = nameInput.value.trim();

      // Resolve the property shape's OWN iri. Three cases:
      //  1. The Shape IRI field has been explicitly edited (shapeIriDirty)
      //     -- respect it literally. A collision with an existing property
      //     shape is reported, not silently worked around, since typing an
      //     exact IRI is a deliberate act.
      //  2. It holds an auto-filled shape:{ClassName}_{propertyName}
      //     default (a class was chosen) -- dedupe it the same way every
      //     other auto-minted IRI in this file is deduped (uniqueShapeIri),
      //     so two shapes coined for the same class+property in the same
      //     session don't collide.
      //  3. It's empty (no class was chosen and nothing was typed) -- fall
      //     back to the pre-existing "mint from the property's own
      //     namespace" scheme, so this form still works without picking a
      //     class up front.
      var shapeIriValue = shapeIriInput.value.trim();
      var newIri;
      if (shapeIriValue && shapeIriDirty){
        if (propShapesData.some(function(p){ return p.iri === shapeIriValue; })){
          warn = document.createElement('p');
          warn.className = 'warn';
          warn.textContent = 'That Shape IRI is already used by another property shape -- choose a different one.';
          errorBox.appendChild(warn);
          return;
        }
        newIri = shapeIriValue;
      } else if (shapeIriValue){
        newIri = uniqueShapeIri(shapeIriValue, propShapesData);
      } else {
        var pathNs = namespaceAndLocal(pathIri);
        newIri = uniqueShapeIri(pathNs.ns + pathNs.local + 'PropertyShape', propShapesData);
      }

      createBtn.disabled = true; createBtn.textContent = 'Creating…';
      // As with the New Node Shape form's new-class path: when minting a
      // new property, its own creation (into ONTOLOGY_GRAPH) is pushed and
      // cache-invalidated FIRST, then loadAllProperties(true) refreshes the
      // memoized property list so it shows up immediately if this form (or
      // another instance of it) is opened again this session.
      var chain = Promise.resolve();
      if (creatingNewProp){
        var propLabel = newPropLabelInput.value.trim() || newPropLocal;
        var propTurtle = buildCreatePropertyTurtle(pathIri, propLabel);
        chain = chain
          .then(function(){ return callTool(SERVER, 'push_turtle', {turtle: propTurtle, graph_iri: ONTOLOGY_GRAPH, mode: 'merge'}); })
          .then(function(){ return mcp.invalidate(SERVER, 'sparql_select').catch(function(){}); })
          .then(function(){ allPropertiesPromise = null; return loadAllProperties(); });
      }
      chain
        .then(function(){
          return callTool(SERVER, 'push_turtle', {turtle: buildCreatePropertyShapeTurtle(newIri, pathIri, name), graph_iri: SHACL_GRAPH, mode: 'merge'})
            .then(function(){ return mcp.invalidate(SERVER, 'sparql_select').catch(function(){}); })
            .then(function(){ return loadPropShapesData(true); })
            .then(function(){ renderPropertyShapesTab(); selectPropertyShape(newIri); });
        })
        .catch(function(err){
          createBtn.disabled = false; createBtn.textContent = 'Create Property Shape';
          renderBanner(errorBox, err);
        });
    });
    actionsRow.appendChild(createBtn);
    actionsRow.appendChild(cancelBtn);
    card.appendChild(actionsRow);
    return card;
  }

  function openNewPropertyShapeForm(){
    selectedPropShapeIri = null;
    renderPropertyShapesTab();
    $detail.innerHTML = '';
    var inner = document.createElement('div');
    inner.className = 'detail-inner';
    var h2 = document.createElement('h2');
    h2.className = 'title';
    h2.textContent = 'New Property Shape';
    inner.appendChild(h2);
    inner.appendChild(buildNewPropertyShapeForm());
    $detail.appendChild(inner);
  }
  function closeNewPropertyShapeForm(){
    renderPropertyShapesTab();
    if (selectedPropShapeIri) selectPropertyShape(selectedPropShapeIri);
    else renderIdleDetail('Nothing selected');
  }

  // ======================================================================
  // Classes / Properties tabs -- browse the raw ontology vocabulary itself
  // (owl:Class / rdf:Property and friends), independent of the SHACL layer
  // built on top of it in Node Shapes / Property Shapes above. Most classes
  // and predicates in THIS dataset carry no explicit `a owl:Class` / `a
  // rdf:Property` triple at all -- they're only known from usage (a
  // holon's rdf:type, or a property shape's sh:path; see the comment on
  // buildCreateClassTurtle above) -- so both loaders merge ontology-graph
  // declarations with usage-derived vocabulary, exactly the way By Type's
  // computeAllTypes() already does for the holon list. Same rail/detail
  // shape as every other flat-list tab here (Taxonomies, Node Shapes,
  // Property Shapes, Namespaces): a loaded-once-per-dataset flag, the
  // currently selected IRI, and a separate "edit form open for" flag.
  // Deprecation reuses the SAME holon:status/holon:DeprecatedStatus
  // mechanism as Taxonomies/Namespaces (deprecatedSet/loadDeprecatedSet/
  // buildSetStatusSparql/buildClearStatusSparql) rather than SHACL's
  // sh:deactivated -- classes and properties aren't SHACL resources.
  // ======================================================================

  var CLASSES_LIST_QUERY = [
    "PREFIX owl: <http://www.w3.org/2002/07/owl#>",
    "PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>",
    "SELECT DISTINCT ?c ?label ?comment WHERE {",
    "  { ?c a owl:Class } UNION { ?c a rdfs:Class } UNION { ?c rdfs:subClassOf ?x1 } UNION { ?x2 rdfs:subClassOf ?c }",
    "  FILTER(isIRI(?c))",
    "  OPTIONAL { ?c rdfs:label ?label }",
    "  OPTIONAL { ?c rdfs:comment ?comment }",
    "}"
  ].join("\n");

  var PROPERTIES_LIST_QUERY = [
    "PREFIX owl: <http://www.w3.org/2002/07/owl#>",
    "PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>",
    "PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>",
    "SELECT ?p ?label ?comment",
    "  (GROUP_CONCAT(DISTINCT STR(?domain); separator=\"|\") AS ?domains)",
    "  (GROUP_CONCAT(DISTINCT STR(?range); separator=\"|\") AS ?ranges) WHERE {",
    "  { ?p a owl:ObjectProperty } UNION { ?p a owl:DatatypeProperty } UNION { ?p a owl:AnnotationProperty } UNION { ?p a rdf:Property }",
    "  FILTER(isIRI(?p))",
    "  OPTIONAL { ?p rdfs:label ?label }",
    "  OPTIONAL { ?p rdfs:comment ?comment }",
    "  OPTIONAL { ?p rdfs:domain ?domain }",
    "  OPTIONAL { ?p rdfs:range ?range }",
    "} GROUP BY ?p ?label ?comment"
  ].join("\n");

  // Instance counts per class, queried directly against HOLONS_GRAPH rather
  // than derived from the client-side `holons` array. `holons` is filled
  // asynchronously by loadList()'s live watchTool subscription (see
  // LIST_QUERY/loadList below) and loadClassesData() can run before that
  // first delivery lands -- e.g. the admin switches straight to the Classes
  // tab right after a dataset loads -- which would otherwise bake in a
  // permanent "0 instances" for every class the moment classesLoaded flips
  // true, since nothing re-triggers loadClassesData() afterward. A direct
  // COUNT query sidesteps that race (and stays correct even if the List
  // view is never opened at all this session).
  var CLASS_INSTANCE_COUNTS_QUERY = [
    "SELECT ?type (COUNT(DISTINCT ?holon) AS ?cnt) WHERE {",
    "  ?holon a ?type .",
    "  FILTER(isIRI(?type))",
    "} GROUP BY ?type"
  ].join("\n");

  // Same idea as CLASS_INSTANCE_COUNTS_QUERY, for properties: how many
  // triples in HOLONS_GRAPH actually use this predicate, independent of
  // whether any property shape references it. Feeds the Delete button's
  // "N triples will also be removed" gate/warning in renderPropertyDetail
  // below -- shape usage (p.shapes) is a schema-level concern shown
  // separately and doesn't affect whether a delete is "safe".
  var PROPERTY_USAGE_COUNTS_QUERY = [
    "SELECT ?p (COUNT(*) AS ?cnt) WHERE {",
    "  ?s ?p ?o .",
    "  FILTER(isIRI(?p))",
    "} GROUP BY ?p"
  ].join("\n");

  function classDisplayLabel(c){ return c.label || humanize(c.iri); }
  function propertyDisplayLabel(p){ return p.label || humanize(p.iri); }

  // Direct children of `iri` in the class hierarchy -- the reverse of
  // directSuper, computed on demand against whatever's currently in
  // classesData rather than a maintained index (this dataset's class
  // count is small enough that a linear scan per detail render is cheap).
  function subclassesOf(iri){
    return classesData.filter(function(c){ return (directSuper[c.iri] || []).indexOf(iri) !== -1; }).map(function(c){ return c.iri; });
  }

  // Writes rdfs:label/rdfs:comment on any ontology-graph resource -- shared
  // by the Classes and Properties edit forms below. Either argument may be
  // '' to clear that field entirely (delete-only, no re-insert), matching
  // buildSetStatusSparql/buildClearStatusSparql's own clear-vs-set split.
  function buildSetLabelCommentSparql(iri, label, comment){
    return [
      "PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>",
      "DELETE { GRAPH <" + ONTOLOGY_GRAPH + "> { <" + iri + "> rdfs:label ?l } }",
      (label ? "INSERT { GRAPH <" + ONTOLOGY_GRAPH + "> { <" + iri + "> rdfs:label " + langLiteral(label) + " } }" : ""),
      "WHERE { OPTIONAL { GRAPH <" + ONTOLOGY_GRAPH + "> { <" + iri + "> rdfs:label ?l } } } ;",
      "DELETE { GRAPH <" + ONTOLOGY_GRAPH + "> { <" + iri + "> rdfs:comment ?c } }",
      (comment ? "INSERT { GRAPH <" + ONTOLOGY_GRAPH + "> { <" + iri + "> rdfs:comment " + langLiteral(comment) + " } }" : ""),
      "WHERE { OPTIONAL { GRAPH <" + ONTOLOGY_GRAPH + "> { <" + iri + "> rdfs:comment ?c } } }"
    ].filter(Boolean).join("\n");
  }

  // A genuine, irreversible DELETE -- like buildDeletePropertyShapeSparql's
  // escape hatch above, but for a class. A class only "exists" in this tool
  // as something declared or instantiated (see the section comment on
  // CLASSES_LIST_QUERY/PROPERTIES_LIST_QUERY), so deleting one that still
  // has instances can't just remove its ontology-graph metadata and call it
  // done -- every holon still typed with it would be left behind, correctly
  // shown elsewhere as "of this type" while that type no longer means
  // anything. So when instanceCount > 0, this cascades: every triple that
  // points AT one of those holons is removed first (while `?holon a
  // <classIri>` still holds, since that's how they're found), then every
  // triple where one of those holons is itself the subject (which is what
  // actually deletes them, holon:isPartOf/type/everything else included),
  // and only then the class's own ontology-graph declaration. Order is load-
  // bearing: SPARQL Update runs each semicolon-separated operation against
  // whatever the graph looks like after the one before it, not a frozen
  // snapshot, so reversing steps 1 and 2 would mean the second DELETE's
  // WHERE no longer finds `?holon a <classIri>` to match against (the first
  // one already removed it). Callers must only reach this after the "N
  // instances will also be deleted, permanently" warning has been shown and
  // armed -- see renderClassDetail's Delete button below.
  function buildDeleteClassSparql(classIri){
    var parts = [
      [
        "DELETE { GRAPH <" + HOLONS_GRAPH + "> { ?referrer ?refPred ?holon } }",
        "WHERE { GRAPH <" + HOLONS_GRAPH + "> { ?holon a <" + classIri + "> . ?referrer ?refPred ?holon } }"
      ].join("\n"),
      [
        "DELETE { GRAPH <" + HOLONS_GRAPH + "> { ?holon ?p ?o } }",
        "WHERE { GRAPH <" + HOLONS_GRAPH + "> { ?holon a <" + classIri + "> ; ?p ?o } }"
      ].join("\n"),
      "DELETE WHERE { GRAPH <" + ONTOLOGY_GRAPH + "> { <" + classIri + "> ?anyP ?anyO } }"
    ];
    return parts.join(";\n");
  }

  // The property equivalent -- but unlike a class, a property isn't what
  // makes a holon "an instance" of anything, so deleting one never cascades
  // into deleting holons themselves. When usageCount > 0 this only strips
  // that predicate's triples wherever they're asserted, leaving the holons
  // that carried them (now just missing that one value) otherwise intact,
  // plus the property's own ontology-graph declaration (rdfs:label/comment/
  // domain/range/type, whatever this editor or anything else wrote about
  // it). Property shapes that reference it via sh:path are left alone --
  // shape usage is a separate, already-visible concern (see "Property
  // Shapes using this path" in renderPropertyDetail) and this tool never
  // deletes SHACL shapes as a side effect of an ontology-graph edit.
  function buildDeletePropertySparql(propIri){
    var parts = [
      "DELETE WHERE { GRAPH <" + HOLONS_GRAPH + "> { ?s <" + propIri + "> ?o } }",
      "DELETE WHERE { GRAPH <" + ONTOLOGY_GRAPH + "> { <" + propIri + "> ?anyP ?anyO } }"
    ];
    return parts.join(";\n");
  }

  // Shared label+comment edit form -- used by both the Classes and
  // Properties detail panes. onSave(label, comment) returns a Promise.
  function buildLabelCommentEditForm(currentLabel, currentComment, onSave, onCancel){
    var card = document.createElement('div');
    card.className = 'addchild-form';
    var labelField = document.createElement('div');
    labelField.className = 'field';
    var labelLabel = document.createElement('label');
    labelLabel.textContent = 'Label';
    labelField.appendChild(labelLabel);
    var labelInput = document.createElement('input');
    labelInput.type = 'text';
    labelInput.value = currentLabel || '';
    labelField.appendChild(labelInput);
    card.appendChild(labelField);

    var commentField = document.createElement('div');
    commentField.className = 'field';
    var commentLabel = document.createElement('label');
    commentLabel.textContent = 'Comment';
    commentField.appendChild(commentLabel);
    var commentArea = document.createElement('textarea');
    commentArea.value = currentComment || '';
    commentField.appendChild(commentArea);
    card.appendChild(commentField);

    var errorBox = document.createElement('div');
    card.appendChild(errorBox);

    var actionsRow = document.createElement('div');
    actionsRow.className = 'form-actions';
    var saveBtn = document.createElement('button');
    saveBtn.type = 'button'; saveBtn.className = 'btn primary'; saveBtn.textContent = 'Save';
    var cancelBtn = document.createElement('button');
    cancelBtn.type = 'button'; cancelBtn.className = 'btn'; cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', onCancel);
    saveBtn.addEventListener('click', function(){
      errorBox.innerHTML = '';
      saveBtn.disabled = true; cancelBtn.disabled = true; saveBtn.textContent = 'Saving…';
      onSave(labelInput.value.trim(), commentArea.value.trim()).catch(function(err){
        saveBtn.disabled = false; cancelBtn.disabled = false; saveBtn.textContent = 'Save';
        renderBanner(errorBox, err);
      });
    });
    actionsRow.appendChild(saveBtn);
    actionsRow.appendChild(cancelBtn);
    card.appendChild(actionsRow);
    return card;
  }

  // Reusable "chips linking elsewhere" section builder -- superclasses/
  // subclasses on a Class, domain/range on a Property, all just a list of
  // other IRIs with a jump handler.
  function buildDetailChipList(inner, label, iris, onClick){
    var secLabel = document.createElement('div');
    secLabel.className = 'section-label';
    secLabel.style.marginTop = '10px';
    secLabel.textContent = label + ' (' + iris.length + ')';
    inner.appendChild(secLabel);
    var wrap = document.createElement('div');
    wrap.style.cssText = 'display:flex; gap:6px; flex-wrap:wrap; margin:0 0 12px;';
    iris.forEach(function(iri){
      var chip = document.createElement('button');
      chip.type = 'button'; chip.className = 'chip';
      chip.innerHTML = '<span>' + humanize(iri) + '</span><span class="arrow">&#8594;</span>';
      chip.addEventListener('click', function(){ onClick(iri); });
      wrap.appendChild(chip);
    });
    inner.appendChild(wrap);
  }

  function loadClassesData(){
    return Promise.all([
      callTool(SERVER, 'sparql_select', {query: CLASSES_LIST_QUERY, graph: ONTOLOGY_GRAPH})
        .then(function(res){ return (res.payload && res.payload.results && res.payload.results.bindings) || []; }),
      loadNodeShapesData(),
      callTool(SERVER, 'sparql_select', {query: CLASS_INSTANCE_COUNTS_QUERY, graph: HOLONS_GRAPH})
        .then(function(res){ return (res.payload && res.payload.results && res.payload.results.bindings) || []; })
        .catch(function(){ return []; })
    ]).then(function(results){
      var bindings = results[0];
      var byIri = {};
      bindings.forEach(function(b){
        byIri[b.c.value] = {iri: b.c.value, label: b.label ? b.label.value : null, comment: b.comment ? b.comment.value : ''};
      });
      // Merge in every class discovered purely from usage -- see the
      // section comment above.
      computeAllTypes().forEach(function(t){
        if (!byIri[t]) byIri[t] = {iri: t, label: null, comment: ''};
      });
      var instanceCounts = {};
      results[2].forEach(function(b){ instanceCounts[b.type.value] = b.cnt ? parseInt(b.cnt.value, 10) || 0 : 0; });
      var shapesByClass = {};
      nodeShapesData.forEach(function(s){
        if (!s.targetClass) return;
        (shapesByClass[s.targetClass] = shapesByClass[s.targetClass] || []).push(s);
      });
      classesData = Object.keys(byIri).map(function(iri){
        var d = byIri[iri];
        return {
          iri: iri,
          label: d.label,
          comment: d.comment,
          superClasses: directSuper[iri] || [],
          instanceCount: instanceCounts[iri] || 0,
          shapes: shapesByClass[iri] || []
        };
      }).sort(function(a, b){ return classDisplayLabel(a).localeCompare(classDisplayLabel(b)); });
      classesLoaded = true;
      return classesData;
    });
  }

  function loadClassesTab(force){
    if (!mcp){
      $classes.innerHTML = '<div class="list-empty">No connector available.</div>';
      return Promise.resolve([]);
    }
    if (force || !classesLoaded){
      $classes.innerHTML = '';
      var loading = document.createElement('div');
      loading.className = 'list-empty';
      loading.textContent = 'Loading classes…';
      $classes.appendChild(loading);
    }
    return Promise.all([loadClassesData(), loadDeprecatedSet(force)])
      .then(function(){
        renderClassesTab();
        if (selectedClassIri) selectClass(selectedClassIri, true);
      })
      .catch(function(err){
        $classes.innerHTML = '';
        renderBanner($classes, err, function(){ loadClassesTab(true); });
      });
  }

  function loadPropertiesData(force){
    return Promise.all([
      callTool(SERVER, 'sparql_select', {query: PROPERTIES_LIST_QUERY, graph: ONTOLOGY_GRAPH})
        .then(function(res){ return (res.payload && res.payload.results && res.payload.results.bindings) || []; }),
      loadPropShapesData(force),
      callTool(SERVER, 'sparql_select', {query: PROPERTY_USAGE_COUNTS_QUERY, graph: HOLONS_GRAPH})
        .then(function(res){ return (res.payload && res.payload.results && res.payload.results.bindings) || []; })
        .catch(function(){ return []; })
    ]).then(function(results){
      var bindings = results[0];
      var byIri = {};
      bindings.forEach(function(b){
        byIri[b.p.value] = {
          iri: b.p.value,
          label: b.label ? b.label.value : null,
          comment: b.comment ? b.comment.value : '',
          domains: (b.domains && b.domains.value) ? b.domains.value.split('|').filter(Boolean) : [],
          ranges: (b.ranges && b.ranges.value) ? b.ranges.value.split('|').filter(Boolean) : []
        };
      });
      // Merge in every predicate discovered purely from SHACL usage
      // (sh:path) -- most properties in this dataset carry no explicit
      // rdf:Property/owl:...Property triple either, same gap as classes.
      var shapesByPath = {};
      propShapesData.forEach(function(ps){
        if (!ps.path) return;
        if (!byIri[ps.path]) byIri[ps.path] = {iri: ps.path, label: null, comment: '', domains: [], ranges: []};
        (shapesByPath[ps.path] = shapesByPath[ps.path] || []).push(ps);
      });
      var usageCounts = {};
      results[2].forEach(function(b){ usageCounts[b.p.value] = b.cnt ? parseInt(b.cnt.value, 10) || 0 : 0; });
      propertiesData = Object.keys(byIri).map(function(iri){
        var d = byIri[iri];
        return {
          iri: iri,
          label: d.label,
          comment: d.comment,
          domains: d.domains,
          ranges: d.ranges,
          shapes: shapesByPath[iri] || [],
          usageCount: usageCounts[iri] || 0
        };
      }).sort(function(a, b){ return propertyDisplayLabel(a).localeCompare(propertyDisplayLabel(b)); });
      propertiesLoaded = true;
      return propertiesData;
    });
  }

  function loadPropertiesTab(force){
    if (!mcp){
      $properties.innerHTML = '<div class="list-empty">No connector available.</div>';
      return Promise.resolve([]);
    }
    if (force || !propertiesLoaded){
      $properties.innerHTML = '';
      var loading = document.createElement('div');
      loading.className = 'list-empty';
      loading.textContent = 'Loading properties…';
      $properties.appendChild(loading);
    }
    return Promise.all([loadPropertiesData(force), loadDeprecatedSet(force)])
      .then(function(){
        renderPropertiesTab();
        if (selectedPropertyIri) selectProperty(selectedPropertyIri, true);
      })
      .catch(function(err){
        $properties.innerHTML = '';
        renderBanner($properties, err, function(){ loadPropertiesTab(true); });
      });
  }

