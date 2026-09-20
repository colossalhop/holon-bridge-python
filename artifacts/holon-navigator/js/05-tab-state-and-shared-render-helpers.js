  // ---- Taxonomies (skos:ConceptScheme / skos:Concept management) state --
  var taxonomiesLoaded = false;
  var schemesData = [];          // [{iri, label, count}] -- a scheme's concepts are
                                  // fetched fresh on every selectScheme() call rather
                                  // than cached here.
  var selectedSchemeIri = null;
  // Every ontology-graph resource currently carrying holon:status
  // holon:DeprecatedStatus (concepts and schemes alike) -- loaded once at
  // startup/refresh, like loadClassHierarchy/loadShapeTargetClasses, and
  // checked synchronously wherever a concept might be selected or shown
  // (the enum <select> in the shape editor, and the read-only Properties
  // value display) so a deprecated value never just vanishes -- it stays
  // visible, tagged, and non-selectable, matching this dataset's existing
  // "never delete, tombstone instead" convention (holon:TombstonedStatus is
  // already used the same way for holons).
  var deprecatedSet = {};

  // Per-tab "show deprecated" preference, shared by every flat-list viewer
  // (Taxonomies' schemes AND its in-detail concepts, Namespaces, Classes,
  // Properties, Node Shapes, Property Shapes) -- keyed by a short tab id
  // (see the buildShowDeprecatedToggle() calls in each tab's render
  // function below). Absent/undefined means "hidden" (the default this
  // was added for, 2026-09-19: a long-lived dataset accumulates enough
  // deprecated/deactivated entries that they used to crowd out the still-
  // live ones); explicitly false means the admin ticked the box to reveal
  // them for this tab. A plain object rather than a single global flag so
  // toggling it on one tab (say, Namespaces, while cleaning up legacy
  // prefixes) doesn't also flip every other tab's view.
  var hideDeprecated = {};
  function isDeprecatedHidden(key){ return hideDeprecated[key] !== false; }

  // Builds the small "Show deprecated"/"Show deactivated" checkbox every
  // flat-list tab's render function drops in next to its "+ New ..."
  // button. `rerender` is called with no arguments on toggle -- callers
  // pass whatever re-render entry point re-applies the corresponding
  // filterByDeprecatedSet/filterByDeactivatedFlag call below (usually the
  // tab's own render function; renderSchemeDetail's concepts toggle passes
  // a closure over its own already-fetched `concepts` array instead, so
  // toggling it doesn't re-issue a live query just to change what's shown).
  function buildShowDeprecatedToggle(key, label, rerender){
    var wrap = document.createElement('label');
    wrap.style.cssText = 'display:flex; align-items:center; gap:6px; font-size:11px; color:var(--ink-soft); margin:0 8px 10px; cursor:pointer; user-select:none;';
    var cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !isDeprecatedHidden(key);
    wrap.appendChild(cb);
    wrap.appendChild(document.createTextNode(label));
    cb.addEventListener('change', function(){
      hideDeprecated[key] = !cb.checked;
      rerender();
    });
    return wrap;
  }

  // Filters a list of {iri, ...} items against the ontology-wide
  // deprecatedSet (Taxonomies, Namespaces, Classes, Properties -- every
  // resource that uses holon:status/holon:DeprecatedStatus rather than
  // SHACL's own sh:deactivated). Returns `items` unchanged when the tab's
  // toggle currently has deprecated entries switched ON.
  function filterByDeprecatedSet(items, key){
    if (!isDeprecatedHidden(key)) return items;
    return items.filter(function(it){ return !deprecatedSet[it.iri]; });
  }

  // The SHACL-shape equivalent of filterByDeprecatedSet above, for Node
  // Shapes/Property Shapes -- those carry their own `deactivated` boolean
  // (from sh:deactivated) rather than participating in the ontology-wide
  // deprecatedSet, since they aren't ontology-graph resources.
  function filterByDeactivatedFlag(items, key){
    if (!isDeprecatedHidden(key)) return items;
    return items.filter(function(it){ return !it.deactivated; });
  }

  // ---- Node Shapes / Property Shapes (SHACL 1.2 Core) tab state ---------
  // Same rail/detail shape as Taxonomies above: a flat list loaded once per
  // dataset (nodeShapesLoaded/propShapesLoaded), the currently selected
  // shape's IRI, and a separate "edit form open for" flag so Edit is its
  // own toggle rather than overloading selection the way the holon Edit
  // form does with editOpenFor.
  var nodeShapesLoaded = false;
  var nodeShapesData = [];        // [{iri, targetClass, label, comment, closed, severity, deactivated, propCount}]
  var selectedNodeShapeIri = null;
  var nodeShapeEditOpenFor = null;
  var propShapesLoaded = false;
  var propShapesData = [];        // [{iri, path, name, severity, deactivated}] -- named (IRI) sh:PropertyShapes only,
                                   // so they can be listed and reused across node shapes via sh:property; an inline
                                   // blank-node property shape hand-authored elsewhere in the graph isn't managed here.
  var selectedPropShapeIri = null;
  var propShapeEditOpenFor = null;
  var allPropertiesPromise = null; // memoized ontology-graph property list, for the "New Property Shape" path picker

  // ---- Classes / Properties (raw ontology vocabulary) tab state ---------
  // Distinct from Node Shapes / Property Shapes above: those are SHACL
  // constraints built ON TOP of a class/predicate; these two tabs browse
  // the underlying vocabulary itself. See the section comment further
  // down (next to CLASSES_LIST_QUERY) for why both loaders merge
  // ontology-graph declarations with usage-derived vocabulary.
  var classesLoaded = false;
  var classesData = [];      // [{iri, label, comment, superClasses:[], instanceCount, shapes:[]}]
  var selectedClassIri = null;
  var classEditOpenFor = null;
  var propertiesLoaded = false;
  var propertiesData = [];   // [{iri, label, comment, domains:[], ranges:[], shapes:[]}]
  var selectedPropertyIri = null;
  var propertyEditOpenFor = null;

  // ---- Namespaces (prefix/URI registry, VANN vocabulary) tab state ------
  // Same rail/detail shape again: a flat list loaded once per dataset, the
  // registry entries live in ONTOLOGY_GRAPH (not SHACL_GRAPH) as tiny
  // owl:Ontology resources carrying vann:preferredNamespacePrefix/
  // vann:preferredNamespaceUri, and deprecation reuses the SAME
  // holon:status/holon:DeprecatedStatus mechanism Taxonomies already uses
  // (via the shared deprecatedSet/loadDeprecatedSet/buildSetStatusSparql/
  // buildClearStatusSparql below) rather than SHACL's sh:deactivated --
  // namespaces aren't SHACL resources, so there's nothing to deactivate.
  var namespacesLoaded = false;
  var namespacesData = [];        // [{iri, prefix, uri, label, comment}]
  var selectedNamespaceIri = null;
  var namespaceEditOpenFor = null;

  var $list = document.getElementById('list');
  var $byType = document.getElementById('byType');
  var $tree = document.getElementById('tree');
  var $taxonomies = document.getElementById('taxonomies');
  var $classes = document.getElementById('classes');
  var $properties = document.getElementById('properties');
  var $nodeShapes = document.getElementById('nodeShapes');
  var $propShapes = document.getElementById('propShapes');
  var $namespaces = document.getElementById('namespaces');
  var $searchWrap = document.getElementById('searchWrap');
  var $detail = document.getElementById('detail');
  var $rail = document.getElementById('rail');
  var $railResizer = document.getElementById('railResizer');
  var $layout = document.querySelector('.layout');
  var $search = document.getElementById('search');
  var $connStatus = document.getElementById('connStatus');
  var $connDot = document.getElementById('connDot');
  var $count = document.getElementById('holonCount');
  var $updated = document.getElementById('updated');
  var $refresh = document.getElementById('refreshBtn');
  var $refreshTop = document.getElementById('refreshBtnTop');
  var $viewSelect = document.getElementById('viewSelect');
  var $serverSelect = document.getElementById('serverSelect');
  var $bankSelect = document.getElementById('bankSelect');
  var $datasetSelect = document.getElementById('datasetSelect');

  function humanize(iri){
    var frag = iri.indexOf('#') !== -1 ? iri.split('#').pop() : iri.split('/').filter(Boolean).pop();
    try { frag = decodeURIComponent(frag); } catch(e){}
    var spaced = frag.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_\-]+/g, ' ').trim();
    if (!spaced) return frag;
    return spaced.split(/\s+/).map(function(w){
      return w.charAt(0).toUpperCase() + w.slice(1);
    }).join(' ');
  }

  function formatDate(v){
    var d = new Date(v);
    if (isNaN(d.getTime())) return v;
    var opts = v.length <= 10 ? {day:'numeric', month:'long', year:'numeric', timeZone:'UTC'}
                               : {day:'numeric', month:'long', year:'numeric', hour:'2-digit', minute:'2-digit', timeZone:'UTC'};
    return d.toLocaleDateString('en-GB', opts);
  }

  function formatNumber(value, datatype){
    if (!datatype || !/(double|decimal|float|integer|int|long)$/.test(datatype)) return null;
    var n = Number(value);
    if (Number.isNaN(n)) return null;
    // Integer-family datatypes (xsd:integer/int/long) always render as plain
    // grouped digits -- "0,000" notation, US-style comma thousands separator,
    // no decimal places -- and never fall into the exponential-notation
    // branch below, no matter how large the value: a country population of
    // 1.4bn should read "1,400,000,000", not "1.400e+9". Only the continuous
    // numeric datatypes (decimal/float/double) still switch to exponential
    // for very large or very small magnitudes.
    if (/(integer|int|long)$/.test(datatype)){
      return n.toLocaleString('en-US', {maximumFractionDigits: 0});
    }
    if (n !== 0 && (Math.abs(n) < 1e-3 || Math.abs(n) >= 1e6)) return n.toExponential(3);
    return n.toLocaleString('en-GB', {maximumFractionDigits: 6});
  }

  // Minimal, self-contained Markdown renderer for holon:description (the
  // free-text Description field). No external library -- description text
  // is short prose (a paragraph or a few list items at most), and keeping
  // this inline avoids depending on a CDN load. Escapes HTML first, so the
  // only tags that ever reach the DOM are the ones this function generates
  // itself; supports paragraphs, headings, blockquotes, bullet/numbered
  // lists, and inline **bold**/*italic*/`code`/[link](url).
  function escapeHtml(s){
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // Takes RAW (unescaped) inline text, escapes it, then applies inline
  // markdown formatting -- block-level detection in markdownToHtml runs on
  // the raw lines first (e.g. ">" or "#" would themselves get escaped away
  // and stop matching if escaping happened before block splitting).
  function mdInline(raw){
    var s = escapeHtml(raw);
    s = s.replace(/`([^`]+)`/g, function(m, c){ return '<code>' + c + '</code>'; });
    s = s.replace(/\*\*([^\n]+?)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/\*([^\n]+?)\*/g, '<em>$1</em>');
    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, function(m, text, url){
      var safeUrl = /^(https?:|mailto:)/i.test(url) ? url : '#';
      return '<a href="' + safeUrl + '" target="_blank" rel="noopener noreferrer">' + text + '</a>';
    });
    return s;
  }

  function markdownToHtml(src){
    if (!src) return '';
    var lines = String(src).replace(/\r\n/g, '\n').split('\n');
    var out = [];
    var i = 0;
    while (i < lines.length){
      var line = lines[i];
      if (!line.trim()){ i++; continue; }
      var h = /^(#{1,6})\s+(.*)$/.exec(line);
      if (h){
        var tag = 'h' + Math.min(h[1].length + 1, 4); // h1 stays reserved for the holon's own title
        out.push('<' + tag + '>' + mdInline(h[2]) + '</' + tag + '>');
        i++;
        continue;
      }
      if (/^>\s?/.test(line)){
        var quoteLines = [];
        while (i < lines.length && /^>\s?/.test(lines[i])){ quoteLines.push(lines[i].replace(/^>\s?/, '')); i++; }
        out.push('<blockquote>' + mdInline(quoteLines.join(' ')) + '</blockquote>');
        continue;
      }
      if (/^[-*+]\s+/.test(line)){
        var items = [];
        while (i < lines.length && /^[-*+]\s+/.test(lines[i])){ items.push('<li>' + mdInline(lines[i].replace(/^[-*+]\s+/, '')) + '</li>'); i++; }
        out.push('<ul>' + items.join('') + '</ul>');
        continue;
      }
      if (/^\d+\.\s+/.test(line)){
        var oitems = [];
        while (i < lines.length && /^\d+\.\s+/.test(lines[i])){ oitems.push('<li>' + mdInline(lines[i].replace(/^\d+\.\s+/, '')) + '</li>'); i++; }
        out.push('<ol>' + oitems.join('') + '</ol>');
        continue;
      }
      var paraLines = [];
      while (i < lines.length && lines[i].trim() && !/^(#{1,6})\s+/.test(lines[i]) && !/^>\s?/.test(lines[i]) && !/^[-*+]\s+/.test(lines[i]) && !/^\d+\.\s+/.test(lines[i])){
        paraLines.push(lines[i]);
        i++;
      }
      out.push('<p>' + mdInline(paraLines.join(' ')) + '</p>');
    }
    return out.join('');
  }

  function setConn(state, label){
    $connDot.className = 'dot' + (state ? ' ' + state : '');
    $connStatus.querySelector('span:last-child').innerHTML = label;
  }

  function mcpErrorCopy(err){
    var code = err && err.code;
    var map = {
      not_granted: ["Connector access not granted", "This view was not granted permission to call your connectors."],
      capability_disabled: ["Live data unavailable here", "This viewer can't run connector calls right now."],
      server_not_connected: [SERVER + " not connected", "Add it in claude.ai Settings → Connectors, or check it's enabled on your Windows box, then refresh."],
      needs_reauth: ["Reconnect " + SERVER, "Reconnect it in claude.ai Settings → Connectors, then refresh."],
      selection_required: ["Choose a connector", "You have more than one " + SERVER + " connector — pick one, then refresh."],
      server_unavailable: [SERVER + " unreachable", "The bridge on your workbench didn't answer. Make sure it's running, then retry."],
      blocked_by_policy: ["Blocked by policy", "Your organisation's policy blocks this call."],
      tool_error: ["Query failed", (err && err.message) || "The bridge reported an error running this query."],
      not_in_manifest: ["Not permitted for this view", "This call fell outside what you allowed this page to do."]
    };
    var entry = map[code] || ["Something went wrong", (err && err.message) || "An unexpected error occurred."];
    return {title: entry[0], hint: entry[1], retryable: !!(err && err.retryable)};
  }

  function renderBanner(container, err, onRetry){
    var copy = mcpErrorCopy(err);
    var div = document.createElement('div');
    div.className = 'banner error';
    div.innerHTML = '<h3>' + copy.title + '</h3><p>' + copy.hint + '</p>';
    if (onRetry){
      var b = document.createElement('button');
      b.className = 'btn primary';
      b.textContent = copy.retryable ? 'Retry' : 'Try again';
      b.addEventListener('click', onRetry);
      div.appendChild(b);
    }
    container.appendChild(div);
    return div;
  }

  function renderListSkeleton(){
    $list.innerHTML = '';
    for (var i=0; i<8; i++){
      var row = document.createElement('div');
      row.style.padding = '9px 10px';
      var sk = document.createElement('div');
      sk.className = 'skeleton';
      sk.style.width = (60 + Math.random()*30) + '%';
      row.appendChild(sk);
      $list.appendChild(row);
    }
  }

  // Shared by the flat list and the by-type groups -- a single holon row,
  // detached (caller appends it wherever it belongs).
  function buildHolonRow(h){
    var row = document.createElement('button');
    row.className = 'row' + (h.iri === selectedIri ? ' active' : '');
    row.type = 'button';
    var lbl = document.createElement('span');
    lbl.className = 'row-label';
    lbl.textContent = h.label;
    row.appendChild(lbl);
    if (h.types.length){
      var tp = document.createElement('span');
      tp.className = 'row-type';
      tp.textContent = humanize(primaryType(h.types));
      tp.title = h.types.map(humanize).join(', ');
      row.appendChild(tp);
    }
    row.addEventListener('click', function(){ selectHolon(h.iri); });
    return row;
  }

  function matchesSearch(h, q){
    if (!q) return true;
    var hay = (h.label + ' ' + h.types.join(' ')).toLowerCase();
    return hay.indexOf(q) !== -1;
  }

  function updateCount(shown){
    $count.textContent = shown === holons.length ? (holons.length + ' holons') : (shown + ' of ' + holons.length);
  }

  function renderEmptyState(container, q){
    var empty = document.createElement('div');
    empty.className = 'list-empty';
    empty.textContent = q ? 'No holons match "' + q + '".' : 'No holons found in this dataset.';
    container.appendChild(empty);
  }

  function renderList(){
    var q = ($search.value || '').toLowerCase().trim();
    $list.innerHTML = '';
    var shown = 0;
    holons.forEach(function(h){
      if (!matchesSearch(h, q)) return;
      shown++;
      $list.appendChild(buildHolonRow(h));
    });
    if (!shown) renderEmptyState($list, $search.value);
    updateCount(shown);
  }

  // A group header for the By Type view: label + count, plus an Add button
  // (for every real type -- not the trailing "Untyped" bucket) that opens
  // the "create a new <Type>" form in the detail pane. Shown for every
  // known type -- see computeAllTypes() -- even ones with zero holons yet,
  // so the header (and its Add button) is how a type gets its first one.
  function buildGroupHeader(g){
    var header = document.createElement('div');
    header.className = 'list-group-header';
    var text = document.createElement('span');
    text.textContent = g.label + ' (' + g.items.length + ')';
    header.appendChild(text);
    if (g.typeIri){
      var addBtn = document.createElement('button');
      addBtn.type = 'button';
      addBtn.className = 'group-add-btn';
      addBtn.textContent = '+';
      addBtn.title = 'Add a new ' + g.label;
      addBtn.setAttribute('aria-label', 'Add a new ' + g.label);
      addBtn.addEventListener('click', function(ev){
        ev.stopPropagation();
        openAddTypeForm(g.typeIri, g.label);
      });
      header.appendChild(addBtn);
    }
    return header;
  }

  // Same holon set as the flat list, grouped under a header per primary
  // type (the same type the row badge shows) -- a holon with no domain
  // type beyond holon:Holon falls into a trailing "Untyped" group. Unlike
  // the flat list, every known type (see computeAllTypes()) gets a header
  // even with zero current members, so a type can be populated for the
  // first time straight from its own header's Add button. A search filters
  // which of those headers show: with no filter, everything appears; while
  // filtering, an empty group only stays visible if its own name matches.
  function renderByType(){
    var q = ($search.value || '').toLowerCase().trim();
    $byType.innerHTML = '';
    var groups = {};
    var order = [];
    function ensureGroup(key, label, typeIri){
      if (!groups[key]){
        groups[key] = {label: label, items: [], typeIri: typeIri};
        order.push(key);
      }
      return groups[key];
    }
    computeAllTypes().forEach(function(t){ ensureGroup(t, humanize(t), t); });
    var shown = 0;
    holons.forEach(function(h){
      if (!matchesSearch(h, q)) return;
      shown++;
      var t = h.types.length ? primaryType(h.types) : null;
      var key = t || ' untyped';
      var g = ensureGroup(key, t ? humanize(t) : 'Untyped', t);
      g.items.push(h);
    });
    var visibleKeys = order.filter(function(key){
      var g = groups[key];
      if (key === ' untyped') return g.items.length > 0;
      if (g.items.length) return true;
      if (!q) return true;
      return g.label.toLowerCase().indexOf(q) !== -1;
    });
    if (!visibleKeys.length){
      renderEmptyState($byType, $search.value);
      updateCount(shown);
      return;
    }
    visibleKeys.sort(function(a, b){
      if (a === ' untyped') return 1;
      if (b === ' untyped') return -1;
      return groups[a].label.localeCompare(groups[b].label);
    });
    visibleKeys.forEach(function(key){
      var g = groups[key];
      $byType.appendChild(buildGroupHeader(g));
      if (g.items.length){
        g.items.forEach(function(h){ $byType.appendChild(buildHolonRow(h)); });
      } else {
        var empty = document.createElement('div');
        empty.className = 'list-empty';
        empty.style.cssText = 'padding:2px 8px 12px; font-size:12px;';
        empty.textContent = 'No holons yet.';
        $byType.appendChild(empty);
      }
    });
    updateCount(shown);
  }

  function renderUpdated(){
    if (!listCacheInfo){ $updated.textContent = ''; return; }
    var d = new Date(listCacheInfo.storedAt);
    $updated.textContent = 'updated ' + d.toLocaleTimeString('en-GB', {hour:'2-digit', minute:'2-digit'});
  }

  function renderTree(){
    $tree.innerHTML = '';
    var root = treeNodes[HOME_IRI];
    if (!root) return;
    $tree.appendChild(renderTreeNode(HOME_IRI, 0));
  }

  function renderTreeNode(iri, depth, isConnection, via){
    var node = treeNodes[iri];
    var wrap = document.createElement('div');

    var row = document.createElement('div');
    row.className = 'tree-row' + (iri === selectedIri ? ' active' : '');
    row.style.paddingLeft = (8 + depth * 18) + 'px';

    var toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'tree-toggle' + (node.hasChildren ? (node.expanded ? ' expanded' : '') : ' leaf');
    toggle.textContent = '▸';
    toggle.tabIndex = node.hasChildren ? 0 : -1;
    toggle.setAttribute('aria-label', node.expanded ? 'Collapse' : 'Expand');
    if (node.hasChildren){
      toggle.addEventListener('click', function(ev){ ev.stopPropagation(); toggleExpand(iri); });
    }
    row.appendChild(toggle);

    var label = document.createElement('span');
    label.className = 'tree-label' + (isConnection ? ' connection' : '');
    label.textContent = node.label;
    if (isConnection){
      label.title = via && via.length ? 'Connection via ' + via.map(humanize).join(', ') : 'Connection';
    }
    row.appendChild(label);

    if (node.types.length){
      var tp = document.createElement('span');
      tp.className = 'tree-type';
      tp.textContent = humanize(primaryType(node.types));
      tp.title = node.types.map(humanize).join(', ');
      row.appendChild(tp);
    }

    row.addEventListener('click', function(){ selectHolon(iri); });
    wrap.appendChild(row);

    if (node.expanded){
      if (node.loading){
        var loading = document.createElement('div');
        loading.className = 'tree-loading';
        loading.style.paddingLeft = (8 + (depth + 1) * 18) + 'px';
        loading.textContent = 'Loading…';
        wrap.appendChild(loading);
      } else if (node.loadError){
        var errWrap = document.createElement('div');
        errWrap.style.paddingLeft = (8 + (depth + 1) * 18) + 'px';
        renderBanner(errWrap, node.loadError, function(){ loadChildren(iri); });
        wrap.appendChild(errWrap);
      } else {
        if (node.children){
          node.children.forEach(function(childIri){
            wrap.appendChild(renderTreeNode(childIri, depth + 1, false));
          });
        }
        if (node.connections){
          node.connections.forEach(function(conn){
            wrap.appendChild(renderTreeNode(conn.iri, depth + 1, true, conn.via));
          });
        }
      }
    }
    return wrap;
  }

  function loadChildren(iri){
    var node = treeNodes[iri];
    if (!node) return;
    node.loading = true;
    node.loadError = null;
    renderTree();
    Promise.all([
      callTool(SERVER, 'sparql_select', {query: childrenQuery(iri)}),
      callTool(SERVER, 'sparql_select', {query: connectionsQuery(iri)})
    ])
      .then(function(results){
        var childBindings = (results[0].payload && results[0].payload.results && results[0].payload.results.bindings) || [];
        var kidIris = childBindings.map(function(b){
          var kIri = b.child.value;
          treeNodes[kIri] = treeNodes[kIri] || {
            label: b.label.value,
            types: b.types ? b.types.value.split('|').filter(Boolean) : [],
            hasChildren: !!(b.hasChildren && b.hasChildren.value === 'true'),
            expanded: false,
            children: null,
            connections: null,
            loading: false
          };
          return kIri;
        });
        var connBindings = (results[1].payload && results[1].payload.results && results[1].payload.results.bindings) || [];
        var connections = connBindings.map(function(b){
          var cIri = b.target.value;
          treeNodes[cIri] = treeNodes[cIri] || {
            label: b.label.value,
            types: b.types ? b.types.value.split('|').filter(Boolean) : [],
            hasChildren: !!(b.hasChildren && b.hasChildren.value === 'true'),
            expanded: false,
            children: null,
            connections: null,
            loading: false
          };
          return {
            iri: cIri,
            via: b.via ? b.via.value.split('|').filter(Boolean) : []
          };
        });
        node.children = kidIris;
        node.connections = connections;
        node.loading = false;
        renderTree();
      })
      .catch(function(err){
        node.loading = false;
        node.loadError = err;
        renderTree();
      });
  }

  function toggleExpand(iri){
    var node = treeNodes[iri];
    if (!node || !node.hasChildren) return;
    node.expanded = !node.expanded;
    if (node.expanded && node.children === null && !node.loading){
      loadChildren(iri);
    } else {
      renderTree();
    }
  }

  function loadTreeRoot(){
    if (!mcp){
      $tree.innerHTML = '<div class="tree-empty">No connector available.</div>';
      return;
    }
    $tree.innerHTML = '';
    var loading = document.createElement('div');
    loading.className = 'tree-empty';
    loading.textContent = 'Loading tree…';
    $tree.appendChild(loading);
    callTool(SERVER, 'sparql_select', {query: nodeInfoQuery(HOME_IRI), graph: HOLONS_GRAPH})
      .then(function(res){
        var bindings = (res.payload && res.payload.results && res.payload.results.bindings) || [];
        var b = bindings[0];
        treeNodes[HOME_IRI] = {
          label: b ? b.label.value : humanize(HOME_IRI),
          types: b && b.types ? b.types.value.split('|').filter(Boolean) : [],
          hasChildren: true,
          expanded: false,
          children: null,
          connections: null,
          loading: false
        };
        treeLoaded = true;
        renderTree();
      })
      .catch(function(err){
        $tree.innerHTML = '';
        renderBanner($tree, err, loadTreeRoot);
      });
  }

