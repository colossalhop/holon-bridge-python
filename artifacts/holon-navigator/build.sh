#!/usr/bin/env bash
# Regenerates dist/app.js from js/*.js, in numeric order, wrapped in the
# original top-level (function(){ ... })(); closure. Run this after editing
# any file under js/.
set -euo pipefail
cd "$(dirname "$0")"

mkdir -p dist
{
  echo "(function(){"
  cat js/01-bridge-connection-and-core-queries.js \
      js/02-taxonomy-and-holon-crud-backend.js \
      js/03-shape-driven-property-editor.js \
      js/04-holon-relationships.js \
      js/05-tab-state-and-shared-render-helpers.js \
      js/06-taxonomies-tab-ui.js \
      js/07-shacl-shapes-shared.js \
      js/08-node-shapes-tab-ui.js \
      js/09-property-shapes-tab-ui.js \
      js/10-classes-tab-ui.js \
      js/11-properties-tab-ui.js \
      js/12-namespaces-tab-ui.js \
      js/13-holon-detail-panel.js \
      js/14-holon-actions.js \
      js/15-app-bootstrap-and-lifecycle.js
  echo "})();"
} > dist/app.js

echo "Wrote dist/app.js ($(wc -l < dist/app.js) lines)"
