#!/bin/bash
# Parse-check ES module files without Node: strips import lines / export keywords and
# asks macOS JavaScriptCore (osascript -l JavaScript) to compile the source with new Function().
# Usage: scripts/jscheck.sh frontend/js/views/*.js
status=0
for f in "$@"; do
  src=$(sed -E -e '/^[[:space:]]*import[[:space:]].*from[[:space:]]+["'"'"'].*["'"'"'];?[[:space:]]*$/d' -e 's/^export (async function|function|const|let|class)/\1/' "$f")
  out=$(SRC="$src" osascript -l JavaScript -e 'ObjC.import("stdlib"); var s=$.getenv("SRC"); try { new Function("return (async () => {\n" + s + "\n})"); "OK" } catch (e) { "SYNTAX ERROR: " + e }' 2>&1)
  echo "$f: $out"
  [[ "$out" == OK ]] || status=1
done
exit $status
