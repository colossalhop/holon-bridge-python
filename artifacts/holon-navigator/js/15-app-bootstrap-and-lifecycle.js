  function loadList(){
    renderListSkeleton();
    // Captured so the watch callback below can tell whether a dataset
    // switch has happened since this watch was registered -- watchTool has
    // no explicit unsubscribe for this call site (unlike selectHolon's
    // detailUnsub), so an in-flight watch on the OLD dataset's LIST_QUERY
    // is still technically live when enterDataset() moves on; without this
    // guard a slow response from the previous dataset could land after the
    // new one has already started rendering and silently overwrite it.
    var myGen = datasetGeneration;
    mcp.watchTool(SERVER, 'sparql_select', {query: LIST_QUERY, graph: HOLONS_GRAPH}, function(ev){
      if (myGen !== datasetGeneration) return;
      if (ev.type === 'error'){
        $list.innerHTML = '';
        renderBanner($list, ev.error, function(){ loadList(); });
        setConn('bad', 'query failed');
        return;
      }
      var bindings = (ev.result.payload && ev.result.payload.results && ev.result.payload.results.bindings) || [];
      holons = bindings.map(function(b){
        return {
          iri: b.holon.value,
          label: b.label.value,
          types: b.types ? b.types.value.split('|').filter(Boolean) : []
        };
      }).sort(function(a, b){ return a.label.localeCompare(b.label, undefined, {sensitivity: 'base'}); });
      iriToLabel = {};
      holons.forEach(function(h){ iriToLabel[h.iri] = h.label; });
      listCacheInfo = ev.result.cache || {storedAt: Date.now()};
      renderUpdated();
      renderList();
      renderByType();
      setConn('ok', DATASET + ' <b>&middot;</b> ' + SERVER);
      if (!selectedIri){
        var withType = holons.find(function(h){ return h.types.length; }) || holons[0];
        if (withType) selectHolon(withType.iri);
      }
    });
  }

  function showWaitingScreen(bankName, datasetName){
    $detail.innerHTML = '';
    var waiting = document.createElement('div');
    waiting.className = 'detail-inner';
    waiting.innerHTML = '<div class="state"><h2>Reaching ' + SERVER + '&hellip;</h2>' +
      '<p>Switching to the <code>' + bankName + '</code> bank and <code>' + datasetName + '</code> dataset, then loading the holon registry.</p></div>';
    $detail.appendChild(waiting);
  }

  // Clears every piece of per-dataset state before switching -- one dataset
  // has nothing to do with another's class hierarchy, SHACL shapes, holon
  // list, current selection, or open forms, so all of it starts genuinely
  // fresh rather than carrying stale entries from whatever was active
  // before. Added 2026-09-15 alongside the Bank/Dataset pickers -- before
  // this, a page load only ever set this state up ONCE, so nothing needed
  // to tear it back down.
  function resetDatasetState(){
    if (detailUnsub){ detailUnsub(); detailUnsub = null; }
    shapeCache = {};
    classInstanceCache = {};
    classInstanceData = {};
    labelCache = {};
    directSuper = {};
    ancestorCache = {};
    shapeTargetClasses = [];
    childTypeConstraints = {};
    inverseNamesPromise = null;
    enumSchemesPromise = null;
    deprecatedSetPromise = null;
    deprecatedSet = {};
    partOfPredicatesPromise = null;
    holons = [];
    iriToLabel = {};
    selectedIri = null;
    lastDetailBindings = null;
    lastDetailCache = null;
    listCacheInfo = null;
    treeLoaded = false;
    treeNodes = {};
    taxonomiesLoaded = false;
    schemesData = [];
    nodeShapesLoaded = false;
    nodeShapesData = [];
    selectedNodeShapeIri = null;
    nodeShapeEditOpenFor = null;
    propShapesLoaded = false;
    propShapesData = [];
    selectedPropShapeIri = null;
    propShapeEditOpenFor = null;
    allPropertiesPromise = null;
    classesLoaded = false;
    classesData = [];
    selectedClassIri = null;
    classEditOpenFor = null;
    propertiesLoaded = false;
    propertiesData = [];
    selectedPropertyIri = null;
    propertyEditOpenFor = null;
    namespacesLoaded = false;
    namespacesData = [];
    selectedNamespaceIri = null;
    namespaceEditOpenFor = null;
    addChildOpenFor = null;
    addConnOpenFor = null;
    editOpenFor = null;
    if ($search) $search.value = '';
    // Reset the rail back to the List tab -- a Containment Tree or
    // Taxonomies view mid-render for the OLD dataset makes no sense once
    // the new one's data starts arriving.
    currentView = 'list';
    $viewSelect.value = 'list';
    $list.hidden = false;
    $byType.hidden = true;
    $tree.hidden = true;
    $taxonomies.hidden = true;
    $nodeShapes.hidden = true;
    $propShapes.hidden = true;
    $classes.hidden = true;
    $properties.hidden = true;
    $namespaces.hidden = true;
    $searchWrap.hidden = false;
  }

  // The whoami + class-hierarchy + shapes + list chain every successful
  // boot needs, whether that's the very first page load or a later switch
  // into a dataset that already has (or was just given) a holon:Home.
  // Split out of enterDataset() so renderUnboundState()'s "Create Root
  // Holon" button can re-enter this exact same path the moment a Home
  // exists, without repeating switch_dataset/get_endpoint/homeQuery.
  function loadDatasetContent(myGen){
    return callTool(SERVER, 'whoami', {}).catch(function(){ return null; })
      .then(function(res){
        if (myGen !== datasetGeneration) return;
        creatorIri = (res && res.payload && res.payload.person) || null;
        return Promise.all([loadClassHierarchy(), loadShapeTargetClasses(), loadDeprecatedSet(), loadChildTypeConstraints()]);
      })
      .then(function(){
        if (myGen !== datasetGeneration) return;
        loadList();
        setPickersEnabled(true);
      });
  }

  // Renders the "this dataset has nothing holon-shaped in it yet" state in
  // place of the normal list/detail UI, with a small form to mint the one
  // thing every other view here assumes exists: a holon:Home. See
  // homeQuery/homeIriFor/buildRootHolonTurtle above for how "unbound" is
  // detected and what gets written.
  function renderUnboundState(datasetName, graphIri, myGen){
    setConn(null, datasetName + ' <b>&middot;</b> unbound');
    $list.innerHTML = '<div class="list-empty">No holon:Home yet in this dataset — create one to get started.</div>';
    $byType.innerHTML = '';
    $count.textContent = '';
    $updated.textContent = '';
    $detail.innerHTML = '';
    var inner = document.createElement('div');
    inner.className = 'detail-inner';
    $detail.appendChild(inner);

    var state = document.createElement('div');
    state.className = 'state';
    state.innerHTML = '<h2>“' + datasetName + '” isn’t holon-configured yet</h2>' +
      '<p>This dataset exists on the bridge, but its holons graph (<code>' + graphIri + '</code>) has no <code>holon:Home</code> instance — the canonical landing point every other view here assumes is there. Give it one to bootstrap the dataset; nothing else is written.</p>';
    inner.appendChild(state);

    var form = document.createElement('div');
    form.className = 'addchild-form';
    form.style.maxWidth = '480px';

    var labelField = document.createElement('div');
    labelField.className = 'field';
    var labelLabel = document.createElement('label');
    labelLabel.textContent = 'Label';
    labelField.appendChild(labelLabel);
    var labelInput = document.createElement('input');
    labelInput.type = 'text';
    labelInput.value = humanize(datasetName) + ' Home';
    labelField.appendChild(labelInput);
    form.appendChild(labelField);

    var descField = document.createElement('div');
    descField.className = 'field';
    var descLabel = document.createElement('label');
    descLabel.textContent = 'Description (optional)';
    descField.appendChild(descLabel);
    var descArea = document.createElement('textarea');
    descArea.placeholder = 'Canonical landing point for the ' + datasetName + ' dataset.';
    descField.appendChild(descArea);
    form.appendChild(descField);

    var errorBox = document.createElement('div');
    form.appendChild(errorBox);

    var actionsRow = document.createElement('div');
    actionsRow.className = 'form-actions';
    var createBtn = document.createElement('button');
    createBtn.type = 'button';
    createBtn.className = 'btn primary';
    createBtn.textContent = 'Create Root Holon';
    createBtn.addEventListener('click', function(){
      errorBox.innerHTML = '';
      var homeIri = homeIriFor(graphIri);
      var turtle = buildRootHolonTurtle(homeIri, labelInput.value.trim() || (humanize(datasetName) + ' Home'), descArea.value.trim());
      createBtn.disabled = true;
      createBtn.textContent = 'Creating…';
      callTool(SERVER, 'push_turtle', {turtle: turtle, graph_iri: graphIri, mode: 'merge'})
        .then(function(){
          if (myGen !== datasetGeneration) return;
          HOME_IRI = homeIri;
          // Every other write-then-read path in this file invalidates the
          // sparql_select cache before its next read (see the comment on
          // the scheme-deprecate toggle) -- this one didn't, so the very
          // first LIST_QUERY fetch for a freshly-unbound dataset kept
          // serving the pre-write "empty dataset" result forever: holons
          // stayed [], nothing matched loadList()'s auto-select, and
          // $detail was never replaced -- the button just sat on
          // "Creating…" even though the write itself had already
          // succeeded. Found 2026-09-16 against a genuinely-empty
          // CS-HB-MCP4/acmeco dataset (the first time this path had
          // ever actually run against data with nothing cached from
          // before).
          return mcp.invalidate(SERVER, 'sparql_select').catch(function(){});
        })
        .then(function(){
          if (myGen !== datasetGeneration) return;
          return loadDatasetContent(myGen);
        })
        .catch(function(err){
          createBtn.disabled = false;
          createBtn.textContent = 'Create Root Holon';
          renderBanner(errorBox, err);
        });
    });
    actionsRow.appendChild(createBtn);
    form.appendChild(actionsRow);
    inner.appendChild(form);
    setPickersEnabled(true);
  }

  function setPickersEnabled(enabled){
    $serverSelect.disabled = !enabled;
    $bankSelect.disabled = !enabled;
    $datasetSelect.disabled = !enabled;
  }

  // The single entry point for "make THIS dataset (on the currently active
  // bank) the one the whole app shows" -- the initial boot, a Dataset
  // picker change, and a Bank picker change (which first repoints the bank,
  // then calls this for whichever dataset it settles on) all funnel through
  // here. datasetGeneration is bumped up front so any async work still
  // in flight from a PREVIOUS call (a slow query, a live watch) recognises
  // itself as stale and no-ops instead of clobbering whatever this call
  // ends up rendering -- see the comment on datasetGeneration's declaration.
  function enterDataset(name){
    datasetGeneration++;
    var myGen = datasetGeneration;
    resetDatasetState();
    DATASET = name;
    if ($datasetSelect.value !== name) $datasetSelect.value = name;
    setPickersEnabled(false);
    setConn(null, 'switching…');
    showWaitingScreen(BANK, name);

    callTool(SERVER, 'switch_dataset', {name: name})
      .then(function(){ return callTool(SERVER, 'get_endpoint', {}); })
      .then(function(res){
        if (myGen !== datasetGeneration) return;
        var graphs = (res && res.payload && res.payload.graphs) || {};
        // Fall back to the one pattern every bank observed so far follows
        // (urn:holongraph:{dataset}:{key}) if get_endpoint ever omits a key
        // -- better to guess consistently than to leave a graph IRI pointed
        // at the PREVIOUS dataset.
        HOLONS_GRAPH = graphs.holons || ("urn:holongraph:" + name + ":holons");
        ONTOLOGY_GRAPH = graphs.ontology || ("urn:holongraph:" + name + ":ontology");
        SHACL_GRAPH = graphs.shacl || ("urn:holongraph:" + name + ":shacl");
        return callTool(SERVER, 'sparql_select', {query: homeQuery(HOLONS_GRAPH)});
      })
      .then(function(res){
        if (myGen !== datasetGeneration) return;
        var bindings = (res && res.payload && res.payload.results && res.payload.results.bindings) || [];
        if (bindings.length){
          HOME_IRI = bindings[0].home.value;
          return loadDatasetContent(myGen);
        }
        renderUnboundState(name, HOLONS_GRAPH, myGen);
      })
      .catch(function(err){
        if (myGen !== datasetGeneration) return;
        setConn('bad', 'setup failed');
        $detail.innerHTML = '';
        var inner2 = document.createElement('div');
        inner2.className = 'detail-inner';
        $detail.appendChild(inner2);
        var hdr = document.createElement('div');
        hdr.className = 'state';
        hdr.innerHTML = '<h2>Couldn’t set up the “' + name + '” dataset</h2><p>The dataset switch failed before any holon could load.</p>';
        inner2.appendChild(hdr);
        renderBanner(inner2, err, function(){ enterDataset(name); });
        setPickersEnabled(true);
      });
  }

  // Populates the Bank/Dataset <select>s from list_banks/list_datasets.
  // Called once at boot; the Dataset one is also repopulated after every
  // bank switch, since the set of datasets a bank's server actually hosts
  // (list_datasets, the true universe) has nothing to do with whichever
  // OTHER bank was active a moment ago.
  function populateSelect(select, items, activeValue){
    select.innerHTML = '';
    items.forEach(function(item){
      var opt = document.createElement('option');
      opt.value = item.value;
      opt.textContent = item.label;
      if (item.value === activeValue) opt.selected = true;
      select.appendChild(opt);
    });
  }

  function loadDatasetOptions(activeName){
    return callTool(SERVER, 'list_datasets', {}).then(function(res){
      var list = (res && res.payload && res.payload.datasets) || [];
      populateSelect($datasetSelect, list.map(function(d){ return {value: d.name, label: d.name}; }), activeName);
      return list;
    });
  }

  // Picks which dataset a freshly-switched-to bank should open by default:
  // its own curated bankScopedDatasets first entry if it has one (that's
  // the bank's "known good" shortlist), else its nominal `dataset` field if
  // the server actually hosts it, else just the first dataset the server
  // reports -- always SOMETHING, since list_datasets always returns the
  // true universe even when bankScopedDatasets is empty (as "local" and
  // "secondary" both currently are).
  function defaultDatasetFor(bank, hostedList){
    var hostedNames = hostedList.map(function(d){ return d.name; });
    if (bank.bankScopedDatasets && bank.bankScopedDatasets.length && hostedNames.indexOf(bank.bankScopedDatasets[0]) !== -1){
      return bank.bankScopedDatasets[0];
    }
    if (bank.dataset && hostedNames.indexOf(bank.dataset) !== -1) return bank.dataset;
    return hostedNames[0] || null;
  }

  function onBankChange(){
    var name = $bankSelect.value;
    if (!name || name === BANK) return;
    setPickersEnabled(false);
    setConn(null, 'switching bank…');
    showWaitingScreen(name, '…');
    callTool(SERVER, 'switch_bank', {name: name})
      .then(function(){ return callTool(SERVER, 'list_banks', {}); })
      .then(function(res){
        var banks = (res && res.payload && res.payload.banks) || [];
        var bank = banks.filter(function(b){ return b.name === name; })[0] || {name: name};
        BANK = name;
        return loadDatasetOptions(null).then(function(hostedList){
          var target = defaultDatasetFor(bank, hostedList);
          if (!target){
            setPickersEnabled(true);
            setConn('bad', 'no datasets on this bank');
            return;
          }
          enterDataset(target);
        });
      })
      .catch(function(err){
        setPickersEnabled(true);
        setConn('bad', 'bank switch failed');
        $detail.innerHTML = '';
        var inner = document.createElement('div');
        inner.className = 'detail-inner';
        $detail.appendChild(inner);
        renderBanner(inner, err, function(){ onBankChange(); });
      });
  }

  function onDatasetChange(){
    var name = $datasetSelect.value;
    if (!name || name === DATASET) return;
    enterDataset(name);
  }

  // The switch_bank -> list_banks -> (repopulate Bank select) ->
  // loadDatasetOptions -> enterDataset chain every connect needs, whether
  // that's the very first page load (init(), once claude.use('mcp') has
  // resolved) or a later switch to a different connector (onServerChange()
  // -- the same acquired `mcp` namespace calls straight into it, just with
  // SERVER/BANK/DATASET already repointed, since a single `mcp` capability
  // can address any connector by name; no need to re-acquire it per switch).
  function connectToServer(){
    setPickersEnabled(false);
    setConn(null, 'switching…');
    showWaitingScreen(BANK, DATASET);
    callTool(SERVER, 'switch_bank', {name: BANK})
      .then(function(){ return callTool(SERVER, 'list_banks', {}); })
      .then(function(res){
        var banks = (res && res.payload && res.payload.banks) || [];
        populateSelect($bankSelect, banks.map(function(b){ return {value: b.name, label: b.name}; }), BANK);
        return loadDatasetOptions(DATASET);
      })
      .then(function(){
        setPickersEnabled(true);
        enterDataset(DATASET);
      })
      .catch(function(err){
        setConn('bad', 'setup failed');
        $detail.innerHTML = '';
        var inner2 = document.createElement('div');
        inner2.className = 'detail-inner';
        $detail.appendChild(inner2);
        var hdr = document.createElement('div');
        hdr.className = 'state';
        hdr.innerHTML = '<h2>Couldn’t reach the bridge</h2><p>Listing banks/datasets failed before any holon could load.</p>';
        inner2.appendChild(hdr);
        renderBanner(inner2, err, connectToServer);
        setPickersEnabled(true);
      });
  }

  // Fires when the Connector picker changes. Resets BANK/DATASET to that
  // connector's own defaults (see CONNECTORS above) rather than carrying
  // over whichever Bank/Dataset happened to be active on the PREVIOUS
  // connector -- those names are meaningless on a different bridge.
  function onServerChange(){
    var name = $serverSelect.value;
    if (!name || name === SERVER) return;
    var defaults = CONNECTORS[name] || {bank: BANK, dataset: DATASET};
    SERVER = name;
    BANK = defaults.bank;
    DATASET = defaults.dataset;
    connectToServer();
  }

  function init(){
    setConn(null, 'connecting…');
    showWaitingScreen(BANK, DATASET);

    claude.use('mcp').then(function(ns){
      if (!ns){
        setConn('bad', 'unavailable');
        $detail.innerHTML = '';
        var inner = document.createElement('div');
        inner.className = 'detail-inner';
        inner.innerHTML = '<div class="state"><h2>Live data isn’t available in this view</h2>' +
          '<p>This copy of the page can’t call your connectors — open it directly from claude.ai with Holonbridge&#8209;Workbench connected.</p></div>';
        $detail.appendChild(inner);
        $list.innerHTML = '<div class="list-empty">No connector available.</div>';
        return;
      }
      mcp = ns;
      populateSelect($serverSelect, Object.keys(CONNECTORS).map(function(k){ return {value: k, label: k}; }), SERVER);
      connectToServer();
    });
  }

  // Discards every cached sparql_select result (list, tree, detail — all
  // of it) and re-queries live, so edits made directly against the graph
  // outside this page (SPARQL UPDATE, push_turtle, another session) show
  // up here without a full page reload. Both refresh buttons share this.
  function refreshAll(){
    if (!mcp) return;
    shapeCache = {};
    classInstanceCache = {};
    classInstanceData = {};
    labelCache = {};
    var buttons = [$refresh, $refreshTop];
    buttons.forEach(function(b){ b.disabled = true; b.textContent = b === $refreshTop ? '↻ Refreshing…' : 'Refreshing…'; });
    mcp.invalidate(SERVER, 'sparql_select').catch(function(){})
      // Re-pull the class hierarchy and shape target classes too -- picks up
      // any ontology/SHACL edit made directly against the graph (a new Kind,
      // a new shape) so By Type's group list stays current, not just the
      // holon data inside those groups.
      .then(function(){ return Promise.all([loadClassHierarchy(), loadShapeTargetClasses(), loadDeprecatedSet(true), loadChildTypeConstraints()]); })
      .then(function(){
        buttons.forEach(function(b){ b.disabled = false; b.textContent = b === $refreshTop ? '↻ Refresh' : 'Refresh'; });
        loadList();
        if (selectedIri) selectHolon(selectedIri);
        if (currentView === 'tree'){
          treeLoaded = false;
          treeNodes = {};
          loadTreeRoot();
        }
        if (currentView === 'taxonomies'){
          loadTaxonomies(true);
        }
        if (currentView === 'nodeshapes'){
          loadNodeShapes(true);
        }
        if (currentView === 'propshapes'){
          allPropertiesPromise = null;
          loadPropertyShapesTab(true);
        }
        if (currentView === 'classes'){
          loadClassesTab(true);
        }
        if (currentView === 'properties'){
          loadPropertiesTab(true);
        }
        if (currentView === 'namespaces'){
          loadNamespaces(true);
        }
      });
  }

  // Draggable divider between the rail (selection: All Holons / By Type /
  // Containment Tree / Taxonomies) and the detail pane (display/edit).
  // Width lives as an inline style on #rail -- simplest thing that beats
  // the CSS var-with-fallback rule in the stylesheet -- and is echoed to
  // localStorage so it survives a reload/republish for this viewer, in
  // this browser (best-effort: wrapped in try/catch, since a private
  // window or blocked site data can make either call throw or no-op).
  (function initRailResizer(){
    var STORAGE_KEY = 'worldtest-viewer:rail-width';
    var DEFAULT_WIDTH = 320;
    var MIN_WIDTH = 220;

    function maxWidth(){
      var layoutW = $layout.getBoundingClientRect().width;
      // Leave the detail pane at least 320px, however wide the window is.
      return Math.max(MIN_WIDTH, Math.min(640, layoutW - 320));
    }
    function clampWidth(w){
      return Math.max(MIN_WIDTH, Math.min(maxWidth(), w));
    }
    function applyWidth(w, persist){
      w = clampWidth(w);
      $rail.style.width = w + 'px';
      $railResizer.setAttribute('aria-valuemin', String(MIN_WIDTH));
      $railResizer.setAttribute('aria-valuemax', String(maxWidth()));
      $railResizer.setAttribute('aria-valuenow', String(Math.round(w)));
      if (persist){
        try { localStorage.setItem(STORAGE_KEY, String(Math.round(w))); } catch(e){}
      }
      return w;
    }

    var restored = DEFAULT_WIDTH;
    try {
      var saved = localStorage.getItem(STORAGE_KEY);
      if (saved && !isNaN(Number(saved))) restored = Number(saved);
    } catch(e){}
    applyWidth(restored, false);
    // Re-clamp on window resize so a saved wide rail doesn't crowd out the
    // detail pane if the window (or the artifact frame) gets narrower.
    window.addEventListener('resize', function(){
      applyWidth(parseFloat($rail.style.width) || DEFAULT_WIDTH, false);
    });

    var dragging = false, startX = 0, startWidth = 0;

    function onMove(clientX){
      applyWidth(startWidth + (clientX - startX), false);
    }
    function stopDrag(finalWidth){
      if (!dragging) return;
      dragging = false;
      $layout.classList.remove('resizing');
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      document.removeEventListener('touchmove', onTouchMove);
      document.removeEventListener('touchend', onTouchEnd);
      applyWidth(finalWidth != null ? finalWidth : parseFloat($rail.style.width), true);
    }
    function onMouseMove(e){ onMove(e.clientX); }
    function onMouseUp(e){ stopDrag(e.clientX != null ? startWidth + (e.clientX - startX) : null); }
    function onTouchMove(e){
      if (e.touches && e.touches.length) { onMove(e.touches[0].clientX); e.preventDefault(); }
    }
    function onTouchEnd(){ stopDrag(null); }

    function startDrag(clientX){
      dragging = true;
      startX = clientX;
      startWidth = $rail.getBoundingClientRect().width;
      $layout.classList.add('resizing');
    }

    $railResizer.addEventListener('mousedown', function(e){
      if (e.button !== 0) return;
      e.preventDefault();
      startDrag(e.clientX);
      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    });
    $railResizer.addEventListener('touchstart', function(e){
      if (!e.touches || !e.touches.length) return;
      startDrag(e.touches[0].clientX);
      document.addEventListener('touchmove', onTouchMove, {passive:false});
      document.addEventListener('touchend', onTouchEnd);
    }, {passive:true});
    $railResizer.addEventListener('dblclick', function(){
      applyWidth(DEFAULT_WIDTH, true);
    });
    $railResizer.addEventListener('keydown', function(e){
      var step = e.shiftKey ? 40 : 16;
      var current = parseFloat($rail.style.width) || DEFAULT_WIDTH;
      if (e.key === 'ArrowLeft'){ applyWidth(current - step, true); e.preventDefault(); }
      else if (e.key === 'ArrowRight'){ applyWidth(current + step, true); e.preventDefault(); }
      else if (e.key === 'Home'){ applyWidth(MIN_WIDTH, true); e.preventDefault(); }
      else if (e.key === 'End'){ applyWidth(maxWidth(), true); e.preventDefault(); }
      else if (e.key === 'Enter' || e.key === ' '){ applyWidth(DEFAULT_WIDTH, true); e.preventDefault(); }
    });
  })();

  $search.addEventListener('input', function(){
    renderList();
    renderByType();
  });
  $refresh.addEventListener('click', refreshAll);
  $refreshTop.addEventListener('click', refreshAll);

  // Views whose rail is a flat resource list with no relationship to the
  // currently selected HOLON (Taxonomies, Node Shapes, Property Shapes) --
  // switching AWAY from one of these back to a holon view (List/By Type/
  // Tree) needs to restore whatever holon was selected before, exactly as
  // leavingTaxonomies used to handle alone.
  var RAIL_ONLY_VIEWS = {taxonomies: true, classes: true, properties: true, nodeshapes: true, propshapes: true, namespaces: true};

  $viewSelect.addEventListener('change', function(){
    var view = $viewSelect.value;
    if (view === currentView) return;
    var leavingRailOnly = RAIL_ONLY_VIEWS[currentView] && !RAIL_ONLY_VIEWS[view];
    currentView = view;
    $list.hidden = view !== 'list';
    $byType.hidden = view !== 'type';
    $tree.hidden = view !== 'tree';
    $taxonomies.hidden = view !== 'taxonomies';
    $classes.hidden = view !== 'classes';
    $properties.hidden = view !== 'properties';
    $nodeShapes.hidden = view !== 'nodeshapes';
    $propShapes.hidden = view !== 'propshapes';
    $namespaces.hidden = view !== 'namespaces';
    $searchWrap.hidden = (view === 'tree' || RAIL_ONLY_VIEWS[view]);
    if (view === 'tree' && !treeLoaded) loadTreeRoot();
    if (view === 'type') renderByType();
    if (view === 'taxonomies') { if (!taxonomiesLoaded) loadTaxonomies(); else renderTaxonomies(); }
    if (view === 'classes') { if (!classesLoaded) loadClassesTab(); else renderClassesTab(); }
    if (view === 'properties') { if (!propertiesLoaded) loadPropertiesTab(); else renderPropertiesTab(); }
    if (view === 'nodeshapes') { if (!nodeShapesLoaded) loadNodeShapes(); else renderNodeShapes(); }
    if (view === 'propshapes') { if (!propShapesLoaded) loadPropertyShapesTab(); else renderPropertyShapesTab(); }
    if (view === 'namespaces') { if (!namespacesLoaded) loadNamespaces(); else renderNamespaces(); }
    if (leavingRailOnly){
      if (selectedIri && lastDetailBindings) rerenderDetail();
      else if (!selectedIri) renderIdleDetail('Nothing selected');
    }
  });

  $serverSelect.addEventListener('change', onServerChange);
  $bankSelect.addEventListener('change', onBankChange);
  $datasetSelect.addEventListener('change', onDatasetChange);

  init();
